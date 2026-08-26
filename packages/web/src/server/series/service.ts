import {
  findRecordingById,
  findSeriesById,
  findVisibleSeries,
  insertSeries,
  listVisibleSeries,
  setRecordingSeries,
  setSeriesArtwork,
  updateSeries,
  type SeriesRow,
  type VisibleSeriesRow,
} from '@thp/db';
import {
  ACCEPTED_ARTWORK_LABEL,
  MAX_ARTWORK_BYTES,
  MAX_ARTWORK_LABEL,
  describeBytes,
  isAcceptedArtworkType,
  type ArtworkGrantRequest,
  type AssignSeriesRequest,
  type CreateSeriesRequest,
  type SeriesPayload,
  type SeriesRecordingView,
  type SeriesView,
  type SetSeriesArtworkRequest,
  type UpdateSeriesRequest,
  type UploadGrantPayload,
} from '@thp/shared';
import { UPLOAD_GRANT_SECONDS, mediaStore, mintArtworkKey } from '@thp/media';
import { ApiError } from '@/server/api/errors';
import { can, type Actor } from '@/server/auth/policy';
import { audit } from '@/server/observability/audit';
import { logger } from '@/server/observability/logger';
import { mintArtworkGrant } from '@/server/series/artwork-grant';
import type { Surface } from '@/server/recordings/service';

/**
 * **Series — three writes and two reads** (Story 6).
 *
 * The writes are the whole of [3.3.6](docs/project/prd.md) minus what it defers: create, rename,
 * move, and — since scope plan 1.2 — setting the cover. There is no delete and no reorder and no
 * merge; each of those has a named home and none of them is here.
 *
 * **The cover arrives in two calls and one `PUT` that never touches this process**, exactly as a
 * recording's audio does (scope tdd 1.3): grant, then the browser sends the bytes straight to the
 * store, then finalise. What makes it safe is what the finalisation is allowed to believe — the
 * declared size in the grant is a convenience that fails an oversized request early, and the
 * authoritative check is the `head` against the store's own metadata.
 *
 * **The one property worth stating up front: assigning a recording writes one column.** Not the
 * title, not the date, not the description, not the summary, not the transcript, not the jobs, not
 * the publication state — and not `playback_progress`, which is keyed on `(user_id, recording_id)`
 * and is not in any statement this file makes. "Moving a recording loses nothing" is therefore a
 * property of the write rather than of the test that checks it, and the test checks it anyway,
 * because the assertion is what will still be true after somebody adds a cascade nobody thought
 * about.
 *
 * **What decides who may read a series is not here**, exactly as with recordings: `@thp/db`'s
 * visibility module owns the condition and tests/guards/visibility-boundary.test.ts refuses a
 * second copy of it. This file passes it a boolean.
 */

/**
 * The most a field can be before we stop reading it — **the same generic ceiling every other route
 * applies**, and it covers the description as well as the title.
 *
 * A larger one for the description would be a rule nobody asked for. What `pages/series-inner.png`
 * shows is two lines of blurb; if a longer one is ever wanted, that is a criterion in a ticket
 * rather than a number widened here.
 */
const MAX_FIELD_LENGTH = 512;

/**
 * Whether this read answers the console's question or a member's — the same two conditions the
 * recordings list already applies, and the member surface wins for the same reason: an admin
 * opening `/series` is asking what the member surface shows.
 */
function readsAsOperator(actor: Actor, surface: Surface): boolean {
  return surface.memberSurface === true ? false : can(actor, 'series.list');
}

/**
 * A freshly written series, as the admin who wrote it reads it back: nothing in it yet.
 *
 * Async since the cover arrived, because a `SeriesView` carries a signed URL rather than a key and
 * signing is the store's answer, not this function's. A creation has no cover by construction; a
 * rename reads this too, and its `artworkKey` is whatever the series already had — which is what
 * stops a rename blanking the cover in the response it answers with.
 */
async function describeNew(row: SeriesRow): Promise<SeriesView> {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    artworkUrl: await mintArtworkGrant(row.artworkKey),
    recordingCount: 0,
    firstRecordedAt: null,
    lastRecordedAt: null,
  };
}

async function describe(row: VisibleSeriesRow): Promise<SeriesView> {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    artworkUrl: await mintArtworkGrant(row.artworkKey),
    recordingCount: row.recordingCount,
    firstRecordedAt: row.firstRecordedAt,
    lastRecordedAt: row.lastRecordedAt,
  };
}

/**
 * Create a series ([3.3.2](docs/project/prd.md), [3.19.5](docs/project/prd.md)).
 *
 * The title is trimmed and required, and a blank one is refused **before a row exists** — which is
 * what makes "the series list is unchanged" the honest form of the assertion. The description is
 * optional and an empty one is stored as `null`, so there is one representation of "nothing
 * written here" rather than two.
 *
 * **Two series may share a title.** Nothing in [3.3](docs/project/prd.md) makes a title an
 * identifier, and a uniqueness rule nobody asked for is a rule somebody has to discover.
 */
export async function createSeries(actor: Actor, body: unknown): Promise<SeriesView> {
  const requested = parseWrite(body, 'Give the series a title.');
  const row = await insertSeries(requested);

  logger.info('series.create', audit(actor, 'series.create', `series:${row.id}`));

  return await describeNew(row);
}

/**
 * Rename a series and rewrite its description ([3.3.6](docs/project/prd.md)).
 *
 * **The recordings in it are not read and not written.** A rename is a write of the `series` row
 * and nothing beside it, which is why nothing about a teaching can change as a side effect of one.
 */
export async function renameSeries(
  actor: Actor,
  id: string,
  body: unknown,
): Promise<SeriesView> {
  const requested = parseWrite(body, 'Give the series a title.');
  const row = await updateSeries(id, requested);
  if (row === null) throw notFound();

  logger.info('series.update', audit(actor, 'series.update', `series:${id}`));

  return await describeNew(row);
}

/**
 * Put a recording into a series, move it to another, or take it out
 * ([3.3.2](docs/project/prd.md), [3.3.9](docs/project/prd.md)).
 *
 * The series is looked up before the write so a series id that does not exist is a refusal the
 * caller reads rather than a foreign-key error, **and the recording keeps whatever it had** — the
 * lookup happens before any update statement runs.
 */
export async function assignRecordingSeries(
  actor: Actor,
  recordingId: string,
  body: unknown,
): Promise<{ readonly id: string; readonly seriesId: string | null }> {
  const seriesId = parseAssignment(body);

  if ((await findRecordingById(recordingId)) === null) {
    throw ApiError.notFound('There is no recording with that id.');
  }
  if (seriesId !== null && (await findSeriesById(seriesId)) === null) {
    throw notFound();
  }

  const row = await setRecordingSeries(recordingId, seriesId);
  if (row === null) throw ApiError.notFound('There is no recording with that id.');

  logger.info('series.assign', {
    ...audit(actor, 'series.assign', `series:${seriesId ?? 'none'}`),
    recordingId,
    seriesId,
  });

  return row;
}

/**
 * **One route, one answer to "which series may this person see"** — the shape
 * `GET /api/v1/recordings` already settled.
 *
 * `series.browse` is what admits the caller; whether they *also* satisfy `series.list` decides
 * whether unpublished recordings are counted and whether a series holding nothing comes back at
 * all. The member surface parameter narrows an admin to the member's answer and can never widen a
 * member to the console's.
 */
export async function listSeriesFor(
  actor: Actor,
  surface: Surface = {},
): Promise<SeriesView[]> {
  const asOperator = readsAsOperator(actor, surface);
  const rows = await listVisibleSeries({ includeUnpublished: asOperator });

  logger.info('series.browse', {
    actorId: actor.id,
    action: 'series.browse',
    target: 'series:*',
    count: rows.length,
    asOperator,
  });

  return Promise.all(rows.map(describe));
}

/**
 * One series and the recordings in it, or a refusal.
 *
 * **A series holding nothing this member may see is refused identically to one that never
 * existed** — same status, same code, same message — so the API does not report which ids exist.
 */
export async function readSeriesFor(
  actor: Actor,
  id: string,
  surface: Surface = {},
): Promise<SeriesPayload> {
  const asOperator = readsAsOperator(actor, surface);
  const found = await findVisibleSeries(id, actor.id, { includeUnpublished: asOperator });

  if (found === null) {
    logger.warn('series.browse.refused', {
      actorId: actor.id,
      action: 'series.browse',
      target: `series:${id}`,
      reason: 'not-visible',
      code: 'not_found',
    });
    throw notFound();
  }

  logger.info('series.browse', {
    actorId: actor.id,
    action: 'series.browse',
    target: `series:${id}`,
    asOperator,
  });

  const recordings: SeriesRecordingView[] = found.recordings.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    recordedAt: row.recordedAt,
    positionMs: row.positionMs,
  }));

  return { series: await describe(found.series), recordings };
}

/**
 * **Permission to send the cover, and nothing else** (scope prd 3.1.3; scope tdd 1.3).
 *
 * The recording upload's grant, one resource down, and it earns its shape the same way: every
 * refusal happens **before the store is asked for anything**, so a rejected format or an oversized
 * declaration costs a request and leaves no URL behind. An error carrying a presigned `PUT` is an
 * error a client could ignore.
 *
 * The series is looked up first so a grant is never minted against an id that does not exist — a
 * key in the bucket for nothing is an orphan nobody can even name the owner of.
 */
export async function grantArtworkUpload(
  actor: Actor,
  seriesId: string,
  body: unknown,
): Promise<UploadGrantPayload> {
  const requested = parseArtworkGrantRequest(body);

  if ((await findSeriesById(seriesId)) === null) throw notFound();

  const key = mintArtworkKey(requested.contentType);
  const expiresAt = new Date(Date.now() + UPLOAD_GRANT_SECONDS * 1000);
  const url = await mediaStore().presignPut({
    key,
    contentType: requested.contentType,
    expiresInSeconds: UPLOAD_GRANT_SECONDS,
  });

  logger.info('series.artwork.granted', {
    ...audit(actor, 'series.artwork', `series:${seriesId}`),
    mediaKey: key,
    // What the person chose it as, so an operator reading the log can tell which upload this was.
    // It is not what the key is built from — see `mintArtworkKey`.
    filename: requested.filename,
    contentType: requested.contentType,
    declaredSize: requested.size,
  });

  return { url, key, contentType: requested.contentType, expiresAt: expiresAt.toISOString() };
}

/**
 * **Point the series at the cover that landed** (scope prd 3.1.4, 3.1.5).
 *
 * The order is the finalisation's whole argument. The key is read first, so a malformed request is
 * refused without a round trip to the store; then **the store is asked what is actually behind
 * it**, because that is the only thing "re-checked server-side" can mean when the API never sees
 * the file; and only then is the pointer written. A client that declared 1 KB and uploaded 3 MB
 * gets a grant it cannot finalise.
 *
 * **Every refusal leaves the series' cover exactly as it was.** Nothing is written before all three
 * checks pass, so there is no state in which a series has half a cover — it has the one it had, or
 * the new one, and no third answer. The object behind a refused key stays in the bucket, invisible,
 * for the same reason a refused audio finalisation's does: there is nothing to delete it with.
 */
export async function setArtwork(
  actor: Actor,
  seriesId: string,
  body: unknown,
): Promise<SeriesView> {
  const key = parseArtworkKey(body);

  const stored = await mediaStore().head(key);
  if (stored === null) {
    throw refuseArtwork(
      actor,
      seriesId,
      'nothing-at-key',
      'That upload did not finish. Choose the image again and re-upload it.',
    );
  }
  if (stored.size > MAX_ARTWORK_BYTES) {
    throw refuseArtwork(
      actor,
      seriesId,
      'over-ceiling',
      `The image that arrived is ${describeBytes(stored.size)}; the limit is ${MAX_ARTWORK_LABEL}.`,
    );
  }
  if (!isAcceptedArtworkType(stored.contentType)) {
    throw refuseArtwork(
      actor,
      seriesId,
      'unaccepted-content-type',
      `The file that arrived is not an image this accepts. Upload ${ACCEPTED_ARTWORK_LABEL}.`,
    );
  }

  const row = await setSeriesArtwork(seriesId, key);
  if (row === null) throw notFound();

  logger.info('series.artwork', {
    ...audit(actor, 'series.artwork', `series:${seriesId}`),
    mediaKey: key,
    size: stored.size,
    contentType: stored.contentType,
  });

  const found = await findSeriesById(seriesId);
  if (found === null) throw notFound();
  return await describeNew(found);
}

function refuseArtwork(
  actor: Actor,
  seriesId: string,
  reason: string,
  message: string,
): ApiError {
  logger.warn('series.artwork.refused', {
    ...audit(actor, 'series.artwork', `series:${seriesId}`),
    reason,
    code: 'invalid_input',
  });
  return ApiError.invalidInput(message);
}

function parseArtworkGrantRequest(body: unknown): {
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
} {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a filename, a content type and a size.');
  }
  const { filename, contentType, size } = body as Partial<ArtworkGrantRequest>;

  if (typeof filename !== 'string' || filename.trim() === '' || filename.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Name the image you are uploading.');
  }
  if (typeof contentType !== 'string' || !isAcceptedArtworkType(contentType)) {
    throw ApiError.invalidInput(
      `That is not an image this accepts. Upload ${ACCEPTED_ARTWORK_LABEL}.`,
    );
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw ApiError.invalidInput('Say how large the image is, in bytes.');
  }
  if (size > MAX_ARTWORK_BYTES) {
    throw ApiError.invalidInput(
      `That image is ${describeBytes(size)}; the limit is ${MAX_ARTWORK_LABEL}.`,
    );
  }

  return { filename: filename.trim(), contentType: contentType.trim().toLowerCase(), size };
}

function parseArtworkKey(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the key of the upload.');
  }
  const { key } = body as Partial<SetSeriesArtworkRequest>;
  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Name the upload this cover is for.');
  }
  return key.trim();
}

function notFound(): ApiError {
  return ApiError.notFound('There is no such series.');
}

/** The body of both writes — they take the same two fields, so they read the same one. */
function parseWrite(
  body: unknown,
  complaint: string,
): { readonly title: string; readonly description: string | null } {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a title and an optional description.');
  }
  const { title, description } = body as Partial<CreateSeriesRequest & UpdateSeriesRequest>;

  if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput(complaint);
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string' || description.length > MAX_FIELD_LENGTH) {
      throw ApiError.invalidInput('That description is longer than this can store.');
    }
  }

  const trimmed = typeof description === 'string' ? description.trim() : '';
  return { title: title.trim(), description: trimmed === '' ? null : trimmed };
}

function parseAssignment(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a series id, or null to clear it.');
  }
  const { seriesId } = body as Partial<AssignSeriesRequest>;
  if (seriesId === null) return null;
  if (typeof seriesId !== 'string' || seriesId.trim() === '') {
    throw ApiError.invalidInput('Name the series, or send null to take the recording out of one.');
  }
  return seriesId.trim();
}
