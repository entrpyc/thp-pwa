import { readGenerateProvider, type EnvSource, type GenerateProviderName } from './env';
import { fakeGeneratorFromEnv } from './fake';
import { miniMaxGenerator } from './minimax';
import type { Generator } from './generator';

export {
  GENERATE_PROVIDERS,
  GENERATE_VARIABLES,
  readGenerateApiKey,
  readGenerateFakeScriptPath,
  readGenerateProvider,
  type EnvSource,
  type GenerateProviderName,
} from './env';
export {
  GenerationError,
  type GeneratedDrafts,
  type GenerationRequest,
  type GenerationResult,
  type GenerationSpend,
  type Generator,
} from './generator';
export {
  fakeGenerator,
  type FakeDraftScript,
  type FakeGenerator,
} from './fake';
export {
  DRAFT_FIELD_INSTRUCTIONS,
  DRAFT_TOOL_NAME,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildToolSchema,
  buildUserPrompt,
} from './prompt';

/**
 * The generator this process is configured with, built once and cached.
 *
 * Cached for the reason the transcriber, the media store and the mailer are: building it per job
 * would read the environment and construct a client per job. Lazy for a sharper one — a worker
 * whose only job is `transcribe` must not fail at import time because no generation key is set.
 */
export function buildGenerator(env: EnvSource = process.env): Generator {
  const provider: GenerateProviderName = readGenerateProvider(env);
  switch (provider) {
    case 'minimax':
      return miniMaxGenerator({ env });
    case 'fake':
      return fakeGeneratorFromEnv(env);
  }
}

let cached: Generator | undefined;

export function generator(): Generator {
  cached ??= buildGenerator();
  return cached;
}
