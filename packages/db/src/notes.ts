import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDatabase, queryable, type Executor } from './client';
import { noBlockBetween } from './member-blocks';
import { note, noteImage, notePin, noteReaction, recording, series, user } from './schema';
import { recordingIsPublished } from './visibility';
import type { NoteVisibility } from '@thp/shared';

/**
 * **The private-note condition, written once** — `visibility = 'public' or author_id = :me`.
 *
 * Every statement against `note` lives here, and this module is the only place in the codebase
 * allowed to decide which notes a given reader may see. tests/guards/note-privacy.test.ts refuses a
 * predicate over `note.visibility` or `note.author_id` anywhere else, which is what turns the
 * Privacy NFR — *"a private note is excluded by the query that reads notes, not by the interface
 * that renders them"* — from a claim into something a build can fail on.
 *
 * **The block condition rides beside it on every read for a reader.** A note, a reply or a
 * reaction by a member the reader has a block with — in either direction — is left out by the
 * same `where` that leaves out a private note, through `member-blocks.ts`'s one predicate rather
 * than a second filter somewhere above. The three reads that take a `readerId` state it; the
 * write-path lookups (`findNoteById`) do not, for the reason given on them: the service refuses
 * an act across a block with a sentence, and a lookup that hid the row would answer `not_found`
 * instead.
 *
 * **What is not here is publication.** No statement in this file compares `recording.published_at`:
 * that is `visibility.ts`'s condition and tests/guards/visibility-boundary.test.ts refuses a second
 * copy of it. This module is handed a recording id the service has already gated, and it answers
 * *which rows*, never *may this person* — authorisation is the policy module's.
 *
 * **Crosses its boundary as row types in and row types out**, plus an {@link Executor} so a caller
 * can pull a write into a transaction — the same shape `transcripts.ts` and `playback.ts` already
 * take. Drizzle never leaves the package.
 */

/**
 * One `note` row.
 *
 * Every stored column except the two generated ones. `is_reply` and `parent_is_reply` are how the
 * one-level rule becomes a row the database cannot hold (active-scope architecture § 6.1) — they
 * are the table's plumbing and nothing outside it has a reason to read them, which is why the reads
 * below name their columns rather than selecting everything.
 *
 * `deletedBy` is on the row because the store answers what is stored. It is never sent to a member
 * (scope prd 3.5.8) — the wire contract is where it is dropped, not here.
 */
export interface NoteRow {
  readonly id: string;
  readonly recordingId: string;
  readonly authorId: string;
  /** The note this one replies to. Non-null exactly on replies. */
  readonly parentId: string | null;
  /** Where in the recording it was written, in milliseconds. Non-null exactly on top-level notes. */
  readonly timestampMs: number | null;
  readonly visibility: NoteVisibility;
  /** Null exactly when the row is a tombstone. */
  readonly text: string | null;
  readonly createdAt: Date;
  /** Null until the first edit; what drives the **edited** indicator. */
  readonly editedAt: Date | null;
  /** Presence is what makes a row a tombstone. */
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
}

/**
 * A note row plus **the one thing about its author a reader is shown** — the display name
 * (scope prd 3.2.8).
 *
 * Joined here rather than gathered by the caller because this module owns every statement against
 * `note` and a read that answers a list is one statement or it is N+1. A deactivated account still
 * matches: deactivation ends access, not authorship (scope prd 3.2.9).
 */
export interface NoteWithAuthorRow extends NoteRow {
  readonly authorDisplayName: string;
  /**
   * The author's avatar key, or `null`. Joined for the reason the name is — one statement, not
   * N+1 — and signed into a URL by the service, never handed to a client as it is.
   */
  readonly authorAvatarKey: string | null;
}

/** A note as a writer supplies it. The id and the timestamps are the table's business. */
export interface NewNote {
  readonly recordingId: string;
  readonly authorId: string;
  readonly visibility: NoteVisibility;
  readonly text: string;
  /** A moment in the recording, on a top-level note. Omitted on a reply. */
  readonly timestampMs?: number | null;
  /** The note being replied to. Omitted on a top-level note. */
  readonly parentId?: string | null;
}

/** The columns every read below returns — named, so the generated pair stays inside the table. */
const NOTE_COLUMNS = {
  id: note.id,
  recordingId: note.recordingId,
  authorId: note.authorId,
  parentId: note.parentId,
  timestampMs: note.timestampMs,
  visibility: note.visibility,
  text: note.text,
  createdAt: note.createdAt,
  editedAt: note.editedAt,
  deletedAt: note.deletedAt,
  deletedBy: note.deletedBy,
} as const;

/**
 * Write a note and answer the row that was written.
 *
 * Takes an executor rather than a handle, like every write since Ticket 02, so a caller with more
 * than one statement to make — the pin-clear and the delete that
 * scope prd 3.6.9 will not let happen separately — can pull this into its
 * transaction.
 *
 * **Nothing is checked here.** The shape rules are the table's: a top-level note without a position
 * and a reply carrying one, a reply to a reply, a private reply and text over the ceiling are each
 * refused by Postgres (active-scope architecture § 6.1), and the state rules are the service's.
 */
export async function insertNote(
  input: NewNote,
  executor: Executor = getDatabase(),
): Promise<NoteRow> {
  const rows = await queryable(executor)
    .insert(note)
    .values({
      recordingId: input.recordingId,
      authorId: input.authorId,
      visibility: input.visibility,
      text: input.text,
      timestampMs: input.timestampMs ?? null,
      parentId: input.parentId ?? null,
    })
    .returning(NOTE_COLUMNS);

  const row = rows[0] as NoteRow | undefined;
  if (!row) throw new Error('insertNote returned no row');
  return row;
}

/**
 * **The private-note condition, as a predicate**: a note is readable by `readerId` when it is
 * public or their own. This is the one statement of it in the codebase — tools/note-privacy.ts
 * fails the build on a comparison over `note.visibility` or `note.author_id` anywhere else — so a
 * read that joins notes from outside this module (the highlights list, which carries a highlighted
 * note's text) applies this rather than spelling the rule again.
 *
 * The block condition is deliberately not folded in: that rule is member-blocks.ts's to state, and
 * each reader applies it beside this one in the direction its own list needs.
 *
 * The return type is left to inference: this is a store module, and tools/import-boundary.ts keeps
 * a Drizzle type out of a store module's signatures. The only callers are the other store modules,
 * which hand it straight back to `and()`.
 */
export function noteReadableBy(readerId: string) {
  return or(eq(note.visibility, 'public'), eq(note.authorId, readerId));
}

/**
 * A recording's notes **as this reader may see them** — every public note on it, plus that reader's
 * own private ones, and no other member's private note in any position
 * (scope prd 3.1.9).
 *
 * The condition is stated here rather than applied to a set somebody else selected, which is the
 * whole reason this is a module: a caller that hands over a pre-filtered list has already made the
 * decision this file exists to own, and an admin asking is not a caller the condition bends for.
 *
 * **Ordered by position, then by when it was written** — the `(recording_id, timestamp_ms,
 * created_at)` index exactly, so scope prd 3.2.1's order is one index scan and is
 * total: two notes at the same moment come back oldest-first, every time, rather than in whatever
 * order the rows happen to be on disk.
 *
 * **Top-level only.** A reply has no position, so it has no place in a list ordered by one; the
 * thread under a note is its own read and arrives with replies.
 *
 * **The tombstone rule is here too** (scope prd 3.5.4): a removed note comes back
 * only while a live reply still hangs off it, so the conversation other members wrote survives its
 * parent. A removed note with nothing under it is simply not in the list — and because the markers
 * derive from this same set, its tick leaves the transport in the same breath rather than being a
 * second thing somebody has to remember to clear.
 *
 * **The author's display name comes back with the row.** An inner join rather than a second pass
 * over the ids the first pass returned: `author_id` is `not null` and restricts on delete, so every
 * note has an author row to join to and the join can drop nothing.
 *
 * **A note by a member the reader has a block with is not in the list**, whichever of the two
 * placed the block — and its whole thread goes with it, because the replies are read by the
 * parents that survived. The reader's own reply under such a note disappears from their view
 * too, which is the honest outcome: a reply with no note above it is half a conversation.
 */
export async function listNotesForReader(
  recordingId: string,
  readerId: string,
  executor: Executor = getDatabase(),
): Promise<NoteWithAuthorRow[]> {
  const rows = await queryable(executor)
    .select({
      ...NOTE_COLUMNS,
      authorDisplayName: user.displayName,
      authorAvatarKey: user.avatarKey,
    })
    .from(note)
    .innerJoin(user, eq(note.authorId, user.id))
    .where(
      and(
        eq(note.recordingId, recordingId),
        isNull(note.parentId),
        // The private-note condition — stated once, in `noteReadableBy`, and applied here.
        noteReadableBy(readerId),
        // The block condition, in both directions, stated through the one module that owns it.
        noBlockBetween(readerId, note.authorId),
        // The tombstone rule: still standing only while it is holding a thread open.
        or(isNull(note.deletedAt), hasLiveReply(readerId)),
      ),
    )
    .orderBy(asc(note.timestampMs), asc(note.createdAt));

  return rows as NoteWithAuthorRow[];
}

/**
 * A note row with its author **and the teaching it sits on** — what the member's own notes page
 * prints above each card. The series is left-joined for the reason the library's rows do it: a
 * recording in no series is the ordinary case.
 */
export interface NoteOnRecordingRow extends NoteWithAuthorRow {
  readonly recordingTitle: string;
  readonly seriesId: string | null;
  readonly seriesTitle: string | null;
}

const NOTE_ON_RECORDING_COLUMNS = {
  ...NOTE_COLUMNS,
  authorDisplayName: user.displayName,
  authorAvatarKey: user.avatarKey,
  recordingTitle: recording.title,
  seriesId: series.id,
  seriesTitle: series.title,
} as const;

/**
 * **Everything one member wrote, across every teaching** — their top-level notes and their
 * replies alike, newest first — for the *My notes* page.
 *
 * Here rather than beside the page's route because it is the author half of the privacy
 * condition as a read: *this author's* rows, of both visibilities. Nobody else's note is in the
 * answer, so the public half has nothing to exclude.
 *
 * **Only standing notes on published teachings.** A removed note is nobody's any more — its text
 * is gone (scope prd 3.5.9) — and a teaching that was taken down takes its notes' read paths
 * with it, which is the line `visibility.ts` draws and the Highlights list follows. The gate is
 * spelled there and consumed here. Neither is deleted by this read: a republished teaching brings
 * its notes back.
 *
 * The thread a reply belongs to is a second read — {@link listThreadRootsForReader} — because the
 * parent is somebody else's note, and *that* read is where the full condition has to be stated.
 */
export async function listNotesByAuthor(
  authorId: string,
  executor: Executor = getDatabase(),
): Promise<NoteOnRecordingRow[]> {
  const rows = await queryable(executor)
    .select(NOTE_ON_RECORDING_COLUMNS)
    .from(note)
    .innerJoin(user, eq(note.authorId, user.id))
    .innerJoin(recording, eq(recording.id, note.recordingId))
    .leftJoin(series, eq(series.id, recording.seriesId))
    .where(and(eq(note.authorId, authorId), isNull(note.deletedAt), recordingIsPublished()))
    .orderBy(desc(note.createdAt), desc(note.id));

  return rows as NoteOnRecordingRow[];
}

/**
 * **The top-level notes these ids name, as this reader may see them** — the threads a member's
 * replies hang under, read for the *My notes* page.
 *
 * The same condition {@link listNotesForReader} states, applied to a set of ids rather than to a
 * teaching: public, or the reader's own; no block either way; and a tombstone **is** returned,
 * because a reply the member wrote under a since-removed note still has a thread to be shown in,
 * and the tombstone is what holds it (scope prd 3.5.4). A parent by a member the reader has a
 * block with is left out, and the reader's own reply under it goes with it — the recording page
 * shows exactly the same, for the reason given there.
 *
 * Only published teachings, for the reason {@link listNotesByAuthor} gives.
 */
export async function listThreadRootsForReader(
  noteIds: readonly string[],
  readerId: string,
  executor: Executor = getDatabase(),
): Promise<NoteOnRecordingRow[]> {
  if (noteIds.length === 0) return [];

  const rows = await queryable(executor)
    .select(NOTE_ON_RECORDING_COLUMNS)
    .from(note)
    .innerJoin(user, eq(note.authorId, user.id))
    .innerJoin(recording, eq(recording.id, note.recordingId))
    .leftJoin(series, eq(series.id, recording.seriesId))
    .where(
      and(
        inArray(note.id, [...noteIds]),
        isNull(note.parentId),
        // The private-note condition, for a read keyed by id rather than by teaching.
        or(eq(note.visibility, 'public'), eq(note.authorId, readerId)),
        noBlockBetween(readerId, note.authorId),
        recordingIsPublished(),
      ),
    );

  return rows as NoteOnRecordingRow[];
}

/**
 * Whether this note still has a reply nobody has deleted **that this reader may see**.
 *
 * A correlated `exists` rather than a join or a second pass: the list read is one index scan and
 * this keeps it one, and the answer is needed as a *condition* rather than as data — the caller
 * never sees how many replies there are, only whether the tombstone still stands
 * (scope prd 3.3.9).
 *
 * Reader-aware because the tombstone exists to hold a thread open, and a thread whose every live
 * reply is by a member the reader has blocked is, to that reader, no thread: the tombstone would
 * stand over an empty list, and its tick would mark a moment with nothing at it.
 */
function hasLiveReply(readerId: string) {
  const reply = alias(note, 'live_reply');
  return exists(
    queryable()
      .select({ one: sql`1` })
      .from(reply)
      .where(
        and(
          eq(reply.parentId, note.id),
          isNull(reply.deletedAt),
          noBlockBetween(readerId, reply.authorId),
        ),
      ),
  );
}

/**
 * One note by id, **with no privacy condition applied**.
 *
 * That is not an oversight and it is not a hole: every caller is the service asking *what state is
 * this note in* before refusing an action on it, and the answers it must give are stated per actor
 * rather than per visibility. A reply to a private note is refused `invalid_input` **for every
 * actor including its own author** (scope prd 3.3.5), and so is a reaction to one
 * (scope prd 3.4.8) — a lookup that hid the row would answer `not_found` to
 * everyone but the author and make the refusal disagree with itself.
 *
 * Which notes a member may **read** is still {@link listNotesForReader}'s answer and nothing
 * else's. This is a write path's precondition, not a read.
 */
export async function findNoteById(
  id: string,
  executor: Executor = getDatabase(),
): Promise<NoteRow | null> {
  const rows = await queryable(executor).select(NOTE_COLUMNS).from(note).where(eq(note.id, id));
  return (rows[0] as NoteRow | undefined) ?? null;
}

/**
 * The threads under these notes, oldest first — **and no deleted reply at all**
 * (scope prd 3.3.10).
 *
 * A second read rather than a widening of {@link listNotesForReader}, exactly as Task 1.2 settled:
 * a reply carries no position and has no place in a list ordered by one, so folding the two into
 * one statement would mean ordering a list by a column half its rows do not have.
 *
 * **No privacy condition, and that is the table's doing rather than an exception.**
 * `note_reply_is_public` refuses a private reply outright, so the public half of the condition is
 * true of every row this could return and stating it would be a predicate that can never exclude
 * anything. The parent's own visibility is what decides whether a thread is reachable at all, and
 * the parent came from the read that does state the condition.
 *
 * **The block condition is stated, though**, because a reply has an author of its own: a thread
 * under a note the reader may see can still hold a reply by somebody they have a block with, and
 * that reply is left out here for the same reader the parent read was for.
 */
export async function listRepliesForNotes(
  parentIds: readonly string[],
  readerId: string,
  executor: Executor = getDatabase(),
): Promise<NoteWithAuthorRow[]> {
  if (parentIds.length === 0) return [];

  const rows = await queryable(executor)
    .select({
      ...NOTE_COLUMNS,
      authorDisplayName: user.displayName,
      authorAvatarKey: user.avatarKey,
    })
    .from(note)
    .innerJoin(user, eq(note.authorId, user.id))
    .where(
      and(
        inArray(note.parentId, [...parentIds]),
        isNull(note.deletedAt),
        noBlockBetween(readerId, note.authorId),
      ),
    )
    // The `(parent_id, created_at)` index exactly — the thread's order (3.3.6).
    .orderBy(asc(note.parentId), asc(note.createdAt));

  return rows as NoteWithAuthorRow[];
}

/**
 * Put new words in a note, and mark it edited.
 *
 * **Text and `edited_at`, and nothing else** (scope prd 3.5.3): there is no
 * parameter here for a position or a visibility, so "editing changes text alone" is a fact about
 * this function's signature rather than a rule a caller has to respect. No prior text is kept —
 * scope prd 3.5.1 says an edit is permanent and has no history, so a revision
 * row would be building the undo the requirement refuses.
 *
 * A note already removed answers `null` rather than coming back to life, which is how the service
 * tells scope prd 3.5.7's refusal from a success.
 */
export async function updateNoteText(
  id: string,
  text: string,
  executor: Executor = getDatabase(),
): Promise<NoteRow | null> {
  const rows = await queryable(executor)
    .update(note)
    .set({ text, editedAt: new Date() })
    .where(and(eq(note.id, id), isNull(note.deletedAt)))
    .returning(NOTE_COLUMNS);
  return (rows[0] as NoteRow | undefined) ?? null;
}

/**
 * Take a note down: `deleted_at`, `deleted_by`, and **`text` cleared to null**.
 *
 * The clear is the decision (active-scope architecture § 7). scope prd 3.5.9 says
 * a deleted note's text is returned to nobody — its author and an admin included — and text nothing
 * may read is content with no reader and a standing disclosure risk. Clearing it makes that true by
 * construction rather than by every future query remembering; the row, the authorship, the moment
 * and the thread all survive, which is what scope prd 3.3.9 actually needs.
 *
 * `deleted_at is null` in the where clause is what makes a second delete answer `null` rather than
 * silently re-stamping a tombstone with a new remover and a new time.
 */
export async function softDeleteNote(
  id: string,
  deletedBy: string,
  executor: Executor = getDatabase(),
): Promise<NoteRow | null> {
  const rows = await queryable(executor)
    .update(note)
    .set({ deletedAt: new Date(), deletedBy, text: null })
    .where(and(eq(note.id, id), isNull(note.deletedAt)))
    .returning(NOTE_COLUMNS);
  return (rows[0] as NoteRow | undefined) ?? null;
}

// =================================================================================================
// Reactions (active-scope architecture § 6.2)
// =================================================================================================

/** How many of the group chose one glyph on one note, and whether the reader is among them. */
export interface NoteReactionRow {
  readonly noteId: string;
  readonly emoji: string;
  readonly count: number;
  readonly mine: boolean;
}

/**
 * Set this member's reaction, replacing whatever they had chosen before.
 *
 * **`on conflict (note_id, user_id) do update` rather than delete-then-insert**, which is the whole
 * of scope prd 3.4.3 and scope prd 3.4.11: a member pressing
 * twice in a second settles on their last selection because the second statement overwrites the
 * first, and two members reacting in the same instant are two rows that cannot collide because the
 * key holds them apart. Neither is a read-then-write the interface has to get right.
 */
export async function setNoteReaction(
  noteId: string,
  userId: string,
  emoji: string,
  executor: Executor = getDatabase(),
): Promise<void> {
  await queryable(executor)
    .insert(noteReaction)
    .values({ noteId, userId, emoji })
    .onConflictDoUpdate({
      target: [noteReaction.noteId, noteReaction.userId],
      set: { emoji, reactedAt: new Date() },
    });
}

/**
 * Take this member's reaction back.
 *
 * Deleting nothing is a success, not an error (scope prd 3.4.4): a member who
 * presses the emoji they already chose and a member acting on a screen that has already been
 * cleared both asked for the same end state, and both have got it.
 */
export async function clearNoteReaction(
  noteId: string,
  userId: string,
  executor: Executor = getDatabase(),
): Promise<void> {
  await queryable(executor)
    .delete(noteReaction)
    .where(and(eq(noteReaction.noteId, noteId), eq(noteReaction.userId, userId)));
}

/**
 * The reaction row for a set of notes — **aggregated in Postgres, not joined wide**.
 *
 * The alternative is one row per reaction travelling to the service to be counted there, which for
 * a well-used teaching is the largest thing on the wire and is a count Postgres will do faster.
 * Only emoji somebody actually chose come back, which is scope prd 3.4.5: an
 * emoji nobody chose has no row to group.
 *
 * **Most-chosen first, ties broken by the glyph**, so a reload does not reshuffle a row of equal
 * counts under a reader's eye.
 *
 * **A reaction by a member the reader has a block with is not counted** — left out before the
 * aggregate rather than subtracted after it, so the count the reader sees is the count of
 * responses from people they can see. An emoji chosen only by blocked members has no row.
 */
export async function listReactionsForNotes(
  noteIds: readonly string[],
  readerId: string,
  executor: Executor = getDatabase(),
): Promise<NoteReactionRow[]> {
  if (noteIds.length === 0) return [];

  const rows = await queryable(executor)
    .select({
      noteId: noteReaction.noteId,
      emoji: noteReaction.emoji,
      count: sql<number>`count(*)::int`,
      mine: sql<boolean>`bool_or(${noteReaction.userId} = ${readerId})`,
    })
    .from(noteReaction)
    .where(
      and(
        inArray(noteReaction.noteId, [...noteIds]),
        noBlockBetween(readerId, noteReaction.userId),
      ),
    )
    .groupBy(noteReaction.noteId, noteReaction.emoji)
    .orderBy(desc(sql`count(*)`), asc(noteReaction.emoji));

  return rows as NoteReactionRow[];
}

// =================================================================================================
// Pins (active-scope architecture § 6.3)
// =================================================================================================

/**
 * Raise a note, or leave it raised.
 *
 * One `on conflict (note_id) do nothing`, which is scope prd 3.6.6 exactly:
 * pinning something already pinned succeeds and changes nothing, so an admin acting on a stale
 * screen has still got what they asked for rather than a refusal for having been slow.
 *
 * `recording_id` is supplied by the caller and checked by the composite foreign key — a pin naming
 * a note on another recording has no key to match, so the denormalised column cannot drift from the
 * note's own.
 */
export async function pinNote(
  input: { readonly noteId: string; readonly recordingId: string; readonly pinnedBy: string },
  executor: Executor = getDatabase(),
): Promise<void> {
  await queryable(executor)
    .insert(notePin)
    .values({ noteId: input.noteId, recordingId: input.recordingId, pinnedBy: input.pinnedBy })
    .onConflictDoNothing({ target: notePin.noteId });
}

/**
 * Lower one raised note, leaving every other pin on the recording where it is
 * (scope prd 3.6.7).
 *
 * Also what scope prd 3.6.9's delete calls, inside the delete's own transaction:
 * a soft delete never fires a cascade, so clearing the pin is a second statement rather than a
 * foreign key, and a recording never shows a pinned tombstone.
 */
export async function unpinNote(noteId: string, executor: Executor = getDatabase()): Promise<void> {
  await queryable(executor).delete(notePin).where(eq(notePin.noteId, noteId));
}

/** Which of these notes an admin has raised — the pin read for a list that spans teachings. */
export async function listPinnedNoteIdsAmong(
  noteIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<string[]> {
  if (noteIds.length === 0) return [];
  const rows = await queryable(executor)
    .select({ noteId: notePin.noteId })
    .from(notePin)
    .where(inArray(notePin.noteId, [...noteIds]));
  return rows.map((row) => row.noteId);
}

/** Which of this recording's notes an admin has raised. The `(recording_id)` index exactly. */
export async function listPinnedNoteIds(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<string[]> {
  const rows = await queryable(executor)
    .select({ noteId: notePin.noteId })
    .from(notePin)
    .where(eq(notePin.recordingId, recordingId));
  return rows.map((row) => row.noteId);
}

// =================================================================================================
// Account deletion (README.md beside the schema; [3.1.9](docs/project/prd.md), [3.1.10](docs/project/prd.md))
// =================================================================================================

/** What became of one author's notes when their account was deleted. */
/**
 * The keys of every picture on this author's **private** notes ([3.12.22](docs/project/prd.md)) —
 * read before account deletion hard-deletes those notes, so the objects can be removed after the
 * commit (README.md beside the schema). Public notes keep their pictures, as they keep their
 * words. Here rather than in `note-images.ts` because it states the private-note condition, and
 * this module is the one place that may.
 */
export async function listPrivateNoteImageKeysOfAuthor(
  authorId: string,
  executor: Executor = getDatabase(),
): Promise<string[]> {
  const rows = await queryable(executor)
    .select({ mediaKey: noteImage.mediaKey })
    .from(noteImage)
    .innerJoin(note, eq(noteImage.noteId, note.id))
    .where(and(eq(note.authorId, authorId), eq(note.visibility, 'private')));
  return rows.map((one) => one.mediaKey);
}

export interface ReassignedNotes {
  /** Ids of the private notes that were deleted outright — for the caller to take their vectors with. */
  readonly deletedPrivateNoteIds: readonly string[];
  /** Public top-level notes now attributed to the placeholder. */
  readonly retainedPublicNotes: number;
  /** Public replies now attributed to the placeholder. */
  readonly retainedPublicReplies: number;
}

/**
 * **Move one author's notes out from under their account**, ahead of the row being deleted.
 *
 * Here and nowhere else, because both statements are predicates over `note.visibility` and
 * `note.author_id` — the two halves of the private-note condition this module alone may state
 * (tests/guards/note-privacy.test.ts). An erasure written beside the account code would be a
 * second place deciding which notes are private.
 *
 * Two statements, in this order:
 *
 * 1. **Private notes are deleted.** A private note is the person's own study and goes with them
 *    (3.1.9). A hard delete rather than a tombstone: a tombstone exists to hold a thread's shape,
 *    and a private note never has a thread (`note_reply_is_public`). Reactions cannot exist on one
 *    either, so nothing cascades that anybody would miss. The ids come back so the caller can take
 *    the vectors in the same transaction — the owner cascade on `embedding` fires when the account
 *    row goes, but a caller should not have to know that to be correct.
 * 2. **Public notes are re-pointed at the placeholder.** Every remaining row by this author — live
 *    notes, live replies and tombstones alike — now names the placeholder as its author, which is
 *    what lets the account row be deleted under a `restrict` key and what keeps every thread
 *    coherent (3.1.10). The text is untouched: a public note was written to the group, and the
 *    person leaving does not un-say it. `deleted_by` is left alone on purpose; the set-null fires
 *    when the row goes, exactly as it would for any departed moderator.
 *
 * The counts are what the confirmation screen tells the person was kept.
 */
export async function reassignNotesOfDeletedAuthor(
  authorId: string,
  placeholderId: string,
  executor: Executor = getDatabase(),
): Promise<ReassignedNotes> {
  const db = queryable(executor);

  const deleted = await db
    .delete(note)
    // The private half of the condition, as a write. The one place it may be written.
    .where(and(eq(note.authorId, authorId), eq(note.visibility, 'private')))
    .returning({ id: note.id });

  const reassigned = await db
    .update(note)
    .set({ authorId: placeholderId })
    .where(eq(note.authorId, authorId))
    .returning({ parentId: note.parentId });

  return {
    deletedPrivateNoteIds: deleted.map((row) => row.id),
    retainedPublicNotes: reassigned.filter((row) => row.parentId === null).length,
    retainedPublicReplies: reassigned.filter((row) => row.parentId !== null).length,
  };
}

/** One note as the embed step sees it: its words, and who alone may find them. */
export interface EmbeddableNoteRow {
  readonly id: string;
  readonly text: string;
  /** The author, on a private note; `null` on a public one, which any member may find. */
  readonly ownerUserId: string | null;
}

/**
 * Every live note on a recording, for the `embed` step — **public and private alike, with the
 * private ones carrying their owner.**
 *
 * This is the one read in the file that is not *for a reader*, and it is here rather than in
 * `embeddings.ts` because it states half of the privacy condition: which notes are private and
 * whose they are. The step copies that answer onto the vector's `owner_user_id`, and
 * `visibility.ts` then applies it as [3.10.9](docs/project/prd.md)'s `where` — so the rule a
 * search enforces is read off `note` exactly once, here, rather than re-derived by a worker.
 *
 * Tombstones are left out: a removed note's text is returned to nobody
 * ([3.12.19](docs/project/prd.md)), and its vector goes with it.
 */
export async function listNotesForEmbedding(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<EmbeddableNoteRow[]> {
  const rows = await queryable(executor)
    .select({
      id: note.id,
      text: sql<string>`${note.text}`,
      ownerUserId: sql<
        string | null
      >`case when ${note.visibility} = 'private' then ${note.authorId} end`,
    })
    .from(note)
    .where(and(eq(note.recordingId, recordingId), isNull(note.deletedAt), isNotNull(note.text)))
    .orderBy(asc(note.createdAt), asc(note.id));
  return rows as EmbeddableNoteRow[];
}
