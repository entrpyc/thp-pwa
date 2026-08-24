/**
 * **What a note is, said once for the whole repository.**
 *
 * Two things live here because the database, the API and the composer each have to agree about
 * them and the price of disagreement is a member losing what they wrote:
 *
 * 1. **The two visibilities.** `packages/db/src/schema.ts` derives its `note_visibility` enum from
 *    {@link NOTE_VISIBILITIES} rather than restating the values beside it, which is what
 *    tests/guards/domain-declarations.test.ts already enforces for `ROLES` and `PIPELINE_STEPS`.
 * 2. **The character ceiling.** The column's check constraint is derived from
 *    {@link MAX_NOTE_LENGTH}, so a note the composer would accept and the database would refuse is
 *    not a state this product can reach.
 *
 * Below them sits **the wire contract** — the request and payload shapes the notes routes carry,
 * and the one path both of them live at. Here rather than beside the routes because the composer
 * parses exactly what the API promises (active-scope architecture § 4.5).
 */

import { RECORDINGS_PATH } from './recordings';

/**
 * Who may read a note.
 *
 * `private` is the author alone; `public` is everyone in the group. Chosen at creation and
 * immutable afterwards (active-scope prd 3.1.5) — no update path writes this column, which is why
 * there is no third value for "was public, now isn't".
 */
export const NOTE_VISIBILITIES = ['private', 'public'] as const;

export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];

/**
 * The most a note may be (active-scope prd 3.1.6).
 *
 * Counted in characters, which is what the composer counts down from and what
 * `char_length` measures — not bytes, so a note in any script gets the same room.
 */
export const MAX_NOTE_LENGTH = 1_000;

// =================================================================================================
// The wire contract (active-scope architecture § 4.5)
// =================================================================================================

/**
 * A recording's notes — read with `GET`, written with `POST`
 * ([3.2.1](docs/active-scope/prd.md), [3.1.1](docs/active-scope/prd.md)).
 *
 * **One path for both**, because both answer the same question about the same collection: which
 * notes belong to this teaching. The recording in the path is authoritative.
 */
export function recordingNotesPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/notes`;
}

/**
 * **How many of the group chose one glyph** — the aggregate the reaction row renders
 * ([5.4.1](docs/active-scope/prd.md)).
 *
 * Only emoji somebody has actually chosen appear ([3.4.5](docs/active-scope/prd.md)): an emoji at
 * zero is absent from the array rather than present carrying a `0`, so the row has nothing to
 * filter. The glyph travels rather than a key, because a reaction stored under an emoji that has
 * left the vocabulary still counts ([3.4.2](docs/active-scope/prd.md)) — `reactionName` labels it.
 */
export interface ReactionCount {
  readonly emoji: string;
  readonly count: number;
}

/**
 * One note, as the reading member is answered.
 *
 * **`deletedBy` is not here and never will be** ([3.5.8](docs/active-scope/prd.md)) — who removed a
 * note is stored and is not a member's business. This is the shape that drop happens in.
 *
 * **A reply is this same shape.** A reply is a note with a parent ([4.10](docs/project/prd.md)), and
 * every capability this scope adds — reacting to it ([3.4.7](docs/active-scope/prd.md)), editing
 * it, deleting it — applies to both on the same terms, so one card component renders either. What a
 * reply cannot have is said by the field rather than by a second interface: `timestampMs` is null
 * because a reply has no moment of its own ([3.3.2](docs/active-scope/prd.md)), `visibility` is
 * always `public` ([3.3.3](docs/active-scope/prd.md)), `pinned` is always false
 * ([3.6.8](docs/active-scope/prd.md)) and `replies` is always empty, because threads are one level
 * deep ([3.3.4](docs/active-scope/prd.md)).
 *
 * `mine` is derived rather than compared on the client. The server already knows who is reading, so
 * "is this mine" is answered once, on the side that cannot get it wrong — and the **Private** badge
 * ([3.2.2](docs/active-scope/prd.md)), the **Mine** filter ([3.2.3](docs/active-scope/prd.md)) and
 * every author control read one field rather than each re-deriving an identity comparison.
 *
 * `visibility` travels because [5.2.3](docs/active-scope/prd.md)'s badge is drawn from it. It is a
 * field to *render*, never a field to filter by: what a member may see was decided by the query.
 */
export interface NoteView {
  readonly id: string;
  /**
   * Where in the recording it was written, in milliseconds — **null on a reply**, which belongs to
   * its parent's moment rather than to one of its own ([3.3.2](docs/active-scope/prd.md)).
   */
  readonly timestampMs: number | null;
  /** The author's display name ([3.1.12](docs/project/prd.md)). A monogram is drawn from it. */
  readonly authorDisplayName: string;
  readonly visibility: NoteVisibility;
  /** Whether the reading member wrote it. */
  readonly mine: boolean;
  /**
   * The text, or the empty string on a tombstone.
   *
   * A deleted note's text is returned to nobody ([3.5.9](docs/active-scope/prd.md)) — and it is not
   * *withheld* here, it is gone: the delete cleared the column, so there is nothing to withhold.
   */
  readonly text: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601, or `null` until the first edit — what drives the **edited** indicator. */
  readonly editedAt: string | null;
  /**
   * Whether this is a tombstone ([5.3.3](docs/active-scope/prd.md)) — a note that was removed and
   * whose replies are still read under it.
   *
   * It says **that** the note was removed and nothing about **who** removed it
   * ([3.5.8](docs/active-scope/prd.md)); the author of an admin-removed note reads exactly what
   * everyone else reads.
   */
  readonly deleted: boolean;
  /** Whether an admin has raised it above the list ([3.6.5](docs/active-scope/prd.md)). */
  readonly pinned: boolean;
  /** The thread under it, oldest first ([3.3.6](docs/active-scope/prd.md)). Empty is no thread. */
  readonly replies: readonly NoteView[];
  /** Only emoji somebody chose, most-chosen first ([3.4.5](docs/active-scope/prd.md)). */
  readonly reactions: readonly ReactionCount[];
  /** The reading member's own choice, or `null` — what marks their pill and the picker's row. */
  readonly myReaction: string | null;
}

/** Payload of `GET /api/v1/recordings/{id}/notes` — the whole visible set, in one answer. */
export interface NotesPayload {
  readonly notes: readonly NoteView[];
}

/**
 * Body of `POST /api/v1/recordings/{id}/notes`.
 *
 * All three together. The visibility is explicit rather than defaulted server-side, because
 * [3.1.4](docs/active-scope/prd.md) makes choosing it part of writing a note — a body that omitted
 * it would make "the member did not choose" and "the client forgot" the same request.
 */
export interface CreateNoteRequest {
  readonly text: string;
  readonly visibility: NoteVisibility;
  readonly timestampMs: number;
}

/**
 * Body of `POST /api/v1/recordings/{id}/notes` **when it is a reply**
 * ([3.3.1](docs/active-scope/prd.md)).
 *
 * One create route, not two (active-scope architecture § 7): a reply is a note with a parent, and a
 * second route would be a second validation path for one set of text rules. So the body carries the
 * parent instead of the moment — a reply has no moment of its own — and the visibility is not the
 * writer's to choose, because a reply is always public ([3.3.3](docs/active-scope/prd.md)).
 */
export interface CreateReplyRequest {
  readonly text: string;
  readonly parentId: string;
}

/** Payload of the create — the note as it now reads, ready to be listed. */
export interface CreateNotePayload {
  readonly note: NoteView;
}

/**
 * What a member is told when the teaching goes away underneath their composer
 * ([3.1.11](docs/active-scope/prd.md), [5.1.4](docs/active-scope/prd.md)).
 *
 * One statement for the same reason {@link MAX_NOTE_LENGTH} is one: the API refuses with it and the
 * composer prints it beside text the member has not lost, and the two saying different things is a
 * member reading a refusal that does not match what happened.
 */
export const NOTE_RECORDING_GONE_MESSAGE =
  "This teaching isn't available any more, so the note can't be saved.";

// =================================================================================================
// The single-note routes (active-scope architecture § 4.4)
// =================================================================================================

/** `PATCH` to edit ([3.5.1](docs/active-scope/prd.md)), `DELETE` to take down (3.5.2). */
export function notePath(noteId: string): string {
  return `/notes/${noteId}`;
}

/** `PUT` to set or replace, `DELETE` to clear ([3.4.3](docs/active-scope/prd.md), 3.4.4). */
export function noteReactionPath(noteId: string): string {
  return `${notePath(noteId)}/reaction`;
}

/**
 * `PUT` to raise, `DELETE` to lower ([3.6.5](docs/active-scope/prd.md), 3.6.7).
 *
 * Addressed on the **note** rather than on the recording, because with any number of pins allowed a
 * recording no longer has *a* pin to `PUT` (active-scope architecture § 4.4).
 */
export function notePinPath(noteId: string): string {
  return `${notePath(noteId)}/pin`;
}

/**
 * Body of `PATCH /api/v1/notes/{id}` — **text and nothing else**
 * ([3.5.3](docs/active-scope/prd.md)).
 *
 * There is no `timestampMs` and no `visibility` here, and their absence is the requirement rather
 * than an omission: raising a private note would publish text written in confidence, and lowering a
 * public one would strand the replies other members wrote under it.
 */
export interface EditNoteRequest {
  readonly text: string;
}

/** Body of `PUT /api/v1/notes/{id}/reaction` — one of the six, exactly as the vocabulary spells it. */
export interface SetReactionRequest {
  readonly emoji: string;
}

/** Payload of every single-note write — the note as it now reads, ready to replace its card. */
export interface NotePayload {
  readonly note: NoteView;
}

// =================================================================================================
// What a member is told
// =================================================================================================

/**
 * The four sentences a member reads when a note went away underneath their screen
 * ([5.3.4](docs/active-scope/prd.md), [5.4.3](docs/active-scope/prd.md),
 * [5.5.4](docs/active-scope/prd.md)).
 *
 * Here rather than beside each component for the reason {@link NOTE_RECORDING_GONE_MESSAGE} is
 * here: the API refuses with `note_removed` and the client prints one of these, and the two saying
 * different things is a member reading a refusal that does not match what happened.
 *
 * Three sentences rather than one, because the member was doing three different things and the
 * one that matters most — a reply — has to say **why their text is still in the field**.
 */
export const NOTE_REMOVED_WHILE_REPLYING_MESSAGE = 'This note was removed while you were writing.';

export const NOTE_REMOVED_MESSAGE = 'This note was removed.';

export const NOTE_ALREADY_REMOVED_MESSAGE = 'This note has already been removed.';
