import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEEPGRAM_KEYTERMS,
  DEEPGRAM_MODEL,
  DEEPGRAM_USD_PER_MINUTE,
  costOf,
  deepgramTranscriber,
  mapDeepgramResponse,
  type HttpTransport,
} from '../../src/asr/deepgram';
import { TranscriptionError } from '../../src/asr';

/**
 * The Deepgram adapter, driven against a stubbed transport.
 *
 * Two things are under test and they are separable, so they are separated. **What the adapter
 * asks for** — the model, the language, the seam that is deliberately empty — and **what it makes
 * of the answer**, which is the part most likely to change under us and is therefore checked
 * against a captured response fixture rather than against a shape typed out beside the assertion.
 *
 * Nothing here reaches a network. The transport is a parameter for exactly that reason.
 */

const FIXTURE = readFileSync(
  resolve(import.meta.dirname, '..', 'fixtures', 'deepgram-response.json'),
  'utf8',
);

/** A transport that records what it was asked and answers with what it was given. */
function stub(answer: { status?: number; body?: string; throws?: Error } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    if (answer.throws) throw answer.throws;
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => answer.body ?? FIXTURE,
    };
  };
  return { calls, transport };
}

const AUDIO_URL = 'https://store.example.test/originals/a.mp3?X-Amz-Signature=abc';

describe('what the adapter asks the provider for', () => {
  it('names the pinned model and the requested language, explicitly', async () => {
    const { calls, transport } = stub();
    await deepgramTranscriber({ apiKey: 'a-key', transport }).transcribe({
      audioUrl: AUDIO_URL,
      language: 'en',
    });

    const query = new URL(calls[0]?.url ?? '').searchParams;
    // Pinned rather than detected: docs/project/prd.md 3.5.7's language is what was *asked for*, and
    // the monolingual model is both the more accurate one and the one the cost table is built on.
    expect(query.get('language')).toBe('en');
    expect(query.get('model')).toBe(DEEPGRAM_MODEL);
    expect(DEEPGRAM_MODEL).toBe('nova-3');
    // Without smart formatting the response carries words and nothing to group them into sentences.
    expect(query.get('smart_format')).toBe('true');
  });

  it('carries the language it is given rather than one written into the adapter', async () => {
    // The language is a parameter of the port, which is what makes a second language later an
    // adapter change instead of a migration. Nothing in this epic calls it with anything but `en`.
    const { calls, transport } = stub();
    await deepgramTranscriber({ apiKey: 'a-key', transport }).transcribe({
      audioUrl: AUDIO_URL,
      language: 'bg',
    });
    expect(new URL(calls[0]?.url ?? '').searchParams.get('language')).toBe('bg');
  });

  it('leaves the keyterm seam open and empty', () => {
    // docs/project/prd.md §7's ministry-vocabulary risk gets keyterms as its mitigation, and they
    // stay empty because a term list is curated through a screen that does not exist. The seam is
    // here so filling it is a scope decision rather than a change of approach.
    expect([...DEEPGRAM_KEYTERMS]).toEqual([]);
  });

  it('sends the location and never the bytes', async () => {
    const { calls, transport } = stub();
    await deepgramTranscriber({ apiKey: 'a-key', transport }).transcribe({
      audioUrl: AUDIO_URL,
      language: 'en',
    });

    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ url: AUDIO_URL });
    expect(calls[0]?.headers['authorization']).toBe('Token a-key');
  });
});

describe('what the adapter makes of the answer', () => {
  it('maps a captured response into segments, a language and a confidence', async () => {
    const result = mapDeepgramResponse(FIXTURE, 'en');

    expect(result.language).toBe('en');
    expect(result.confidence).toBeCloseTo(0.98817, 5);
    // Sentences, not words and not paragraphs — and offsets in whole milliseconds, because a seek
    // lands on an integer or it lands on whatever the last rounding chose.
    expect(result.segments).toEqual([
      {
        startMs: 80,
        endMs: 4123,
        text: "Good morning, and welcome to this morning's teaching.",
      },
      {
        startMs: 4123,
        endMs: 9880,
        text: 'We are picking up where we left off last week, in the second chapter.',
      },
      {
        startMs: 10_400,
        endMs: 15_340,
        text: 'Before we read, I want to say a word about why this passage matters.',
      },
    ]);
  });

  it('reads the model, its version, the billed duration and the cost off the metadata', async () => {
    const { spend } = mapDeepgramResponse(FIXTURE, 'en');

    expect(spend.model).toBe('general-nova-3');
    expect(spend.modelVersion).toBe('2025-01-09.29447');
    expect(spend.durationSeconds).toBe(27.6);
    expect(spend.costUsd).toBeCloseTo((27.6 / 60) * DEEPGRAM_USD_PER_MINUTE, 8);
    expect(spend.requestId).toBe('0b6b0b7a-6d5a-4a1e-9f5f-1f4a6c2b8e11');
  });

  it('prices a job at the published monolingual rate', () => {
    // $0.0043/min = $0.258/hr, which is where docs/project/architecture.md § Estimated running
    // costs' ~$0.26/hr came from. A 90-minute teaching is ~$0.39.
    expect(DEEPGRAM_USD_PER_MINUTE).toBe(0.0043);
    expect(costOf(3600)).toBeCloseTo(0.258, 6);
    expect(costOf(90 * 60)).toBeCloseTo(0.387, 6);
    expect(costOf(0)).toBe(0);
  });

  it('nothing downstream sees the provider shape', () => {
    const result = mapDeepgramResponse(FIXTURE, 'en');
    // Channels, alternatives and words are the provider's vocabulary and stop at this file.
    expect(Object.keys(result).sort()).toEqual(['confidence', 'language', 'segments', 'spend']);
    for (const segment of result.segments) {
      expect(Object.keys(segment).sort()).toEqual(['endMs', 'startMs', 'text']);
    }
  });
});

describe('a call that does not come back with a transcript', () => {
  it('names the status and the provider words when the provider refuses', async () => {
    const { transport } = stub({ status: 415, body: 'unsupported media type' });

    await expect(
      deepgramTranscriber({ apiKey: 'a-key', transport }).transcribe({
        audioUrl: AUDIO_URL,
        language: 'en',
      }),
    ).rejects.toThrowError(/HTTP 415.*unsupported media type/s);
  });

  it('names the timeout when the provider never answers', async () => {
    // A transport that waits past the deadline, which is what the abort exists for: a worker
    // blocked forever would sit `running` until somebody restarted the process.
    const transport: HttpTransport = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });

    await expect(
      deepgramTranscriber({ apiKey: 'a-key', transport, timeoutMs: 20 }).transcribe({
        audioUrl: AUDIO_URL,
        language: 'en',
      }),
    ).rejects.toThrowError(/did not answer within/);
  });

  it('names the failure when the provider cannot be reached at all', async () => {
    const { transport } = stub({ throws: new Error('getaddrinfo ENOTFOUND') });

    await expect(
      deepgramTranscriber({ apiKey: 'a-key', transport }).transcribe({
        audioUrl: AUDIO_URL,
        language: 'en',
      }),
    ).rejects.toThrowError(/could not be reached: getaddrinfo ENOTFOUND/);
  });

  it('every one of them is the port error, so the handler has one thing to catch', async () => {
    const cases: HttpTransport[] = [
      stub({ status: 500, body: 'boom' }).transport,
      stub({ body: 'not json at all' }).transport,
      stub({ body: '{"results":{"channels":[]}}' }).transport,
    ];

    for (const transport of cases) {
      await expect(
        deepgramTranscriber({ apiKey: 'a-key', transport }).transcribe({
          audioUrl: AUDIO_URL,
          language: 'en',
        }),
      ).rejects.toBeInstanceOf(TranscriptionError);
    }
  });
});
