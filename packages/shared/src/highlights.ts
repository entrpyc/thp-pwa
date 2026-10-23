import { USERS_PATH } from './accounts';

/**
 * **Highlights on the wire** ([3.15](docs/project/prd.md); [4.14](docs/project/prd.md)) — a member's
 * private playlist of the moments that mattered: whole teachings, single lines of them, and notes
 * of their own ([3.12.17](docs/project/prd.md)).
 *
 * Three things live here because the four pin controls, the playlist, the API and the database
 * each have to agree about them:
 *
 * 1. **The kinds.** An entry targets a recording, a segment of one, or a note — exactly the three
 *    [3.15.1](docs/project/prd.md)–[3.15.3](docs/project/prd.md) name — derived into the database's
 *    `highlight_kind` enum rather than restated (tools/domain-declarations.ts registers it).
 * 2. **The ceiling.** A member keeps at most {@link MAX_HIGHLIGHTS}; see the constant for why.
 * 3. **The wire contract** — the paths, the request and the view, so every control renders the
 *    same list the playlist does.
 *
 * **Private by construction** ([3.15.9](docs/project/prd.md)). The routes are under `/users/me`,
 * the shape the blocked list takes: the only playlist anybody may read or change is their own, and
 * a path that could name somebody else's would need an ownership rule to refuse what it should
 * never have been able to express. No admin route lists anybody's highlights, and none will.
 */

// =================================================================================================
// The vocabulary
// =================================================================================================

/**
 * What an entry targets. `segment` is "this moment" — a position the server snaps to the
 * transcript line playing there — and `note` is one of the member's own notes, whose moment is
 * the note's.
 */
export const HIGHLIGHT_KINDS = ['recording', 'segment', 'note'] as const;

export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];

export function isHighlightKind(value: unknown): value is HighlightKind {
  return typeof value === 'string' && (HIGHLIGHT_KINDS as readonly string[]).includes(value);
}

/**
 * **How many entries one member may keep.** Pinning past it is refused with `highlights_full`
 * and a sentence saying to remove some first.
 *
 * A ceiling because the playlist is read whole — the profile page and every pin control fetch the
 * list once and decide pinned state from it — and a list with no bound is a read with no bound. Five
 * hundred is far past what a person curates by hand (a pin a day for over a year) and far short of
 * what a runaway client could write without one.
 */
export const MAX_HIGHLIGHTS = 500;

/**
 * **How near a moment has to be to count as pinned already**, in milliseconds, when the entry
 * could not be snapped to a transcript line (a teaching with no transcript, or a position after
 * its last line). A snapped entry is "pinned" while playback is anywhere inside its line; an
 * unsnapped one has no line, so this window stands in for it. Five seconds: wide enough that the
 * press that pinned and the press that unpins land on the same entry, narrow enough that two
 * distinct moments in one teaching stay two entries.
 */
export const UNSNAPPED_MOMENT_WINDOW_MS = 5_000;

// =================================================================================================
// The routes
// =================================================================================================

/**
 * The signed-in account's playlist, relative to the `/api/v1` prefix. `GET` lists it, newest
 * pinned first; `POST` pins an entry. Both answer the list as it now stands.
 */
export const HIGHLIGHTS_PATH = `${USERS_PATH}/me/highlights`;

/** `DELETE` removes this entry ([3.15.8](docs/project/prd.md)), and answers the list as it now stands. */
export function highlightPath(highlightId: string): string {
  return `${HIGHLIGHTS_PATH}/${highlightId}`;
}

/** The playlist's page on the web origin — the profile's dedicated section ([3.15.5](docs/project/prd.md)). */
export const HIGHLIGHTS_PAGE_PATH = '/profile/highlights';

/**
 * **The address parameter a playlist row opens a teaching with**: `/recordings/{id}?at=<ms>`.
 *
 * Opening a highlight restores *that* moment rather than the member's stored position, and does
 * not start playing ([3.15.7](docs/project/prd.md), [3.2.12](docs/project/prd.md)) — a member who
 * pressed a row has not asked for sound. The parameter is read once, at the recording page's mount,
 * and nothing writes it back; a reload of the address lands on the same moment, which is what a
 * bookmark of a highlight should do.
 */
export const HIGHLIGHT_AT_PARAM = 'at';

// =================================================================================================
// Bodies and payloads
// =================================================================================================

/**
 * Body of `POST /api/v1/users/me/highlights` — which of the three targets, and its id.
 *
 * A segment is pinned by **position**, not by segment id: the control that pins "this moment" is
 * the transport, which knows where playback is and need not have loaded the transcript. The
 * server snaps the position to the line playing there ([3.15.2](docs/project/prd.md)), and the
 * answer carries the line.
 */
export type CreateHighlightRequest =
  | { readonly kind: 'recording'; readonly recordingId: string }
  | { readonly kind: 'segment'; readonly recordingId: string; readonly positionMs: number }
  | { readonly kind: 'note'; readonly noteId: string };

/** The teaching an entry is in, as the playlist row prints it: title, series, and the admin's line about it. */
export interface HighlightRecordingRef {
  readonly id: string;
  readonly title: string;
  /** The admin's description, or `null` — the "brief description" of a whole-recording entry (3.15.6). */
  readonly description: string | null;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  /**
   * The study, with a signed URL to its cover or `null` — the same grant the library row carries,
   * so a playlist row's play control can hand the transport its tile (3.2.4) without opening the
   * teaching's page first.
   */
  readonly series: {
    readonly id: string;
    readonly title: string;
    readonly artworkUrl: string | null;
  } | null;
}

/**
 * The transcript line a segment entry was snapped to, or `null` when there was none to snap to —
 * or when a later transcript run replaced the line. The playlist prints its text as the entry's
 * description; the transport reads its span to know whether the moment playing is this one.
 */
export interface HighlightSegmentRef {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/**
 * One entry, as the playlist and the pin controls read it ([3.15.6](docs/project/prd.md)).
 *
 * `positionMs` is the moment the entry opens at: the line's start for a segment, the note's moment
 * for a note, and `null` for a whole teaching, which opens wherever the member had got to. The
 * note's moment is read off the note at answer time rather than stored twice, so the two cannot
 * disagree.
 */
export interface HighlightView {
  readonly id: string;
  readonly kind: HighlightKind;
  /** ISO 8601 — the date pinned, which the playlist shows and orders by. */
  readonly pinnedAt: string;
  readonly recording: HighlightRecordingRef;
  readonly positionMs: number | null;
  /** Present on a `segment` entry that could be snapped; `null` otherwise. */
  readonly segment: HighlightSegmentRef | null;
  /** Present on a `note` entry: the note's id and its text, which the playlist prints in place of a description. */
  readonly note: { readonly id: string; readonly text: string } | null;
}

/**
 * Payload of `GET /api/v1/users/me/highlights`, and of both writes — the list as it now stands,
 * newest pinned first, so a control never has to merge a write's answer into a list it fetched
 * earlier.
 */
export interface HighlightListPayload {
  readonly highlights: readonly HighlightView[];
}

export const HIGHLIGHTS_FULL_MESSAGE = `Your Highlights hold ${MAX_HIGHLIGHTS} entries already. Remove some to pin more.`;
