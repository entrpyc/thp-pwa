import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '@thp/shared';
import {
  EMBED_VARIABLES,
  EmbeddingError,
  FAKE_EMBED_MODEL,
  buildEmbedder,
  fakeEmbedder,
  fakeVector,
} from '../../src/embed';

/**
 * The embedder factory and the fake it builds.
 *
 * What the fake has to be is small and exact: the width the column holds, the same vector for the
 * same words, a different vector for different words, unit length so a cosine over it is a number
 * in the real range, and a spend of nothing. Anything beyond that — meaning, nearness — it must
 * **not** be asserted to have, because it has none.
 */
describe('buildEmbedder', () => {
  it('builds the fake when the environment names it', async () => {
    const model = buildEmbedder({ EMBED_PROVIDER: 'fake' });
    expect(model.name).toBe('fake');
    expect(model.model).toBe(FAKE_EMBED_MODEL);

    const result = await model.embed(['Good morning.']);
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    // Nothing was spent, and the column says so rather than carrying a plausible number an operator
    // reading docs/project/prd.md §7's spend would have to know to discount.
    expect(result.spend.costUsd).toBe(0);
    expect(result.spend.inputTokens).toBe(0);
    expect(result.spend.model).toBe(FAKE_EMBED_MODEL);
  });

  it('builds the real one when nothing says otherwise, given a key', () => {
    // Constructed, not called: what is under test is which adapter a deployment gets by default.
    expect(buildEmbedder({ EMBED_API_KEY: 'a-key' }).name).toBe('openai');
  });

  it('refuses to build the real one without a key, naming the variable', () => {
    expect(() => buildEmbedder({ EMBED_PROVIDER: 'openai' })).toThrowError(/EMBED_API_KEY is not set/);
  });

  it('refuses a provider nobody has written an adapter for, listing the ones that exist', () => {
    expect(() => buildEmbedder({ EMBED_PROVIDER: 'a-model-we-do-not-have' })).toThrowError(
      /EMBED_PROVIDER is "a-model-we-do-not-have"\. It must be one of openai, fake/,
    );
  });

  it('is put on the fake by the one switch, whatever the block says', () => {
    expect(buildEmbedder({ EMBED_PROVIDER: 'openai', THP_MOCK_EXTERNAL: 'true' }).name).toBe('fake');
  });

  it('names every variable it reads, so .env.example can be checked against the list', () => {
    expect([...EMBED_VARIABLES]).toEqual(['EMBED_PROVIDER', 'EMBED_API_KEY']);
  });
});

describe('the fake embedder', () => {
  it('answers the same vector for the same words, every time', () => {
    const once = fakeVector('In the beginning was the Word.');
    const again = fakeVector('In the beginning was the Word.');
    expect(again).toEqual(once);
  });

  it('answers a different vector for different words — a corrected line demonstrably changed', () => {
    const before = fakeVector('A word about Epafras before we begin.');
    const after = fakeVector('A word about Epaphras before we begin.');
    expect(after).not.toEqual(before);
    // Not merely unequal somewhere: the vectors are genuinely different directions, not one
    // coordinate apart, so a cosine over them would say so.
    const dot = before.reduce((sum, value, index) => sum + value * (after[index] ?? 0), 0);
    expect(Math.abs(dot)).toBeLessThan(0.5);
  });

  it('is unit length, as a real model’s vectors are', () => {
    const vector = fakeVector('Turn with me to the second chapter.');
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(vector.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('keeps the order of the texts it was given, one vector each', async () => {
    const model = fakeEmbedder();
    const texts = ['first', 'second', 'third'];
    const result = await model.embed(texts);
    expect(result.vectors).toEqual(texts.map(fakeVector));
    expect(model.calls).toEqual([texts]);
  });

  it('refuses to embed nothing — a caller with no texts should not have reached a provider', async () => {
    await expect(fakeEmbedder().embed([])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('answers something for the empty string rather than a vector of NaN', () => {
    // The handler filters blank sources out, but a fake that produced NaN for one would make a
    // test that forgot to look like a pass.
    const vector = fakeVector('');
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vector.every((value) => Number.isFinite(value))).toBe(true);
  });
});
