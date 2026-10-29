import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@thp/shared';
import { checkSourceObject } from '../../src/source-object';

/**
 * **The original is checked again before the worker reads it** (security audit 2026-10-28,
 * finding 9). Finalise checked the size once; the presigned PUT that put the object there is
 * still live for an hour and binds only the content type, so what is at the key when a step runs
 * is not necessarily what was finalised.
 */
describe('checking the original before reading it', () => {
  it('lets an object at or under the upload ceiling through', () => {
    expect(() => checkSourceObject('originals/a.mp3', { size: 1, contentType: 'audio/mpeg' })).not.toThrow();
    expect(() =>
      checkSourceObject('originals/a.mp3', { size: MAX_UPLOAD_BYTES, contentType: 'audio/mpeg' }),
    ).not.toThrow();
  });

  it('refuses an object over the ceiling, naming the key and the limit', () => {
    expect(() =>
      checkSourceObject('originals/a.mp3', { size: MAX_UPLOAD_BYTES + 1, contentType: 'audio/mpeg' }),
    ).toThrow(/originals\/a\.mp3.*over the 200 MB upload limit.*replaced after the upload was finalised/);
  });
});
