import { describe, expect, it } from 'vitest';
import { MAX_STEERING_PROMPT_LENGTH, REVIEW_KINDS } from '@thp/shared';
import { readPayload } from '../../src/generate-draft';

/**
 * Reading `job.payload`, which was written by a route in **another process**.
 *
 * The column is `jsonb` and nothing about it is guaranteed, so every field is checked. The
 * interesting decision is what an unreadable payload means: it is read as **no payload** rather
 * than as a failure, because the honest fallback for "I could not tell which kinds were asked for"
 * is to generate all of them — which is what a chained job asks for anyway.
 */
describe('what a generate_draft job was asked for', () => {
  it('reads a chained job — no payload at all — as both kinds and no steer', () => {
    for (const nothing of [null, undefined, 'a string', 42, []]) {
      expect(readPayload(nothing)).toEqual({ kinds: [...REVIEW_KINDS], prompt: null });
    }
  });

  it('reads a single-kind regeneration as that kind alone', () => {
    expect(readPayload({ kinds: ['summary'] })).toEqual({ kinds: ['summary'], prompt: null });
  });

  it('carries the steering sentence, trimmed', () => {
    expect(readPayload({ kinds: ['summary'], prompt: '  Say more about the second half.  ' })).toEqual(
      { kinds: ['summary'], prompt: 'Say more about the second half.' },
    );
  });

  it('caps a sentence somebody sent as an essay', () => {
    const enormous = 'x'.repeat(MAX_STEERING_PROMPT_LENGTH * 3);
    expect(readPayload({ prompt: enormous }).prompt).toHaveLength(MAX_STEERING_PROMPT_LENGTH);
  });

  it('ignores a kind nobody has an artefact for, and falls back rather than failing', () => {
    // A payload naming only nonsense leaves nothing to generate, and generating nothing would be a
    // job that succeeded having done no work — which reads on the panel as a draft that exists.
    expect(readPayload({ kinds: ['a_kind_we_do_not_have'] }).kinds).toEqual([...REVIEW_KINDS]);
    expect(readPayload({ kinds: ['summary', 'a_kind_we_do_not_have'] }).kinds).toEqual(['summary']);
  });

  it('treats an empty steering sentence as none, so a blank field is not an instruction', () => {
    expect(readPayload({ prompt: '   ' }).prompt).toBeNull();
    expect(readPayload({ prompt: 42 }).prompt).toBeNull();
  });
});
