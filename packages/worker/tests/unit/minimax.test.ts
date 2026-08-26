import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVIEW_KINDS } from '@thp/shared';
import { GenerationError, type GenerationRequest } from '../../src/generate';
import {
  MINIMAX_ENDPOINT,
  MINIMAX_MODEL,
  buildRequestBody,
  costOf,
  mapResponse,
  miniMaxGenerator,
  type HttpTransport,
} from '../../src/generate/minimax';
import { DRAFT_TOOL_NAME } from '../../src/generate/prompt';

/**
 * The generation adapter, against captured responses and a transport that reaches no network.
 *
 * Three things are under test and they are the three things most likely to change under us:
 *
 * 1. **One request carries the whole transcript**, with the tool forced and only the asked-for
 *    fields on it. That is the cost and consistency decision
 *    core-listening scope tdd § Key choices took, and it is only true if the
 *    request says so.
 * 2. **The mapping**, from the provider's content blocks to two strings and five numbers.
 * 3. **The prose answer fails.** Structured output here is a forced tool call rather than a schema
 *    parameter, and the failure that creates is named rather than defended against — a model that
 *    writes a paragraph instead fails the job, which reads on `/admin/pipeline` with its reason and
 *    is re-runnable from there.
 */

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, '..', 'fixtures', name), 'utf8');
}

const TOOL_CALL = fixture('minimax-tool-call.json');
const PROSE = fixture('minimax-prose.json');

/** A transcript long enough that "the whole of it" is a visible claim rather than a phrase. */
const TRANSCRIPT = Array.from(
  { length: 200 },
  (_, index) => `Sentence number ${index} of the teaching.`,
).join(' ');

const REQUEST: GenerationRequest = {
  title: 'The kindness of God',
  transcript: TRANSCRIPT,
  kinds: [...REVIEW_KINDS],
  steeringPrompt: null,
};

/** A transport that records what it was given and answers with a captured body. */
function transportOf(body: string, status = 200): {
  transport: HttpTransport;
  calls: { url: string; body: string }[];
} {
  const calls: { url: string; body: string }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { transport, calls };
}

describe('the request the adapter builds', () => {
  it('is one call carrying the whole transcript', () => {
    const body = buildRequestBody(REQUEST) as {
      model: string;
      messages: { role: string; content: string }[];
      system: string;
    };

    // One message, and the transcript in it end to end — not a window, not a chunk, not two calls.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.content).toContain('Sentence number 0 of the teaching.');
    expect(body.messages[0]?.content).toContain('Sentence number 199 of the teaching.');
    expect(body.messages[0]?.content).toContain(REQUEST.title);
    expect(body.model).toBe(MINIMAX_MODEL);
  });

  it('forces the tool rather than hoping for it', () => {
    const body = buildRequestBody(REQUEST) as {
      tools: { name: string; input_schema: { properties: Record<string, unknown>; required: string[] } }[];
      tool_choice: { type: string; name: string };
    };

    // Structured output by schema is not documented on either compatible surface; tool calling is,
    // and naming the tool is what makes the structured answer a requirement rather than a hope.
    expect(body.tool_choice).toEqual({ type: 'tool', name: DRAFT_TOOL_NAME });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]?.name).toBe(DRAFT_TOOL_NAME);
    expect(Object.keys(body.tools[0]?.input_schema.properties ?? {}).sort()).toEqual([
      'citations',
      'description',
      'summary',
    ]);
    expect(body.tools[0]?.input_schema.required.sort()).toEqual([
      'citations',
      'description',
      'summary',
    ]);
    // 1.3.1 — the list-shaped field is asked for as a list of structured entries, in the same one
    // call. The shape comes from the field's declaration, not from a branch naming scripture.
    const citations = body.tools[0]?.input_schema.properties['citations'] as {
      type: string;
      items: { type: string; properties: Record<string, unknown>; required: string[] };
    };
    expect(citations.type).toBe('array');
    expect(Object.keys(citations.items.properties).sort()).toEqual([
      'book',
      'chapter',
      'verseEnd',
      'verseStart',
    ]);
    expect(citations.items.required.sort()).toEqual(['book', 'chapter']);
  });

  it('asks only for the fields the kinds name, so a regeneration pays for one', () => {
    const body = buildRequestBody({ ...REQUEST, kinds: ['summary'] }) as {
      tools: { input_schema: { properties: Record<string, unknown> } }[];
    };
    expect(Object.keys(body.tools[0]?.input_schema.properties ?? {})).toEqual(['summary']);
  });

  it('carries the steering sentence, marked as the admin’s and after the standing instruction', () => {
    const steered = buildRequestBody({
      ...REQUEST,
      steeringPrompt: 'It missed the point about the second half.',
    }) as { messages: { content: string }[] };

    const content = steered.messages[0]?.content ?? '';
    expect(content).toContain('It missed the point about the second half.');
    // Last, and labelled: two instructions of equal weight that contradict each other is the shape
    // a steered regeneration must not take.
    expect(content.indexOf('The admin reviewing the previous draft')).toBeGreaterThan(
      content.indexOf('Write the following'),
    );
  });
});

describe('the response the adapter maps', () => {
  it('turns a tool call into one value per kind, and the spend beside it', () => {
    const result = mapResponse(TOOL_CALL, [...REVIEW_KINDS]);

    expect(result.drafts.summary).toContain('second chapter');
    expect(result.drafts.recording_metadata).toContain('close reading');
    // The list-shaped kind comes back as entries, unresolved — the book is still the words the
    // model wrote, because placing them in the canon is not a question about the response.
    expect(result.drafts.scripture).toEqual([
      { book: 'Romans', chapter: 8, verseStart: 1, verseEnd: 4 },
      { book: 'John', chapter: 3, verseStart: 16, verseEnd: 16 },
      { book: 'Psalm', chapter: 23 },
    ]);
    expect(result.spend.model).toBe('MiniMax-M3');
    expect(result.spend.modelVersion).toBe('MiniMax-M3');
    expect(result.spend.inputTokens).toBe(81_234);
    expect(result.spend.outputTokens).toBe(512);
    expect(result.spend.requestId).toBe('msg_a-known-request-id');
    expect(result.promptVersion).not.toBe('');
  });

  it('fails a prose answer, naming the tool that was not called', () => {
    // The failure mode the forced tool call creates, met head-on rather than salvaged: a summary
    // parsed out of free text would be a draft nobody could tell from a structured one.
    expect(() => mapResponse(PROSE, [...REVIEW_KINDS])).toThrowError(GenerationError);
    expect(() => mapResponse(PROSE, [...REVIEW_KINDS])).toThrowError(
      new RegExp(`without calling ${DRAFT_TOOL_NAME}`),
    );
  });

  it('fails a tool call missing a field it was asked for', () => {
    const half = JSON.stringify({
      id: 'msg_half',
      model: MINIMAX_MODEL,
      content: [{ type: 'tool_use', name: DRAFT_TOOL_NAME, input: { summary: 'Only one.' } }],
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    expect(() => mapResponse(half, [...REVIEW_KINDS])).toThrowError(/without a description/);
    // And the same body is fine when only that field was asked for.
    expect(mapResponse(half, ['summary']).drafts.summary).toBe('Only one.');
  });

  /**
   * 1.3.2 — **a list-shaped field required a list.** A model that wrote its citations out as a
   * sentence has not answered in the structure that was required, and storing that prose as though
   * it were citations is the one outcome worse than failing the step.
   */
  it('fails a list-shaped field answered as prose, or as a list of sentences', () => {
    const called = (citations: unknown) =>
      JSON.stringify({
        id: 'msg_shape',
        model: MINIMAX_MODEL,
        content: [
          {
            type: 'tool_use',
            name: DRAFT_TOOL_NAME,
            input: { summary: 'A summary.', description: 'A description.', citations },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      });

    expect(() => mapResponse(called('Romans 8:1-4 and John 3:16'), ['scripture'])).toThrowError(
      GenerationError,
    );
    expect(() => mapResponse(called(['Romans 8:1-4', 'John 3:16']), ['scripture'])).toThrowError(
      /other than a list of entries/,
    );
    expect(() => mapResponse(called(undefined), ['scripture'])).toThrowError(GenerationError);
  });

  it('accepts an empty list, because finding no scripture is an answer', () => {
    // 3.1.6: a teaching the machine finds no scripture in still produces a reviewable draft, so an
    // empty list must survive the adapter rather than being read as a missing field.
    const empty = JSON.stringify({
      id: 'msg_empty',
      model: MINIMAX_MODEL,
      content: [{ type: 'tool_use', name: DRAFT_TOOL_NAME, input: { citations: [] } }],
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    expect(mapResponse(empty, ['scripture']).drafts.scripture).toEqual([]);
  });

  it('fails a body that is not JSON at all', () => {
    expect(() => mapResponse('<html>gateway timeout</html>', ['summary'])).toThrowError(
      /not JSON/,
    );
  });

  it('prices the call from the token counts the provider reported', () => {
    // $0.30/M in and $1.20/M out: an ~80k-token transcript and ~1k of output is about $0.025, which
    // is the number project tdd 8.2 is being checked against.
    expect(costOf(81_234, 1_000)).toBeCloseTo(0.025_57, 5);
    expect(costOf(0, 0)).toBe(0);
    expect(mapResponse(TOOL_CALL, [...REVIEW_KINDS]).spend.costUsd).toBeCloseTo(0.025_0, 3);
  });
});

describe('the adapter end to end, without a network', () => {
  it('posts once, to the one endpoint, and answers with the draft', async () => {
    const { transport, calls } = transportOf(TOOL_CALL);
    const model = miniMaxGenerator({ apiKey: 'a-key', transport });

    const result = await model.generate(REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(MINIMAX_ENDPOINT);
    expect(calls[0]?.body).toContain('Sentence number 199 of the teaching.');
    expect(result.drafts.summary).toContain('second chapter');
    expect(model.name).toBe('minimax');
  });

  it('fails with the provider’s own words when it refuses', async () => {
    const { transport } = transportOf('rate limit exceeded', 429);
    const model = miniMaxGenerator({ apiKey: 'a-key', transport });

    await expect(model.generate(REQUEST)).rejects.toThrowError(/HTTP 429: rate limit exceeded/);
  });

  it('fails naming the timeout rather than hanging the worker forever', async () => {
    const model = miniMaxGenerator({
      apiKey: 'a-key',
      timeoutMs: 5,
      transport: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });

    // What this stops is a worker blocked forever on a provider that never answers, which would sit
    // `running` until somebody restarted the process.
    await expect(model.generate(REQUEST)).rejects.toThrowError(/did not answer within/);
  });
});
