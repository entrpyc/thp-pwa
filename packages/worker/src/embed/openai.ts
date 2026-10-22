import { readEmbedApiKey, type EnvSource } from './env';
import {
  EmbeddingError,
  requireDimensions,
  type Embedder,
  type EmbeddingResult,
  type EmbeddingSpend,
} from './embedder';

/**
 * **The real embedder** — OpenAI's `text-embedding-3-small` over its embeddings endpoint, with
 * plain `fetch` and no SDK, for the reason the generation adapter has none: a dependency is a
 * second door into the provider, and tests/guards/generate-boundary.test.ts names this file as the
 * only one allowed to say the host's name.
 *
 * **Why this model.** It answers 1536 dimensions natively, which is project tdd 4.4's width with
 * no truncation step; it is multilingual, which a library of teachings not in English depends on;
 * and at $0.02 per million tokens a ninety-minute teaching costs a fraction of a cent, against the
 * under-a-dollar line in project tdd 8. The choice is configuration rather than architecture —
 * `EMBED_PROVIDER` names it, and the operator confirms it — but the dimension is not: a model of
 * another width is a different column.
 *
 * **Texts leave the system to this provider**, as transcripts already do to the generation one,
 * and private notes among them. Third-party egress was already the architecture's position; the
 * adapter sends the words and the words only — no ids, no member, no recording title.
 *
 * One request per batch. The endpoint takes a list and answers a list in the same order, with
 * `index` on each entry; the mapping sorts by it rather than trusting the order, so a provider
 * that answered out of order would still land each vector on its text.
 */

export const OPENAI_EMBEDDINGS_ENDPOINT = 'https://api.openai.com/v1/embeddings';

export const OPENAI_EMBED_MODEL = 'text-embedding-3-small';

/** Published list price, per million input tokens. There is no output side to an embedding. */
export const OPENAI_USD_PER_MILLION_INPUT = 0.02;

/** A batch is small text; a minute is generous, and a hung call should fail the job, not hold it. */
export const OPENAI_TIMEOUT_MS = 60 * 1000;

export type HttpTransport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface OpenAiOptions {
  readonly apiKey?: string;
  readonly transport?: HttpTransport;
  readonly timeoutMs?: number;
  readonly env?: EnvSource;
}

export function openAiEmbedder(options: OpenAiOptions = {}): Embedder {
  const { env = process.env, timeoutMs = OPENAI_TIMEOUT_MS } = options;
  const apiKey = options.apiKey ?? readEmbedApiKey(env);
  const transport = options.transport ?? (globalThis.fetch as unknown as HttpTransport);

  return {
    name: 'openai',
    model: OPENAI_EMBED_MODEL,

    async embed(texts: readonly string[]): Promise<EmbeddingResult> {
      if (texts.length === 0) {
        throw new EmbeddingError('The embedding provider was asked to embed nothing.');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let body: string;
      try {
        const response = await transport(OPENAI_EMBEDDINGS_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(buildRequestBody(texts)),
          signal: controller.signal,
        });

        if (!response.ok) {
          // The status, and the provider's own words, truncated — an operator reads this off the
          // failed job row and it has to say which end refused.
          const detail = (await response.text().catch(() => '')).slice(0, 400);
          throw new EmbeddingError(
            `The embedding provider refused the request with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          );
        }
        body = await response.text();
      } catch (cause) {
        if (cause instanceof EmbeddingError) throw cause;
        if (controller.signal.aborted) {
          throw new EmbeddingError(
            `The embedding provider did not answer within ${Math.round(timeoutMs / 1000)} seconds`,
            { cause },
          );
        }
        throw new EmbeddingError(
          `The embedding provider could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      } finally {
        clearTimeout(timer);
      }

      return mapResponse(body, texts.length);
    },
  };
}

export function buildRequestBody(texts: readonly string[]): Record<string, unknown> {
  return {
    model: OPENAI_EMBED_MODEL,
    input: [...texts],
    // Floats rather than the base64 default: a vector is written to a column, never shipped to a
    // browser, so there is nothing to save by packing it and one more decode to get wrong.
    encoding_format: 'float',
  };
}

interface OpenAiEmbeddingsResponse {
  readonly data?: readonly { readonly index?: number; readonly embedding?: unknown }[];
  readonly model?: string;
  readonly usage?: { readonly prompt_tokens?: number; readonly total_tokens?: number };
  readonly id?: string;
}

/**
 * The provider's answer to a list of vectors and one spend record.
 *
 * Fails on anything short of one well-formed vector per input: a missing entry would otherwise be
 * a text that silently never got a vector, which reads as "no search hit" forever rather than as
 * a job an operator can see and re-run.
 */
export function mapResponse(body: string, expected: number): EmbeddingResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new EmbeddingError('The embedding provider answered with something that is not JSON', {
      cause,
    });
  }

  const response = parsed as OpenAiEmbeddingsResponse;
  const entries = response.data;
  if (!Array.isArray(entries) || entries.length !== expected) {
    throw new EmbeddingError(
      `The embedding provider answered ${Array.isArray(entries) ? entries.length : 'no'} vectors for ${expected} inputs. Run this step again.`,
    );
  }

  const vectors: number[][] = new Array(expected);
  for (const entry of entries) {
    const index = entry.index;
    if (typeof index !== 'number' || index < 0 || index >= expected || vectors[index]) {
      throw new EmbeddingError(
        'The embedding provider answered with an entry that names no input, or names one twice.',
      );
    }
    const vector = entry.embedding;
    if (!Array.isArray(vector) || vector.some((value) => typeof value !== 'number')) {
      throw new EmbeddingError(
        `The embedding provider answered input ${index} with something that is not a list of numbers.`,
      );
    }
    requireDimensions(vector as number[], index);
    vectors[index] = vector as number[];
  }

  return { vectors, spend: spendOf(response) };
}

export function costOf(inputTokens: number): number {
  return (inputTokens / 1_000_000) * OPENAI_USD_PER_MILLION_INPUT;
}

function spendOf(response: OpenAiEmbeddingsResponse): EmbeddingSpend {
  const inputTokens = response.usage?.prompt_tokens ?? response.usage?.total_tokens ?? 0;
  return {
    model: response.model ?? OPENAI_EMBED_MODEL,
    inputTokens,
    costUsd: costOf(inputTokens),
    requestId: response.id ?? 'unknown',
  };
}
