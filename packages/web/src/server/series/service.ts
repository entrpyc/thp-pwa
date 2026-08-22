import {
  findRecordingById,
  findSeriesById,
  findVisibleSeries,
  insertSeries,
  listVisibleSeries,
  setRecordingSeries,
  updateSeries,
  type SeriesRow,
  type VisibleSeriesRow,
} from '@thp/db';
import type {
  AssignSeriesRequest,
  CreateSeriesRequest,
  SeriesPayload,
  SeriesRecordingView,
  SeriesView,
  UpdateSeriesRequest,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { can, type Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';
import type { Surface } from '@/server/recordings/service';

/**
 * **Series — three writes and two reads** (Story 6).
 *
 * The writes are the whole of [3.3.6](docs/project/prd.md) minus what it defers: create, rename
 * and move. There is no delete and no reorder and no merge, and there is no artwork upload; each
 * of those has a named home and none of them is here.
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

/** A freshly written series, as the admin who wrote it reads it back: nothing in it yet. */
function describeNew(row: SeriesRow): SeriesView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    recordingCount: 0,
    firstRecordedAt: null,
    lastRecordedAt: null,
  };
}

function describe(row: VisibleSeriesRow): SeriesView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
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

  logger.info('series.create', audit(actor, 'series.create', row.id));

  return describeNew(row);
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

  logger.info('series.update', audit(actor, 'series.update', id));

  return describeNew(row);
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
    ...audit(actor, 'series.assign', seriesId ?? 'none'),
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

  return rows.map(describe);
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

  return { series: describe(found.series), recordings };
}

function notFound(): ApiError {
  return ApiError.notFound('There is no such series.');
}

/** Actor, action and target, under the request's correlation id. The logger supplies the time. */
function audit(actor: Actor, action: string, id: string): Record<string, unknown> {
  return {
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    target: `series:${id}`,
  };
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
