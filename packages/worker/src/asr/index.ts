import { readAsrProvider, type AsrProviderName, type EnvSource } from './env';
import { deepgramTranscriber } from './deepgram';
import { fakeTranscriberFromEnv } from './fake';
import type { Transcriber } from './transcriber';

export {
  ASR_PROVIDERS,
  ASR_VARIABLES,
  readAsrApiKey,
  readAsrProvider,
  readFakeScriptPath,
  type AsrProviderName,
  type EnvSource,
} from './env';
export {
  TranscriptionError,
  type TranscribedSegment,
  type Transcriber,
  type TranscriptionRequest,
  type TranscriptionResult,
  type TranscriptionSpend,
} from './transcriber';
export {
  fakeTranscriber,
  type FakeScript,
  type FakeScriptSegment,
  type FakeTranscriber,
} from './fake';

/**
 * The transcriber this process is configured with, built once and cached.
 *
 * Cached for the reason the media store and the mailer are: building it per job would read the
 * environment and construct a client per job. Lazy for a sharper one — a worker whose
 * `generate_draft` job is all it has to do must not fail at import time because no ASR key is set.
 */
export function buildTranscriber(env: EnvSource = process.env): Transcriber {
  const provider: AsrProviderName = readAsrProvider(env);
  switch (provider) {
    case 'deepgram':
      return deepgramTranscriber({ env });
    case 'fake':
      return fakeTranscriberFromEnv(env);
  }
}

let cached: Transcriber | undefined;

export function transcriber(): Transcriber {
  cached ??= buildTranscriber();
  return cached;
}
