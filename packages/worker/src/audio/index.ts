import { readProcessAudioProvider, type EnvSource, type ProcessAudioProviderName } from './env';
import { ffmpegProcessor } from './ffmpeg';
import { fakeProcessor } from './fake';
import type { AudioProcessor } from './processor';

export {
  PROCESS_AUDIO_PROVIDERS,
  PROCESS_AUDIO_VARIABLES,
  readFfmpegPath,
  readProcessAudioProvider,
  type EnvSource,
  type ProcessAudioProviderName,
} from './env';
export { FFMPEG_TIMEOUT_MS, PLAYBACK_BITRATE, ffmpegProcessor } from './ffmpeg';
export { fakeProcessor } from './fake';
export {
  AudioProcessingError,
  type AudioProcessRequest,
  type AudioProcessor,
  type ProcessedRendition,
} from './processor';

/**
 * The processor this process is configured with, built once and cached — the transcriber's
 * construction, applied to the transcoder, and lazy for the same reason: a worker with nothing but
 * drafts to run must not fail at import time over a binary it never spawns.
 */
export function buildAudioProcessor(env: EnvSource = process.env): AudioProcessor {
  const provider: ProcessAudioProviderName = readProcessAudioProvider(env);
  switch (provider) {
    case 'ffmpeg':
      return ffmpegProcessor({ env });
    case 'fake':
      return fakeProcessor();
  }
}

let cached: AudioProcessor | undefined;

export function audioProcessor(): AudioProcessor {
  cached ??= buildAudioProcessor();
  return cached;
}
