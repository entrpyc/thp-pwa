import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '@thp/shared';
import { EmbeddingError } from '../../src/embed';
import {
  OPENAI_EMBEDDINGS_ENDPOINT,
  OPENAI_EMBED_MODEL,
  OPENAI_USD_PER_MILLION_INPUT,
  buildRequestBody,
  costOf,
  mapResponse,
  openAiEmbedder,
  type HttpTransport,
} from '../../src/embed/openai';

/**
 * The real embedding adapter, against built responses and a transport that reaches no network.
 *
 * Three things are under test, and they are the three most likely to change under us: the request
 * carries the texts and the model and asks for floats; the mapping lands each vector on its text
 * by `index` rather than by position and refuses a wrong width before the column would; and a
 * refusal or a hang becomes a sentence a job row can carry.
 */

function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, index) => (index + seed) / 10_000);
}

function responseFor(vectors: readonly number[][], order?: readonly number[]): string {
  const data = (order ?? vectors.map((_unused, index) => index)).map((index) => ({
    object: 'embedding',
    index,
    embedding: vectors[index],
  }));
  return JSON.stringify({
    object: 'list',
    data,
    model: OPENAI_EMBED_MODEL,
    usage: { prompt_tokens: 42, total_tokens: 42 },
    id: 'req-1',
  });
}

function transportOf(
  body: string,
  status = 200,
): { transport: HttpTransport; calls: { url: string; body: string; headers: Record<string, string> }[] } {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { transport, calls };
}

describe('the request', () => {
  it('carries every text, names the model and asks for floats', () => {
    const body = buildRequestBody(['one', 'two']);
    expect(body).toEqual({ model: OPENAI_EMBED_MODEL, input: ['one', 'two'], encoding_format: 'float' });
  });

  it('goes to the embeddings endpoint with the key as a bearer and nothing but the words', async () => {
    const { transport, calls } = transportOf(responseFor([vector(1), vector(2)]));
    const model = openAiEmbedder({ apiKey: 'a-key', transport });

    await model.embed(['one', 'two']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(OPENAI_EMBEDDINGS_ENDPOINT);
    expect(calls[0]?.headers['authorization']).toBe('Bearer a-key');
    // The words and nothing else leave the system: no id, no member, no title in the body.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(buildRequestBody(['one', 'two']));
  });
});

describe('the mapping', () => {
  it('lands each vector on its text by index, whatever order the provider answered in', () => {
    const first = vector(1);
    const second = vector(2);
    const result = mapResponse(responseFor([first, second], [1, 0]), 2);
    expect(result.vectors[0]).toEqual(first);
    expect(result.vectors[1]).toEqual(second);
  });

  it('records the model and the spend as the provider reported them', () => {
    const result = mapResponse(responseFor([vector(1)]), 1);
    expect(result.spend.model).toBe(OPENAI_EMBED_MODEL);
    expect(result.spend.inputTokens).toBe(42);
    expect(result.spend.requestId).toBe('req-1');
    expect(result.spend.costUsd).toBe(costOf(42));
  });

  it('prices input tokens at the published rate', () => {
    expect(costOf(1_000_000)).toBe(OPENAI_USD_PER_MILLION_INPUT);
    expect(costOf(16_000)).toBeCloseTo(0.00032, 10);
  });

  it('refuses a vector of the wrong width, naming both widths', () => {
    const short = vector(1).slice(0, 1024);
    expect(() => mapResponse(responseFor([short]), 1)).toThrowError(
      new RegExp(`1024 dimensions.*${EMBEDDING_DIMENSIONS}`),
    );
  });

  it('refuses an answer with fewer vectors than inputs — a text silently without a vector is a hit for nothing forever', () => {
    expect(() => mapResponse(responseFor([vector(1)]), 2)).toThrowError(/1 vectors for 2 inputs/);
  });

  it('refuses an entry that names an input twice', () => {
    const body = JSON.stringify({
      data: [
        { index: 0, embedding: vector(1) },
        { index: 0, embedding: vector(2) },
      ],
    });
    expect(() => mapResponse(body, 2)).toThrowError(/names no input, or names one twice/);
  });

  it('refuses something that is not JSON', () => {
    expect(() => mapResponse('<html>rate limited</html>', 1)).toThrowError(/not JSON/);
  });
});

describe('failure, as the job row reads it', () => {
  it('a refusal carries the status and the provider’s words', async () => {
    const { transport } = transportOf('{"error":{"message":"Incorrect API key"}}', 401);
    const model = openAiEmbedder({ apiKey: 'a-key', transport });
    await expect(model.embed(['one'])).rejects.toThrowError(/HTTP 401.*Incorrect API key/);
  });

  it('a hang becomes a timeout naming the seconds', async () => {
    const transport: HttpTransport = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const model = openAiEmbedder({ apiKey: 'a-key', transport, timeoutMs: 20 });
    await expect(model.embed(['one'])).rejects.toThrowError(/did not answer within 0 seconds/);
  });

  it('a transport error is an EmbeddingError, not a bare network error', async () => {
    const transport: HttpTransport = async () => {
      throw new Error('ECONNREFUSED');
    };
    const model = openAiEmbedder({ apiKey: 'a-key', transport });
    await expect(model.embed(['one'])).rejects.toBeInstanceOf(EmbeddingError);
    await expect(model.embed(['one'])).rejects.toThrowError(/could not be reached: ECONNREFUSED/);
  });

  it('refuses to embed nothing without reaching the transport', async () => {
    const { transport, calls } = transportOf(responseFor([]));
    const model = openAiEmbedder({ apiKey: 'a-key', transport });
    await expect(model.embed([])).rejects.toBeInstanceOf(EmbeddingError);
    expect(calls).toHaveLength(0);
  });
});
