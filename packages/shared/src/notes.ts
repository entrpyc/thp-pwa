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
 * One note, as the reading member is answered.
 *
 * **`deletedBy` is not here and never will be** ([3.5.8](docs/active-scope/prd.md)) — who removed a
 * note is stored and is not a member's business. This is the shape that drop happens in.
 *
 * `mine` is derived rather than compared on the client. The server already knows who is reading, so
 * "is this mine" is answered once, on the side that cannot get it wrong — and the **Private** badge
 * ([3.2.2](docs/active-scope/prd.md)), the **Mine** filter ([3.2.3](docs/active-scope/prd.md)) and
 * every later author control read one field rather than each re-deriving an identity comparison.
 *
 * `visibility` travels because [5.2.3](docs/active-scope/prd.md)'s badge is drawn from it. It is a
 * field to *render*, never a field to filter by: what a member may see was decided by the query.
 */
export interface NoteView {
  readonly id: string;
  /** Where in the recording it was written, in milliseconds. */
  readonly timestampMs: number;
  /** The author's display name ([3.1.12](docs/project/prd.md)). A monogram is drawn from it. */
  readonly authorDisplayName: string;
  readonly visibility: NoteVisibility;
  /** Whether the reading member wrote it. */
  readonly mine: boolean;
  readonly text: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601, or `null` until the first edit — what drives the **edited** indicator. */
  readonly editedAt: string | null;
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
