/**
 * **The series wire contract** (Story 6).
 *
 * A series is a title, a description and the recordings pointing at it. Everything else a person
 * reads about one — how many recordings it holds and the span of dates they cover — is
 * *computed*, never stored: [4.3](docs/project/prd.md) calls both auto-calculated, and a
 * denormalised count is a second answer to a question one query already answers. So no shape here
 * is a row, and none of them carries a count column.
 *
 * **No artwork field anywhere.** `pages/series-listing.png` and `pages/series-inner.png` both draw
 * cover art; [3.3.3](docs/project/prd.md) is deferred, and a nullable `artworkKey` added "for
 * later" is how deferral quietly stops being deferral.
 *
 * **No duration either**, which is why {@link SeriesView} carries a date range where
 * `pages/series-inner.png` prints `2h 14m total`. [3.3.5](docs/project/prd.md) names title,
 * description, date range and count as what a series carries, and running time is not on that
 * list — the range is the requirement rather than a degraded version of the picture.
 */

import { RECORDINGS_PATH, RECORDING_SURFACE_PARAM, LIBRARY_SURFACE } from './recordings';
import type { TagRef } from './tags';

/** The series collection, relative to the `/api/v1` prefix. */
export const SERIES_PATH = '/series';

/** One series, under the API prefix. Addressed by uuid, like every other resource here. */
export function seriesPath(seriesId: string): string {
  return `${SERIES_PATH}/${seriesId}`;
}

/**
 * The listing as a member reads it — series holding at least one published recording, counted over
 * published recordings only.
 *
 * The same `?surface=library` parameter the recordings list already takes, for the same reason: an
 * admin opening `/series` is asking what the member surface shows, not asking to be answered as an
 * operator. It narrows and never widens.
 */
export const MEMBER_SERIES_PATH = `${SERIES_PATH}?${RECORDING_SURFACE_PARAM}=${LIBRARY_SURFACE}`;

/** One series, as a member reads it. */
export function memberSeriesPath(seriesId: string): string {
  return `${seriesPath(seriesId)}?${RECORDING_SURFACE_PARAM}=${LIBRARY_SURFACE}`;
}

/**
 * **Where a recording's series is set, cleared and moved** — a sub-resource of the *recording*,
 * because what the request changes is the recording. Create, rename and read hang off
 * `/api/v1/series`; this one does not.
 */
export function recordingSeriesPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/series`;
}

/** The member series listing, on the web origin. `pages/series-listing.png`. */
export const MEMBER_SERIES_PAGE_PATH = '/series';

/** One series' page, on the web origin. `pages/series-inner.png`. */
export function seriesPagePath(seriesId: string): string {
  return `${MEMBER_SERIES_PAGE_PATH}/${seriesId}`;
}

/** The console's fifth panel, on the web origin rather than under the API prefix. */
export const ADMIN_SERIES_PAGE_PATH = '/admin/series';

/** Body of `POST /api/v1/series`. The title is required; the description is optional. */
export interface CreateSeriesRequest {
  readonly title: string;
  readonly description?: string | null;
}

/**
 * Body of `PATCH /api/v1/series/{id}`.
 *
 * Both fields together rather than a partial patch of one: the console edits a series in one form
 * with two inputs, and "which of these did you mean to change" is a question a two-field form does
 * not raise.
 */
export interface UpdateSeriesRequest {
  readonly title: string;
  readonly description?: string | null;
}

/**
 * Body of `PUT /api/v1/recordings/{id}/series`.
 *
 * `null` takes the recording out of every series, which is a state
 * [3.3.9](docs/project/prd.md) makes ordinary rather than exceptional — most recordings have no
 * series, and the nullable column is what makes "at most one" a property of the database.
 */
export interface AssignSeriesRequest {
  readonly seriesId: string | null;
}

/**
 * A series, as anyone permitted to see it reads it.
 *
 * `recordingCount` and the two dates are **aggregates over the recordings the caller may see** —
 * so the console's answer for a series and a member's answer for the same series can legitimately
 * differ, and that falls straight out of [3.2.2](docs/project/prd.md). Both dates are `null` for a
 * series with no recordings in it, which is a state the console shows and the member surface never
 * returns.
 */
export interface SeriesView {
  readonly id: string;
  readonly title: string;
  /**
   * **A short-lived signed URL for this series' cover, or `null`** (scope prd 3.1.6; scope tdd 1.4).
   *
   * Minted for this response after the policy check the rest of the row already passed, never
   * stored and never a key: media is not publicly addressable, so a URL with an expiry on it is
   * the only way anything reads a cover. `null` is the ordinary state and every surface renders
   * without artwork rather than reserving an empty frame (scope prd 3.1.7, 3.2.6).
   */
  readonly artworkUrl: string | null;
  readonly description: string | null;
  readonly recordingCount: number;
  /** `YYYY-MM-DD` — the earliest date recorded in the series, or `null` when it holds nothing. */
  readonly firstRecordedAt: string | null;
  /** `YYYY-MM-DD` — the latest. Equal to the first for a series holding one recording. */
  readonly lastRecordedAt: string | null;
  /**
   * The tags an admin put on this series ([4.7](docs/project/prd.md)), alphabetically, and empty
   * for one with none. **Its own, not its recordings'**: a series and each teaching in it are
   * tagged by hand and independently, so nothing here is derived from the rows below it.
   */
  readonly tags: readonly TagRef[];
}

/**
 * One recording as a row of a series page.
 *
 * `positionMs` is **the requesting member's own** stored position and nobody else's — the detail
 * query joins `playback_progress` on `(user_id, recording_id)`. `null` means they have never
 * started it, which is a different answer from zero and the row renders it differently: a started
 * row prints where to resume, an unstarted one prints the date it was recorded.
 *
 * There is no duration and therefore no percentage and no bar, for the same reason the resume card
 * prints elapsed only.
 */
export interface SeriesRecordingView {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  /** `YYYY-MM-DD`. What the series orders by — newest first, as the library does. */
  readonly recordedAt: string;
  readonly positionMs: number | null;
}

/** Payload of `GET /api/v1/series`. */
export interface SeriesListPayload {
  readonly series: readonly SeriesView[];
}

/**
 * Payload of `GET /api/v1/series/{id}`.
 *
 * Recordings come back **newest recorded first**, the same order as the library:
 * [3.3.1](docs/project/prd.md) is the product's one answer to "what is most recent" and a series
 * is no exception to it. The `01.`–`08.` numbering the reference draws is a recording's place in
 * the *study*, so it counts down this list rather than up — a teaching's number is a fact about
 * the study and does not move because the list is read from the other end. It is computed for
 * display and stored nowhere: there is no ordering column, because reordering is deferred.
 */
export interface SeriesPayload {
  readonly series: SeriesView;
  readonly recordings: readonly SeriesRecordingView[];
}


/**
 * **Where a series' cover is granted and finalised** — a sub-resource of the series, because what
 * the request changes is the series (scope tdd 1.3).
 *
 * Two calls, for the reason the recording upload takes two: the bytes never pass through the API.
 * `POST …/artwork/uploads` authorises and answers with a presigned `PUT`; the browser sends the
 * image straight to the store; `PUT …/artwork` names the key and the pointer is written after the
 * store has been asked what actually landed.
 */
export function seriesArtworkPath(seriesId: string): string {
  return `${seriesPath(seriesId)}/artwork`;
}

export function seriesArtworkUploadsPath(seriesId: string): string {
  return `${seriesArtworkPath(seriesId)}/uploads`;
}

/**
 * Body of `POST /api/v1/series/{id}/artwork/uploads`.
 *
 * The same three fields the audio grant takes, and they mean the same things: the filename is
 * logged and never used to build the key, and the size is a **convenience** that fails an oversized
 * request before an upload rather than after one. The authoritative check is the `head` at
 * finalisation, which is the only thing "re-checked server-side" can mean when the API never sees
 * the file.
 */
export interface ArtworkGrantRequest {
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
}

/** Body of `PUT /api/v1/series/{id}/artwork`. The key from the grant, now with bytes behind it. */
export interface SetSeriesArtworkRequest {
  readonly key: string;
}

/**
 * **Where a series' tags are set** ([4.7](docs/project/prd.md)) — a sub-resource of the series,
 * for the reason the artwork is: what the request changes is the series. `PUT` of the whole set,
 * by name; see `SetTagsRequest` in `tags.ts`.
 */
export function seriesTagsPath(seriesId: string): string {
  return `${seriesPath(seriesId)}/tags`;
}
