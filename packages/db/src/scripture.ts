import { eq } from 'drizzle-orm';
import type { BookId, ScriptureOrigin } from '@thp/shared';
import { getDatabase, withTransaction, type Executor } from './client';
import { scriptureReference } from './schema';

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
