import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  SOUND_PROFILE_LOUDNESS_RANGE_LU,
  SOUND_PROFILE_TRUE_PEAK_DBTP,
  type SoundProfileSettings,
} from '@thp/shared';
import { readFfmpegPath, type EnvSource } from './env';
import {
  AudioProcessingError,
  type AudioExcerpt,
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
 *
 * **The sound profile is a filter chain** (project tdd 4.8), in this order:
 *
 * 1. `afftdn` — spectral noise reduction, tracking the noise floor as it goes, by the profile's
 *    decibels. Skipped at zero.
 * 2. Clarity — a high-pass at 80 Hz to take out handling rumble and room boom, a lift of the
 *    presence band around 3 kHz by the profile's decibels, and a gentle 2:1 compressor to bring
 *    quiet phrases up towards the loud ones. Skipped at zero, all three together.
 * 3. `loudnorm` — EBU R128 normalisation to the profile's integrated target, at a fixed true-peak
 *    ceiling and loudness range. **Two passes**: the first measures the input as it comes out of
 *    the stages above, the second normalises linearly using those measurements. Linear mode is
 *    what keeps the dynamics of speech intact; the single-pass mode is a dynamic normaliser that
 *    pumps on pauses, which is exactly what a teaching is full of.
 *
 * The order matters. Noise is measured and removed before anything lifts it; the compressor sees
 * the cleaned voice; and loudness is the last word, so what every recording shares is its level.
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
 * `loudnorm` resamples to 192 kHz internally and would hand the encoder that rate; 48 kHz is what
 * the encoder is for, and what the plain transcode produces anyway.
 */
export const OUTPUT_SAMPLE_RATE = '48000';

/**
 * Thirty minutes, the transcription timeout's reasoning re-used: an encode of a 90-minute file
 * takes a couple of minutes, and what the ceiling stops is a hung binary sitting `running` until
 * somebody restarts the process. Each pass gets the whole of it; a profile encode is two passes.
 */
export const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Below this many bytes nothing was encoded: an M4A this small is a header with no frames, which
 * is what an excerpt that starts after the recording ends produces. Named rather than inlined so
 * the failure reads as a rule and not a magic number.
 */
export const MIN_RENDITION_BYTES = 1024;

/** What the first `loudnorm` pass measured about the input, as the second pass wants it. */
export interface LoudnessMeasurement {
  readonly inputI: number;
  readonly inputTp: number;
  readonly inputLra: number;
  readonly inputThresh: number;
  readonly targetOffset: number;
}

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

        if (request.profile === null) {
          await run(
            binary,
            encodeArguments({ sourcePath, renditionPath, filterGraph: null, excerpt: request.excerpt }),
            timeoutMs,
          );
        } else {
          const measured = await run(
            binary,
            measureArguments({ sourcePath, profile: request.profile, excerpt: request.excerpt }),
            timeoutMs,
            'all',
          );
          const measurement = parseLoudnormMeasurement(measured);
          await run(
            binary,
            encodeArguments({
              sourcePath,
              renditionPath,
              filterGraph: buildFilterGraph(request.profile, measurement),
              excerpt: request.excerpt,
            }),
            timeoutMs,
          );
        }

        const { size } = await stat(renditionPath);
        if (size < MIN_RENDITION_BYTES) {
          throw new AudioProcessingError(
            request.excerpt
              ? 'nothing was encoded — the excerpt starts after the recording ends'
              : 'nothing was encoded — the original holds no audio ffmpeg could decode',
          );
        }

        await upload(request.uploadUrl, renditionPath, request.contentType);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * The `-af` argument for a profile.
 *
 * With a measurement, the `loudnorm` stage runs in **linear** mode against it — the second pass.
 * Without one, `loudnorm` prints what it measured as JSON and the audio goes nowhere — the first.
 * The stages before `loudnorm` are identical in both, which is the whole point of measuring: the
 * second pass has to see the same signal the first one did.
 */
export function buildFilterGraph(
  profile: SoundProfileSettings,
  measurement: LoudnessMeasurement | null,
): string {
  const stages: string[] = [];

  if (profile.noiseReductionDb > 0) {
    // `tn=1` tracks the noise floor rather than assuming one, which is what a library recorded in
    // several rooms needs: the profile says how much to take out, the recording says from where.
    stages.push(`afftdn=nr=${profile.noiseReductionDb}:tn=1`);
  }

  if (profile.voiceClarityDb > 0) {
    stages.push('highpass=f=80');
    stages.push(`equalizer=f=3000:width_type=o:width=2:g=${profile.voiceClarityDb}`);
    // Threshold is an amplitude, 0.1 ≈ −20 dBFS. No makeup gain: level is `loudnorm`'s job.
    stages.push('acompressor=threshold=0.1:ratio=2:attack=5:release=100');
  }

  const target =
    `I=${profile.loudnessTargetLufs}:TP=${SOUND_PROFILE_TRUE_PEAK_DBTP}` +
    `:LRA=${SOUND_PROFILE_LOUDNESS_RANGE_LU}`;
  if (measurement === null) {
    stages.push(`loudnorm=${target}:print_format=json`);
  } else {
    stages.push(
      `loudnorm=${target}` +
        `:measured_I=${measurement.inputI}:measured_TP=${measurement.inputTp}` +
        `:measured_LRA=${measurement.inputLra}:measured_thresh=${measurement.inputThresh}` +
        `:offset=${measurement.targetOffset}:linear=true:print_format=summary`,
    );
  }

  return stages.join(',');
}

/**
 * The first pass: decode, filter, measure, discard. Stderr is where the measurement is printed,
 * at the `info` level, so this run cannot be quiet the way the encode is.
 */
export function measureArguments(input: {
  readonly sourcePath: string;
  readonly profile: SoundProfileSettings;
  readonly excerpt?: AudioExcerpt | undefined;
}): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'info',
    ...excerptArguments(input.excerpt),
    '-i',
    input.sourcePath,
    '-vn',
    '-af',
    buildFilterGraph(input.profile, null),
    '-f',
    'null',
    '-',
  ];
}

/** The encode — plain when `filterGraph` is `null`, the profile's second pass otherwise. */
export function encodeArguments(input: {
  readonly sourcePath: string;
  readonly renditionPath: string;
  readonly filterGraph: string | null;
  readonly excerpt?: AudioExcerpt | undefined;
}): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...excerptArguments(input.excerpt),
    '-i',
    input.sourcePath,
    // `-vn` drops the cover art some MP3s embed as a video stream; without it the copy into an
    // audio-only container fails on exactly the files a person exported from a phone app.
    '-vn',
    ...(input.filterGraph === null ? [] : ['-af', input.filterGraph]),
    '-ar',
    OUTPUT_SAMPLE_RATE,
    '-c:a',
    'aac',
    '-b:a',
    PLAYBACK_BITRATE,
    '-movflags',
    '+faststart',
    input.renditionPath,
  ];
}

/**
 * `-ss` and `-t` **before** `-i`: the input is seeked rather than decoded up to the start, which
 * on a 90-minute original is the difference between a preview in seconds and one in a minute.
 */
function excerptArguments(excerpt: AudioExcerpt | undefined): string[] {
  if (!excerpt) return [];
  return ['-ss', String(excerpt.startSeconds), '-t', String(excerpt.durationSeconds)];
}

/**
 * The measurement out of the first pass's stderr.
 *
 * `loudnorm` prints one JSON object; everything around it is the decoder talking. The object is
 * found by its keys rather than by position, so a build that prints a line more or less does not
 * move it. Values arrive as strings, and `-inf` is what an excerpt with no audio in it measures
 * — refused here in words rather than handed to the second pass as a number it cannot use.
 */
export function parseLoudnormMeasurement(stderr: string): LoudnessMeasurement {
  const match = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!match) {
    throw new AudioProcessingError(
      'ffmpeg measured nothing — the loudness pass printed no measurement',
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch (cause) {
    throw new AudioProcessingError('ffmpeg printed a measurement that could not be read', {
      cause,
    });
  }

  const read = (key: string): number => {
    const value = Number(parsed[key]);
    if (!Number.isFinite(value)) {
      throw new AudioProcessingError(
        `ffmpeg measured "${String(parsed[key])}" for ${key} — the excerpt holds no audio, or ` +
          'starts after the recording ends',
      );
    }
    return value;
  };

  return {
    inputI: read('input_i'),
    inputTp: read('input_tp'),
    inputLra: read('input_lra'),
    inputThresh: read('input_thresh'),
    targetOffset: read('target_offset'),
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

/**
 * Run the binary once and hand back what it wrote to stderr. A non-zero exit fails with the
 * tool's own last words, truncated; `all` keeps the whole of stderr, for the pass whose output
 * *is* the answer.
 */
function run(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  keep: 'tail' | 'all' = 'tail',
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = keep === 'all' ? stderr + chunk.toString() : (stderr + chunk.toString()).slice(-2000);
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
      if (code === 0) resolvePromise(stderr);
      else {
        rejectPromise(
          new AudioProcessingError(
            `ffmpeg exited with ${code}${stderr ? `: ${stderr.trim().slice(-400)}` : ''}`,
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
