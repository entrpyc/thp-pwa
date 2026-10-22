/**
 * Embedding configuration, read here and nowhere else — the same discipline `generate/env.ts`
 * applies to the generation block and `asr/env.ts` to transcription. A missing setting should fail
 * with one sentence naming the variable, not as an authorisation error three frames deep inside a
 * provider call.
 *
 * **No vendor is compiled in**, and **no key has a default.** A default API key is not a thing; a
 * default *provider* is, and it is the real one, exactly as `GENERATE_PROVIDER` defaults to
 * `minimax`.
 */

import { isExternalMocked } from '@thp/shared/mock';

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Which embedder to build.
 *
 * - `openai` — the real one. The only one a deployment should ever name. `text-embedding-3-small`
 *   answers 1536 dimensions natively, which is project tdd 4.4's width with no truncation step.
 * - `fake` — derives a vector from the text itself, deterministically, and reaches no network.
 *   What the whole suite runs against, which is what makes "no test reaches a provider" a
 *   property of the configuration rather than of a mock somebody remembered to install. Unlike
 *   the ASR and generation fakes it reads no script: the right answer for a vector is a function
 *   of the words, and a fixture would only be a second place to keep that function wrong.
 */
export const EMBED_PROVIDERS = ['openai', 'fake'] as const;

export type EmbedProviderName = (typeof EMBED_PROVIDERS)[number];

/**
 * `THP_MOCK_EXTERNAL` is read first and **wins over an explicitly named provider** — see
 * `@thp/shared/mock` for why the switch can have no exceptions and still mean anything.
 */
export function readEmbedProvider(env: EnvSource = process.env): EmbedProviderName {
  if (isExternalMocked(env)) return 'fake';
  const configured = (env['EMBED_PROVIDER'] ?? 'openai').trim().toLowerCase();
  if ((EMBED_PROVIDERS as readonly string[]).includes(configured)) {
    return configured as EmbedProviderName;
  }
  throw new Error(
    `EMBED_PROVIDER is "${configured}". It must be one of ${EMBED_PROVIDERS.join(', ')} — see .env.example.`,
  );
}

/** Every variable this module reads, named in one place so a reader can find the block. */
export const EMBED_VARIABLES = ['EMBED_PROVIDER', 'EMBED_API_KEY'] as const;

/** The provider key. Required whenever the real adapter is in use, and never defaulted. */
export function readEmbedApiKey(env: EnvSource = process.env): string {
  const value = env['EMBED_API_KEY'];
  if (!value || value.trim() === '') {
    throw new Error('EMBED_API_KEY is not set, and EMBED_PROVIDER is "openai". See .env.example.');
  }
  return value.trim();
}
