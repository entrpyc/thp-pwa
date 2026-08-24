import {
  clearNoteReaction,
  findNoteById,
  findVisibleRecording,
  insertNote,
  listNotesForReader,
  listPinnedNoteIds,
  listReactionsForNotes,
  listRepliesForNotes,
  pinNote,
  setNoteReaction,
  softDeleteNote,
  unpinNote,
  updateNoteText,
  withTransaction,
  type NoteReactionRow,
  type NoteRow,
  type NoteWithAuthorRow,
} from '@thp/db';
import {
  MAX_NOTE_LENGTH,
  NOTE_ALREADY_REMOVED_MESSAGE,
  NOTE_RECORDING_GONE_MESSAGE,
  NOTE_REMOVED_MESSAGE,
  NOTE_REMOVED_WHILE_REPLYING_MESSAGE,
  NOTE_VISIBILITIES,
  isReactionEmoji,
  type CreateNotePayload,
  type NotePayload,
  type NoteView,
  type NoteVisibility,
  type NotesPayload,
  type ReactionCount,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { authorise } from '@/server/auth/authorise';
import { can, type Actor } from '@/server/auth/policy';
import { audit } from '@/server/observability/audit';
import { logger } from '@/server/observability/logger';

/**
 * **Notes, written and read** (active-scope architecture § 4.3) — [3.1](docs/active-scope/prd.md)
 * through [3.6](docs/active-scope/prd.md).
 *
 * The order every path here asks its questions in is the one § 8 sets: **recording still published
 * → actor permitted → resource in a state that admits the action → write → audit if the write was
 * moderation**. The first step is `findVisibleRecording`'s, which is why nothing below compares a
 * publication timestamp; the second is `apiRoute`'s or `authorise`'s, which is why nothing below
 * reads a role or compares an id; and the row selection is `packages/db/src/notes.ts`'s, which is
 * why nothing below decides which rows come back.
 *
 * What this module does own is **the state rules the schema cannot carry, and the text rules the
 * table cannot state as a refusal a person can read**. Concretely: a reply whose parent is a reply,
 * a reply or a reaction aimed at a private note, a pin of a reply or of a private note — each
 * `invalid_input`, because no interface offers any of them and a request carrying one is malformed
 * rather than unauthorised. And any action on a note already deleted — `note_removed`, because
 * *that* request was well-formed against an affordance that was real when it was rendered.
 *
 * **The publication gate answers `not_found` on both paths, and says different things.** A read of
 * an unpublished teaching is a refusal rather than an empty list
 * ([3.2.12](docs/active-scope/prd.md)); a write to one carries
 * [5.1.4](docs/active-scope/prd.md)'s message, because the composer prints it beside text the
 * member is about to lose otherwise.
 */

// =================================================================================================
// Writing
// =================================================================================================

/**
 * Write a note at a moment, **or a reply under one**, and answer what was written.
 *
 * One entry point rather than two (active-scope architecture § 7): a reply is a note with a parent
 * ([4.10](docs/project/prd.md)), and the alternative is two validation paths for one set of text
 * rules that then have to be kept in step. The body says which it is — a `parentId` and no moment,
 * or a moment and no parent — and everything after the fork is shared.
 *
 * The created note comes back in the same shape the list uses, so the composer can put it straight
 * into the list it is sitting above rather than translating between two ideas of what a note is.
 */
export async function createNote(
  actor: Actor,
  recordingId: string,
  body: unknown,
): Promise<CreateNotePayload> {
  await requirePublished(actor, recordingId, 'note.write', NOTE_RECORDING_GONE_MESSAGE);

  const fields = asObject(body, 'Send a JSON object with the note, its visibility and its moment.');
  const text = parseText(fields['text']);
  const parentId = fields['parentId'];

  if (parentId === undefined || parentId === null) {
    const requested = parseTopLevel(fields);
    const row = await insertNote({
      recordingId,
      authorId: actor.id,
      visibility: requested.visibility,
      text,
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

    return { note: bare({ ...row, authorDisplayName: actor.displayName }, actor) };
  }

  const parent = await requireReplyableParent(parentId, recordingId, fields);
  const row = await insertNote({
    recordingId,
    authorId: actor.id,
    // Public in every case ([3.3.3](docs/active-scope/prd.md)): a reply to a note everyone can see,
    // that only its author could see, would be a message to nobody. There is nothing to choose, so
    // nothing here reads what the body asked for beyond refusing an explicit `private`.
    visibility: 'public',
    text,
    parentId: parent.id,
  });

  logger.info('note.write', {
    actorId: actor.id,
    action: 'note.write',
    target: `note:${row.id}`,
    recordingId,
    parentId: parent.id,
  });

  return { note: bare({ ...row, authorDisplayName: actor.displayName }, actor) };
}

/**
 * Correct your own words ([3.5.1](docs/active-scope/prd.md)).
 *
 * **Text alone.** The store's `updateNoteText` takes no other parameter, so
 * [3.5.3](docs/active-scope/prd.md) — a timestamp and a visibility are not editable in either
 * direction — is a fact about the call rather than a rule this function has to remember: a body
 * carrying either is read for its `text` and nothing else. Raising a private note would publish
 * text written in confidence and lowering a public one would strand its replies, so neither is a
 * field the API accepts anywhere.
 *
 * Who may is `note.edit`'s answer, and it carries `requiresOwnership` — which is why an admin
 * editing a note they did not write is refused here with no special case: moderation is deletion,
 * never rewriting somebody's words ([3.6.2](docs/active-scope/prd.md)).
 */
export async function editNote(actor: Actor, noteId: string, body: unknown): Promise<NotePayload> {
  const existing = await requireNote(actor, noteId, 'note.edit');
  authorise(actor, 'note.edit', `note:${noteId}`, {
    kind: 'note',
    id: noteId,
    ownerId: existing.authorId,
  });
  requireStanding(existing, NOTE_ALREADY_REMOVED_MESSAGE);

  const text = parseText(asObject(body, 'Send a JSON object carrying the new text.')['text']);
  const row = await updateNoteText(noteId, text);
  if (row === null) throw ApiError.noteRemoved(NOTE_ALREADY_REMOVED_MESSAGE);

  return { note: await describeOne(row, actor) };
}

/**
 * Take a note down — **your own, or, for an admin, anybody's public one**
 * ([3.5.2](docs/active-scope/prd.md), [3.6.1](docs/active-scope/prd.md)).
 *
 * The two are one route and two policy answers, asked in order (active-scope architecture § 7):
 * the owned `note.delete` first, and `note.moderate` only where it denied. No id is compared here
 * and no role is read — the ownership comparison stays inside the rule table, and which of the two
 * answered is also exactly [3.6.4](docs/active-scope/prd.md)'s audit condition, so an admin
 * deleting their own note takes the owned path and is not logged as moderation.
 *
 * **The delete and the pin-clear are one transaction** ([3.6.9](docs/active-scope/prd.md)). A soft
 * delete never fires a cascade, so the pin has to be cleared by a second statement — and two
 * statements that can half-happen would leave a recording showing a pinned tombstone.
 */
export async function deleteNote(actor: Actor, noteId: string): Promise<NotePayload> {
  const existing = await requireNote(actor, noteId, 'note.delete');

  const moderating = !can(actor, 'note.delete', {
    kind: 'note',
    id: noteId,
    ownerId: existing.authorId,
  });
  if (moderating) {
    authorise(actor, 'note.moderate', `note:${noteId}`);
    // An admin may not reach a private note at all ([3.6.2](docs/active-scope/prd.md)): it is
    // absent from every admin-facing response this scope builds, and moderating one would be
    // acting on something they are not entitled to have seen.
    requirePublic(existing, 'This note is private. Only its author can remove it.');
  }
  requireStanding(existing, NOTE_ALREADY_REMOVED_MESSAGE);

  const row = await withTransaction(async (tx) => {
    const deleted = await softDeleteNote(noteId, actor.id, tx);
    if (deleted === null) return null;
    await unpinNote(noteId, tx);
    return deleted;
  });
  if (row === null) throw ApiError.noteRemoved(NOTE_ALREADY_REMOVED_MESSAGE);

  if (moderating) {
    logger.info('note.moderate', audit(actor, 'note.moderate', `note:${noteId}`));
  }

  return { note: await describeOne(row, actor) };
}

// =================================================================================================
// Reactions
// =================================================================================================

/** Set or replace this member's reaction ([3.4.3](docs/active-scope/prd.md)). */
export async function setReaction(
  actor: Actor,
  noteId: string,
  body: unknown,
): Promise<NotePayload> {
  const existing = await requireReactable(actor, noteId);
  const { emoji } = asObject(body, 'Send a JSON object carrying the emoji.');

  // Compared against the vocabulary's exact string, which is what stops the `❤` / `❤️`
  // variation-selector split: only characters that are already one of the six ever land, so two
  // spellings of one reaction cannot become two rows counted apart.
  if (!isReactionEmoji(emoji)) {
    throw ApiError.invalidInput('That is not one of the reactions this product offers.');
  }

  await setNoteReaction(noteId, actor.id, emoji);
  return { note: await describeOne(existing, actor) };
}

/**
 * Take this member's reaction back ([3.4.4](docs/active-scope/prd.md)).
 *
 * Clearing when nothing is set succeeds. A member pressing the emoji they already chose and a
 * member acting on a screen that has already been cleared asked for the same end state, and both
 * have got it — refusing the second would be reporting a difference the member cannot see.
 */
export async function clearReaction(actor: Actor, noteId: string): Promise<NotePayload> {
  const existing = await requireReactable(actor, noteId);
  await clearNoteReaction(noteId, actor.id);
  return { note: await describeOne(existing, actor) };
}

// =================================================================================================
// Pins
// =================================================================================================

/** Raise a note so the group reads it first ([3.6.5](docs/active-scope/prd.md)). */
export async function pinNoteFor(actor: Actor, noteId: string): Promise<NotePayload> {
  const existing = await requireNote(actor, noteId, 'note.pin');
  authorise(actor, 'note.pin', `note:${noteId}`);
  requireStanding(existing, NOTE_ALREADY_REMOVED_MESSAGE);
  // Only a top-level public note is a thing to raise ([3.6.8](docs/active-scope/prd.md)). A reply
  // has no moment of its own, and a private note is nobody else's to read.
  if (existing.parentId !== null) {
    throw ApiError.invalidInput('A reply cannot be pinned — only the note it hangs under.');
  }
  requirePublic(existing, 'A private note cannot be pinned.');

  await pinNote({ noteId, recordingId: existing.recordingId, pinnedBy: actor.id });
  logger.info('note.pin', audit(actor, 'note.pin', `note:${noteId}`));

  return { note: await describeOne(existing, actor) };
}

/** Lower one raised note, leaving every other pin in place ([3.6.7](docs/active-scope/prd.md)). */
export async function unpinNoteFor(actor: Actor, noteId: string): Promise<NotePayload> {
  const existing = await requireNote(actor, noteId, 'note.unpin');
  authorise(actor, 'note.unpin', `note:${noteId}`);

  await unpinNote(noteId);
  logger.info('note.unpin', audit(actor, 'note.unpin', `note:${noteId}`));

  return { note: await describeOne(existing, actor) };
}

// =================================================================================================
// Reading
// =================================================================================================

/**
 * Everything on this teaching this member may see, in one answer.
 *
 * **One `GET`, one payload** (active-scope architecture § 7): the list, each note's thread, the
 * reactions on both, the reading member's own choice and which notes are pinned come back together,
 * because the transport's markers and the panel's list have to be the same data — a delete that
 * removed a note from one and left its tick on the other is exactly what two sources buy.
 *
 * **Four statements, none of them a wide join.** The notes, the threads under them, the reaction
 * counts aggregated in Postgres, and the pinned ids. A single join would multiply every note by its
 * replies by its reactions and hand the difference back as rows to de-duplicate here.
 *
 * Nothing here re-sorts and nothing here filters: another member's private note is absent because
 * the query never selected it, for every actor including an admin.
 */
export async function readNotesFor(actor: Actor, recordingId: string): Promise<NotesPayload> {
  await requirePublished(actor, recordingId, 'note.read');

  const rows = await listNotesForReader(recordingId, actor.id);
  const replies = await listRepliesForNotes(rows.map((row) => row.id));
  const reactions = await listReactionsForNotes(
    [...rows, ...replies].map((row) => row.id),
    actor.id,
  );
  const pinned = new Set(await listPinnedNoteIds(recordingId));

  const byParent = new Map<string, NoteWithAuthorRow[]>();
  for (const reply of replies) {
    const parentId = reply.parentId ?? '';
    const held = byParent.get(parentId);
    if (held === undefined) byParent.set(parentId, [reply]);
    else held.push(reply);
  }
  const byNote = groupReactions(reactions);

  logger.info('note.read', {
    actorId: actor.id,
    action: 'note.read',
    target: `recording:${recordingId}`,
    notes: rows.length,
  });

  return {
    notes: rows.map((row) => ({
      ...describe(row, actor, byNote, pinned.has(row.id)),
      replies: (byParent.get(row.id) ?? []).map((reply) => describe(reply, actor, byNote, false)),
    })),
  };
}

// =================================================================================================
// The gates, in the order § 8 sets them
// =================================================================================================

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
 * The note this single-note route names, with its teaching's publication already checked.
 *
 * Every route under `/notes/{id}` starts here, so the publication gate applies to a note reached by
 * its own id exactly as it applies to one reached through its recording — a teaching taken down
 * takes its notes' write paths with it.
 *
 * **No privacy condition is applied to the lookup**, deliberately: the refusals this scope owes are
 * stated per actor rather than per visibility — a reply to a private note is `invalid_input` for
 * *every* actor including its author ([3.3.5](docs/active-scope/prd.md)) — and a lookup that hid
 * the row would answer `not_found` to everyone but the author and make one rule give two answers.
 */
async function requireNote(actor: Actor, noteId: string, action: string): Promise<NoteRow> {
  const row = await findNoteById(noteId);
  if (row === null) throw ApiError.notFound('There is no note with that id.');
  await requirePublished(actor, row.recordingId, action);
  return row;
}

/** A note in a state that takes a reaction — everything `PUT` and `DELETE` on it share. */
async function requireReactable(actor: Actor, noteId: string): Promise<NoteRow> {
  const existing = await requireNote(actor, noteId, 'note.react');
  authorise(actor, 'note.react', `note:${noteId}`);
  requireStanding(existing, NOTE_REMOVED_MESSAGE);
  // Private notes take no reactions, for every actor including the author
  // ([3.4.8](docs/active-scope/prd.md)) — there is nobody for a reaction on one to be seen by.
  requirePublic(existing, 'A private note takes no reactions.');
  return existing;
}

/**
 * The note being replied to, or the refusal — every rule
 * [3.3](docs/active-scope/prd.md) puts on a parent, in one place.
 */
async function requireReplyableParent(
  parentId: unknown,
  recordingId: string,
  fields: Record<string, unknown>,
): Promise<NoteRow> {
  if (typeof parentId !== 'string' || parentId.trim() === '') {
    throw ApiError.invalidInput('Give the id of the note being replied to.');
  }
  // Refused before the schema's check constraint reaches it, so the member reads a sentence rather
  // than a constraint violation. The constraint remains the backstop.
  if (fields['visibility'] === 'private') {
    throw ApiError.invalidInput('A reply is always public — a private reply reaches nobody.');
  }

  const parent = await findNoteById(parentId);
  if (parent === null) throw ApiError.invalidInput('There is no note with that id to reply to.');

  // The recording in the path is authoritative ([3.1.5](docs/active-scope/implementation-plan.md)):
  // a parent on another teaching would put a reply in a list its thread does not belong to.
  if (parent.recordingId !== recordingId) {
    throw ApiError.invalidInput('That note is not on this teaching.');
  }
  // One level, and no more. Re-pointing at the grandparent would silently move a member's reply to
  // a conversation they were not answering ([3.3.4](docs/active-scope/prd.md)).
  if (parent.parentId !== null) {
    throw ApiError.invalidInput('A reply cannot be replied to — answer the note it hangs under.');
  }
  requirePublic(parent, 'A private note cannot be replied to.');
  requireStanding(parent, NOTE_REMOVED_WHILE_REPLYING_MESSAGE);

  return parent;
}

/**
 * Refuse an action on a note somebody has already removed
 * ([5.4.1](docs/active-scope/implementation-plan.md)).
 *
 * `note_removed` rather than `invalid_input`, because the request was well-formed against an
 * affordance that was real when it was rendered — a **Reply** control, a reaction pill, an **Edit**
 * entry — and the member is owed a sentence that says the note went away rather than one that says
 * they got the request wrong.
 */
function requireStanding(row: NoteRow, message: string): void {
  if (row.deletedAt !== null) throw ApiError.noteRemoved(message);
}

/** Refuse an action that only a note the whole group can read admits. */
function requirePublic(row: NoteRow, message: string): void {
  if (row.visibility !== 'public') throw ApiError.invalidInput(message);
}

// =================================================================================================
// Describing
// =================================================================================================

/** The reaction rows the store aggregated, keyed by the note they belong to. */
function groupReactions(rows: readonly NoteReactionRow[]): Map<string, NoteReactionRow[]> {
  const byNote = new Map<string, NoteReactionRow[]>();
  for (const row of rows) {
    const held = byNote.get(row.noteId);
    if (held === undefined) byNote.set(row.noteId, [row]);
    else held.push(row);
  }
  return byNote;
}

/**
 * A row as a member is answered.
 *
 * `deletedBy` is dropped here ([3.5.8](docs/active-scope/prd.md)) — this is the boundary the store's
 * "answer what is stored" stops at, and the author of an admin-removed note reads the same tombstone
 * as everybody else.
 *
 * **A tombstone carries nothing but the fact that it is one.** Its text is already `null` — the
 * delete cleared the column — and its reactions are dropped rather than counted
 * ([3.4.10](docs/active-scope/prd.md)): a row of responses to words nobody can read any more is a
 * reaction to nothing.
 */
function describe(
  row: NoteWithAuthorRow,
  reader: Actor,
  byNote: Map<string, NoteReactionRow[]>,
  pinned: boolean,
): NoteView {
  const deleted = row.deletedAt !== null;
  const reactions: ReactionCount[] = deleted
    ? []
    : (byNote.get(row.id) ?? []).map((one) => ({ emoji: one.emoji, count: one.count }));

  return {
    id: row.id,
    timestampMs: row.timestampMs,
    authorDisplayName: row.authorDisplayName,
    visibility: row.visibility,
    // Answered here rather than compared on the client: the server is the side that knows who is
    // reading, and it is the side that already decided which rows this reader may have.
    mine: row.authorId === reader.id,
    text: row.text ?? '',
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
    deleted,
    pinned,
    replies: [],
    reactions,
    myReaction: deleted
      ? null
      : ((byNote.get(row.id) ?? []).find((one) => one.mine)?.emoji ?? null),
  };
}

/**
 * A note the caller has just written to, as it now reads.
 *
 * The three reads a single-note write needs to answer honestly. The client refreshes the whole list
 * after every write anyway, so this exists so the payload is not a shape that *claims* a note has no
 * replies and no reactions when it has both.
 */
async function describeOne(row: NoteRow, actor: Actor): Promise<NoteView> {
  const [replies, reactions, pinned] = await Promise.all([
    listRepliesForNotes([row.id]),
    listReactionsForNotes([row.id], actor.id),
    listPinnedNoteIds(row.recordingId),
  ]);
  const byNote = groupReactions(reactions);
  const authored = { ...row, authorDisplayName: actor.displayName };

  return {
    ...describe(authored, actor, byNote, pinned.includes(row.id)),
    // The author's own name is only right where the actor *is* the author, which is every path that
    // reaches here except an admin's moderation — and that one answers a tombstone, whose author
    // line is replaced by 5.3.3's single line anyway.
    authorDisplayName: row.authorId === actor.id ? actor.displayName : '',
    replies: replies.map((reply) => describe(reply, actor, byNote, false)),
  };
}

/** A freshly written note, before anything can have replied or reacted to it. */
function bare(row: NoteWithAuthorRow, actor: Actor): NoteView {
  return describe(row, actor, new Map(), false);
}

// =================================================================================================
// Reading the body
// =================================================================================================

function asObject(body: unknown, complaint: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) throw ApiError.invalidInput(complaint);
  return body as Record<string, unknown>;
}

/**
 * The text, or the refusal.
 *
 * **Trimmed, then measured** ([3.1.6](docs/active-scope/prd.md)): padding cannot push a real note
 * over the ceiling, and a note of nothing but spaces is a note of nothing. Over-long text is
 * refused rather than truncated — a member who wrote 1,200 characters is owed the refusal, not a
 * silently shortened note they will discover later.
 *
 * One function for the composer, the reply field and the edit form, because
 * [3.3.1](docs/active-scope/prd.md) and [3.5.1](docs/active-scope/prd.md) both say *the rules at
 * 3.1 apply unchanged* — and the only way to mean that is to run the same code.
 */
function parseText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.invalidInput('Write something before saving the note.');
  }
  if (value.trim().length > MAX_NOTE_LENGTH) {
    throw ApiError.invalidInput(`${MAX_NOTE_LENGTH.toLocaleString('en-GB')} characters maximum.`);
  }
  return value.trim();
}

/** The two fields only a top-level note carries: where it sits, and who may read it. */
function parseTopLevel(fields: Record<string, unknown>): {
  readonly visibility: NoteVisibility;
  readonly timestampMs: number;
} {
  const { visibility, timestampMs } = fields;

  if (!isVisibility(visibility)) {
    throw ApiError.invalidInput('Say whether the note is private or public.');
  }
  // `>= 0` and nothing more: no recording's duration is stored anywhere in this product, so there
  // is no ceiling to compare a position against (active-scope prd 3.1.10's second half).
  if (!Number.isInteger(timestampMs) || (timestampMs as number) < 0) {
    throw ApiError.invalidInput('Give the moment as whole milliseconds from the start.');
  }

  return { visibility, timestampMs: timestampMs as number };
}

function isVisibility(value: unknown): value is NoteVisibility {
  return typeof value === 'string' && (NOTE_VISIBILITIES as readonly string[]).includes(value);
}
