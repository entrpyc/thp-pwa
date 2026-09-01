import { describe, expect, it } from 'vitest';
import { MIN_CHAPTER_MS } from '@thp/shared';
import { settleChapters, snapToLine } from '../../src/chapters/boundaries';
import type { ProposedChapter, TranscriptLine } from '../../src/generate';

/**
 * **Where a chapter boundary may be** ([3.22.2](docs/project/prd.md),
 * [3.22.4](docs/project/prd.md), [3.22.5](docs/project/prd.md)).
 *
 * The rules are pure functions precisely so they can be driven here: every one of them is a claim
 * about arithmetic, and asserting arithmetic through a job ledger and a database means asserting it
 * expensively, on whatever fixture happened to be handy, and never at the boundary itself.
 *
 * The model in these tests is a *bad* one on purpose — out of order, off the line, repeating itself,
 * cutting too soon. That is the input the requirements are written against: 3.22.5 exists because a
 * boundary can land inside a sentence, and 3.22.4 exists because a proposal can be two minutes long.
 */

const MINUTE = 60_000;

/** A transcript whose lines start every ten seconds — close enough to catch an off-by-a-line. */
const LINES: readonly TranscriptLine[] = Array.from({ length: 360 }, (_unused, index) => ({
  startMs: index * 10_000,
  text: `Line ${index + 1}.`,
}));

function proposal(startMs: number, name = 'A part'): ProposedChapter {
  return { startMs, title: name, summary: `${name}, in one paragraph.` };
}

describe('snapping a proposal to a transcript line (3.22.5)', () => {
  /**
   * **Back, not forward.** A chapter that opens half a sentence in is what the requirement refuses;
   * moving forward instead would leave the tail of that sentence in the previous chapter, which is
   * the same defect facing the other way.
   */
  it('moves a boundary inside a line back to where that line began', () => {
    expect(snapToLine(LINES, 20_000)).toBe(20_000);
    expect(snapToLine(LINES, 20_001)).toBe(20_000);
    expect(snapToLine(LINES, 29_999)).toBe(20_000);
    expect(snapToLine(LINES, 30_000)).toBe(30_000);
  });

  it('answers nothing for a moment before the first line', () => {
    const late: TranscriptLine[] = [{ startMs: 5_000, text: 'After a silence.' }];
    expect(snapToLine(late, 0)).toBeNull();
    expect(snapToLine(late, 5_000)).toBe(5_000);
  });

  it('answers the last line for a moment past the end', () => {
    expect(snapToLine(LINES, 10 * 60 * MINUTE)).toBe(3_590_000);
  });
});

describe('settling a proposed list (3.22.2, 3.22.4, 3.22.5)', () => {
  it('snaps every boundary to a line and counts what it moved', () => {
    const settled = settleChapters(
      [proposal(0), proposal(20 * MINUTE + 3_500), proposal(45 * MINUTE)],
      LINES,
    );

    expect(settled.chapters.map((one) => one.startMs)).toEqual([0, 20 * MINUTE, 45 * MINUTE]);
    expect(settled.snapped).toBe(1);
    expect(LINES.some((line) => line.startMs === 20 * MINUTE)).toBe(true);
  });

  /** A model may answer out of order; that is untidiness rather than a reason to fail a pipeline. */
  it('puts an out-of-order answer in order', () => {
    const settled = settleChapters(
      [proposal(45 * MINUTE, 'Third'), proposal(0, 'First'), proposal(20 * MINUTE, 'Second')],
      LINES,
    );
    expect(settled.chapters.map((one) => one.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('drops a boundary that snaps onto one already taken, and counts it', () => {
    const settled = settleChapters(
      [proposal(0), proposal(20 * MINUTE), proposal(20 * MINUTE + 4_000), proposal(45 * MINUTE)],
      LINES,
    );
    expect(settled.chapters).toHaveLength(3);
    expect(settled.duplicates).toBe(1);
  });

  /**
   * **The first chapter begins at the beginning** ([3.22.2](docs/project/prd.md)) — otherwise the
   * opening of the teaching is in no chapter at all, which is the one hole the no-end design cannot
   * rule out on its own. Its text is kept: the model named the opening stretch and only mis-placed
   * where it starts.
   */
  it('moves the first boundary to the first line and keeps its words', () => {
    const settled = settleChapters(
      [proposal(3 * MINUTE, 'Opening'), proposal(25 * MINUTE, 'Second')],
      LINES,
    );
    expect(settled.chapters[0]?.startMs).toBe(0);
    expect(settled.chapters[0]?.title).toBe('Opening');
  });

  it('begins at the first line even when the transcript begins after a silence', () => {
    const late: TranscriptLine[] = [
      { startMs: 8_000, text: 'After a silence.' },
      { startMs: 20 * MINUTE, text: 'Later.' },
      { startMs: 40 * MINUTE, text: 'Later still.' },
    ];
    const settled = settleChapters([proposal(0), proposal(20 * MINUTE), proposal(40 * MINUTE)], late);
    expect(settled.chapters[0]?.startMs).toBe(8_000);
  });

  /**
   * **A chapter shorter than the floor is not one** ([3.22.4](docs/project/prd.md)). The repair is
   * to remove the boundary that would have created it, which lengthens the chapter *before* it —
   * rather than inventing a boundary nobody proposed.
   */
  it('drops a boundary that arrives less than fifteen minutes after the one before', () => {
    const settled = settleChapters(
      [proposal(0, 'First'), proposal(4 * MINUTE, 'Too soon'), proposal(30 * MINUTE, 'Third')],
      LINES,
    );

    expect(settled.chapters.map((one) => one.title)).toEqual(['First', 'Third']);
    expect(settled.tooSoon).toBe(1);
    expect(settled.chapters[1]!.startMs - settled.chapters[0]!.startMs).toBeGreaterThanOrEqual(
      MIN_CHAPTER_MS,
    );
  });

  it('keeps a boundary exactly at the floor', () => {
    const settled = settleChapters([proposal(0), proposal(MIN_CHAPTER_MS), proposal(40 * MINUTE)], LINES);
    expect(settled.chapters).toHaveLength(3);
    expect(settled.tooSoon).toBe(0);
  });

  /**
   * **A list of one is not a shorter list, it is a list that should not exist**
   * ([3.22.4](docs/project/prd.md)): "every surface that would show chapters leaves them out rather
   * than offering a single row that is the whole teaching".
   */
  it('empties a list that settles to one chapter, and says that is why', () => {
    const settled = settleChapters([proposal(0, 'The whole thing')], LINES);
    expect(settled.chapters).toEqual([]);
    expect(settled.tooFew).toBe(true);
  });

  it('empties a list whose second boundary came too soon to survive', () => {
    const settled = settleChapters([proposal(0), proposal(2 * MINUTE)], LINES);
    expect(settled.chapters).toEqual([]);
    expect(settled.tooSoon).toBe(1);
    expect(settled.tooFew).toBe(true);
  });

  /** Nothing proposed and a teaching too short to divide are different facts about a run. */
  it('tells a model that proposed nothing from a teaching that was too short', () => {
    expect(settleChapters([], LINES).tooFew).toBe(false);
    expect(settleChapters([proposal(0)], LINES).tooFew).toBe(true);
  });

  it('answers nothing for a transcript with no lines in it', () => {
    expect(settleChapters([proposal(0), proposal(20 * MINUTE)], []).chapters).toEqual([]);
  });

  /**
   * The whole point of the pipeline: whatever a model answers, what comes out is a legal tiling.
   * Asserted as the invariant rather than as a list, so an input nobody thought of still has to
   * satisfy it.
   */
  it('always answers a legal tiling, however badly the model answered', () => {
    const nonsense = [
      proposal(999_999_999),
      proposal(-5_000),
      proposal(20 * MINUTE + 1),
      proposal(20 * MINUTE + 2),
      proposal(0),
      proposal(50 * MINUTE),
    ];
    const settled = settleChapters(nonsense, LINES);

    const starts = settled.chapters.map((one) => one.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(starts.length);
    expect(starts.every((at) => LINES.some((line) => line.startMs === at))).toBe(true);
    expect(starts[0]).toBe(LINES[0]?.startMs);
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(MIN_CHAPTER_MS);
    }
    expect(settled.chapters.length === 0 || settled.chapters.length >= 2).toBe(true);
  });
});
