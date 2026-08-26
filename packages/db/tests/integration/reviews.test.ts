import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  closeReviewItem,
  createDatabase,
  findOpenDraft,
  findReviewItem,
  insertRecording,
  insertUser,
  listPendingReviews,
  replaceOpenDrafts,
  replaceTranscript,
  runMigrations,
  type DatabaseHandle,
} from '@thp/db';
import { REVIEW_FIELD, REVIEW_KINDS, REVIEW_STATUSES, type ReviewKind } from '@thp/shared';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The review gate's queries.
 *
 * **The property this suite exists for is the first one**: everything waiting on an admin comes
 * back from a single call filtering a single column. docs/project/prd.md 3.19.2 asks for one place
 * holding it, and project tdd 6.2 says that must not degrade
 * into a union of six as artefact types arrive — so the test seeds **both kinds in all three
 * statuses** and asserts that only the drafts come back, from one read that never mentions `kind`.
 */

const databaseUrl = inject('databaseUrl');

let target: ThrowawayDatabase;
let sql: postgres.Sql;
let handle: DatabaseHandle;
let adminId: string;
let seeded = 0;

async function newRecording(title = 'A teaching', recordedAt = '2026-08-16'): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/reviews-${seeded}-${Date.now().toString(36)}.mp3`,
      title,
      recordedAt,
    },
    handle,
  );
  return row.id;
}

/**
 * What the machine wrote, per kind — a paragraph for a text-shaped field, a list of citations for
 * a list-shaped one. Keyed the way the handler keys it, so the read is exercised against the shape
 * a real draft has.
 */
const MACHINE: Record<ReviewKind, unknown> = {
  summary: 'What the machine wrote.',
  recording_metadata: 'A line.',
  scripture: [
    { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4 },
    { book: 'john', chapter: 3, verseStart: 16, verseEnd: 16 },
  ],
};

/** A draft of each named kind, written the way the handler writes them. */
async function draftsFor(recordingId: string, kinds: readonly ReviewKind[]) {
  return replaceOpenDrafts(
    recordingId,
    kinds.map((kind) => ({
      kind,
      fields: { [REVIEW_FIELD[kind].name]: MACHINE[kind] },
      provenance: {
        model: 'fake',
        modelVersion: 'fake-1',
        promptVersion: 'draft-1',
        steeringPrompt: null,
        fields: { [REVIEW_FIELD[kind].name]: { aiSuggested: true, editedByAdmin: false } },
      },
    })),
    handle,
  );
}

beforeAll(async () => {
  target = await createThrowawayDatabase(databaseUrl, 'reviews');
  await runMigrations({ url: target.url });
  sql = postgres(target.url, { max: 4, onnotice: () => {} });
  handle = createDatabase({ url: target.url, max: 6 });

  const admin = await insertUser(
    {
      email: 'reviews-admin@example.test',
      passwordHash: 'not-a-hash',
      displayName: 'An admin',
      role: 'admin',
    },
    handle,
  );
  adminId = admin.id;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await target?.drop();
}, 60_000);

describe('the Pending Reviews read', () => {
  it('returns only the drafts, of both kinds, from one call', async () => {
    // Both kinds in all three statuses, so "one column decides" has something to be true of.
    const open = await newRecording('Both kinds waiting');
    await draftsFor(open, REVIEW_KINDS);

    const closed = await newRecording('Both kinds closed');
    const closedItems = await draftsFor(closed, REVIEW_KINDS);
    for (const [index, item] of closedItems.entries()) {
      await closeReviewItem(
        { id: item.id, status: index === 0 ? 'published' : 'discarded', reviewedBy: adminId },
        handle,
      );
    }

    const pending = await listPendingReviews(handle);

    const mine = pending.filter((one) => one.recordingId === open || one.recordingId === closed);
    expect(mine).toHaveLength(REVIEW_KINDS.length);
    expect(mine.every((one) => one.recordingId === open)).toBe(true);
    expect(mine.map((one) => one.kind).sort()).toEqual([...REVIEW_KINDS].sort());
    // Every status the enum admits is represented in the seed, so this is not vacuous.
    expect([...REVIEW_STATUSES]).toHaveLength(3);
  });

  /**
   * 1.2.3 — **a scripture item and a summary item come back from the same one query**, in the
   * queue's existing order, with the list-shaped draft intact.
   *
   * The property the single-table gate exists to hold: `listPendingReviews` filters one column and
   * branches on `kind` nowhere, so a fourth artefact costs a value in an enum rather than a union
   * in this read.
   */
  it('returns a list-shaped draft beside a text one, in the order the queue already sorts by', async () => {
    const older = await newRecording('An older teaching', '2026-05-17');
    await draftsFor(older, ['scripture']);
    const newer = await newRecording('A newer teaching', '2026-06-21');
    await draftsFor(newer, ['summary', 'scripture']);

    const mine = (await listPendingReviews(handle)).filter(
      (one) => one.recordingId === older || one.recordingId === newer,
    );

    // Newest recording first, which is the ordering the queue already had — the new kind sorts
    // with everything else rather than beside it.
    expect(mine.map((one) => one.recordingId)).toEqual([newer, newer, older]);
    expect(mine.filter((one) => one.recordingId === newer).map((one) => one.kind).sort()).toEqual([
      'scripture',
      'summary',
    ]);

    // The list survives the round trip as entries rather than as text.
    expect(mine.find((one) => one.recordingId === older)?.fields).toEqual({
      citations: MACHINE.scripture,
    });
  });

  it('carries the recording it is about, so the queue reads as work rather than as ids', async () => {
    const recordingId = await newRecording('The kindness of God', '2026-05-17');
    await draftsFor(recordingId, ['summary']);

    const found = (await listPendingReviews(handle)).find((one) => one.recordingId === recordingId);

    expect(found?.recordingTitle).toBe('The kindness of God');
    expect(found?.recordedAt).toBe('2026-05-17');
    expect(found?.fields).toEqual({ summary: 'What the machine wrote.' });
  });

  it('counts the transcript’s words at read time, and answers zero when there is none', async () => {
    const withTranscript = await newRecording('Has a transcript');
    await replaceTranscript(
      {
        recordingId: withTranscript,
        language: 'en',
        confidence: 0.9,
        segments: [
          { startMs: 0, endMs: 1000, text: 'One two three four.' },
          { startMs: 1000, endMs: 2000, text: '  five   six  ' },
          { startMs: 2000, endMs: 3000, text: '' },
        ],
      },
      handle,
    );
    await draftsFor(withTranscript, ['summary']);

    const without = await newRecording('Has none');
    await draftsFor(without, ['summary']);

    const pending = await listPendingReviews(handle);
    // Nothing stores this: at ~900 segments the sum is cheaper than a column somebody has to keep
    // in step with every re-transcription and every Story 5 correction.
    expect(pending.find((one) => one.recordingId === withTranscript)?.wordCount).toBe(6);
    // A recording with no transcript counts zero, which is the honest answer rather than a hole.
    expect(pending.find((one) => one.recordingId === without)?.wordCount).toBe(0);
  });

  it('is ordered newest recording first, like every other admin list', async () => {
    const label = `Order ${Date.now().toString(36)}`;
    for (const [title, day] of [
      [`${label} middle`, '2026-01-05'],
      [`${label} newest`, '2026-07-19'],
      [`${label} oldest`, '2025-12-24'],
    ] as const) {
      await draftsFor(await newRecording(title, day), ['summary']);
    }

    const mine = (await listPendingReviews(handle)).filter((one) =>
      one.recordingTitle.startsWith(label),
    );
    expect(mine.map((one) => one.recordedAt)).toEqual(['2026-07-19', '2026-01-05', '2025-12-24']);

    // And the ordering is the whole list's, not just these rows: every neighbouring pair is in
    // order, so a row another test wrote cannot be sitting out of place between them.
    const all = (await listPendingReviews(handle)).map((one) => one.recordedAt);
    expect([...all].sort().reverse()).toEqual(all);
  });
});

describe('writing drafts', () => {
  it('replaces the open draft of a kind rather than appending a second', async () => {
    const recordingId = await newRecording();
    const [first] = await draftsFor(recordingId, ['summary']);
    const [second] = await draftsFor(recordingId, ['summary']);

    // Dispatch is at-least-once, so the write has to leave one draft per kind however many times
    // it is called.
    expect(second?.id).not.toBe(first?.id);
    expect(await findReviewItem(first?.id ?? '', handle)).toBeNull();
    expect((await findOpenDraft(recordingId, 'summary', handle))?.id).toBe(second?.id);
  });

  it('never deletes a closed item, so the audit trail survives a regeneration', async () => {
    const recordingId = await newRecording();
    const [first] = await draftsFor(recordingId, ['summary']);
    await closeReviewItem({ id: first?.id ?? '', status: 'discarded', reviewedBy: adminId }, handle);

    await draftsFor(recordingId, ['summary']);

    // The row stays as the record of what the machine proposed and who rejected it — which is what
    // makes docs/project/prd.md 3.6.10's deletion satisfied "in the sense that matters" honest.
    expect((await findReviewItem(first?.id ?? '', handle))?.status).toBe('discarded');
  });

  it('leaves the other kind’s draft alone', async () => {
    const recordingId = await newRecording();
    await draftsFor(recordingId, REVIEW_KINDS);
    const metadata = await findOpenDraft(recordingId, 'recording_metadata', handle);

    await draftsFor(recordingId, ['summary']);

    expect((await findOpenDraft(recordingId, 'recording_metadata', handle))?.id).toBe(metadata?.id);
  });
});

describe('closing an item', () => {
  it('stamps who did it and when', async () => {
    const [item] = await draftsFor(await newRecording(), ['summary']);

    const closed = await closeReviewItem(
      { id: item?.id ?? '', status: 'published', reviewedBy: adminId },
      handle,
    );

    expect(closed?.status).toBe('published');
    expect(closed?.reviewedBy).toBe(adminId);
    expect(closed?.reviewedAt).toBeInstanceOf(Date);
  });

  it('answers null for an item that is already closed, from the database', async () => {
    const [item] = await draftsFor(await newRecording(), ['summary']);
    await closeReviewItem({ id: item?.id ?? '', status: 'published', reviewedBy: adminId }, handle);

    // The `status = 'draft'` predicate is what makes a second press a refusal rather than a silent
    // re-apply — including for two admins pressing at the same moment, which no check-then-write
    // could answer correctly.
    const again = await closeReviewItem(
      { id: item?.id ?? '', status: 'discarded', reviewedBy: adminId },
      handle,
    );
    expect(again).toBeNull();
    expect((await findReviewItem(item?.id ?? '', handle))?.status).toBe('published');
  });

  it('takes the admin’s edited text and provenance when they are given', async () => {
    const [item] = await draftsFor(await newRecording(), ['summary']);

    const closed = await closeReviewItem(
      {
        id: item?.id ?? '',
        status: 'published',
        reviewedBy: adminId,
        fields: { summary: 'What the admin wrote instead.' },
        provenance: { fields: { summary: { aiSuggested: true, editedByAdmin: true } } },
      },
      handle,
    );

    expect(closed?.fields).toEqual({ summary: 'What the admin wrote instead.' });
    expect(closed?.provenance).toEqual({
      fields: { summary: { aiSuggested: true, editedByAdmin: true } },
    });
  });

  it('leaves the draft text alone when nothing is supplied', async () => {
    const [item] = await draftsFor(await newRecording(), ['summary']);

    const closed = await closeReviewItem(
      { id: item?.id ?? '', status: 'discarded', reviewedBy: adminId },
      handle,
    );

    // A discard keeps what the machine said in the closed row.
    expect(closed?.fields).toEqual({ summary: 'What the machine wrote.' });
  });
});
