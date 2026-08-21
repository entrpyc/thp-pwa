import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTranscriber } from '../../src/asr';

/**
 * Which transcriber a given configuration produces.
 *
 * **The fake is a value of the same setting the real one is**, exactly as `MAIL_TRANSPORT=capture`
 * is — not a mock installed per test file. That is what makes "the suite never reaches a provider"
 * a property of how the process was configured, and what lets a developer drive the whole pipeline
 * end to end with no account and no spend.
 */

const SCRIPT = resolve(import.meta.dirname, '..', 'fixtures', 'teaching-script.json');

describe('buildTranscriber', () => {
  it('builds the fake when the environment names it, and reads its script off disk', async () => {
    const asr = buildTranscriber({ ASR_PROVIDER: 'fake', ASR_FAKE_SCRIPT: SCRIPT });
    expect(asr.name).toBe('fake');

    const result = await asr.transcribe({ audioUrl: 'https://example.test/a.mp3', language: 'en' });
    expect(result.language).toBe('en');
    expect(result.confidence).toBeCloseTo(0.94, 5);
    expect(result.segments).toHaveLength(5);
    expect(result.segments[0]?.startMs).toBe(0);
    // Nothing was spent, and the column says so rather than carrying a plausible number an operator
    // reading docs/project/prd.md §7's spend would have to know to discount.
    expect(result.spend.costUsd).toBe(0);
  });

  it('builds the real one when nothing says otherwise, given a key', () => {
    // Constructed, not called: what is under test is which adapter a deployment gets by default.
    expect(buildTranscriber({ ASR_API_KEY: 'a-key' }).name).toBe('deepgram');
  });

  it('refuses to build the real one without a key, naming the variable', () => {
    expect(() => buildTranscriber({ ASR_PROVIDER: 'deepgram' })).toThrowError(
      /ASR_API_KEY is not set/,
    );
  });

  it('refuses the fake without a script, naming the variable', () => {
    expect(() => buildTranscriber({ ASR_PROVIDER: 'fake' })).toThrowError(
      /ASR_FAKE_SCRIPT is not set/,
    );
  });

  it('says which file it could not read when the script is missing', () => {
    expect(() =>
      buildTranscriber({ ASR_PROVIDER: 'fake', ASR_FAKE_SCRIPT: 'nowhere/at/all.json' }),
    ).toThrowError(/nowhere[/\\]at[/\\]all\.json/);
  });
});
