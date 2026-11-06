import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDatabase, queryable, withTransaction, type Executor } from './client';
import { note, noteFolder, noteFolderNote } from './schema';

/**
 * **A member's note folders** — every statement against `note_folder` and `note_folder_note`.
 *
 * Owner-scoped throughout, as `highlights.ts` is: every read and every write takes the member's
 * id and puts it in the `where`, so "a folder is its owner's alone" is a property of calling
 * anything in this file rather than of each caller remembering a condition. There is no read or
 * write that takes only a folder id.
 *
 * **Nothing here reads a note's visibility or author.** Whose note may be filed is the service's
 * gate over the row `notes.ts` answers; this module files what it is told to file into folders
 * the member owns, and the one condition it states about a note is that it is standing — a
 * tombstone's filings are left out of the read and removed by the delete, the arrangement
 * `highlight.note_id` keeps.
 *
 * Crosses its boundary as row types in and row types out, plus an {@link Executor}.
 */

/** One `note_folder` row. */
export interface NoteFolderRow {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly createdAt: Date;
}

/** One filing: which note is in which folder. */
export interface NoteFolderFilingRow {
  readonly folderId: string;
  readonly noteId: string;
}

const FOLDER_COLUMNS = {
  id: noteFolder.id,
  userId: noteFolder.userId,
  name: noteFolder.name,
  createdAt: noteFolder.createdAt,
} as const;

// =================================================================================================
// Reading
// =================================================================================================

/** A member's folders, by name — case-insensitively, so `apple` sits beside `Banana`. */
export async function listNoteFoldersForMember(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<NoteFolderRow[]> {
  const rows = await queryable(executor)
    .select(FOLDER_COLUMNS)
    .from(noteFolder)
    .where(eq(noteFolder.userId, userId))
    .orderBy(asc(sql`lower(${noteFolder.name})`), asc(noteFolder.createdAt), asc(noteFolder.id));
  return rows as NoteFolderRow[];
}

/**
 * Every filing in a member's folders whose note is **standing**. One statement for all folders
 * rather than one per folder, so the list is never N+1. A tombstoned note's filing is left out
 * rather than returned flagged: there is nothing to show under a removed note.
 */
export async function listNoteFolderFilingsForMember(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<NoteFolderFilingRow[]> {
  const rows = await queryable(executor)
    .select({ folderId: noteFolderNote.folderId, noteId: noteFolderNote.noteId })
    .from(noteFolderNote)
    .innerJoin(noteFolder, eq(noteFolder.id, noteFolderNote.folderId))
    .innerJoin(note, eq(note.id, noteFolderNote.noteId))
    .where(and(eq(noteFolder.userId, userId), isNull(note.deletedAt)))
    .orderBy(asc(noteFolderNote.createdAt), asc(noteFolderNote.noteId));
  return rows;
}

/** How many folders this member keeps — what the ceiling counts. */
export async function countNoteFoldersForMember(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const rows = await queryable(executor)
    .select({ count: sql<number>`count(*)::int` })
    .from(noteFolder)
    .where(eq(noteFolder.userId, userId));
  return rows[0]?.count ?? 0;
}

/**
 * Which of these ids are folders **of this member** — the check a filing makes before it writes.
 * An id that is somebody else's folder is simply absent, indistinguishable from one that is
 * nobody's, which is how the service refuses without revealing.
 */
export async function findNoteFoldersForMember(
  ids: readonly string[],
  userId: string,
  executor: Executor = getDatabase(),
): Promise<NoteFolderRow[]> {
  if (ids.length === 0) return [];
  const rows = await queryable(executor)
    .select(FOLDER_COLUMNS)
    .from(noteFolder)
    .where(and(eq(noteFolder.userId, userId), inArray(noteFolder.id, [...ids])));
  return rows as NoteFolderRow[];
}

// =================================================================================================
// Writing
// =================================================================================================

/**
 * Create a folder. A name the member already uses raises the unique violation
 * `note_folder_user_name_unique`, which the service turns into `note_folder_exists`; nothing is
 * checked ahead here, because a check-then-insert is the race the index exists to close.
 */
export async function insertNoteFolder(
  input: { readonly userId: string; readonly name: string },
  executor: Executor = getDatabase(),
): Promise<NoteFolderRow> {
  const rows = await queryable(executor)
    .insert(noteFolder)
    .values({ userId: input.userId, name: input.name })
    .returning(FOLDER_COLUMNS);
  const row = rows[0];
  if (row === undefined) throw new Error('insert note_folder returned no row');
  return row as NoteFolderRow;
}

/**
 * Rename a folder **the member owns**, or `null` when the id is not one of theirs — somebody
 * else's and nobody's answer the same. The unique violation on a taken name is the caller's to
 * read, as on insert.
 */
export async function renameNoteFolderForMember(
  id: string,
  userId: string,
  name: string,
  executor: Executor = getDatabase(),
): Promise<NoteFolderRow | null> {
  const rows = await queryable(executor)
    .update(noteFolder)
    .set({ name })
    .where(and(eq(noteFolder.id, id), eq(noteFolder.userId, userId)))
    .returning(FOLDER_COLUMNS);
  return (rows[0] as NoteFolderRow | undefined) ?? null;
}

/**
 * Remove a folder **the member owns**; its filings cascade, its notes stay. An id that is
 * somebody else's deletes nothing and answers `false`, indistinguishable from an id that is
 * nobody's.
 */
export async function deleteNoteFolderForMember(
  id: string,
  userId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .delete(noteFolder)
    .where(and(eq(noteFolder.id, id), eq(noteFolder.userId, userId)))
    .returning({ id: noteFolder.id });
  return rows.length > 0;
}

/**
 * **Set which of the member's folders a note is in**, replacing the set: every filing of this
 * note in a folder of theirs goes, and one row per named folder is written. One transaction, so
 * a picker that saved sees exactly what it ticked and never a half-state. The caller has already
 * established that each id is the member's own folder ({@link findNoteFoldersForMember}) and
 * that the note is theirs to file.
 */
export async function replaceNoteFilings(
  noteId: string,
  userId: string,
  folderIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<void> {
  await withTransaction(async (tx) => {
    const own = tx.select({ id: noteFolder.id }).from(noteFolder).where(eq(noteFolder.userId, userId));
    await tx
      .delete(noteFolderNote)
      .where(and(eq(noteFolderNote.noteId, noteId), inArray(noteFolderNote.folderId, own)));
    if (folderIds.length > 0) {
      await tx
        .insert(noteFolderNote)
        .values(folderIds.map((folderId) => ({ folderId, noteId })))
        .onConflictDoNothing();
    }
  }, executor);
}

/**
 * Every filing of a note, in anybody's folder — what the notes service calls inside a soft
 * delete's transaction, which fires no cascade. Owner-less deliberately: the note is going, and
 * so is every record of where it was filed.
 */
export async function deleteFilingsOfNote(
  noteId: string,
  executor: Executor = getDatabase(),
): Promise<void> {
  await queryable(executor).delete(noteFolderNote).where(eq(noteFolderNote.noteId, noteId));
}
