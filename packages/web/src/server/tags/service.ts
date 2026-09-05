import {
  deleteTag as deleteTagRow,
  ensureTags,
  findRecordingById,
  findSeriesById,
  findTagById,
  insertTag,
  isUniqueViolation,
  listTags as listTagRows,
  listTagsForRecordings,
  listTagsForSeries,
  renameTag as renameTagRow,
  replaceRecordingTags,
  replaceSeriesTags,
  withTransaction,
  type TagCountRow,
  type TagRow,
} from '@thp/db';
import {
  MAX_TAG_LENGTH,
  normaliseTagName,
  type CreateTagRequest,
  type DeleteTagPayload,
  type RenameTagRequest,
  type SetTagsRequest,
  type TagRef,
  type TagView,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { audit } from '@/server/observability/audit';
import { logger } from '@/server/observability/logger';

/**
 * **Tags — the taxonomy, and the two things it is applied to** ([4.7](docs/project/prd.md)).
 *
 * Five writes and one read, all operator work. What this file is careful about:
 *
 * 1. **A name has one spelling before it is compared with anything.** `normaliseTagName` runs on
 *    every name that arrives — create, rename, and every entry of a set — so `Grace`, `grace ` and
 *    `GRACE` are one request for one tag. The database holds the same rule as a check constraint,
 *    so a caller that skipped this file could not make a second spelling exist either.
 * 2. **Duplicates are refused by the index, not by a lookup.** Create and rename both try the write
 *    and read a unique violation as `tag_exists`; a `select` first would leave a window in which two
 *    requests both find nothing.
 * 3. **Setting the tags on a thing never touches the thing.** `replaceRecordingTags` and
 *    `replaceSeriesTags` write the join table and nothing else — no column of `recording` or
 *    `series` is in either statement — so tagging a live teaching leaves it live and tagging a draft
 *    does not publish it, as a property of the write rather than of a test.
 * 4. **Who may read a tag is not decided here.** A member reads a recording's tags because the
 *    visibility module let them read the recording; this file only ever answers about ids a caller
 *    already holds. Nothing in it compares a publication timestamp.
 */

/** The most a raw field can be before we stop reading it — the same ceiling every route applies. */
const MAX_FIELD_LENGTH = 512;

/**
 * The most tags one request may put on one thing.
 *
 * Not a product rule — [4.7](docs/project/prd.md) sets no count — but a bound on the request, the
 * way `MAX_FIELD_LENGTH` is: a set of names arrives as an array, and an array with no ceiling is a
 * request with no ceiling. Far above anything a row will ever carry.
 */
const MAX_TAGS_PER_ITEM = 50;

export function describeTag(row: TagCountRow): TagView {
  return {
    id: row.id,
    name: row.name,
    recordingCount: row.recordingCount,
    seriesCount: row.seriesCount,
  };
}

function toRefs(rows: readonly TagRow[]): TagRef[] {
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

/**
 * The tags on each of these recordings, keyed by id, as refs.
 *
 * What the recordings service attaches to its rows — one statement for a whole list, and an empty
 * list for a recording the map has nothing for. Here rather than in that service so the shape a
 * recording carries and the shape a series carries come from the same function.
 */
export async function tagRefsForRecordings(
  recordingIds: readonly string[],
): Promise<Map<string, TagRef[]>> {
  const found = await listTagsForRecordings(recordingIds);
  return new Map([...found].map(([id, rows]) => [id, toRefs(rows)]));
}

/** The same, for series. */
export async function tagRefsForSeries(seriesIds: readonly string[]): Promise<Map<string, TagRef[]>> {
  const found = await listTagsForSeries(seriesIds);
  return new Map([...found].map(([id, rows]) => [id, toRefs(rows)]));
}

/** Every tag with its counts, alphabetically — the console's Tags panel. */
export async function listTagsFor(actor: Actor): Promise<TagView[]> {
  const rows = await listTagRows();

  logger.info('tag.list', {
    actorId: actor.id,
    action: 'tag.list',
    target: 'tag:*',
    count: rows.length,
  });

  return rows.map(describeTag);
}

/**
 * Create a tag ([4.7](docs/project/prd.md)).
 *
 * The name is normalised, refused if blank or too long **before a row exists**, and written; the
 * unique index is what refuses a name that already exists, and that comes back as `tag_exists` so
 * the console can say which it was. A new tag is on nothing, so the counts are zero by construction.
 */
export async function createTag(actor: Actor, body: unknown): Promise<TagView> {
  const name = parseName(body, 'Give the tag a name.');

  let row: TagRow;
  try {
    row = await insertTag(name);
  } catch (cause) {
    if (!isUniqueViolation(cause)) throw cause;
    throw exists(name);
  }

  logger.info('tag.create', { ...audit(actor, 'tag.create', `tag:${row.id}`), name });

  return { id: row.id, name: row.name, recordingCount: 0, seriesCount: 0 };
}

/**
 * Rename a tag everywhere at once ([4.7](docs/project/prd.md)).
 *
 * One column on one row: every recording and series that carries the tag prints the new name
 * because each was only ever pointing at the id. Renaming onto a name another tag already has is
 * refused as `tag_exists` rather than merged — merging two tags is a different act with different
 * consequences, and one nobody has asked for. Renaming a tag to the name it already has is a
 * no-op that answers as a success.
 */
export async function renameTagFor(actor: Actor, id: string, body: unknown): Promise<TagView> {
  const name = parseName(body, 'Give the tag a name.');

  const before = await findTagById(id);
  if (before === null) throw notFound();

  let row: TagRow | null;
  try {
    row = await renameTagRow(id, name);
  } catch (cause) {
    if (!isUniqueViolation(cause)) throw cause;
    throw exists(name);
  }
  if (row === null) throw notFound();

  logger.info('tag.rename', {
    ...audit(actor, 'tag.rename', `tag:${id}`),
    from: before.name,
    to: row.name,
  });

  // The counts cannot have changed in a rename: nothing on either join table was written.
  return describeTag({ ...before, name: row.name });
}

/**
 * Delete a tag, taking it off every recording and series it was on ([4.7](docs/project/prd.md)).
 *
 * The counts come back from inside the transaction that deleted the rows, so the console's
 * "removed from 3 recordings and 1 series" is what happened rather than what a list showed before
 * the press. **No recording or series is written**: the applications cascade from the tag, and
 * there is no column on either owner for a tag to have touched.
 */
export async function deleteTagFor(actor: Actor, id: string): Promise<DeleteTagPayload> {
  const removed = await deleteTagRow(id);
  if (removed === null) throw notFound();

  logger.info('tag.delete', {
    ...audit(actor, 'tag.delete', `tag:${id}`),
    name: removed.name,
    recordingCount: removed.recordingCount,
    seriesCount: removed.seriesCount,
  });

  return {
    id: removed.id,
    name: removed.name,
    recordingCount: removed.recordingCount,
    seriesCount: removed.seriesCount,
  };
}

/**
 * Make these the tags on a recording — the whole set, by name ([4.7](docs/project/prd.md)).
 *
 * The recording is looked up first so an id that does not exist is a refusal the caller reads
 * rather than a foreign-key error. Then, in one transaction: every name that is not yet a tag
 * becomes one, and the recording's applications are replaced with the set. Type-to-add is this
 * one request — an admin who typed a new word has created a tag and applied it in the same press.
 */
export async function setRecordingTagsFor(
  actor: Actor,
  recordingId: string,
  body: unknown,
): Promise<TagRef[]> {
  const names = parseNames(body);

  if ((await findRecordingById(recordingId)) === null) {
    throw ApiError.notFound('There is no recording with that id.');
  }

  const rows = await withTransaction(async (tx) => {
    const tags = await ensureTags(names, tx);
    return replaceRecordingTags(
      recordingId,
      tags.map((tag) => tag.id),
      tx,
    );
  });

  logger.info('tag.assign', {
    ...audit(actor, 'tag.assign', `recording:${recordingId}`),
    tags: rows.map((row) => row.name),
  });

  return toRefs(rows);
}

/** The same, for a series. See {@link setRecordingTagsFor}. */
export async function setSeriesTagsFor(
  actor: Actor,
  seriesId: string,
  body: unknown,
): Promise<TagRef[]> {
  const names = parseNames(body);

  if ((await findSeriesById(seriesId)) === null) {
    throw ApiError.notFound('There is no such series.');
  }

  const rows = await withTransaction(async (tx) => {
    const tags = await ensureTags(names, tx);
    return replaceSeriesTags(
      seriesId,
      tags.map((tag) => tag.id),
      tx,
    );
  });

  logger.info('tag.assign', {
    ...audit(actor, 'tag.assign', `series:${seriesId}`),
    tags: rows.map((row) => row.name),
  });

  return toRefs(rows);
}

function notFound(): ApiError {
  return ApiError.notFound('There is no such tag.');
}

function exists(name: string): ApiError {
  return ApiError.tagExists(`There is already a tag called “${name}”.`);
}

/**
 * One name, normalised — the body of create and rename.
 *
 * The raw string is bounded before it is normalised, so a megabyte of whitespace is refused for its
 * length rather than collapsed and accepted. The normalised result is what is checked against
 * `MAX_TAG_LENGTH`, because that is the spelling that will be stored and shown.
 */
function parseName(body: unknown, complaint: string): string {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a name.');
  }
  const { name } = body as Partial<CreateTagRequest & RenameTagRequest>;
  return normaliseOne(name, complaint);
}

function normaliseOne(raw: unknown, complaint: string): string {
  if (typeof raw !== 'string' || raw.length > MAX_FIELD_LENGTH) throw ApiError.invalidInput(complaint);
  const name = normaliseTagName(raw);
  if (name === '') throw ApiError.invalidInput(complaint);
  if (name.length > MAX_TAG_LENGTH) {
    throw ApiError.invalidInput(`A tag can be at most ${MAX_TAG_LENGTH} characters.`);
  }
  return name;
}

/**
 * The set of names a `PUT …/tags` carries, each normalised, blanks dropped, duplicates folded.
 *
 * Blanks are dropped rather than refused because a type-to-add field produces them — a trailing
 * comma, a press of Enter on nothing — and refusing the whole set for one empty entry would refuse
 * the tags the admin actually typed. A name that is *not* blank and is too long is refused, because
 * that is a tag they meant and cannot have.
 */
function parseNames(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a list of tag names.');
  }
  const { names } = body as Partial<SetTagsRequest>;
  if (!Array.isArray(names)) throw ApiError.invalidInput('Send the tags as a list of names.');
  if (names.length > MAX_TAGS_PER_ITEM) {
    throw ApiError.invalidInput(`That is more than ${MAX_TAGS_PER_ITEM} tags on one thing.`);
  }

  const seen = new Set<string>();
  for (const raw of names) {
    if (typeof raw !== 'string' || raw.length > MAX_FIELD_LENGTH) {
      throw ApiError.invalidInput('Every tag has to be a name.');
    }
    const name = normaliseTagName(raw);
    if (name === '') continue;
    if (name.length > MAX_TAG_LENGTH) {
      throw ApiError.invalidInput(`A tag can be at most ${MAX_TAG_LENGTH} characters.`);
    }
    seen.add(name);
  }
  return [...seen];
}
