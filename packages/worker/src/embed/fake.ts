import { EMBEDDING_DIMENSIONS } from '@thp/shared';
import { EmbeddingError, type Embedder, type EmbeddingResult } from './embedder';

/**
 * An embedder that derives every vector from the text it is given.
 *
 * **Configuration, not a mock.** `EMBED_PROVIDER=fake` is a value of the same setting `openai` is,
 * exactly as `ASR_PROVIDER=fake` and `GENERATE_PROVIDER=fake` are — so "the suite never reaches a
 * provider" is a property of how the process was configured rather than of a stub somebody
 * remembered to install in each file. It is also what lets a developer run the whole pipeline end
 * to end with no account and no spend.
 *
 * **Deterministic, and sensitive to the words.** The same text always answers the same vector and
 * two different texts answer different ones, which is the whole of what the tests need: a row
 * re-embedded after a correction ([3.5.5](docs/project/prd.md)) demonstrably changed, and a row
 * for unchanged text demonstrably did not. The vectors are unit length, as a real model's are, so
 * a cosine distance over them is a number in the range a real one would produce — but **nothing
 * about them is semantic**: two sentences that mean the same thing are no closer than two that do
 * not, and a test that asserted otherwise would be asserting about a random number generator.
 *
 * No script and no fixture, unlike the other two fakes: what a transcript or a draft *says* is a
 * choice a test wants to make, whereas the right vector for a text is a function of the text, and
 * a fixture would only be a second place to hold that function wrong.
 */

export const FAKE_EMBED_MODEL = 'fake-embed-1';

/** What the fake was asked to embed, in order. Read by tests asserting what reached it. */
export interface FakeEmbedderCalls {
  readonly calls: readonly (readonly string[])[];
}

export interface FakeEmbedder extends Embedder, FakeEmbedderCalls {}

export function fakeEmbedder(): FakeEmbedder {
  const calls: (readonly string[])[] = [];

  return {
    name: 'fake',
    model: FAKE_EMBED_MODEL,
    calls,

    async embed(texts: readonly string[]): Promise<EmbeddingResult> {
      if (texts.length === 0) {
        throw new EmbeddingError('The fake embedder was asked to embed nothing.');
      }
      calls.push([...texts]);
      return {
        vectors: texts.map(fakeVector),
        spend: {
          model: FAKE_EMBED_MODEL,
          inputTokens: 0,
          // Nothing was spent, and the column says so rather than carrying a plausible number an
          // operator reading docs/project/prd.md §7's spend would have to know to discount.
          costUsd: 0,
          requestId: `fake-embed-${calls.length}`,
        },
      };
    },
  };
}

/**
 * The vector for one text: a pseudo-random unit vector seeded by a hash of the words.
 *
 * Two independent 32-bit hashes seed a 128-bit xorshift state, so two texts collide only if both
 * hashes do — which keeps "different text, different vector" true across any fixture a test will
 * write, without pretending to be cryptographic.
 */
export function fakeVector(text: string): number[] {
  const state = new Uint32Array([
    fnv1a(text) || 0x9e3779b9,
    djb2(text) || 0x85ebca6b,
    0xc2b2ae35,
    0x27d4eb2f,
  ]);

  const raw = new Array<number>(EMBEDDING_DIMENSIONS);
  let norm = 0;
  for (let index = 0; index < EMBEDDING_DIMENSIONS; index += 1) {
    const value = xorshift128(state) / 0xffffffff - 0.5;
    raw[index] = value;
    norm += value * value;
  }
  const scale = 1 / Math.sqrt(norm);
  return raw.map((value) => value * scale);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function djb2(text: string): number {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 33) + text.charCodeAt(index)) >>> 0;
  }
  return hash >>> 0;
}

function xorshift128(state: Uint32Array): number {
  let t = state[3] as number;
  const s = state[0] as number;
  state[3] = state[2] as number;
  state[2] = state[1] as number;
  state[1] = s;
  t ^= t << 11;
  t ^= t >>> 8;
  state[0] = (t ^ s ^ (s >>> 19)) >>> 0;
  return state[0];
}
