import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import { noteImage } from './schema';

/**
 * **Pictures on notes at the database** ([3.12.22](docs/project/prd.md)–[3.12.25](docs/project/prd.md)).
 *
 * Every statement against `note_image` lives here. The module answers *which rows* and never *may
 * this person*; the notes service holds the policy and the store, and this holds the shape of a
 * read — one statement for a whole list's pictures rather than one per note, as the author join in
 * `notes.ts` is one statement rather than N+1.
 *
 * **Keys go out as keys.** The service signs them into URLs; nothing here knows the store.
 */

export interface NoteImageRow {
  readonly id: string;
  readonly noteId: string;
  readonly mediaKey: string;
  readonly alt: string | null;
  readonly position: number;
}

export interface NewNoteImage {
  readonly mediaKey: string;
  readonly alt: string | null;
}

const COLUMNS = {
  id: noteImage.id,
  noteId: noteImage.noteId,
  mediaKey: noteImage.mediaKey,
  alt: noteImage.alt,
  position: noteImage.position,
} as const;

/** Write a note's pictures in the order given. Positions are the array's own. */
export async function insertNoteImages(
  noteId: string,
  images: readonly NewNoteImage[],
  executor: Executor = getDatabase(),
): Promise<NoteImageRow[]> {
  if (images.length === 0) return [];
  const rows = await queryable(executor)
    .insert(noteImage)
    .values(
      images.map((one, position) => ({ noteId, mediaKey: one.mediaKey, alt: one.alt, position })),
    )
    .returning(COLUMNS);
  return rows as NoteImageRow[];
}

/** The pictures of these notes, in strip order, keyed by the caller afterwards. */
export async function listImagesForNotes(
  noteIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<NoteImageRow[]> {
  if (noteIds.length === 0) return [];
  const rows = await queryable(executor)
    .select(COLUMNS)
    .from(noteImage)
    .where(inArray(noteImage.noteId, [...noteIds]))
    .orderBy(asc(noteImage.noteId), asc(noteImage.position));
  return rows as NoteImageRow[];
}

export async function findNoteImageById(
  imageId: string,
  executor: Executor = getDatabase(),
): Promise<NoteImageRow | null> {
  const rows = await queryable(executor)
    .select(COLUMNS)
    .from(noteImage)
    .where(eq(noteImage.id, imageId))
    .limit(1);
  return (rows[0] as NoteImageRow | undefined) ?? null;
}

/** Whether an upload key is already some note's picture — the unique index asked ahead of time. */
export async function isNoteImageKeyUsed(
  mediaKey: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .select({ id: noteImage.id })
    .from(noteImage)
    .where(eq(noteImage.mediaKey, mediaKey))
    .limit(1);
  return rows.length > 0;
}

/**
 * Replace a note's pictures with this list: rows not in `keep` go, kept rows take the new order and
 * description, new ones are written. Answers the keys of the rows that went, for the store.
 */
export async function replaceNoteImages(
  noteId: string,
  images: readonly ({ readonly id: string; readonly alt: string | null } | NewNoteImage)[],
  executor: Executor = getDatabase(),
): Promise<{ readonly removedKeys: string[]; readonly rows: NoteImageRow[] }> {
  const db = queryable(executor);
  const existing = (await db.select(COLUMNS).from(noteImage).where(eq(noteImage.noteId, noteId))) as NoteImageRow[];
  const keptIds = new Set(images.flatMap((one) => ('id' in one ? [one.id] : [])));
  const removed = existing.filter((one) => !keptIds.has(one.id));
  if (removed.length > 0) {
    await db.delete(noteImage).where(inArray(noteImage.id, removed.map((one) => one.id)));
  }
  // Two passes so a kept row moving into a position a new row is about to take never collides on
  // the way: positions are not unique at the database, but the order is what the strip draws.
  const rows: NoteImageRow[] = [];
  for (const [position, one] of images.entries()) {
    if ('id' in one) {
      const updated = await db
        .update(noteImage)
        .set({ alt: one.alt, position })
        .where(and(eq(noteImage.id, one.id), eq(noteImage.noteId, noteId)))
        .returning(COLUMNS);
      const row = updated[0] as NoteImageRow | undefined;
      if (row !== undefined) rows.push(row);
    } else {
      const inserted = await db
        .insert(noteImage)
        .values({ noteId, mediaKey: one.mediaKey, alt: one.alt, position })
        .returning(COLUMNS);
      const row = inserted[0] as NoteImageRow | undefined;
      if (row !== undefined) rows.push(row);
    }
  }
  return { removedKeys: removed.map((one) => one.mediaKey), rows };
}

/** Take one picture off a note. Answers its key, or `null` when there was none. */
export async function deleteNoteImage(
  imageId: string,
  executor: Executor = getDatabase(),
): Promise<string | null> {
  const rows = await queryable(executor)
    .delete(noteImage)
    .where(eq(noteImage.id, imageId))
    .returning({ mediaKey: noteImage.mediaKey });
  return rows[0]?.mediaKey ?? null;
}

/** Take every picture off a note — the soft delete's companion. Answers the keys, for the store. */
export async function deleteImagesOfNote(
  noteId: string,
  executor: Executor = getDatabase(),
): Promise<string[]> {
  const rows = await queryable(executor)
    .delete(noteImage)
    .where(eq(noteImage.noteId, noteId))
    .returning({ mediaKey: noteImage.mediaKey });
  return rows.map((one) => one.mediaKey);
}
