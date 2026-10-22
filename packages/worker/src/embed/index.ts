import { readEmbedProvider, type EmbedProviderName, type EnvSource } from './env';
import { fakeEmbedder } from './fake';
import { openAiEmbedder } from './openai';
import type { Embedder } from './embedder';

export {
  EMBED_PROVIDERS,
  EMBED_VARIABLES,
  readEmbedApiKey,
  readEmbedProvider,
  type EmbedProviderName,
  type EnvSource,
} from './env';
export {
  EmbeddingError,
  requireDimensions,
  type Embedder,
  type EmbeddingResult,
  type EmbeddingSpend,
} from './embedder';
export { FAKE_EMBED_MODEL, fakeEmbedder, fakeVector, type FakeEmbedder } from './fake';

/**
 * The embedder this process is configured with, built once and cached.
 *
 * Cached for the reason the generator, the transcriber and the media store are: building it per
 * job would read the environment and construct a client per job. Lazy for a sharper one — a worker
 * whose only job is `transcribe` must not fail at import time because no embedding key is set.
 */
export function buildEmbedder(env: EnvSource = process.env): Embedder {
  const provider: EmbedProviderName = readEmbedProvider(env);
  switch (provider) {
    case 'openai':
      return openAiEmbedder({ env });
    case 'fake':
      return fakeEmbedder();
  }
}

let cached: Embedder | undefined;

export function embedder(): Embedder {
  cached ??= buildEmbedder();
  return cached;
}
