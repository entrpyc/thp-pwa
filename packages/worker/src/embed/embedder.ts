import { EMBEDDING_DIMENSIONS } from '@thp/shared';

/**
 * **The embedding port** (project tdd 5.5's `embed`, beside `transcribe` and `generate`) — the
 * one shape every provider is bent to, and the only thing the `embed` step knows about any of
 * them.
 *
 * Deliberately narrow: texts in, vectors out, one spend record per call. No per-text options, no
 * chunking, no caching — a segment is a sentence or two and a summary a few hundred words, both
 * far inside any model's input ceiling, and the step compares stored text to current text before
 * it asks, which is the only cache this product needs.
 *
 * Every vector is **exactly {@link EMBEDDING_DIMENSIONS} wide.** The adapter checks before the
 * handler writes, so a model answering a different width fails the job naming the width rather
 * than failing an insert with a Postgres message about a column.
 */

export interface EmbeddingSpend {
  /** Which model produced the vectors — stored on every row, because two models' vectors do not compare. */
  readonly model: string;
  readonly inputTokens: number;
  readonly costUsd: number;
  /** The provider's id for the call, or the fake's counter. For the log and the job row. */
  readonly requestId: string;
}

export interface EmbeddingResult {
  /** One vector per input text, in the order the texts were given. */
  readonly vectors: readonly (readonly number[])[];
  readonly spend: EmbeddingSpend;
}

export interface Embedder {
  readonly name: string;
  /** The model this embedder writes under; the step reads it to tell a stale row from a current one. */
  readonly model: string;
  /**
   * Vectors for these texts, in order. An empty list is an error at the adapter rather than a
   * no-op: a caller with nothing to embed should not have reached a provider.
   */
  embed(texts: readonly string[]): Promise<EmbeddingResult>;
}

export class EmbeddingError extends Error {
  override readonly name = 'EmbeddingError';
}

/** Refuse a vector of the wrong width before it reaches the column that would refuse it less clearly. */
export function requireDimensions(vector: readonly number[], index: number): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new EmbeddingError(
      `The embedding provider answered ${vector.length} dimensions for input ${index}; the ` +
        `column holds ${EMBEDDING_DIMENSIONS}. The model is not the one this schema was built for.`,
    );
  }
}
