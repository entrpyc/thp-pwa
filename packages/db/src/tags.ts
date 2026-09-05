import { asc, eq, inArray, sql } from 'drizzle-orm';
import { getDatabase, queryable, withTransaction, type Executor } from './client';
import { recordingTag, seriesTag, tag } from './schema';

/**
 * **Tags** — the shared taxonomy and its two applications ([4.7](docs/project/prd.md)).
 *
 * Query construction lives in this package and nowhere else, as everywhere: the import-boundary
 * guard refuses a `drizzle-orm` import from `packages/web`.
 *
 * **Nothing here compares a publication timestamp.** A tag rides whatever it is on: a member reads
 * a recording's tags because they may read the recording, and `visibility.ts` is what decided
 * that. These functions take ids the caller has already been allowed to hold and answer about
 * those ids only, which is why none of them needs the `includeUnpublished` boolean and why the
 * visibility guard has nothing to say about this file.
 *
 * **Names arrive normalised.** Every write here trusts the caller to have applied
 * `normaliseTagName`; the check constraint on the table is what makes that trust cheap to hold, and
 * a caller that forgets gets a database error rather than a second spelling of an existing tag.
 */

export interface TagRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

/** A tag with how many recordings and how many series carry it — the console's reading. */
export interface TagCountRow extends TagRow {
  readonly recordingCount: number;
  readonly seriesCount: number;
}

/**
 * The two counts, as correlated subqueries rather than joins: two left joins and a `group by` would
 * multiply the rows before counting them, and `count(distinct …)` twice is the same statement
 * written the hard way.
 */
const recordingCount = sql<number>`(
  select count(*) from ${recordingTag} where ${recordingTag.tagId} = ${tag.id}
)::int`;
const seriesCount = sql<number>`(
  select count(*) from ${seriesTag} where ${seriesTag.tagId} = ${tag.id}
)::int`;

function countedTags(executor: Executor) {
  return queryable(executor)
    .select({
      id: tag.id,
      name: tag.name,
      createdAt: tag.createdAt,
      recordingCount,
      seriesCount,
    })
    .from(tag);
}

/** Every tag, alphabetically, each with its two counts. */
export async function listTags(executor: Executor = getDatabase()): Promise<TagCountRow[]> {
  const rows = await countedTags(executor).orderBy(asc(tag.name));
  return rows as TagCountRow[];
}

/** One tag with its counts, or `null`. */
export async function findTagById(
  id: string,
  executor: Executor = getDatabase(),
): Promise<TagCountRow | null> {
  const rows = await countedTags(executor).where(eq(tag.id, id)).limit(1);
  return (rows[0] as TagCountRow | undefined) ?? null;
}

/**
 * Create a tag. **The unique index is what refuses a duplicate**, and the caller reads that as a
 * conflict rather than checking first — a `select` followed by an `insert` has a window in which
 * two requests both find nothing.
 */
export async function insertTag(name: string, executor: Executor = getDatabase()): Promise<TagRow> {
  const rows = await queryable(executor).insert(tag).values({ name }).returning();
  const row = rows[0] as TagRow | undefined;
  if (!row) throw new Error('insertTag returned no row');
  return row;
}

/**
 * Rename a tag everywhere at once.
 *
 * **One column on one row.** The applications point at the id, so nothing on any recording or
 * series is read or written — every surface prints the new name because it was only ever printing
 * a reference. The same unique index refuses a rename onto a name another tag already has; `null`
 * back means there is no such tag.
 */
export async function renameTag(
  id: string,
  name: string,
  executor: Executor = getDatabase(),
): Promise<TagRow | null> {
  const rows = await queryable(executor)
    .update(tag)
    .set({ name })
    .where(eq(tag.id, id))
    .returning();
  return (rows[0] as TagRow | undefined) ?? null;
}

/**
 * Delete a tag, taking it off every recording and series it was on.
 *
 * The two join tables cascade, so the delete is one statement; the counts are read **inside the
 * same transaction** first, so what the caller reports as removed is what was actually removed
 * rather than what a list happened to show before the press. `null` back means there was no such
 * tag, and nothing was deleted.
 */
export async function deleteTag(
  id: string,
  executor: Executor = getDatabase(),
): Promise<TagCountRow | null> {
  return withTransaction(async (tx) => {
    const found = await findTagById(id, tx);
    if (found === null) return null;
    await tx.delete(tag).where(eq(tag.id, id));
    return found;
  }, executor);
}

/**
 * **The tags these names denote, creating any that do not exist yet** — what type-to-add asks.
 *
 * One `insert … on conflict do nothing` for the whole list and one `select` after it, rather than
 * a lookup per name: a name that already exists is left exactly as it is (its id, its `created_at`),
 * a name that does not becomes a row, and two requests racing to create the same tag both end up
 * holding the one row the index allowed. Names are expected normalised; the caller de-duplicates
 * by normalising, and this de-duplicates again because `values()` with a repeated name would
 * conflict with itself.
 */
export async function ensureTags(
  names: readonly string[],
  executor: Executor = getDatabase(),
): Promise<TagRow[]> {
  const unique = [...new Set(names)];
  if (unique.length === 0) return [];
  const on = queryable(executor);
  await on
    .insert(tag)
    .values(unique.map((name) => ({ name })))
    .onConflictDoNothing({ target: tag.name });
  const rows = await on.select().from(tag).where(inArray(tag.name, unique)).orderBy(asc(tag.name));
  return rows as TagRow[];
}

/**
 * Make these the tags on a recording — the whole set, replacing whatever was there.
 *
 * A delete and an insert in one transaction, so there is no moment in which the recording has half
 * its tags. **Nothing on the `recording` row is read or written**: the title, the date, the
 * publication state, the series and every member's position are not in either statement. Answers
 * the tags now on the recording, alphabetically, from the database rather than from the input.
 */
export async function replaceRecordingTags(
  recordingId: string,
  tagIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<TagRow[]> {
  return withTransaction(async (tx) => {
    await tx.delete(recordingTag).where(eq(recordingTag.recordingId, recordingId));
    if (tagIds.length > 0) {
      await tx.insert(recordingTag).values(tagIds.map((tagId) => ({ recordingId, tagId })));
    }
    return (await listTagsForRecordings([recordingId], tx)).get(recordingId) ?? [];
  }, executor);
}

/** The same, for a series. See {@link replaceRecordingTags}. */
export async function replaceSeriesTags(
  seriesId: string,
  tagIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<TagRow[]> {
  return withTransaction(async (tx) => {
    await tx.delete(seriesTag).where(eq(seriesTag.seriesId, seriesId));
    if (tagIds.length > 0) {
      await tx.insert(seriesTag).values(tagIds.map((tagId) => ({ seriesId, tagId })));
    }
    return (await listTagsForSeries([seriesId], tx)).get(seriesId) ?? [];
  }, executor);
}

/**
 * The tags on each of these recordings, keyed by recording id, alphabetically within each.
 *
 * **One statement for a whole list**, which is why the read services attach tags with a second
 * query over the ids they already hold rather than a join inside the visibility read: a join would
 * multiply every recording row by its tag count and force a `group by` over a dozen columns, and a
 * query per row would cost a library page as many round trips as it has teachings. A recording
 * with no tags is simply absent from the map, and the caller reads that as an empty list.
 */
export async function listTagsForRecordings(
  recordingIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<Map<string, TagRow[]>> {
  const byRecording = new Map<string, TagRow[]>();
  if (recordingIds.length === 0) return byRecording;
  const rows = await queryable(executor)
    .select({
      ownerId: recordingTag.recordingId,
      id: tag.id,
      name: tag.name,
      createdAt: tag.createdAt,
    })
    .from(recordingTag)
    .innerJoin(tag, eq(tag.id, recordingTag.tagId))
    .where(inArray(recordingTag.recordingId, [...recordingIds]))
    .orderBy(asc(tag.name));
  for (const row of rows) {
    const list = byRecording.get(row.ownerId) ?? [];
    list.push({ id: row.id, name: row.name, createdAt: row.createdAt });
    byRecording.set(row.ownerId, list);
  }
  return byRecording;
}

/** The same, for series. See {@link listTagsForRecordings}. */
export async function listTagsForSeries(
  seriesIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<Map<string, TagRow[]>> {
  const bySeries = new Map<string, TagRow[]>();
  if (seriesIds.length === 0) return bySeries;
  const rows = await queryable(executor)
    .select({
      ownerId: seriesTag.seriesId,
      id: tag.id,
      name: tag.name,
      createdAt: tag.createdAt,
    })
    .from(seriesTag)
    .innerJoin(tag, eq(tag.id, seriesTag.tagId))
    .where(inArray(seriesTag.seriesId, [...seriesIds]))
    .orderBy(asc(tag.name));
  for (const row of rows) {
    const list = bySeries.get(row.ownerId) ?? [];
    list.push({ id: row.id, name: row.name, createdAt: row.createdAt });
    bySeries.set(row.ownerId, list);
  }
  return bySeries;
}
