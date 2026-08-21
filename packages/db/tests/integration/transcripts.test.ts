import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  findTranscriptByRecording,
  insertRecording,
  listSegments,
  replaceTranscript,
  runMigrations,
  withTransaction,
  type DatabaseHandle,
} from '@thp/db';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The transcript queries, against a real database.
 *
 * One behaviour carries the whole suite: **writing a transcript replaces whatever was there.**
 * Dispatch is at-least-once, so the handler that calls this runs again on the same recording — from
 * the startup sweep, and from Ticket 04's re-run button — and "exactly one transcript per recording"
 * has to survive that without the caller checking first.
 */
describe('writing a recording its transcript', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let handle: DatabaseHandle;
  let recordings = 0;

  async function newRecording(): Promise<string> {
    recordings += 1;
    const row = await insertRecording(
      {
        originalMediaKey: `originals/transcript-queries-${recordings}.mp3`,
        title: `Teaching ${recordings}`,
        recordedAt: '2026-03-15',
      },
      handle,
    );
    return row.id;
  }

  const threeSegments = [
    { startMs: 0, endMs: 4000, text: 'The first thing.' },
    { startMs: 4000, endMs: 9000, text: 'The second thing.' },
    { startMs: 9000, endMs: 12_500, text: 'The third thing.' },
  ];

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'transcripts');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    handle = createDatabase({ url: target.url, max: 4 });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('writes the transcript and its segments together', async () => {
    const recordingId = await newRecording();

    const written = await replaceTranscript(
      { recordingId, language: 'en', confidence: 0.91, segments: threeSegments },
      handle,
    );

    expect(written.recordingId).toBe(recordingId);
    expect(written.language).toBe('en');
    expect(written.confidence).toBeCloseTo(0.91, 5);
    expect(written.createdAt).toBeInstanceOf(Date);

    const segments = await listSegments(written.id, handle);
    expect(segments.map((one) => [one.startMs, one.endMs, one.text])).toEqual(
      threeSegments.map((one) => [one.startMs, one.endMs, one.text]),
    );
    // Story 5's columns exist and nothing in this epic writes them.
    expect(segments.every((one) => one.correctedAt === null)).toBe(true);
    expect(segments.every((one) => one.correctedByUserId === null)).toBe(true);
    // And a writer that says nothing about the speaker writes null, which is what a transcript
    // with no speaker information in it reads as.
    expect(segments.every((one) => one.speaker === null)).toBe(true);
  });

  it('reads a speaker back where one was written, and null where one was not', async () => {
    const recordingId = await newRecording();

    const written = await replaceTranscript(
      {
        recordingId,
        language: 'en',
        confidence: 0.95,
        segments: [
          { startMs: 0, endMs: 4000, text: 'The teacher opens.', speaker: 0 },
          { startMs: 4000, endMs: 9000, text: 'A question from the room.', speaker: 1 },
          { startMs: 9000, endMs: 12_500, text: 'The teacher again.', speaker: 0 },
          // Explicitly nobody — a real answer from a provider that attributed this to no one.
          { startMs: 12_500, endMs: 15_000, text: 'Something nobody was given.', speaker: null },
          // And a writer that omits the field entirely, which is every fixture written before the
          // column existed.
          { startMs: 15_000, endMs: 17_000, text: 'Written without a speaker at all.' },
        ],
      },
      handle,
    );

    const segments = await listSegments(written.id, handle);
    expect(segments.map((one) => one.speaker)).toEqual([0, 1, 0, null, null]);
  });

  it('reads segments back ascending by start, whatever order they were given in', async () => {
    const recordingId = await newRecording();
    const written = await replaceTranscript(
      {
        recordingId,
        language: 'en',
        confidence: 0.8,
        // The caller's order is not the reader's order, and the reader is what has to be right.
        segments: [threeSegments[2]!, threeSegments[0]!, threeSegments[1]!],
      },
      handle,
    );

    expect((await listSegments(written.id, handle)).map((one) => one.startMs)).toEqual([
      0, 4000, 9000,
    ]);
  });

  it('leaves exactly one transcript and one set of segments when run twice', async () => {
    const recordingId = await newRecording();

    await replaceTranscript(
      { recordingId, language: 'en', confidence: 0.5, segments: threeSegments },
      handle,
    );
    const second = await replaceTranscript(
      {
        recordingId,
        language: 'en',
        confidence: 0.97,
        segments: [{ startMs: 0, endMs: 2000, text: 'A better transcription.' }],
      },
      handle,
    );

    const [counts] = await sql<{ transcripts: string; segments: string }[]>`
      select
        (select count(*)::text from transcript where recording_id = ${recordingId}) as transcripts,
        (select count(*)::text from segment
          join transcript on transcript.id = segment.transcript_id
          where transcript.recording_id = ${recordingId}) as segments
    `;
    expect(counts?.transcripts).toBe('1');
    expect(counts?.segments).toBe('1');

    // And it is the *second* run's answer that survived, not the first's.
    const current = await findTranscriptByRecording(recordingId, handle);
    expect(current?.id).toBe(second.id);
    expect(current?.confidence).toBeCloseTo(0.97, 5);
    expect((await listSegments(second.id, handle)).map((one) => one.text)).toEqual([
      'A better transcription.',
    ]);
  });

  it('leaves nothing behind when the segment write fails', async () => {
    const recordingId = await newRecording();

    // A segment whose text is null: the insert fails inside the transaction that had just written
    // the transcript row. A transcript with a hole in it is a transcript nothing downstream could
    // tell from a complete one, so neither may land.
    await expect(
      replaceTranscript(
        {
          recordingId,
          language: 'en',
          confidence: 0.9,
          segments: [{ startMs: 0, endMs: 1000, text: null as unknown as string }],
        },
        handle,
      ),
    ).rejects.toThrow();

    expect(await findTranscriptByRecording(recordingId, handle)).toBeNull();
  });

  it('keeps the previous transcript when the replacement fails', async () => {
    const recordingId = await newRecording();
    const first = await replaceTranscript(
      { recordingId, language: 'en', confidence: 0.88, segments: threeSegments },
      handle,
    );

    await expect(
      replaceTranscript(
        {
          recordingId,
          language: 'en',
          confidence: 0.2,
          segments: [{ startMs: 0, endMs: 1000, text: null as unknown as string }],
        },
        handle,
      ),
    ).rejects.toThrow();

    // The delete and the insert are one transaction, so a failed re-run does not destroy what was
    // there — the recording still has the transcript it had.
    const current = await findTranscriptByRecording(recordingId, handle);
    expect(current?.id).toBe(first.id);
    expect(await listSegments(first.id, handle)).toHaveLength(3);
  });

  it('rolls back with the caller when it is given a transaction', async () => {
    const recordingId = await newRecording();

    await expect(
      withTransaction(async (tx) => {
        await replaceTranscript(
          { recordingId, language: 'en', confidence: 0.9, segments: threeSegments },
          tx,
        );
        throw new Error('the caller changed its mind');
      }, handle),
    ).rejects.toThrow('the caller changed its mind');

    // Nested by design: given a transaction it joins it rather than opening a second one, which is
    // what lets a handler write a transcript inside a wider unit of work.
    expect(await findTranscriptByRecording(recordingId, handle)).toBeNull();
  });

  it('answers null for a recording that has no transcript', async () => {
    expect(await findTranscriptByRecording(await newRecording(), handle)).toBeNull();
  });
});
