/**
 * **Playback, as the wire and the six steps of the speed control see it.**
 *
 * Three things live here because more than one process has to agree about them, and the price of
 * disagreement is a member noticing:
 *
 * 1. **The six speeds** ([3.2.4](docs/project/prd.md)). The control renders them, the API refuses
 *    anything else, and `packages/db/src/schema.ts` derives its check constraint from the same
 *    tuple — so the column cannot hold a rate no control can produce, and adding a seventh step is
 *    one edit here plus one migration rather than a search of the codebase.
 * 2. **The floor under a stored position.** Five seconds, applied by the client that decides to
 *    write and by the API that accepts the write, so "opening a teaching and closing it does not
 *    create a resume point" is true whichever end is asked.
 * 3. **One timecode formatter.** The transport bar, the resume card and anything later that prints
 *    an offset all read the same function, because two formatters is how `1:05` and `01:05` end up
 *    on the same screen.
 *
 * **No shape in this file carries an object key**, and only one carries a URL: the signed `GET`
 * that {@link PlaybackGrantPayload} is, which is minted per request and expires. The bucket is
 * never publicly addressable ([§6](docs/project/prd.md) Security).
 */

import { RECORDINGS_PATH } from './recordings';

/**
 * The seven steps, in the order the control renders them ([3.2.4](docs/project/prd.md)).
 *
 * A tuple rather than a range: the reference draws a pill cycling through named values, and a
 * continuous rate is a different control answering a different question. `1` is the default and is
 * deliberately spelled `1` rather than `1.0` — it is the number the column defaults to.
 *
 * `1.75` joined the six in a later pass. The gap between `1.5` and `2` was the widest on the scale
 * and the one a listener working through a long teaching lands in, so the step goes where the
 * cycling order already puts it rather than at the end.
 */
export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/** What every account starts at, and what the column defaults to. */
export const DEFAULT_PLAYBACK_SPEED = 1;

export function isPlaybackSpeed(value: unknown): value is PlaybackSpeed {
  return typeof value === 'number' && (PLAYBACK_SPEEDS as readonly number[]).includes(value);
}

/** `1.5x`. Trailing zeros dropped, because `0.50x` reads as precision nobody asked for. */
export function formatPlaybackSpeed(speed: number): string {
  return `${speed}x`;
}

/**
 * The step after this one, wrapping. The control is a single pill rather than a menu — the whole of
 * `bottom-navigation/default.png` gives it one tap target — so "next" is the entire interaction.
 */
export function nextPlaybackSpeed(speed: number): PlaybackSpeed {
  const index = (PLAYBACK_SPEEDS as readonly number[]).indexOf(speed);
  return PLAYBACK_SPEEDS[(index + 1) % PLAYBACK_SPEEDS.length] ?? DEFAULT_PLAYBACK_SPEED;
}

/**
 * **Below this, a position is not a resume point.** Opening a teaching, hearing three seconds of it
 * and closing the tab should leave nothing behind — otherwise the landing offers a card that
 * resumes at the very beginning, which is worse than no card.
 *
 * Applied by the client before it writes and by the API before it stores, so the rule holds whether
 * the write came from this product's player or from anything else holding a session.
 */
export const MIN_STORED_POSITION_MS = 5_000;

/**
 * **The now-playing view** — `pages/player.png`, opened from the docked transport
 * ([3.3.1](docs/scope/prd.md)).
 *
 * A page path rather than an API path, and it lives here rather than in `recordings.ts` because
 * what the route shows is *the playback session* rather than any one teaching: there is no id in
 * it, and there could not be — the address means "whatever is playing", which is the only thing
 * that keeps it truthful after the member opens a second teaching.
 *
 * A route under the member layout, so the `<audio>` element and the transport that owns it stay
 * mounted across the transition ([3.3.4](docs/scope/prd.md); scope tdd 1.6).
 */
export const NOW_PLAYING_PAGE_PATH = '/now-playing';

/** Where a member asks for a signed `GET` to hear a recording with. */
export function recordingPlaybackPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/playback`;
}

/** Where this member's position in one recording is read and written. */
export function recordingProgressPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/progress`;
}

/**
 * Where the landing asks what to offer to resume.
 *
 * A static segment under the recordings collection rather than a top-level `/playback` resource:
 * what it answers *is* a recording, and this epic's whole playback surface hangs off the two
 * resources that already exist.
 */
export const RESUME_PATH = `${RECORDINGS_PATH}/resume`;

/** Where the signed-in account's preferred speed is written. `me`, never an id in the path. */
export const PLAYBACK_SPEED_PATH = '/users/me/playback-speed';

/**
 * Payload of `GET /api/v1/recordings/{id}/playback`.
 *
 * `url` is a presigned `GET` bound to the object and good until `expiresAt`. **The key is not
 * here** — a client that could name the object could ask for it again after the recording was
 * unpublished, and the whole point of the grant is that the authorisation check happened before it
 * was signed.
 */
export interface PlaybackGrantPayload {
  readonly url: string;
  /** ISO 8601. The client re-requests before this rather than after, so a listen is not interrupted. */
  readonly expiresAt: string;
}

/** Body of `PUT /api/v1/users/me/playback-speed`. One of {@link PLAYBACK_SPEEDS}. */
export interface PlaybackSpeedRequest {
  readonly speed: number;
}

/** Payload of the same. What the account now plays at, whatever was asked for. */
export interface PlaybackSpeedPayload {
  readonly speed: number;
}

/** Body of `PUT /api/v1/recordings/{id}/progress`. Milliseconds, matching `segment`'s offsets. */
export interface PlaybackProgressRequest {
  readonly positionMs: number;
}

/**
 * Payload of `GET` and `PUT` on the progress resource.
 *
 * `null` on both fields means this member has no stored position in this recording — which is a
 * different answer from zero, and the recording page treats it as one: nothing to seek to.
 */
export interface PlaybackProgressPayload {
  readonly positionMs: number | null;
  /** ISO 8601, or `null`. */
  readonly updatedAt: string | null;
}

/**
 * The teaching the landing offers to pick back up ([3.2.5](docs/project/prd.md)).
 *
 * **Elapsed only, and no duration** — `pages/dashboard.png` prints `01:23 / 02:30` and the second
 * half of that is not a number this epic has anywhere: nothing inspects the media, `recording` has
 * no `duration` column, and the player learns the total from the element once it has loaded. So the
 * card says where the member got to and nothing about how far that is through.
 */
export interface ResumeView {
  readonly recordingId: string;
  readonly title: string;
  readonly description: string | null;
  readonly positionMs: number;
  /**
   * The series this teaching is in, or `null` for one in none.
   *
   * Here because the landing **opens this into the transport** rather than only drawing a card off
   * it: the bar's tile is the series' cover and the line under the title is the series' name, and a
   * recording has neither of its own (scope prd 3.2.3, 3.2.4). Without them the bar restored on a
   * cold load would be a plainer bar than the same teaching opened from its own page.
   */
  readonly seriesTitle: string | null;
  readonly artworkUrl: string | null;
}

/** Payload of `GET /api/v1/recordings/resume`. `null` when there is nothing to resume. */
export interface ResumePayload {
  readonly resume: ResumeView | null;
}

/**
 * `mm:ss`, rolling to `h:mm:ss` past an hour — **the one formatter**, so the transport bar's
 * elapsed, its total and the resume card's position cannot spell the same offset three ways.
 *
 * Negative and non-finite inputs floor to zero rather than throwing: a media element reports `NaN`
 * for the duration of a source it has not loaded yet, and a player that crashed on that would
 * crash on every first paint.
 */
export function formatTimecode(milliseconds: number): string {
  const total = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
