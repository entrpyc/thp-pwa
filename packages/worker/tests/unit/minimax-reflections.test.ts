import { describe, expect, it } from 'vitest';
import { MAX_FLOW_QUESTION_LENGTH } from '@thp/shared';
import {
  GenerationError,
  REFLECTION_PROMPT_VERSION,
  REFLECTION_TOOL_NAME,
  buildReflectionUserPrompt,
  fakeGenerator,
  fakeReflectionFor,
} from '../../src/generate';
import { buildReflectionRequestBody, mapReflectionResponse } from '../../src/generate/minimax';

/**
 * **The reflection call, without a network** ([3.14.4](docs/project/prd.md)): what the adapter
 * asks for, and how it reads the answer back. The handler's rules — which subjects came back
 * missing — are the integration suite's; this file is about the adapter alone.
 */

const REQUEST = {
  title: 'Walking in Grace',
  subjects: [
    { key: 'a', title: 'Forgiving first', summary: 'Why forgiveness comes before being asked.' },
    { key: 'b', title: 'Who God says you are', summary: 'Identity before activity.' },
  ],
};

function response(input: unknown, usage = { input_tokens: 120, output_tokens: 40 }): string {
  return JSON.stringify({
    id: 'req-1',
    model: 'MiniMax-M3',
    content: [{ type: 'tool_use', name: REFLECTION_TOOL_NAME, input }],
    usage,
  });
}

describe('the request the adapter builds', () => {
  it('sends the titles and summaries under their keys, and never a transcript', () => {
    const body = buildReflectionRequestBody(REQUEST);
    const prompt = (body['messages'] as { content: string }[])[0]?.content ?? '';
    expect(prompt).toContain('Key: a');
    expect(prompt).toContain('Forgiving first');
    expect(prompt).toContain('Identity before activity.');
    expect(prompt).not.toContain('Transcript');
    expect(buildReflectionUserPrompt(REQUEST)).toBe(prompt);
  });

  it('forces the reflection tool rather than hoping for it, and tells the model the ceiling', () => {
    const body = buildReflectionRequestBody(REQUEST);
    expect(body['tool_choice']).toEqual({ type: 'tool', name: REFLECTION_TOOL_NAME });
    expect(String(body['system'])).toContain(String(MAX_FLOW_QUESTION_LENGTH));
    // Not a recall question: the instruction says so in as many words.
    expect(String(body['system'])).toMatch(/never a test/i);
  });
});

describe('the response the adapter maps', () => {
  it('turns the tool call into one question per key, trimmed, with the spend beside it', () => {
    const mapped = mapReflectionResponse(
      response({
        reflections: [
          { key: 'a', question: '  Who did you forgive first this week?  ' },
          { key: 'b', question: 'Where did you act from who you are?' },
        ],
      }),
    );
    expect(mapped.reflections).toEqual([
      { key: 'a', question: 'Who did you forgive first this week?' },
      { key: 'b', question: 'Where did you act from who you are?' },
    ]);
    expect(mapped.promptVersion).toBe(REFLECTION_PROMPT_VERSION);
    expect(mapped.spend.inputTokens).toBe(120);
    expect(mapped.spend.outputTokens).toBe(40);
    expect(mapped.spend.requestId).toBe('req-1');
  });

  it('drops a blank question rather than recording one a member cannot be asked', () => {
    const mapped = mapReflectionResponse(
      response({ reflections: [{ key: 'a', question: '   ' }, { key: 'b', question: 'Fine.' }] }),
    );
    expect(mapped.reflections.map((one) => one.key)).toEqual(['b']);
  });

  it('fails a prose answer, naming the tool that was not called', () => {
    const prose = JSON.stringify({ content: [{ type: 'text', text: 'Here are some questions…' }] });
    expect(() => mapReflectionResponse(prose)).toThrow(GenerationError);
    expect(() => mapReflectionResponse(prose)).toThrow(REFLECTION_TOOL_NAME);
  });

  it('fails a question missing its key or its text, and a body that is not JSON', () => {
    expect(() => mapReflectionResponse(response({ reflections: [{ question: 'No key.' }] }))).toThrow(
      GenerationError,
    );
    expect(() => mapReflectionResponse(response({ reflections: 'not a list' }))).toThrow(GenerationError);
    expect(() => mapReflectionResponse('<html>')).toThrow(GenerationError);
  });
});

describe('the fake', () => {
  it('answers every key it is asked for, naming the subject in the question', async () => {
    const fake = fakeGenerator({ summary: 's', description: 'd' });
    const answer = await fake.writeReflections(REQUEST);
    expect(answer.reflections.map((one) => one.key)).toEqual(['a', 'b']);
    expect(answer.reflections[0]?.question).toBe(fakeReflectionFor('Forgiving first'));
    expect(answer.reflections[0]?.question).toContain('Forgiving first');
    expect(fake.reflectionRequests).toHaveLength(1);
    expect(answer.spend.costUsd).toBe(0);
  });
});
