import { USERS_PATH } from './accounts';
import { notePath } from './notes';

/**
 * **Note folders on the wire** — a member's own way of grouping the notes they wrote, across every
 * teaching: named folders, one level deep, with any note of theirs in any number of them.
 *
 * Three things live here because the two surfaces that file a note (the recording page's card
 * and the *My notes* page's), the folder picker, the API and the database each have to agree:
 *
 * 1. **The ceilings.** How many folders one member may keep ({@link MAX_NOTE_FOLDERS}) and how
 *    long a name may be ({@link MAX_NOTE_FOLDER_NAME_LENGTH}) — the column's check constraint is
 *    derived from the second, so a name the picker accepts is never one the database refuses.
 * 2. **The wire contract** — the paths, the request bodies and the one view, so every surface
 *    renders the same folders from the same answer.
 * 3. **The one lookup** every surface makes — {@link foldersOfNote} — so "which folders is this
 *    note in" has one answer on every screen.
 *
 * **Private by construction**, as Highlights are: the routes are under `/users/me`, the only
 * folders anybody can read or change are their own, and no admin route lists anybody's. A folder
 * is a fact about the member, not about the note: a public note filed by its author is still
 * public, and nobody else learns where it was filed.
 *
 * **No nesting, and no column for it.** One level deep is the product's decision, and a table
 * with no `parent_id` cannot hold a second level by accident.
 */

// =================================================================================================
// The ceilings
// =================================================================================================

/**
 * **How many folders one member may keep.** Creating past it is refused with `note_folders_full`
 * and a sentence saying to remove one first. A hundred, by the product's decision: far past what
 * a person sorts study notes into by hand, and a bound on a list every surface reads whole.
 */
export const MAX_NOTE_FOLDERS = 100;

/** The most a folder's name may be, in characters — a label on a pill, not a sentence. */
export const MAX_NOTE_FOLDER_NAME_LENGTH = 60;

/**
 * What a member reads at the ceiling. One statement, because the API refuses with it and the
 * picker prints it, and the two disagreeing is a member reading a refusal that does not match
 * what happened.
 */
export const NOTE_FOLDERS_FULL_MESSAGE = `You already have ${MAX_NOTE_FOLDERS} folders. Remove one before creating another.`;

/** What a member reads when a name is already one of their folders'. */
export const NOTE_FOLDER_EXISTS_MESSAGE = 'You already have a folder with that name.';

// =================================================================================================
// The routes
// =================================================================================================

/**
 * The signed-in account's folders, relative to the `/api/v1` prefix. `GET` lists them, by name;
 * `POST` creates one. Both answer the list as it now stands.
 */
export const NOTE_FOLDERS_PATH = `${USERS_PATH}/me/note-folders`;

/** `PATCH` renames this folder, `DELETE` removes it (its notes stay, unfiled). Both answer the list. */
export function noteFolderPath(folderId: string): string {
  return `${NOTE_FOLDERS_PATH}/${folderId}`;
}

/**
 * `PUT` sets **which of the caller's folders this note is in**, replacing the set. Addressed on
 * the note, as every single-note write is, because it is a fact about one note; the body names
 * the folders. Only the author's own top-level notes can be filed.
 */
export function noteFoldersPath(noteId: string): string {
  return `${notePath(noteId)}/folders`;
}

// =================================================================================================
// The wire contract
// =================================================================================================

/**
 * One folder, with the notes in it. The note ids travel with the folder rather than a folder list
 * on every note, because the member's folders are read once per page while notes are read per
 * teaching — and a card decides "which folders am I in" by {@link foldersOfNote} over this list.
 */
export interface NoteFolderView {
  readonly id: string;
  readonly name: string;
  /** The member's own top-level notes filed here, standing ones only. */
  readonly noteIds: readonly string[];
  /** ISO 8601. */
  readonly createdAt: string;
}

/** Payload of every note-folder route — the member's folders as they now stand, by name. */
export interface NoteFoldersPayload {
  readonly folders: readonly NoteFolderView[];
}

/** Body of `POST /api/v1/users/me/note-folders`. */
export interface CreateNoteFolderRequest {
  readonly name: string;
}

/** Body of `PATCH /api/v1/users/me/note-folders/{id}`. */
export interface RenameNoteFolderRequest {
  readonly name: string;
}

/** Body of `PUT /api/v1/notes/{id}/folders` — the whole set; an empty array unfiles the note. */
export interface SetNoteFoldersRequest {
  readonly folderIds: readonly string[];
}

// =================================================================================================
// The lookup
// =================================================================================================

/** The folders this note is in, in the list's order — empty when it is unfiled. */
export function foldersOfNote(
  folders: readonly NoteFolderView[],
  noteId: string,
): NoteFolderView[] {
  return folders.filter((one) => one.noteIds.includes(noteId));
}

/**
 * A name as the member typed it, or `null` when it is not one the product accepts: trimmed, at
 * least one character, at most {@link MAX_NOTE_FOLDER_NAME_LENGTH}. Here so the picker can refuse
 * before sending exactly what the API would refuse.
 */
export function normaliseNoteFolderName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > MAX_NOTE_FOLDER_NAME_LENGTH) return null;
  return trimmed;
}
