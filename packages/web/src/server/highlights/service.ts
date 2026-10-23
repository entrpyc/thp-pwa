import {
  countHighlightsForMember,
  deleteHighlightForMember,
  findHighlightByTarget,
  findNoteById,
  findSegmentAt,
  findVisibleRecording,
  insertHighlight,
  listHighlightsForMember,
  type HighlightListRow,
  type NewHighlight,
} from '@thp/db';
import {
  HIGHLIGHTS_FULL_MESSAGE,
  MAX_HIGHLIGHTS,
  isHighlightKind,
  type HighlightListPayload,
  type HighlightView,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';
import { mintArtworkGrant } from '@/server/series/artwork-grant';

/**
 * **A member's Highlights** ([3.15](docs/project/prd.md)) — reading the playlist, pinning to it,
 * removing from it.
 *
 * Who may is the policy module's answer, asked by the routes (`highlight.list`,
 * `highlight.create`, `highlight.remove`), and every one of the three is the caller's own list by
 * construction: nothing in the path names whose. What this module decides is what a pin may
 * target — a teaching the member can see, a line of one, a note of their own — and what every
 * write answers.
 *
 * **Every write answers the list as it now stands**, the shape every note write and the blocked
 * list take: a control that pressed Pin renders what came back rather than merging a verdict into
 * a list it fetched earlier, and four controls on four screens cannot disagree about what is pinned.
 *
 * **Refusals say nothing about what exists.** A teaching the member may not see, a note that is
 * not theirs, and an id that is nobody's are all `not_found` with the same sentence — the rule
 * the recording read path already keeps, applied to the one route that takes ids from a body.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_SUCH_TEACHING = 'That teaching is not available.';
const NO_SUCH_NOTE = 'That note is not one of yours.';

export async function listHighlightsFor(actor: Actor): Promise<HighlightListPayload> {
  const rows = await listHighlightsForMember(actor.id);
  return { highlights: await Promise.all(rows.map(describe)) };
}

/**
 * **Pin an entry**, from the body a control sent.
 *
 * The body is validated here rather than typed through, because it is the one highlights route
 * that reads ids a client wrote: a kind that is not one of the three, an id that is not a uuid, or
 * a position that is not a whole non-negative number of milliseconds is `invalid_input` before it
 * reaches a statement.
 *
 * Then, by kind:
 *
 * - **`recording`** — the teaching must be visible to the member (published), which is the one
 *   check the recording page itself makes; the entry is the teaching.
 * - **`segment`** — the same, and the position is **snapped** to the transcript line playing
 *   there ([3.15.2](docs/project/prd.md)): the entry stores the line's start and its id, so two
 *   presses during one sentence are one entry and the playlist can print the sentence. A moment
 *   with no line under it — no transcript, or silence after the last line — is stored as the raw
 *   position with no line; the playlist prints the moment and the transport treats a press within
 *   a few seconds as the same entry.
 * - **`note`** — the note must exist, be standing, and be **the member's own**
 *   ([3.12.17](docs/project/prd.md)); and its teaching must be visible, for the reason the notes
 *   read path refuses an unpublished one. Anything else is `not_found` with one sentence, so the
 *   route cannot be used to learn whether a private note's id exists.
 *
 * The ceiling is checked before the write and not inside a lock: two pins racing at the limit can
 * land the member one over it, which costs nothing and is corrected by the next remove. Pinning
 * what is already pinned is a success that changes nothing and does not count against the
 * ceiling, so a member at the limit can still re-press a control they have already pressed.
 */
export async function pinHighlightFor(actor: Actor, body: unknown): Promise<HighlightListPayload> {
  const input = await resolveTarget(actor, body);

  const held = await countHighlightsForMember(actor.id);
  if (held >= MAX_HIGHLIGHTS) {
    // The one press that is not refused at the ceiling: a duplicate, which would write nothing.
    if ((await findHighlightByTarget(input)) !== null) return listHighlightsFor(actor);
    throw ApiError.highlightsFull(HIGHLIGHTS_FULL_MESSAGE);
  }

  const created = await insertHighlight(input);
  log(actor, input, created);
  return listHighlightsFor(actor);
}

/**
 * Remove an entry ([3.15.8](docs/project/prd.md)). An id that is not on the member's list — never
 * was, already removed, or somebody else's — succeeds and changes nothing: the member asked for an
 * end state and has it, and a refusal would be the one way to learn that an id is somebody else's.
 * Only a malformed id is refused, because it is not an end state anybody can be in.
 */
export async function removeHighlightFor(
  actor: Actor,
  highlightId: string,
): Promise<HighlightListPayload> {
  const id = parseId(highlightId, 'That is not a highlight id.');
  const removed = await deleteHighlightForMember(id, actor.id);
  logger.info('highlight.remove', {
    actorId: actor.id,
    action: 'highlight.remove',
    target: `highlight:${id}`,
    removed,
  });
  return listHighlightsFor(actor);
}

// =================================================================================================
// Resolving a target
// =================================================================================================

async function resolveTarget(actor: Actor, body: unknown): Promise<NewHighlight> {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('The body must say what to pin.');
  }
  const { kind } = body as { kind?: unknown };
  if (!isHighlightKind(kind)) {
    throw ApiError.invalidInput('kind must be recording, segment or note.');
  }

  if (kind === 'note') {
    const noteId = parseId((body as { noteId?: unknown }).noteId, 'noteId must be a note id.');
    const row = await findNoteById(noteId);
    // One sentence for every way this is not pinnable, so nothing about another member's note —
    // not even that the id exists — is learned here. A reply is refused too: it has no moment of
    // its own ([3.12.7](docs/project/prd.md)), and a playlist entry is a moment.
    if (
      row === null ||
      row.deletedAt !== null ||
      row.authorId !== actor.id ||
      row.timestampMs === null
    ) {
      throw ApiError.notFound(NO_SUCH_NOTE);
    }
    await requireVisible(row.recordingId);
    return { userId: actor.id, recordingId: row.recordingId, kind, noteId: row.id };
  }

  const recordingId = parseId(
    (body as { recordingId?: unknown }).recordingId,
    'recordingId must be a recording id.',
  );
  await requireVisible(recordingId);

  if (kind === 'recording') {
    return { userId: actor.id, recordingId, kind };
  }

  const { positionMs } = body as { positionMs?: unknown };
  if (typeof positionMs !== 'number' || !Number.isInteger(positionMs) || positionMs < 0) {
    throw ApiError.invalidInput('positionMs must be a whole number of milliseconds, zero or more.');
  }
  const line = await findSegmentAt(recordingId, positionMs);
  return line === null
    ? { userId: actor.id, recordingId, kind, positionMs }
    : { userId: actor.id, recordingId, kind, positionMs: line.startMs, segmentId: line.id };
}

/** The teaching is published for this member, or the refusal that says nothing about why. */
async function requireVisible(recordingId: string): Promise<void> {
  const row = await findVisibleRecording(recordingId, { includeUnpublished: false });
  if (row === null) throw ApiError.notFound(NO_SUCH_TEACHING);
}

/** The id as a uuid, or the refusal — before it reaches a statement that would throw on it. */
function parseId(value: unknown, message: string): string {
  if (typeof value !== 'string') throw ApiError.invalidInput(message);
  const trimmed = value.trim();
  if (!UUID.test(trimmed)) throw ApiError.invalidInput(message);
  return trimmed.toLowerCase();
}

function log(actor: Actor, input: NewHighlight, created: boolean): void {
  logger.info('highlight.create', {
    actorId: actor.id,
    action: 'highlight.create',
    target:
      input.kind === 'note'
        ? `note:${input.noteId}`
        : `recording:${input.recordingId}${input.kind === 'segment' ? `@${input.positionMs}` : ''}`,
    kind: input.kind,
    created,
  });
}

// =================================================================================================
// Describing
// =================================================================================================

/**
 * One row as the wire shows it. The note's moment is the note's; a snapped line's moment is the
 * stored position, which is the line's start by construction; a whole teaching has none.
 */
async function describe(row: HighlightListRow): Promise<HighlightView> {
  const segment =
    row.segmentStartMs !== null && row.segmentEndMs !== null && row.segmentText !== null
      ? { startMs: row.segmentStartMs, endMs: row.segmentEndMs, text: row.segmentText }
      : null;
  return {
    id: row.id,
    kind: row.kind,
    pinnedAt: row.createdAt.toISOString(),
    recording: {
      id: row.recordingId,
      title: row.recordingTitle,
      description: row.recordingDescription,
      recordedAt: row.recordedAt,
      series:
        row.seriesId !== null && row.seriesTitle !== null
          ? {
              id: row.seriesId,
              title: row.seriesTitle,
              // Signed here and never a key on the wire — the same grant the library row carries.
              artworkUrl: await mintArtworkGrant(row.seriesArtworkKey),
            }
          : null,
    },
    positionMs: row.kind === 'note' ? row.noteTimestampMs : row.positionMs,
    segment,
    note: row.noteId !== null ? { id: row.noteId, text: row.noteText ?? '' } : null,
  };
}

export { HIGHLIGHTS_FULL_MESSAGE };
