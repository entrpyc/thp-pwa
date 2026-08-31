import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_PAGE_PATH,
  MEMBER_LIBRARY_PAGE_PATH,
  MEMBER_SERIES_PAGE_PATH,
  NOW_PLAYING_PAGE_PATH,
  isRecordingPagePath,
  recordingPagePath,
} from '@thp/shared';

/**
 * **Which screen opens a teaching of its own.**
 *
 * The player restores the last sitting into the transport on every member screen *except* this one,
 * because this one is about to open a teaching itself — restoring here would be a second grant, a
 * second notes fetch and a bar naming the previous sitting until the page replaced it.
 *
 * So the predicate is the whole of that decision, and it is asserted against the *builders* rather
 * than against strings typed here: the two live beside each other so they cannot drift, and this is
 * what says so.
 */

describe('a teaching’s own page is the one screen that opens a teaching', () => {
  it('recognises what the builder builds', () => {
    expect(isRecordingPagePath(recordingPagePath('a3f1c2d4-0000-4000-8000-000000000001'))).toBe(
      true,
    );
  });

  it.each([
    ['the dashboard', DASHBOARD_PAGE_PATH],
    ['the library itself', MEMBER_LIBRARY_PAGE_PATH],
    ['the series listing', MEMBER_SERIES_PAGE_PATH],
    // The now-playing view has no teaching of its own — it draws whatever is loaded, so it is
    // precisely a screen the restore has to run on.
    ['the now-playing view', NOW_PLAYING_PAGE_PATH],
  ])('leaves %s alone', (_screen, path) => {
    expect(isRecordingPagePath(path)).toBe(false);
  });

  it.each([
    ['a trailing slash with nothing after it', `${MEMBER_LIBRARY_PAGE_PATH}/`],
    ['a deeper route under a teaching', `${MEMBER_LIBRARY_PAGE_PATH}/an-id/notes`],
    ['a path that merely starts the same way', '/recordings-archive/an-id'],
    ['a different collection', '/series/an-id'],
  ])('is not fooled by %s', (_case, path) => {
    expect(isRecordingPagePath(path)).toBe(false);
  });
});
