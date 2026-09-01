import { MIN_CHAPTERS, MIN_CHAPTER_MS } from '@thp/shared';
import type { ProposedChapter, TranscriptLine } from '../generate';

/**
 * **What a model proposed, turned into a list that satisfies
 * [3.22.2](docs/project/prd.md), [3.22.4](docs/project/prd.md) and
 * [3.22.5](docs/project/prd.md).**
 *
 * Pure functions, in their own module, and that is the point: three of the requirements in the
 * chapters scope are arithmetic over offsets, and arithmetic asserted through a database and a job
 * ledger is arithmetic asserted expensively and vaguely. The handler beside this does the reading
 * and the writing; every rule about *where a boundary may be* is here, and every one of them is
 * driven directly by `packages/worker/tests/unit/chapter-boundaries.test.ts`.
 *
 * The rules, in the order they are applied, and why that order:
 *
 * 1. **Snap to a transcript segment's start** ([3.22.5](docs/project/prd.md)). A model handed
 *    offsets can still answer with one that is a few milliseconds off, or with a number it worked
 *    out rather than copied. Snapping first means every later rule compares real boundaries.
 * 2. **Sort, and drop repeats.** A model may answer out of order, and two proposals a second apart
 *    snap to the same line. Neither is a failure worth halting a pipeline over.
 * 3. **Begin at the beginning** ([3.22.2](docs/project/prd.md)). The first chapter starts at the
 *    first line of the transcript whatever the model said, because a teaching's first minutes
 *    belong to a chapter or the tiling has a hole in it.
 * 4. **Drop boundaries that come too soon** ([3.22.4](docs/project/prd.md)). A chapter shorter than
 *    {@link MIN_CHAPTER_MS} is not one, and the honest repair is to remove the boundary that would
 *    have created it — which lengthens the chapter before it rather than inventing a boundary
 *    nobody proposed.
 * 5. **Fewer than two is none** ([3.22.4](docs/project/prd.md)). A list of one row that is the whole
 *    teaching is what the requirement explicitly refuses, so it is emptied rather than shortened.
 *
 * **Nothing here fails.** Every rule repairs or discards, and the worst answer is an empty list —
 * which is a real result rather than an error. What *does* fail the step is a model that answered
 * in the wrong shape, and that is refused in the adapter before anything reaches here.
 *
 * The **maximum** chapter length is deliberately not enforced. It is stated to the model in the
 * prompt, and enforcing it afterwards would mean inventing a boundary in the middle of a stretch of
 * teaching the model did not divide — a cut at a moment nothing chose, which is worse than a long
 * chapter and is not what [3.22.4](docs/project/prd.md) asks for ("cut where the teaching turns").
 */

/** One chapter, once every rule above has been applied to the list it is in. */
export interface SettledChapter {
  readonly startMs: number;
  readonly title: string;
  readonly summary: string;
}

/** What a settling did, so the run can say so rather than only show its output. */
export interface SettledChapters {
  readonly chapters: readonly SettledChapter[];
  /** How many proposals were moved to a line's start ([3.22.5](docs/project/prd.md)). */
  readonly snapped: number;
  /** How many were dropped as repeats of a boundary already taken. */
  readonly duplicates: number;
  /** How many were dropped for arriving less than {@link MIN_CHAPTER_MS} after the one before. */
  readonly tooSoon: number;
  /**
   * `true` when a list survived every rule and was then emptied for holding fewer than
   * {@link MIN_CHAPTERS} ([3.22.4](docs/project/prd.md)).
   *
   * Separate from an empty answer, because the two are different facts about a run: a model that
   * proposed nothing and a teaching too short to divide both write no chapters, and only the second
   * is worth a line in the log.
   */
  readonly tooFew: boolean;
}

/**
 * **The start of the transcript line this offset falls in**, or `null` when it falls before the
 * first line ([3.22.5](docs/project/prd.md)).
 *
 * The *last* line starting at or before the offset — so a boundary proposed in the middle of a
 * sentence moves back to where that sentence began rather than forward to the next one. Back rather
 * than forward because a chapter that opens half a sentence in is exactly what the requirement
 * refuses, and moving forward would leave the tail of that sentence in the previous chapter, which
 * is the same defect facing the other way.
 *
 * `lines` must be in playback order, which is the order `listSegments` decides.
 */
export function snapToLine(lines: readonly TranscriptLine[], offsetMs: number): number | null {
  let found: number | null = null;
  for (const line of lines) {
    if (line.startMs > offsetMs) break;
    found = line.startMs;
  }
  return found;
}

/**
 * Apply every rule above, in order, and say what each one did.
 *
 * A transcript with no lines answers with nothing: there is no first line for a first chapter to
 * begin at, and the handler refuses such a recording before it reaches here anyway.
 */
export function settleChapters(
  proposed: readonly ProposedChapter[],
  lines: readonly TranscriptLine[],
): SettledChapters {
  const first = lines[0];
  if (first === undefined) {
    return { chapters: [], snapped: 0, duplicates: 0, tooSoon: 0, tooFew: false };
  }

  // 1 and 2 — snapped, then in order, then without repeats.
  let snapped = 0;
  let duplicates = 0;
  const placed: SettledChapter[] = [];

  for (const one of proposed) {
    // A proposal before the first line belongs to the first line: it is the model naming the
    // opening of the teaching with a number it rounded down too far, and rule 3 wants it there
    // regardless.
    const at = snapToLine(lines, one.startMs) ?? first.startMs;
    if (at !== one.startMs) snapped += 1;
    placed.push({ startMs: at, title: one.title, summary: one.summary });
  }

  placed.sort((a, b) => a.startMs - b.startMs);

  const distinct: SettledChapter[] = [];
  for (const one of placed) {
    if (distinct.some((kept) => kept.startMs === one.startMs)) {
      duplicates += 1;
      continue;
    }
    distinct.push(one);
  }

  // 3 — the first chapter begins at the beginning, whatever it said. Its own text is kept: the
  // model named the opening stretch of the teaching and only mis-placed where it starts.
  const opening = distinct[0];
  if (opening !== undefined && opening.startMs !== first.startMs) {
    distinct[0] = { ...opening, startMs: first.startMs };
    snapped += 1;
  }

  // 4 — a boundary less than the floor after the one before it would make a chapter that is not
  // one, so the boundary goes and the chapter before it runs on.
  let tooSoon = 0;
  const kept: SettledChapter[] = [];
  for (const one of distinct) {
    const previous = kept[kept.length - 1];
    if (previous !== undefined && one.startMs - previous.startMs < MIN_CHAPTER_MS) {
      tooSoon += 1;
      continue;
    }
    kept.push(one);
  }

  // 5 — one row that is the whole teaching is what 3.22.4 refuses, so it is emptied.
  if (kept.length < MIN_CHAPTERS) {
    return { chapters: [], snapped, duplicates, tooSoon, tooFew: kept.length > 0 };
  }

  return { chapters: kept, snapped, duplicates, tooSoon, tooFew: false };
}
