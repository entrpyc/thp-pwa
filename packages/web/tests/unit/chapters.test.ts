import { describe, expect, it } from 'vitest';
import {
  CHAPTER_SCOPE_PARAM,
  MAX_CHAPTER_MS,
  MIN_CHAPTERS,
  MIN_CHAPTER_MS,
  TARGET_CHAPTER_MS,
  chapterAt,
  chapterMergePath,
  chapterPagePath,
  chapterPath,
  chapterSplitPath,
  chaptersThatFit,
  filterChapters,
  isInChapter,
  isRecordingPagePath,
  recordingChaptersPath,
  recordingPagePath,
  scopedToChapter,
  type ChapterView,
} from '@thp/shared';

/**
 * **The chapter vocabulary, driven directly** ([3.22](docs/project/prd.md)).
 *
 * Three of this scope's requirements are arithmetic over offsets — which chapter is playing
 * (3.22.16), what a chapter contains (3.22.14) and what a search narrows to (3.22.11) — and each of
 * them is asserted through a browser somewhere else in the suite. That is the *right* place to
 * assert the behaviour and the wrong place to assert the rule: a half-open interval that was
 * accidentally closed at both ends would still look correct through a browser on every fixture
 * where nothing sits exactly on a boundary.
 *
 * So the boundaries themselves are asserted here, exactly on them, where a wrong answer is a
 * failing line rather than a screen that happens to look right.
 */

/** A tiling of a two-hour teaching, built the way the API derives one. */
function tiling(...starts: readonly number[]): ChapterView[] {
  return starts.map((startMs, index) => ({
    id: `chapter-${index + 1}`,
    position: index + 1,
    startMs,
    endMs: starts[index + 1] ?? startMs + TARGET_CHAPTER_MS,
    title: `Part ${index + 1}`,
    summary: `The ${index + 1}th part.`,
    editedByAdmin: false,
  }));
}

const MINUTE = 60_000;

describe('the length range chapters are cut to (3.22.4)', () => {
  it('is fifteen to twenty-five minutes, aiming at the middle', () => {
    expect(MIN_CHAPTER_MS).toBe(15 * MINUTE);
    expect(MAX_CHAPTER_MS).toBe(25 * MINUTE);
    expect(TARGET_CHAPTER_MS).toBeGreaterThan(MIN_CHAPTER_MS);
    expect(TARGET_CHAPTER_MS).toBeLessThan(MAX_CHAPTER_MS);
  });

  /**
   * The requirement's own sentence, as a number: "a recording too short to hold two of them gets
   * none". A teaching under two target lengths cannot fit two, and the fake generator and the
   * worker both read this one function rather than each deciding for themselves.
   */
  it('says how many chapters a teaching of a given length can hold', () => {
    expect(MIN_CHAPTERS).toBe(2);
    expect(chaptersThatFit(0)).toBe(0);
    expect(chaptersThatFit(12 * MINUTE)).toBe(0);
    expect(chaptersThatFit(TARGET_CHAPTER_MS)).toBe(1);
    expect(chaptersThatFit(2 * TARGET_CHAPTER_MS)).toBe(2);
    expect(chaptersThatFit(95 * MINUTE)).toBe(4);
  });

  it('answers nothing for a length that is not a length', () => {
    expect(chaptersThatFit(-1)).toBe(0);
    expect(chaptersThatFit(Number.NaN)).toBe(0);
    expect(chaptersThatFit(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('which chapter an offset falls in (3.22.2, 3.22.14, 3.22.16)', () => {
  const chapters = tiling(0, 20 * MINUTE, 45 * MINUTE);

  /**
   * **The half-open interval is the whole of "no gaps and no overlaps" as a predicate.** A moment
   * exactly on a boundary belongs to the chapter that *starts* there and to no other — so nothing
   * is in two chapters, and nothing between the first start and the last end is in none.
   */
  it('puts a moment exactly on a boundary in the chapter that starts there', () => {
    expect(chapterAt(chapters, 20 * MINUTE)?.position).toBe(2);
    expect(isInChapter(chapters[0] as ChapterView, 20 * MINUTE)).toBe(false);
    expect(isInChapter(chapters[1] as ChapterView, 20 * MINUTE)).toBe(true);
  });

  it('puts the moment one millisecond before a boundary in the chapter before it', () => {
    expect(chapterAt(chapters, 20 * MINUTE - 1)?.position).toBe(1);
  });

  it('puts every moment of the teaching in exactly one chapter', () => {
    const last = chapters[chapters.length - 1] as ChapterView;
    for (let at = 0; at < last.endMs; at += MINUTE) {
      const holding = chapters.filter((one) => isInChapter(one, at));
      expect(holding, `${at}ms is in ${holding.length} chapters`).toHaveLength(1);
    }
  });

  /**
   * `null` has two ordinary causes and neither is a failure: a teaching with no chapters, and a
   * moment before the first chapter's start on a teaching whose transcript begins after a silence.
   * Every surface draws nothing for both rather than guessing at the first chapter.
   */
  it('answers null before the first chapter and after the last', () => {
    const late = tiling(30 * MINUTE, 50 * MINUTE);
    expect(chapterAt(late, 0)).toBeNull();
    expect(chapterAt(chapters, (chapters[2] as ChapterView).endMs)).toBeNull();
    expect(chapterAt([], 0)).toBeNull();
  });
});

describe('the search over one teaching’s chapters (3.22.11)', () => {
  const chapters: ChapterView[] = [
    { ...(tiling(0)[0] as ChapterView), title: 'The vine and the branches', summary: 'Abiding.' },
    {
      ...(tiling(0)[0] as ChapterView),
      id: 'second',
      title: 'Bearing fruit',
      summary: 'What pruning is for.',
    },
  ];

  it('matches on the title', () => {
    expect(filterChapters(chapters, 'vine').map((one) => one.id)).toEqual(['chapter-1']);
  });

  it('matches on the summary as well as the title', () => {
    expect(filterChapters(chapters, 'pruning').map((one) => one.id)).toEqual(['second']);
  });

  it('ignores case, so a member typing quickly still finds it', () => {
    expect(filterChapters(chapters, 'VINE')).toHaveLength(1);
  });

  /** Clearing the field is the way back, rather than a state with its own control. */
  it('answers the whole list for a blank query', () => {
    expect(filterChapters(chapters, '')).toHaveLength(2);
    expect(filterChapters(chapters, '   ')).toHaveLength(2);
  });

  it('answers nothing when nothing matches', () => {
    expect(filterChapters(chapters, 'ezekiel')).toHaveLength(0);
  });
});

describe('the paths (3.22.10, 3.22.13, 3.22.14)', () => {
  it('reads a teaching’s chapters under the recording', () => {
    expect(recordingChaptersPath('r1')).toBe('/recordings/r1/chapters');
  });

  it('addresses a chapter on its own, because an admin acts on the chapter', () => {
    expect(chapterPath('c1')).toBe('/chapters/c1');
    expect(chapterSplitPath('c1')).toBe('/chapters/c1/split');
    expect(chapterMergePath('c1')).toBe('/chapters/c1/merge');
  });

  /**
   * A chapter's address is the teaching's with something added, which is what a chapter is — and
   * what lets the player recognise both as routes that open a teaching.
   */
  it('puts a chapter’s page under the teaching it divides', () => {
    expect(chapterPagePath('r1', 'c1')).toBe(`${recordingPagePath('r1')}/chapters/c1`);
  });

  it('scopes a read by chapter id, never by a pair of offsets', () => {
    expect(scopedToChapter('/recordings/r1/notes', 'c1')).toBe(
      `/recordings/r1/notes?${CHAPTER_SCOPE_PARAM}=c1`,
    );
    // A path that already carries a query keeps it — the surface parameter and the scope are
    // different questions and both may be asked at once.
    expect(scopedToChapter('/recordings/r1?surface=library', 'c1')).toBe(
      `/recordings/r1?surface=library&${CHAPTER_SCOPE_PARAM}=c1`,
    );
  });
});

/**
 * **A chapter page opens a teaching of its own** ([3.22.13](docs/project/prd.md)).
 *
 * The player skips restoring the last sitting on any route that answers `true` here. A chapter page
 * that answered `false` would spend a grant and a notes fetch on the previous sitting and name it on
 * the bar for the seconds before this page replaced it.
 */
describe('which routes open a teaching (3.22.13)', () => {
  it('counts a chapter’s page as one', () => {
    expect(isRecordingPagePath(chapterPagePath('r1', 'c1'))).toBe(true);
  });

  it('still counts a teaching’s own page as one, and the library as not', () => {
    expect(isRecordingPagePath(recordingPagePath('r1'))).toBe(true);
    expect(isRecordingPagePath('/recordings')).toBe(false);
    expect(isRecordingPagePath('/')).toBe(false);
  });

  /** Not a general "under a teaching": a later route that does not open one must not become one. */
  it('does not count some other route under a teaching', () => {
    expect(isRecordingPagePath('/recordings/r1/mindmap')).toBe(false);
    expect(isRecordingPagePath('/recordings/r1/chapters')).toBe(false);
    expect(isRecordingPagePath('/recordings/r1/chapters/c1/notes')).toBe(false);
  });
});
