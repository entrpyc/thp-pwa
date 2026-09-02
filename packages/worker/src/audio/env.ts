/**
 * Audio-processing configuration, read here and nowhere else — the discipline `asr/env.ts` applies
 * to the transcriber, applied to the transcoder, and for the same reason: a missing setting should
 * fail with one sentence naming the variable, not as a spawn error three frames deep.
 */

import { isExternalMocked } from '@thp/shared/mock';

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Which processor to build.
 *
 * - `ffmpeg` — the real one, shelling out to the binary named by `FFMPEG_PATH`. The only one a
 *   deployment should ever name.
 * - `fake` — copies the original to the rendition key unchanged. What the suite runs against: the
 *   pipeline's shape is exercised for real — a second object appears, the row repoints — without
 *   the machine needing a transcoder. The same shape as `ASR_PROVIDER=fake`.
 */
export const PROCESS_AUDIO_PROVIDERS = ['ffmpeg', 'fake'] as const;

export type ProcessAudioProviderName = (typeof PROCESS_AUDIO_PROVIDERS)[number];

/**
 * `THP_MOCK_EXTERNAL` is read first and **wins over an explicitly named provider** — see
 * `@thp/shared/mock` for why the switch can have no exceptions and still mean anything. ffmpeg is
 * a local binary rather than a paid call, but a machine with the switch on is a machine that asked
 * to run without external tooling, and a transcoder it does not have is exactly that.
 */
export function readProcessAudioProvider(env: EnvSource = process.env): ProcessAudioProviderName {
  if (isExternalMocked(env)) return 'fake';
  const configured = (env['PROCESS_AUDIO_PROVIDER'] ?? 'ffmpeg').trim().toLowerCase();
  if ((PROCESS_AUDIO_PROVIDERS as readonly string[]).includes(configured)) {
    return configured as ProcessAudioProviderName;
  }
  throw new Error(
    `PROCESS_AUDIO_PROVIDER is "${configured}". It must be one of ${PROCESS_AUDIO_PROVIDERS.join(', ')} — see .env.example.`,
  );
}

/** Every variable this module reads, named in one place so a reader can find the block. */
export const PROCESS_AUDIO_VARIABLES = ['PROCESS_AUDIO_PROVIDER', 'FFMPEG_PATH'] as const;

/** Where the ffmpeg binary lives. Defaulted to the PATH's, because that is where a host puts it. */
export function readFfmpegPath(env: EnvSource = process.env): string {
  const value = env['FFMPEG_PATH']?.trim();
  return value ? value : 'ffmpeg';
}
