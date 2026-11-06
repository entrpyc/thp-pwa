import {
  countNoteFoldersForMember,
  deleteNoteFolderForMember,
  findNoteById,
  findNoteFoldersForMember,
  insertNoteFolder,
  isUniqueViolation,
  listNoteFolderFilingsForMember,
  listNoteFoldersForMember,
  renameNoteFolderForMember,
  replaceNoteFilings,
  type NoteFolderRow,
} from '@thp/db';
import {
  MAX_NOTE_FOLDERS,
  MAX_NOTE_FOLDER_NAME_LENGTH,
  NOTE_FOLDERS_FULL_MESSAGE,
  NOTE_FOLDER_EXISTS_MESSAGE,
  normaliseNoteFolderName,
  type NoteFolderView,
  type NoteFoldersPayload,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

/**
 * **A member's note folders** — reading them, creating, renaming and removing one, and filing a
 * note of their own.
 *
 * Who may is the policy module's answer, asked by the routes (`note-folder.list`,
 * `note-folder.create`, `note-folder.rename`, `note-folder.remove`, `note-folder.file`), and
 * every one of the five is the caller's own folders by construction: nothing in a path names
 * whose. What this module decides is what a filing may target — a standing top-level note the
 * member wrote, into folders the member owns — and what every write answers.
 *
 * **Every write answers the folders as they now stand**, the shape every Highlights write takes:
 * a picker that saved renders what came back rather than merging a verdict into a list it fetched
 * earlier, and the pills on two pages cannot disagree about where a note is filed.
 *
 * **Refusals say nothing about what exists.** A note that is not the member's own, a reply, a
 * tombstone, a folder that is somebody else's, and an id that is nobody's are all `not_found`
 * with one sentence each — the rule the highlights service keeps for the one route that takes
 * ids from a body.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_SUCH_FOLDER = 'There is no such folder.';
const NO_SUCH_NOTE = 'There is no such note to file.';
const NAME_INVALID = `A folder needs a name of 1 to ${MAX_NOTE_FOLDER_NAME_LENGTH} characters.`;

export async function listNoteFoldersFor(actor: Actor): Promise<NoteFoldersPayload> {
  const [folders, filings] = await Promise.all([
    listNoteFoldersForMember(actor.id),
    listNoteFolderFilingsForMember(actor.id),
  ]);
  const byFolder = new Map<string, string[]>();
  for (const filing of filings) {
    const held = byFolder.get(filing.folderId);
    if (held === undefined) byFolder.set(filing.folderId, [filing.noteId]);
    else held.push(filing.noteId);
  }
  return { folders: folders.map((row) => describe(row, byFolder.get(row.id) ?? [])) };
}

/**
 * **Create a folder** from the body a picker sent.
 *
 * The name is normalised — trimmed, inner whitespace collapsed — before the ceiling and the
 * uniqueness are asked, so `" Sermons "` is `Sermons` and a second `sermons` is the same folder.
 * The ceiling is checked before the write and not inside a lock: two creates racing at the limit
 * can land the member one over it, which costs nothing and is corrected by the next remove.
 */
export async function createNoteFolderFor(actor: Actor, body: unknown): Promise<NoteFoldersPayload> {
  const name = parseName(body);

  const held = await countNoteFoldersForMember(actor.id);
  if (held >= MAX_NOTE_FOLDERS) throw ApiError.noteFoldersFull(NOTE_FOLDERS_FULL_MESSAGE);

  let created: NoteFolderRow;
  try {
    created = await insertNoteFolder({ userId: actor.id, name });
  } catch (caught) {
    if (isUniqueViolation(caught)) throw ApiError.noteFolderExists(NOTE_FOLDER_EXISTS_MESSAGE);
    throw caught;
  }
  logger.info('note-folder.create', {
    actorId: actor.id,
    action: 'note-folder.create',
    target: `note-folder:${created.id}`,
  });
  return listNoteFoldersFor(actor);
}

/** **Rename a folder** of the member's own. Somebody else's id and nobody's are one `not_found`. */
export async function renameNoteFolderFor(
  actor: Actor,
  folderId: string,
  body: unknown,
): Promise<NoteFoldersPayload> {
  const id = parseId(folderId, 'That is not a folder id.');
  const name = parseName(body);

  let renamed: NoteFolderRow | null;
  try {
    renamed = await renameNoteFolderForMember(id, actor.id, name);
  } catch (caught) {
    if (isUniqueViolation(caught)) throw ApiError.noteFolderExists(NOTE_FOLDER_EXISTS_MESSAGE);
    throw caught;
  }
  if (renamed === null) throw ApiError.notFound(NO_SUCH_FOLDER);
  logger.info('note-folder.rename', {
    actorId: actor.id,
    action: 'note-folder.rename',
    target: `note-folder:${id}`,
  });
  return listNoteFoldersFor(actor);
}

/**
 * **Remove a folder.** Its notes stay, unfiled from it. An id that is not on the member's list —
 * never was, already removed, or somebody else's — succeeds and changes nothing: the member asked
 * for an end state and has it, and a refusal would be the one way to learn that an id is somebody
 * else's. Only a malformed id is refused, because it is not an end state anybody can be in.
 */
export async function removeNoteFolderFor(actor: Actor, folderId: string): Promise<NoteFoldersPayload> {
  const id = parseId(folderId, 'That is not a folder id.');
  const removed = await deleteNoteFolderForMember(id, actor.id);
  logger.info('note-folder.remove', {
    actorId: actor.id,
    action: 'note-folder.remove',
    target: `note-folder:${id}`,
    removed,
  });
  return listNoteFoldersFor(actor);
}

/**
 * **File a note**: set which of the member's folders it is in, replacing the set.
 *
 * Three gates, each one sentence:
 *
 * - **The note** must exist, be standing, be **top-level** — a reply belongs to its thread's
 *   moment and is filed nowhere of its own — and be **the member's own**. Anything else is
 *   `not_found` with one sentence, so the route cannot be used to learn whether another member's
 *   note id exists. The author check is a comparison on the row the store answered, not a query
 *   predicate: which rows a reader may have is still the store's decision alone.
 * - **The folders** must each be the member's own. One that is not — somebody else's, or
 *   nobody's — is the same `not_found` as a folder that was removed under the picker.
 * - **The body** must be a list of ids. Duplicates are folded; an empty list unfiles the note,
 *   which is a thing a member means and not a mistake.
 */
export async function setNoteFoldersFor(
  actor: Actor,
  noteId: string,
  body: unknown,
): Promise<NoteFoldersPayload> {
  const id = parseId(noteId, 'That is not a note id.');
  const folderIds = parseFolderIds(body);

  const row = await findNoteById(id);
  if (row === null || row.deletedAt !== null || row.parentId !== null || row.authorId !== actor.id) {
    throw ApiError.notFound(NO_SUCH_NOTE);
  }

  const own = await findNoteFoldersForMember(folderIds, actor.id);
  if (own.length !== folderIds.length) throw ApiError.notFound(NO_SUCH_FOLDER);

  await replaceNoteFilings(id, actor.id, folderIds);
  logger.info('note-folder.file', {
    actorId: actor.id,
    action: 'note-folder.file',
    target: `note:${id}`,
    folders: folderIds.length,
  });
  return listNoteFoldersFor(actor);
}

// =================================================================================================
// Parsing
// =================================================================================================

/** The name off a create or rename body, normalised — or `invalid_input` with one sentence. */
export function parseName(body: unknown): string {
  if (typeof body !== 'object' || body === null) throw ApiError.invalidInput(NAME_INVALID);
  const name = normaliseNoteFolderName((body as { name?: unknown }).name);
  if (name === null) throw ApiError.invalidInput(NAME_INVALID);
  return name;
}

/** The folder ids off a filing body, each a uuid, duplicates folded — or `invalid_input`. */
export function parseFolderIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('The body must list the folders.');
  }
  const { folderIds } = body as { folderIds?: unknown };
  if (!Array.isArray(folderIds)) throw ApiError.invalidInput('folderIds must be a list of folder ids.');
  const ids = new Set<string>();
  for (const one of folderIds) ids.add(parseId(one, 'folderIds must be a list of folder ids.'));
  return [...ids];
}

function parseId(value: unknown, complaint: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw ApiError.invalidInput(complaint);
  return value.toLowerCase();
}

function describe(row: NoteFolderRow, noteIds: readonly string[]): NoteFolderView {
  return { id: row.id, name: row.name, noteIds, createdAt: row.createdAt.toISOString() };
}
