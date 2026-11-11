import { desc, eq, inArray } from 'drizzle-orm';
import type { StoredReleaseNoteDoc } from '@thp/shared';
import { getDatabase, queryable, withTransaction, type Executor } from './client';
import { announcement, notification, releaseNote } from './schema';

/**
 * **Release notes at the database.** Every statement against `release_note` lives here. The module
 * answers *which rows* and never *may this person*; the service holds the policy, reads the body
 * into a document before it gets here, and signs the pictures on the way out.
 *
 * **The body arrives parsed.** `parseReleaseNoteDoc` in `@thp/shared` is the one reading of what
 * the editor sends; these functions store what they are given.
 */

export interface ReleaseNoteRow {
  readonly id: string;
  readonly title: string;
  readonly body: StoredReleaseNoteDoc;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewReleaseNote {
  readonly title: string;
  readonly body: StoredReleaseNoteDoc;
  readonly createdBy: string;
}

export async function insertReleaseNote(
  input: NewReleaseNote,
  executor: Executor = getDatabase(),
): Promise<ReleaseNoteRow> {
  const rows = await queryable(executor)
    .insert(releaseNote)
    .values({ title: input.title, body: input.body, createdBy: input.createdBy })
    .returning();
  const row = rows[0] as ReleaseNoteRow | undefined;
  if (row === undefined) throw new Error('insertReleaseNote returned no row');
  return row;
}

/** Rewrite a post's title and body. Answers the row as it now reads, or `null` when there is none. */
export async function updateReleaseNote(
  id: string,
  input: { readonly title: string; readonly body: StoredReleaseNoteDoc },
  executor: Executor = getDatabase(),
): Promise<ReleaseNoteRow | null> {
  const rows = await queryable(executor)
    .update(releaseNote)
    .set({ title: input.title, body: input.body, updatedAt: new Date() })
    .where(eq(releaseNote.id, id))
    .returning();
  return (rows[0] as ReleaseNoteRow | undefined) ?? null;
}

export async function findReleaseNoteById(
  id: string,
  executor: Executor = getDatabase(),
): Promise<ReleaseNoteRow | null> {
  const rows = await queryable(executor).select().from(releaseNote).where(eq(releaseNote.id, id)).limit(1);
  return (rows[0] as ReleaseNoteRow | undefined) ?? null;
}

/** Every post, newest first. */
export async function listReleaseNotes(executor: Executor = getDatabase()): Promise<ReleaseNoteRow[]> {
  const rows = await queryable(executor)
    .select()
    .from(releaseNote)
    .orderBy(desc(releaseNote.createdAt), desc(releaseNote.id));
  return rows as ReleaseNoteRow[];
}

/**
 * Remove a post. Answers whether there was one.
 *
 * **The notices that pointed at it are repointed first, in the same transaction.** A new-feature
 * notification stores where a press lands; with the post gone that would be a 404 in every
 * member's bell, so those rows are moved to `fallbackHref` — the list of release notes, which the
 * caller names because paths are not this package's to know. The send itself keeps its row and
 * loses its pointer (`announcement.release_note_id` sets null), so the console still lists what
 * was said.
 */
export async function deleteReleaseNote(
  id: string,
  fallbackHref: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const sends = await tx
      .select({ id: announcement.id })
      .from(announcement)
      .where(eq(announcement.releaseNoteId, id));
    if (sends.length > 0) {
      await tx
        .update(notification)
        .set({ href: fallbackHref })
        .where(
          inArray(
            notification.announcementId,
            sends.map((one) => one.id),
          ),
        );
    }
    const removed = await tx.delete(releaseNote).where(eq(releaseNote.id, id)).returning({ id: releaseNote.id });
    return removed.length > 0;
  }, executor);
}
