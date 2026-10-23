import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as packaged from '@thp/embed';
import { OPENAI_EMBEDDINGS_ENDPOINT, OPENAI_EMBED_MODEL } from '@thp/embed/openai';
import * as workers from '../../../worker/src/embed';
import {
  OPENAI_EMBEDDINGS_ENDPOINT as WORKER_ENDPOINT,
  OPENAI_EMBED_MODEL as WORKER_MODEL,
} from '../../../worker/src/embed/openai';

/**
 * **`@thp/embed` is the worker's embed adapter, and stays it** — see the package's `index.ts`.
 *
 * The API embeds a search query with the package and the worker embeds every row with its own
 * copy, and a search ranks by the distance between the two. If the two functions drifted — a
 * different fake, a different model — stored vectors and query vectors would stop being
 * comparable and search would rank nonsense while every other test stayed green. So the copies
 * are held to each other here: the fake's vector for a text, the real adapter's model and host,
 * and the files themselves.
 *
 * This test is deleted the day the worker's `embed/index.ts` becomes a re-export of the package,
 * which is the one-line change the package was built for.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const FILES = ['embedder.ts', 'env.ts', 'fake.ts', 'openai.ts'] as const;

describe('the embed package and the worker’s adapter are one adapter', () => {
  it('derives the same vector from the same words', () => {
    for (const text of ['grace', 'Romans 8:28', 'the vine and the branches']) {
      expect(packaged.fakeVector(text)).toEqual(workers.fakeVector(text));
    }
    expect(packaged.FAKE_EMBED_MODEL).toBe(workers.FAKE_EMBED_MODEL);
  });

  it('names the same model at the same host', () => {
    expect(OPENAI_EMBED_MODEL).toBe(WORKER_MODEL);
    expect(OPENAI_EMBEDDINGS_ENDPOINT).toBe(WORKER_ENDPOINT);
  });

  it('is the same source, file for file', () => {
    for (const file of FILES) {
      const ours = readFileSync(resolve(REPO_ROOT, 'packages/embed/src', file), 'utf8');
      const theirs = readFileSync(resolve(REPO_ROOT, 'packages/worker/src/embed', file), 'utf8');
      expect(ours, file).toBe(theirs);
    }
  });
});
