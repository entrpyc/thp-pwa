import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVIEW_KINDS } from '@thp/shared';
import { buildGenerator, GENERATE_VARIABLES } from '../../src/generate';

/**
 * Which generator a given configuration produces.
 *
 * **The fake is a value of the same setting the real one is**, exactly as `ASR_PROVIDER=fake` and
 * `MAIL_TRANSPORT=capture` are — not a mock installed per test file. That is what makes "no test
 * reaches a provider" a property of how the process was configured rather than of something
 * somebody remembered to install, and what lets a developer drive the whole pipeline end to end
 * with no account and no spend.
 */

const SCRIPT = resolve(import.meta.dirname, '..', 'fixtures', 'draft-script.json');

describe('buildGenerator', () => {
  it('builds the fake when the environment names it, and reads its script off disk', async () => {
    const model = buildGenerator({ GENERATE_PROVIDER: 'fake', GENERATE_FAKE_SCRIPT: SCRIPT });
    expect(model.name).toBe('fake');

    const result = await model.generate({
      title: 'A teaching',
      lines: [{ startMs: 0, text: 'Good morning.' }],
      kinds: [...REVIEW_KINDS],
      steeringPrompt: null,
    });

    expect(result.drafts.summary).toContain('second chapter');
    expect(result.drafts.recording_metadata).toContain('second chapter');
    // Nothing was spent, and the column says so rather than carrying a plausible number an operator
    // reading docs/project/prd.md §7's spend would have to know to discount.
    expect(result.spend.costUsd).toBe(0);
    expect(result.promptVersion).not.toBe('');
  });

  it('answers only the kinds it was asked for', async () => {
    // What a steered regeneration needs: one kind in, one draft out, and nothing written for the
    // other. The fake honours this because the *request* carries the kinds — the real adapter
    // filters the tool schema by the same list.
    const model = buildGenerator({ GENERATE_PROVIDER: 'fake', GENERATE_FAKE_SCRIPT: SCRIPT });
    const result = await model.generate({
      title: 'A teaching',
      lines: [{ startMs: 0, text: 'Good morning.' }],
      kinds: ['summary'],
      steeringPrompt: null,
    });

    expect(Object.keys(result.drafts)).toEqual(['summary']);
  });

  it('carries the steering sentence into what it answers, so a second draft is a second draft', async () => {
    const model = buildGenerator({ GENERATE_PROVIDER: 'fake', GENERATE_FAKE_SCRIPT: SCRIPT });
    const result = await model.generate({
      title: 'A teaching',
      lines: [{ startMs: 0, text: 'Good morning.' }],
      kinds: ['summary'],
      steeringPrompt: 'Say more about the second half.',
    });

    expect(result.drafts.summary).toContain('Say more about the second half.');
  });

  it('builds the real one when nothing says otherwise, given a key', () => {
    // Constructed, not called: what is under test is which adapter a deployment gets by default.
    expect(buildGenerator({ GENERATE_API_KEY: 'a-key' }).name).toBe('minimax');
  });

  it('refuses to build the real one without a key, naming the variable', () => {
    expect(() => buildGenerator({ GENERATE_PROVIDER: 'minimax' })).toThrowError(
      /GENERATE_API_KEY is not set/,
    );
  });

  it('refuses the fake without a script, naming the variable', () => {
    expect(() => buildGenerator({ GENERATE_PROVIDER: 'fake' })).toThrowError(
      /GENERATE_FAKE_SCRIPT is not set/,
    );
  });

  it('says which file it could not read when the script is missing', () => {
    expect(() =>
      buildGenerator({ GENERATE_PROVIDER: 'fake', GENERATE_FAKE_SCRIPT: 'nowhere/at/all.json' }),
    ).toThrowError(/nowhere[/\\]at[/\\]all\.json/);
  });

  it('refuses a provider nobody has written an adapter for, listing the ones that exist', () => {
    expect(() => buildGenerator({ GENERATE_PROVIDER: 'a-model-we-do-not-have' })).toThrowError(
      /GENERATE_PROVIDER is "a-model-we-do-not-have"/,
    );
  });

  it('names every variable it reads in one place, so a reader can find the block', () => {
    expect([...GENERATE_VARIABLES]).toEqual([
      'GENERATE_PROVIDER',
      'GENERATE_API_KEY',
      'GENERATE_FAKE_SCRIPT',
    ]);
  });
});
