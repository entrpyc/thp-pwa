import {
  findVisibleRecording,
  insertNote,
  listNotesForReader,
  type NoteWithAuthorRow,
} from '@thp/db';
import {
  MAX_NOTE_LENGTH,
  NOTE_RECORDING_GONE_MESSAGE,
  NOTE_VISIBILITIES,
  type CreateNotePayload,
  type CreateNoteRequest,
  type NoteView,
  type NoteVisibility,
  type NotesPayload,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

/**
 * **Notes, written and read** (active-scope architecture § 4.3) —
 * [3.1](docs/active-scope/prd.md) and [3.2](docs/active-scope/prd.md).
 *
 * The order every path here asks its questions in is the one § 8 sets: **recording still published
 * → actor permitted → write or read**. The middle step is `apiRoute`'s, which is why nothing below
 * mentions a role; the first is `findVisibleRecording`'s, which is why nothing below compares a
 * publication timestamp; and the third is `packages/db/src/notes.ts`'s, which is why nothing below
 * decides which rows come back.
 *
 * What this module does own is **the text rules the table cannot state as a refusal a person can
 * read**. The column's check constraint refuses text over the ceiling with a constraint violation;
 * [3.1.7](docs/active-scope/prd.md) wants a refusal, so the ceiling is checked here and the
 * constraint is the backstop.
 *
 * **The publication gate answers `not_found` on both paths, and says different things.** A read of
 * an unpublished teaching is a refusal rather than an empty list
 * ([3.2.12](docs/active-scope/prd.md)); a write to one carries
 * [5.1.4](docs/active-scope/prd.md)'s message, because the composer prints it beside text the
 * member is about to lose otherwise.
 */

/**
 * Write a note at a moment, and answer the note that was written.
 *
 * The created note comes back in the same shape the list uses, so the composer can put it straight
 * into the list it is sitting above rather than translating between two ideas of what a note is.
 * The author is the actor, so its display name is already in hand and needs no second read.
 */
export async function createNote(
  actor: Actor,
  recordingId: string,
  body: unknown,
): Promise<CreateNotePayload> {
  await requirePublished(actor, recordingId, 'note.write', NOTE_RECORDING_GONE_MESSAGE);
  const requested = parseNote(body);

  const row = await insertNote({
    recordingId,
    authorId: actor.id,
    visibility: requested.visibility,
    text: requested.text,
    timestampMs: requested.timestampMs,
  });

  logger.info('note.write', {
    actorId: actor.id,
    action: 'note.write',
    target: `note:${row.id}`,
    recordingId,
    visibility: row.visibility,
    timestampMs: row.timestampMs,
  });

  return { note: describeNote({ ...row, authorDisplayName: actor.displayName }, actor) };
}

/**
 * Everything on this teaching this member may see, in one answer.
 *
 * **One `GET`, one payload** (active-scope architecture § 7), and the order is the store's — the
 * `(recording_id, timestamp_ms, created_at)` index, which is
 * [3.2.1](docs/active-scope/prd.md)'s order exactly. Nothing here re-sorts it, and nothing here
 * filters it: another member's private note is absent because the query never selected it, for
 * every actor including an admin.
 */
export async function readNotesFor(actor: Actor, recordingId: string): Promise<NotesPayload> {
  await requirePublished(actor, recordingId, 'note.read');

  const rows = await listNotesForReader(recordingId, actor.id);

  logger.info('note.read', {
    actorId: actor.id,
    action: 'note.read',
    target: `recording:${recordingId}`,
    notes: rows.length,
  });

  return { notes: rows.map((row) => describeNote(row, actor)) };
}

/**
 * The recording, read through the member gate, or the refusal.
 *
 * `not_found` for an unpublished id and for one that never existed alike — the same answer the
 * transcript and the recording itself give, reached the same way, so the API does not report which
 * ids exist. Only the sentence differs, and only on the write.
 */
async function requirePublished(
  actor: Actor,
  recordingId: string,
  action: string,
  message = 'There is no such teaching.',
): Promise<void> {
  const row = await findVisibleRecording(recordingId, { includeUnpublished: false });
  if (row !== null) return;

  logger.warn('note.refused', {
    actorId: actor.id,
    action,
    target: `recording:${recordingId}`,
    reason: 'not-visible',
    code: 'not_found',
  });
  throw ApiError.notFound(message);
}

/**
 * A row as a member is answered.
 *
 * `deletedBy` is dropped here ([3.5.8](docs/active-scope/prd.md)) — this is the boundary the store's
 * "answer what is stored" stops at. `timestampMs` and `text` are non-null on every row this scope
 * can return: the table refuses a top-level note without a position, and the read is top-level only.
 */
function describeNote(row: NoteWithAuthorRow, reader: Actor): NoteView {
  return {
    id: row.id,
    timestampMs: row.timestampMs ?? 0,
    authorDisplayName: row.authorDisplayName,
    visibility: row.visibility,
    // Answered here rather than compared on the client: the server is the side that knows who is
    // reading, and it is the side that already decided which rows this reader may have.
    mine: row.authorId === reader.id,
    text: row.text ?? '',
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
  };
}

/**
 * The body, or the refusal.
 *
 * **Trimmed, then measured** ([3.1.6](docs/active-scope/prd.md)): padding cannot push a real note
 * over the ceiling, and a note of nothing but spaces is a note of nothing. Over-long text is
 * refused rather than truncated — a member who wrote 1,200 characters is owed the refusal, not a
 * silently shortened note they will discover later.
 */
function parseNote(body: unknown): CreateNoteRequest {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the note, its visibility and its moment.');
  }
  const { text, visibility, timestampMs } = body as Partial<CreateNoteRequest>;

  if (typeof text !== 'string' || text.trim() === '') {
    throw ApiError.invalidInput('Write something before saving the note.');
  }
  if (text.trim().length > MAX_NOTE_LENGTH) {
    throw ApiError.invalidInput(`${MAX_NOTE_LENGTH.toLocaleString('en-GB')} characters maximum.`);
  }
  if (!isVisibility(visibility)) {
    throw ApiError.invalidInput('Say whether the note is private or public.');
  }
  // `>= 0` and nothing more: no recording's duration is stored anywhere in this product, so there
  // is no ceiling to compare a position against (active-scope prd 3.1.10's second half).
  if (!Number.isInteger(timestampMs) || (timestampMs as number) < 0) {
    throw ApiError.invalidInput('Give the moment as whole milliseconds from the start.');
  }

  return { text: text.trim(), visibility, timestampMs: timestampMs as number };
}

function isVisibility(value: unknown): value is NoteVisibility {
  return typeof value === 'string' && (NOTE_VISIBILITIES as readonly string[]).includes(value);
}

