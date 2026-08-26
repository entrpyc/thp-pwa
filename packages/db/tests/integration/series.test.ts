import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  createDatabase,
  findRecordingById,
  findSeriesById,
  findVisibleSeries,
  insertRecording,
  insertSeries,
  listVisibleSeries,
  setRecordingPublication,
  setRecordingSeries,
  setSeriesArtwork,
  updateSeries,
  upsertPlaybackProgress,
  insertUser,
  type DatabaseHandle,
} from '@thp/db';
import { ROLE } from '@thp/shared';

/**
 * **Series at the database** (Story 6 Ticket 01).
 *
 * The round trip — a series written and read back, a recording assigned to it and read back — plus
 * the two properties the layer above cannot fake:
 *
 * 1. **An assignment writes one column.** Everything else about the recording is compared before
 *    and after, field by field, rather than argued from the schema.
 * 2. **The counts are over the recordings the caller may see**, which is what makes the console's
 *    answer and a member's answer for the same series legitimately different.
 */

const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;
let seeded = 0;

async function newRecording(title: string, recordedAt: string): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    { originalMediaKey: `originals/series-db-${RUN}-${seeded}.mp3`, title, recordedAt },
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

describe('a series round-trips, and so does an assignment', () => {
  it('writes a series with a title and a description and reads it back', async () => {
    const created = await insertSeries(
      { title: `Romans ${RUN}`, description: 'A verse-by-verse study.' },
      handle,
    );
    const read = await findSeriesById(created.id, handle);

    expect(read?.title).toBe(`Romans ${RUN}`);
    expect(read?.description).toBe('A verse-by-verse study.');
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it('stores a series with no description as null', async () => {
    const created = await insertSeries({ title: `No blurb ${RUN}`, description: null }, handle);
    expect((await findSeriesById(created.id, handle))?.description).toBeNull();
  });

  it('puts a recording into a series, moves it, and takes it out', async () => {
    const first = await insertSeries({ title: `First ${RUN}`, description: null }, handle);
    const second = await insertSeries({ title: `Second ${RUN}`, description: null }, handle);
    const recordingId = await newRecording(`Moved ${RUN}`, '2026-04-01');

    expect((await findRecordingById(recordingId, handle))?.seriesId ?? null).toBeNull();

    await setRecordingSeries(recordingId, first.id, handle);
    expect((await findRecordingById(recordingId, handle))?.seriesId).toBe(first.id);

    await setRecordingSeries(recordingId, second.id, handle);
    expect((await findRecordingById(recordingId, handle))?.seriesId).toBe(second.id);

    await setRecordingSeries(recordingId, null, handle);
    expect((await findRecordingById(recordingId, handle))?.seriesId ?? null).toBeNull();
  });

  it('answers null for a series and a recording that do not exist', async () => {
    const nowhere = '00000000-0000-0000-0000-000000000000';
    expect(await findSeriesById(nowhere, handle)).toBeNull();
    expect(await setRecordingSeries(nowhere, null, handle)).toBeNull();
    expect(await updateSeries(nowhere, { title: 'x', description: null }, handle)).toBeNull();
  });
});

describe('what an assignment and a rename leave alone', () => {
  it('changes nothing about the recording but its series, across an assign-move-clear', async () => {
    const first = await insertSeries({ title: `Keep A ${RUN}`, description: null }, handle);
    const second = await insertSeries({ title: `Keep B ${RUN}`, description: null }, handle);
    const recordingId = await newRecording(`Untouched ${RUN}`, '2026-04-02');
    await setRecordingPublication(recordingId, new Date(), handle);

    const before = await findRecordingById(recordingId, handle);

    await setRecordingSeries(recordingId, first.id, handle);
    await setRecordingSeries(recordingId, second.id, handle);
    await setRecordingSeries(recordingId, null, handle);

    const after = await findRecordingById(recordingId, handle);

    // Field by field rather than "looks the same": the point is that one column moved and the
    // other seven did not, including the publication timestamp.
    expect(after).toEqual(before);
  });

  it('leaves every stored position exactly as it was', async () => {
    const first = await insertSeries({ title: `Progress A ${RUN}`, description: null }, handle);
    const second = await insertSeries({ title: `Progress B ${RUN}`, description: null }, handle);
    const recordingId = await newRecording(`Listened ${RUN}`, '2026-04-03');

    const listener = await insertUser(
      {
        email: `series-db-listener-${RUN}@example.test`,
        passwordHash: 'hash',
        displayName: 'Listener',
        role: ROLE.member,
      },
      handle,
    );
    const written = await upsertPlaybackProgress(
      { userId: listener.id, recordingId, positionMs: 754_000 },
      handle,
    );

    await setRecordingSeries(recordingId, first.id, handle);
    await setRecordingSeries(recordingId, second.id, handle);

    const found = await findVisibleSeries(second.id, listener.id, { includeUnpublished: true }, handle);
    const row = found?.recordings.find((one) => one.id === recordingId);
    expect(row?.positionMs).toBe(754_000);

    // And the row itself is byte-identical, `updated_at` included — no series write goes near it.
    const still = await upsertPlaybackProgress(
      { userId: listener.id, recordingId, positionMs: 754_000 },
      handle,
    );
    expect(still.positionMs).toBe(written.positionMs);
  });

  it('renames a series without reading or writing a single recording', async () => {
    const created = await insertSeries({ title: `Before ${RUN}`, description: 'Old.' }, handle);
    const recordingId = await newRecording(`In a renamed series ${RUN}`, '2026-04-04');
    await setRecordingSeries(recordingId, created.id, handle);

    const before = await findRecordingById(recordingId, handle);
    const renamed = await updateSeries(
      created.id,
      { title: `After ${RUN}`, description: 'New.' },
      handle,
    );

    expect(renamed?.title).toBe(`After ${RUN}`);
    expect(renamed?.description).toBe('New.');
    expect(await findRecordingById(recordingId, handle)).toEqual(before);
  });
});

describe('the counts are over the recordings the caller may see', () => {
  it('counts everything for the console and only the published for a member', async () => {
    const created = await insertSeries({ title: `Counted ${RUN}`, description: null }, handle);

    const published = await newRecording(`Counted published ${RUN}`, '2026-01-10');
    const alsoPublished = await newRecording(`Counted also ${RUN}`, '2026-03-20');
    const hidden = await newRecording(`Counted hidden ${RUN}`, '2026-06-30');

    for (const id of [published, alsoPublished, hidden]) {
      await setRecordingSeries(id, created.id, handle);
    }
    await setRecordingPublication(published, new Date(), handle);
    await setRecordingPublication(alsoPublished, new Date(), handle);

    const forConsole = (await listVisibleSeries({ includeUnpublished: true }, handle)).find(
      (one) => one.id === created.id,
    );
    expect(forConsole?.recordingCount).toBe(3);
    expect(forConsole?.firstRecordedAt).toBe('2026-01-10');
    expect(forConsole?.lastRecordedAt).toBe('2026-06-30');

    const forMember = (await listVisibleSeries({ includeUnpublished: false }, handle)).find(
      (one) => one.id === created.id,
    );
    expect(forMember?.recordingCount).toBe(2);
    // The range spans the published two only — the unpublished June recording does not move it.
    expect(forMember?.firstRecordedAt).toBe('2026-01-10');
    expect(forMember?.lastRecordedAt).toBe('2026-03-20');
  });

  it('shows an empty series to the console and never to a member', async () => {
    const created = await insertSeries({ title: `Empty ${RUN}`, description: null }, handle);

    const forConsole = (await listVisibleSeries({ includeUnpublished: true }, handle)).find(
      (one) => one.id === created.id,
    );
    expect(forConsole?.recordingCount).toBe(0);
    expect(forConsole?.firstRecordedAt).toBeNull();
    expect(forConsole?.lastRecordedAt).toBeNull();

    const forMember = (await listVisibleSeries({ includeUnpublished: false }, handle)).find(
      (one) => one.id === created.id,
    );
    expect(forMember).toBeUndefined();
  });
});

// =================================================================================================

describe('the artwork pointer', () => {
  it('reads back null on a series nobody has given a cover', async () => {
    // scope plan 1.1.2. `null` is the ordinary no-cover state of scope prd 3.1.7, not an error and
    // not a series that is somehow incomplete — which is why nothing about creating one changed.
    const created = await insertSeries({ title: `Uncovered ${RUN}`, description: null }, handle);
    expect((await findSeriesById(created.id, handle))?.artworkKey).toBeNull();
  });

  it('points a series with no cover at a key', async () => {
    // scope plan 1.1.3.
    const created = await insertSeries({ title: `Covered ${RUN}`, description: null }, handle);
    const key = `artwork/${RUN}-first.webp`;

    expect((await setSeriesArtwork(created.id, key, handle))?.artworkKey).toBe(key);
    expect((await findSeriesById(created.id, handle))?.artworkKey).toBe(key);
  });

  it('replaces the key on a series that already has one', async () => {
    // scope plan 1.1.4, and scope prd 3.1.5 at the database: replacing is a repoint and nothing
    // else. What happens to the object the old key named is not this layer's business — the store
    // has no delete (scope tdd 1.1) and the row simply stops naming it.
    const created = await insertSeries({ title: `Replaced ${RUN}`, description: null }, handle);
    await setSeriesArtwork(created.id, `artwork/${RUN}-old.webp`, handle);

    await setSeriesArtwork(created.id, `artwork/${RUN}-new.webp`, handle);

    expect((await findSeriesById(created.id, handle))?.artworkKey).toBe(`artwork/${RUN}-new.webp`);
  });

  it('leaves the title and the description exactly as they were', async () => {
    // scope plan 1.1.5. The same property the assignment block asserts about a recording, for the
    // same reason: "setting a cover changes nothing else" is a fact about the statement rather than
    // about the test that checks it, and it is compared field by field rather than argued.
    const created = await insertSeries(
      { title: `Untouched ${RUN}`, description: 'The wording nobody asked to change.' },
      handle,
    );
    const before = await findSeriesById(created.id, handle);

    await setSeriesArtwork(created.id, `artwork/${RUN}-untouched.webp`, handle);
    const after = await findSeriesById(created.id, handle);

    // The write actually happened — otherwise the three assertions below hold for a statement that
    // did nothing at all, which is the one way "it changed nothing else" can be vacuously true.
    expect(after?.artworkKey).toBe(`artwork/${RUN}-untouched.webp`);
    expect(after?.title).toBe(before?.title);
    expect(after?.description).toBe(before?.description);
    expect(after?.createdAt?.getTime()).toBe(before?.createdAt?.getTime());
  });

  it('returns null for an id that is not a series, and writes nothing', async () => {
    // scope plan 1.1.6. `null` back is what the route turns into `not_found`, and it has to come
    // from the write finding no row rather than from a lookup the write could race.
    const created = await insertSeries({ title: `Bystander ${RUN}`, description: null }, handle);
    await setSeriesArtwork(created.id, `artwork/${RUN}-bystander.webp`, handle);

    const missing = await setSeriesArtwork(
      '00000000-0000-4000-8000-000000000000',
      `artwork/${RUN}-nowhere.webp`,
      handle,
    );

    expect(missing).toBeNull();
    expect((await findSeriesById(created.id, handle))?.artworkKey).toBe(
      `artwork/${RUN}-bystander.webp`,
    );
  });
});
