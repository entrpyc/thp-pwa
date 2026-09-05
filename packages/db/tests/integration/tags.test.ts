import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  createDatabase,
  deleteTag,
  ensureTags,
  findRecordingById,
  findSeriesById,
  findTagById,
  insertRecording,
  insertSeries,
  insertTag,
  isUniqueViolation,
  listTags,
  listTagsForRecordings,
  listTagsForSeries,
  renameTag,
  replaceRecordingTags,
  replaceSeriesTags,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { normaliseTagName } from '@thp/shared';

/**
 * **Tags at the database** ([4.7](docs/project/prd.md)).
 *
 * The round trip — a tag written and read back, applied to a recording and a series and read back
 * — plus the four properties the layer above cannot fake:
 *
 * 1. **The name is the identity, and the database holds the spelling.** A second row with the same
 *    name is refused by the index, and a name that did not go through `normaliseTagName` is refused
 *    by the check — so there is no state in which `Grace` and `grace` are two tags.
 * 2. **Applying, renaming and deleting a tag writes nothing on the thing it is on.** The recording
 *    and series rows are compared field by field before and after, rather than argued from the
 *    schema.
 * 3. **A series' tags and its recordings' tags are independent.** Tagging one touches nothing on
 *    the other.
 * 4. **Deleting a tag cascades through both join tables**, and reports what it took with it.
 */

const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;
let seeded = 0;

/** A name unique to this run, already in the one spelling the table accepts. */
function name(word: string): string {
  return normaliseTagName(`${word} ${RUN}`);
}

async function newRecording(title: string): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    { originalMediaKey: `originals/tags-db-${RUN}-${seeded}.mp3`, title, recordedAt: '2026-05-01' },
    handle,
  );
  return row.id;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

// =================================================================================================

describe('a tag round-trips', () => {
  it('writes a tag and reads it back with both counts at zero', async () => {
    const created = await insertTag(name('grace'), handle);
    const read = await findTagById(created.id, handle);

    expect(read?.name).toBe(name('grace'));
    expect(read?.recordingCount).toBe(0);
    expect(read?.seriesCount).toBe(0);
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it('lists tags alphabetically', async () => {
    await insertTag(name('zeal'), handle);
    await insertTag(name('faith'), handle);

    const ours = (await listTags(handle)).filter((one) => one.name.endsWith(RUN));
    const names = ours.map((one) => one.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain(name('faith'));
    expect(names).toContain(name('zeal'));
  });

  it('answers null for a tag that does not exist', async () => {
    const nowhere = '00000000-0000-0000-0000-000000000000';
    expect(await findTagById(nowhere, handle)).toBeNull();
    expect(await renameTag(nowhere, name('nothing'), handle)).toBeNull();
    expect(await deleteTag(nowhere, handle)).toBeNull();
  });
});

describe('the name is the identity', () => {
  it('refuses a second tag with the same name at the index', async () => {
    await insertTag(name('hope'), handle);
    await expect(insertTag(name('hope'), handle)).rejects.toSatisfy(isUniqueViolation);
  });

  it('refuses a name that was not normalised, so a second spelling cannot exist', async () => {
    // Capitalised, padded, and blank: each is a spelling the product never writes, and the check
    // constraint is what makes "never" a property of the table rather than of the callers.
    await expect(insertTag(`Grace ${RUN}`, handle)).rejects.toThrow();
    await expect(insertTag(` ${name('grace')}`, handle)).rejects.toThrow();
    await expect(insertTag('', handle)).rejects.toThrow();
  });

  it('refuses a rename onto a name another tag already has', async () => {
    const first = await insertTag(name('mercy'), handle);
    await insertTag(name('truth'), handle);
    await expect(renameTag(first.id, name('truth'), handle)).rejects.toSatisfy(isUniqueViolation);
    // The refused rename left the tag as it was.
    expect((await findTagById(first.id, handle))?.name).toBe(name('mercy'));
  });

  it('ensures a list of names, creating the missing ones and keeping the existing ones', async () => {
    const existing = await insertTag(name('kept'), handle);

    const rows = await ensureTags([name('kept'), name('new'), name('new'), name('another')], handle);

    expect(rows.map((one) => one.name)).toEqual(
      [name('another'), name('kept'), name('new')].sort(),
    );
    // The existing tag is the same row, not a replacement.
    expect(rows.find((one) => one.name === name('kept'))?.id).toBe(existing.id);
    expect(await ensureTags([], handle)).toEqual([]);
  });
});

describe('applying tags to a recording and to a series', () => {
  it('sets the whole set on a recording, replaces it, and clears it', async () => {
    const recordingId = await newRecording(`Tagged ${RUN}`);
    const [a, b, c] = await ensureTags([name('r-a'), name('r-b'), name('r-c')], handle);

    const first = await replaceRecordingTags(recordingId, [a!.id, c!.id], handle);
    expect(first.map((one) => one.name)).toEqual([a!.name, c!.name]);

    const second = await replaceRecordingTags(recordingId, [b!.id], handle);
    expect(second.map((one) => one.name)).toEqual([b!.name]);
    expect((await listTagsForRecordings([recordingId], handle)).get(recordingId)?.map((one) => one.id)).toEqual([b!.id]);

    const cleared = await replaceRecordingTags(recordingId, [], handle);
    expect(cleared).toEqual([]);
    expect((await listTagsForRecordings([recordingId], handle)).has(recordingId)).toBe(false);
  });

  it('answers the tags of many recordings in one map, and nothing for one with none', async () => {
    const tagged = await newRecording(`Many A ${RUN}`);
    const bare = await newRecording(`Many B ${RUN}`);
    const [t] = await ensureTags([name('many')], handle);
    await replaceRecordingTags(tagged, [t!.id], handle);

    const found = await listTagsForRecordings([tagged, bare], handle);
    expect(found.get(tagged)?.map((one) => one.name)).toEqual([name('many')]);
    expect(found.has(bare)).toBe(false);
    expect((await listTagsForRecordings([], handle)).size).toBe(0);
  });

  it('changes nothing on the recording row across set, replace and clear', async () => {
    const recordingId = await newRecording(`Untouched ${RUN}`);
    await setRecordingPublication(recordingId, new Date(), handle);
    const [a, b] = await ensureTags([name('u-a'), name('u-b')], handle);

    const before = await findRecordingById(recordingId, handle);

    await replaceRecordingTags(recordingId, [a!.id], handle);
    await replaceRecordingTags(recordingId, [a!.id, b!.id], handle);
    await replaceRecordingTags(recordingId, [], handle);

    // Field by field rather than "looks the same": the point is that nothing moved, including the
    // publication timestamp.
    expect(await findRecordingById(recordingId, handle)).toEqual(before);
  });

  it('tags a series on its own, independently of the recordings in it', async () => {
    const created = await insertSeries({ title: `Study ${RUN}`, description: null }, handle);
    const recordingId = await newRecording(`In study ${RUN}`);
    // `ensureTags` answers alphabetically, not in the order asked, so pick each by name.
    const ensured = await ensureTags([name('series-only'), name('recording-only')], handle);
    const s = ensured.find((one) => one.name === name('series-only'));
    const r = ensured.find((one) => one.name === name('recording-only'));

    const before = await findSeriesById(created.id, handle);

    await replaceSeriesTags(created.id, [s!.id], handle);
    await replaceRecordingTags(recordingId, [r!.id], handle);

    expect((await listTagsForSeries([created.id], handle)).get(created.id)?.map((one) => one.name)).toEqual([name('series-only')]);
    expect((await listTagsForRecordings([recordingId], handle)).get(recordingId)?.map((one) => one.name)).toEqual([name('recording-only')]);

    // The series row is byte-identical, and the counts reflect exactly one application each.
    expect(await findSeriesById(created.id, handle)).toEqual(before);
    expect((await findTagById(s!.id, handle))?.seriesCount).toBe(1);
    expect((await findTagById(s!.id, handle))?.recordingCount).toBe(0);
    expect((await findTagById(r!.id, handle))?.recordingCount).toBe(1);
    expect((await findTagById(r!.id, handle))?.seriesCount).toBe(0);

    expect(await replaceSeriesTags(created.id, [], handle)).toEqual([]);
  });

  it('puts the same tag on a recording and a series — one taxonomy, two applications', async () => {
    const created = await insertSeries({ title: `Shared ${RUN}`, description: null }, handle);
    const recordingId = await newRecording(`Shared ${RUN}`);
    const [shared] = await ensureTags([name('shared')], handle);

    await replaceSeriesTags(created.id, [shared!.id], handle);
    await replaceRecordingTags(recordingId, [shared!.id], handle);

    const counted = await findTagById(shared!.id, handle);
    expect(counted?.recordingCount).toBe(1);
    expect(counted?.seriesCount).toBe(1);
  });
});

describe('renaming and deleting reach every application', () => {
  it('renames a tag everywhere at once by writing one row', async () => {
    const recordingId = await newRecording(`Renamed ${RUN}`);
    const created = await insertSeries({ title: `Renamed ${RUN}`, description: null }, handle);
    const [t] = await ensureTags([name('before')], handle);
    await replaceRecordingTags(recordingId, [t!.id], handle);
    await replaceSeriesTags(created.id, [t!.id], handle);

    const renamed = await renameTag(t!.id, name('after'), handle);
    expect(renamed?.name).toBe(name('after'));

    expect((await listTagsForRecordings([recordingId], handle)).get(recordingId)?.[0]?.name).toBe(name('after'));
    expect((await listTagsForSeries([created.id], handle)).get(created.id)?.[0]?.name).toBe(name('after'));
    // Same id throughout: the applications were never rewritten.
    expect((await listTagsForRecordings([recordingId], handle)).get(recordingId)?.[0]?.id).toBe(t!.id);
  });

  it('deletes a tag from everything it was on, reports the counts, and touches nothing else', async () => {
    const recordingA = await newRecording(`Del A ${RUN}`);
    const recordingB = await newRecording(`Del B ${RUN}`);
    const created = await insertSeries({ title: `Del ${RUN}`, description: null }, handle);
    const [doomed, kept] = await ensureTags([name('doomed'), name('kept-on')], handle);
    await replaceRecordingTags(recordingA, [doomed!.id, kept!.id], handle);
    await replaceRecordingTags(recordingB, [doomed!.id], handle);
    await replaceSeriesTags(created.id, [doomed!.id], handle);

    const recordingBefore = await findRecordingById(recordingA, handle);
    const seriesBefore = await findSeriesById(created.id, handle);

    const removed = await deleteTag(doomed!.id, handle);
    expect(removed?.name).toBe(name('doomed'));
    expect(removed?.recordingCount).toBe(2);
    expect(removed?.seriesCount).toBe(1);

    expect(await findTagById(doomed!.id, handle)).toBeNull();
    expect((await listTagsForRecordings([recordingA], handle)).get(recordingA)?.map((one) => one.name)).toEqual([name('kept-on')]);
    expect((await listTagsForRecordings([recordingB], handle)).has(recordingB)).toBe(false);
    expect((await listTagsForSeries([created.id], handle)).has(created.id)).toBe(false);

    expect(await findRecordingById(recordingA, handle)).toEqual(recordingBefore);
    expect(await findSeriesById(created.id, handle)).toEqual(seriesBefore);
    // The other tag is untouched, and a second delete finds nothing.
    expect((await findTagById(kept!.id, handle))?.recordingCount).toBe(1);
    expect(await deleteTag(doomed!.id, handle)).toBeNull();
  });
});
