import { readEmbedProvider, type EmbedProviderName, type EnvSource } from './env';
import { fakeEmbedder } from './fake';
import { openAiEmbedder } from './openai';
import type { Embedder } from './embedder';

/**
 * **The embedding port as a package** — `@thp/embed`, beside `@thp/bible` and `@thp/media` and
 * for the same reason those two are packages rather than folders inside one process: the worker
 * embeds every source when a teaching changes, and the API embeds the *query* when a member
 * searches ([3.10.2](docs/project/prd.md)); neither process may import the other (the import
 * boundary guard), so the one adapter both call has to sit between them.
 *
 * **This is a copy of `packages/worker/src/embed`, file for file, and the copy is deliberate.**
 * The search ticket that created this package was not allowed to touch the worker's embed step or
 * its adapter, so the worker keeps its own copy for now. The intended end state is one package:
 * the worker's `embed/index.ts` becomes `export * from '@thp/embed'` and its four sibling files
 * go, which is a one-line change in the worker and nothing here. Until then
 * `packages/web/tests/unit/embed-package.test.ts` holds the two copies to each other — the fake's
 * vector for a text, the real adapter's model and endpoint — so a stored vector and a query vector
 * can never be computed by two functions that have quietly drifted apart. A query embedded by a
 * different function from the one that embedded the rows would rank nonsense, which is the one
 * failure a search cannot see in itself.
 */

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
