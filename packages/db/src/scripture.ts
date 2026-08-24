import { and, asc, eq, or } from 'drizzle-orm';
import type { BookId, ScriptureOrigin } from '@thp/shared';
import { getDatabase, queryable, withTransaction, type Executor } from './client';
import { scriptureReference, verseText } from './schema';

/**
 * A teaching's approved scripture references (Task 1.4). Query construction lives in this package
 * and nowhere else — the import-boundary guard refuses a `drizzle-orm` import outside it.
 *
 * One write, because there is only one thing that ever happens to this table: an admin approves a
 * list, and the recording's references become that list.
 */

/** One row of `scripture_reference`, as the rest of the application sees it. */
export interface ScriptureReferenceRow {
  readonly id: string;
  readonly recordingId: string;
  readonly book: BookId;
  readonly chapter: number;
  readonly verseStart: number;
  readonly verseEnd: number;
  readonly origin: ScriptureOrigin;
  readonly editedByAdmin: boolean;
  readonly createdAt: Date;
}

/** One reference as the approve path supplies it. The id and the timestamp are the table's. */
export interface NewScriptureReference {
  readonly book: BookId;
  readonly chapter: number;
  readonly verseStart: number;
  readonly verseEnd: number;
  readonly origin: ScriptureOrigin;
  readonly editedByAdmin: boolean;
}

/**
 * **Make this list the recording's references**, replacing whatever was there.
 *
 * Delete-then-insert, which is [3.2.11](docs/active-scope/prd.md) said as a write: approving a
 * later draft *replaces* rather than appends, so the approved set is what the last approval said,
 * in full. Appending would leave a teaching carrying the union of every draft ever approved for it,
 * which nobody could correct without deleting rows by hand.
 *
 * **An empty list is a legal call** and deletes everything — that is
 * [3.2.7](docs/active-scope/prd.md)'s "this teaching has no scripture references", written as the
 * absence of rows. What distinguishes it from "nobody has looked yet" is the closed `review_item`,
 * not anything here.
 *
 * Nested by design: the approve path passes the transaction it is already closing the review item
 * in, so the references and the close land together or not at all.
 */
export async function replaceScriptureReferences(
  recordingId: string,
  references: readonly NewScriptureReference[],
  executor: Executor = getDatabase(),
): Promise<ScriptureReferenceRow[]> {
  return withTransaction(async (tx) => {
    await tx.delete(scriptureReference).where(eq(scriptureReference.recordingId, recordingId));
    if (references.length === 0) return [];

    const inserted = await tx
      .insert(scriptureReference)
      .values(references.map((one) => ({ recordingId, ...one })))
      .returning();

    return inserted as ScriptureReferenceRow[];
  }, executor);
}

/**
 * **The verse text cache** ([3.2.1](docs/active-scope/implementation-plan.md)–
 * [3.2.2](docs/active-scope/implementation-plan.md)).
 *
 * Two statements, because two is what the cache does: read what is held, and hold what was just
 * fetched. Deciding *which* verses are missing is not a question about storage and is not asked
 * here — it belongs beside the source, in `@thp/bible`.
 */

/** One held verse, as the rest of the application sees it. */
export interface VerseTextRow {
  readonly translation: string;
  readonly book: BookId;
  readonly chapter: number;
  readonly verse: number;
  readonly text: string;
  readonly fetchedAt: Date;
}

/** One verse to hold. The timestamp is the table's. */
export interface NewVerseText {
  readonly translation: string;
  readonly book: BookId;
  readonly chapter: number;
  readonly verse: number;
  readonly text: string;
}

/** A chapter to read held verses for. */
export interface ChapterKey {
  readonly book: BookId;
  readonly chapter: number;
}

/**
 * Every verse held for these chapters, in this translation.
 *
 * **By chapter rather than by range**, because that is the grain a source answers at: a citation
 * that needs three verses of a chapter already held pays one read, and the next citation of the
 * same chapter pays none. An empty list of chapters reads nothing rather than everything.
 */
export async function findHeldVerses(
  translation: string,
  chapters: readonly ChapterKey[],
  executor: Executor = getDatabase(),
): Promise<VerseTextRow[]> {
  if (chapters.length === 0) return [];

  const wanted = chapters.map((one) =>
    and(eq(verseText.book, one.book), eq(verseText.chapter, one.chapter)),
  );

  const rows = await queryable(executor)
    .select()
    .from(verseText)
    .where(and(eq(verseText.translation, translation), or(...wanted)))
    .orderBy(asc(verseText.book), asc(verseText.chapter), asc(verseText.verse));

  return rows as VerseTextRow[];
}

/**
 * Hold these verses, leaving alone any that are already held.
 *
 * **`do nothing` rather than an update**, and that is the point of the cache rather than a detail
 * of it: what is held is what the source said the first time, and two teachings resolving the same
 * chapter at the same moment must not turn into a unique violation on a path that
 * [3.2.4](docs/active-scope/implementation-plan.md) requires to keep succeeding.
 */
export async function saveVerseTexts(
  verses: readonly NewVerseText[],
  executor: Executor = getDatabase(),
): Promise<number> {
  if (verses.length === 0) return 0;

  const written = await queryable(executor)
    .insert(verseText)
    .values([...verses])
    .onConflictDoNothing()
    .returning({ verse: verseText.verse });

  return written.length;
}
