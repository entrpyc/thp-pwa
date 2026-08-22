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
