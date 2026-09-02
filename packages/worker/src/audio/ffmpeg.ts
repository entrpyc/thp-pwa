import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFfmpegPath, type EnvSource } from './env';
import {
  AudioProcessingError,
  type AudioProcessor,
  type AudioProcessRequest,
  type ProcessedRendition,
} from './processor';

/**
 * **The one file in the repository permitted to name the transcoder** — the seam `deepgram.ts`
 * cuts for ASR, cut for ffmpeg.
 *
 * It shells out rather than binding a library: ffmpeg *is* the tool, its command line is its
 * stable interface, and a wrapper dependency would sit between the application and two decades of
 * that stability for no gain. The binary is named by `FFMPEG_PATH` and must be installed on the
 * worker host — a missing binary fails the job with a sentence saying so, which an operator reads
 * off the failed row.
 *
 * **Why AAC in M4A.** Browsers seek an MP4 container exactly — it carries a sample-to-time index —
 * where a VBR MP3 is seeked by estimation: measured on a real teaching, `currentTime` after a seek
 * was up to nine seconds away from the audio actually playing. `+faststart` moves that index ahead
 * of the media so a browser can seek before it has the whole file, which is what streaming a
 * 90-minute teaching is.
 */

/** The rendition this adapter produces, always. */
const RENDITION: ProcessedRendition = { extension: 'm4a', contentType: 'audio/mp4' };

/**
 * 96 kbit/s — transparent for speech, ~25% smaller than the typical original, and constant, so
 * the encode's own size is predictable. A named constant because the day somebody wants stereo
 * music quality this is the one number to revisit.
 */
export const PLAYBACK_BITRATE = '96k';

/**
 * Thirty minutes, the transcription timeout's reasoning re-used: an encode of a 90-minute file
 * takes a couple of minutes, and what the ceiling stops is a hung binary sitting `running` until
 * somebody restarts the process.
 */
export const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

export interface FfmpegOptions {
  readonly env?: EnvSource;
  readonly timeoutMs?: number;
}

export function ffmpegProcessor(options: FfmpegOptions = {}): AudioProcessor {
  const { env = process.env, timeoutMs = FFMPEG_TIMEOUT_MS } = options;
  const binary = readFfmpegPath(env);

  return {
    name: 'ffmpeg',

    outputFor(): ProcessedRendition {
      return RENDITION;
    },

    async process(request: AudioProcessRequest): Promise<void> {
      const workDir = await mkdtemp(join(tmpdir(), 'thp-process-audio-'));
      const sourcePath = join(workDir, 'source');
      const renditionPath = join(workDir, `rendition.${RENDITION.extension}`);

      try {
        await download(request.sourceUrl, sourcePath);
        await transcode(binary, sourcePath, renditionPath, timeoutMs);
        await upload(request.uploadUrl, renditionPath, request.contentType);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}

/** Fetch the original onto disk. Streamed, so the process never holds the file twice. */
async function download(url: string, toPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new AudioProcessingError(`the original could not be fetched (HTTP ${response.status})`);
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(toPath));
}

/** Run the encode. A non-zero exit fails with the tool's own last words, truncated. */
function transcode(
  binary: string,
  sourcePath: string,
  renditionPath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      binary,
      // `-vn` drops the cover art some MP3s embed as a video stream; without it the copy into an
      // audio-only container fails on exactly the files a person exported from a phone app.
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-vn', '-c:a', 'aac',
        '-b:a', PLAYBACK_BITRATE, '-movflags', '+faststart', renditionPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(
        new AudioProcessingError(
          `ffmpeg did not finish within ${Math.round(timeoutMs / 60_000)} minutes`,
        ),
      );
    }, timeoutMs);

    child.on('error', (cause) => {
      clearTimeout(timer);
      rejectPromise(
        new AudioProcessingError(
          `ffmpeg could not be started as "${binary}" — is it installed on this host?`,
          { cause },
        ),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new AudioProcessingError(
            `ffmpeg exited with ${code}${stderr ? `: ${stderr.trim().slice(0, 400)}` : ''}`,
          ),
        );
      }
    });
  });
}

/** Put the rendition behind the signed grant. The content type is the one the grant was signed for. */
async function upload(url: string, fromPath: string, contentType: string): Promise<void> {
  const body = await readFile(fromPath);
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  });
  if (!response.ok) {
    throw new AudioProcessingError(`the rendition could not be stored (HTTP ${response.status})`);
  }
}
