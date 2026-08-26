import { findHeldVerses, saveVerseTexts, type Executor } from '@thp/db';
import type { ScriptureCitation } from '@thp/shared';
import { readBibleTranslation } from './env';
import { bibleSource } from './configured';
import type { BibleSource, Verse } from './source';

/**
 * **Verse text is fetched once and held** (scope prd 3.3.1–
 * scope prd 3.3.2).
 *
 * The cache-aside read, in the one place both callers reach it: the draft step resolves what the
 * machine proposed, and the review form resolves what an admin just typed. Neither of them decides
 * anything about caching, which is what stops the two from disagreeing about when a call is made.
 *
 * **What is already held is never fetched again**, across teachings as much as within one — the
 * cache is keyed by the passage rather than by the citer, so the second teaching to quote a verse
 * pays nothing for it. That is the line
 * project tdd 8.2 is built on.
 *
 * **Held is read once, for every chapter at issue, before anything is fetched.** A list of ten
 * citations is one read and then only the calls that are actually missing — asking per citation
 * would make a teaching that quotes one chapter ten times ten reads of the same rows.
 *
 * **Nothing here throws over a source that has no text.** The port already promises that
 * (scope prd 3.1.5); this keeps the promise by treating a passage with no verses
 * as a real answer — the citation stands and has no text yet — rather than as a failure to report.
 */

/** One citation and the verses of it, in verse order. Empty when there is no text yet. */
export interface ResolvedPassage {
  readonly citation: ScriptureCitation;
  readonly verses: readonly Verse[];
}

/**
 * What a resolution did, which is what scope prd 3.3.9 is recorded from: how many
 * verses were fetched, how many were served from what we already held, and the source's own
 * identifier for the call.
 */
export interface PassageResolution {
  readonly passages: readonly ResolvedPassage[];
  readonly fetched: number;
  readonly held: number;
  /** The last call's identifier, or `null` when nothing was called. */
  readonly requestId: string | null;
}

export interface ResolveOptions {
  readonly source?: BibleSource;
  readonly translation?: string;
  readonly executor?: Executor;
}

/** Which chapter a verse is in. The key everything below is grouped by. */
function chapterKey(citation: ScriptureCitation): string {
  return `${citation.book}:${citation.chapter}`;
}

export async function resolvePassages(
  citations: readonly ScriptureCitation[],
  options: ResolveOptions = {},
): Promise<PassageResolution> {
  if (citations.length === 0) return { passages: [], fetched: 0, held: 0, requestId: null };

  const source = options.source ?? bibleSource();
  const translation = options.translation ?? readBibleTranslation();

  const chapters = new Map(citations.map((one) => [chapterKey(one), one]));
  const rows = await findHeldVerses(
    translation,
    [...chapters.values()].map((one) => ({ book: one.book, chapter: one.chapter })),
    options.executor,
  );

  /**
   * What is held, per chapter, as this resolution proceeds. Verses fetched partway through are
   * added to it, so a list citing the same chapter twice fetches it once.
   */
  const heldByChapter = new Map<string, Map<number, string>>();
  for (const row of rows) {
    const key = `${row.book}:${row.chapter}`;
    const chapter = heldByChapter.get(key) ?? new Map<number, string>();
    chapter.set(row.verse, row.text);
    heldByChapter.set(key, chapter);
  }

  const passages: ResolvedPassage[] = [];
  let fetched = 0;
  let held = 0;
  let requestId: string | null = null;

  for (const citation of citations) {
    const key = chapterKey(citation);
    const chapter = heldByChapter.get(key) ?? new Map<number, string>();
    heldByChapter.set(key, chapter);

    const wanted: number[] = [];
    for (let verse = citation.verseStart; verse <= citation.verseEnd; verse += 1) wanted.push(verse);

    const missing = wanted.filter((verse) => !chapter.has(verse));
    held += wanted.length - missing.length;

    if (missing.length > 0) {
      const answer = await source.readPassage(citation);
      if (answer.requestId !== null) requestId = answer.requestId;

      // Only what is not already held is written, so the text a verse was first fetched with is
      // the text it keeps. The count is what actually landed rather than what came back.
      const fresh = answer.verses.filter((one) => !chapter.has(one.number));
      fetched += await saveVerseTexts(
        fresh.map((one) => ({
          translation,
          book: citation.book,
          chapter: citation.chapter,
          verse: one.number,
          text: one.text,
        })),
        options.executor,
      );
      for (const one of fresh) chapter.set(one.number, one.text);
    }

    const verses: Verse[] = [];
    for (const verse of wanted) {
      const text = chapter.get(verse);
      if (text !== undefined) verses.push({ number: verse, text });
    }
    passages.push({ citation, verses });
  }

  return { passages, fetched, held, requestId };
}
