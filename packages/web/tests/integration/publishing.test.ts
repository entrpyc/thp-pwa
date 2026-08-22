import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  RECORDINGS_PATH,
  REVIEW_FIELD,
  ROLE,
  recordingPublishPath,
  recordingSummaryPath,
  recordingSummaryUnpublishPath,
  recordingUnpublishPath,
  type AdminRecordingListPayload,
  type PublicationPayload,
  type RecordingListPayload,
  type RecordingView,
} from '@thp/shared';
import { DOMAIN_EVENT_MESSAGE } from '@thp/shared/observability/events';
import {
  createDatabase,
  enqueueJob,
  findSummaryByRecording,
  insertRecording,
  listSegments,
  publishSummary,
  replaceOpenDrafts,
  replaceTranscript,
  setSummaryPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

/**
 * **Publishing, and the one condition that decides what a member sees.**
 *
 * This is the suite the whole epic's member-visibility claim rests on, and it is deliberately
 * written from the *member's* side: what `GET /api/v1/recordings` answers them, over the four
 * combinations of the two gates, and what it never carries.
 *
 * Three properties beyond that, each of which would be a bug nobody noticed otherwise:
 *
 * 1. **Unpublish deletes nothing.** Everything behind the recording survives, so re-publishing is a
 *    restoration rather than a rebuild.
 * 2. **Publishing has no precondition.** Open drafts, a discarded summary and a missing transcript
 *    all leave a recording publishable (docs/project/prd.md, 3.6.10) — this module must not
 *    second-guess the one judgement the review gate exists to leave with a person.
 * 3. **A member never receives an admin-only field**, asserted as the *exact key set* rather than as
 *    an absence, because a key added later is exactly the kind of leak an absence check misses.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');

let admin: TestAccount;
let adminCookie: string;
let member: TestAccount;
let memberCookie: string;
let handle: DatabaseHandle;
let sql: postgres.Sql;
let seeded = 0;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Answer<T>> {
  const { cookie, ...rest } = init;
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    ...rest,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...rest.headers,
    },
  });
  const body: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    code: (body as { error?: { code?: string } })?.error?.code ?? null,
    body: body as T,
  };
}

const post = <T>(path: string, cookie = adminCookie) =>
  call<T>(path, { method: 'POST', cookie });

/** A recording with a transcript behind it, unless asked for one without. */
async function newRecording(options: { transcript?: boolean } = {}): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/publish-${seeded}-${Date.now().toString(36)}.mp3`,
      title: `Publishable ${seeded} ${Date.now().toString(36)}`,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  if (options.transcript !== false) {
    await replaceTranscript(
      {
        recordingId: row.id,
        language: 'en',
        confidence: 0.94,
        segments: [{ startMs: 0, endMs: 4000, text: 'Good morning.' }],
      },
      handle,
    );
  }
  return row.id;
}

/** This recording, as the caller may see it. `undefined` when they may not see it at all. */
async function readAs(recordingId: string, cookie: string): Promise<RecordingView | undefined> {
  const listed = await call<RecordingListPayload>(RECORDINGS_PATH, { cookie });
  expect(listed.status).toBe(200);
  return listed.body.recordings.find((one) => one.id === recordingId);
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'publish-admin');
  admin = signedInAdmin.account;
  adminCookie = signedInAdmin.cookie;

  const signedInMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'publish-member');
  member = signedInMember.account;
  memberCookie = signedInMember.cookie;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

// =================================================================================================

describe('the publish control', () => {
  it('sets published_at, and clears it again', async () => {
    const recordingId = await newRecording();

    const published = await post<PublicationPayload>(recordingPublishPath(recordingId));
    expect(published.status).toBe(200);
    expect(published.body.publishedAt).not.toBeNull();

    const unpublished = await post<PublicationPayload>(recordingUnpublishPath(recordingId));
    expect(unpublished.status).toBe(200);
    expect(unpublished.body.publishedAt).toBeNull();
  });

  it('answers with the timestamp it already had when pressed twice', async () => {
    const recordingId = await newRecording();

    const first = await post<PublicationPayload>(recordingPublishPath(recordingId));
    const second = await post<PublicationPayload>(recordingPublishPath(recordingId));

    // "When did this go live" is a fact, and a stray tap on a phone should not move it.
    expect(second.status).toBe(200);
    expect(second.body.publishedAt).toBe(first.body.publishedAt);
  });

  it('answers not_found for a recording that does not exist', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await post(recordingPublishPath(missing))).code).toBe('not_found');
    expect((await post(recordingUnpublishPath(missing))).code).toBe('not_found');
  });

  it('has no precondition beyond the recording existing', async () => {
    // Three recordings the gate would have opinions about, if it had any. docs/project/prd.md
    // 3.6.10: nothing publishes automatically, and nothing blocks an admin who has decided.
    const withOpenDrafts = await newRecording();
    await replaceOpenDrafts(
      withOpenDrafts,
      [{ kind: 'summary', fields: { summary: 'Waiting.' }, provenance: {} }],
      handle,
    );

    const withDiscardedSummary = await newRecording();
    const [discarded] = await replaceOpenDrafts(
      withDiscardedSummary,
      [{ kind: 'summary', fields: { summary: 'Rejected.' }, provenance: {} }],
      handle,
    );
    await sql`update review_item set status = 'discarded' where id = ${discarded?.id ?? ''}`;

    const withNoTranscript = await newRecording({ transcript: false });

    for (const recordingId of [withOpenDrafts, withDiscardedSummary, withNoTranscript]) {
      expect((await post(recordingPublishPath(recordingId))).status).toBe(200);
    }
  });

  it('deletes nothing when it takes a teaching down, and restores it whole', async () => {
    const recordingId = await newRecording();
    await publishSummary(recordingId, 'The approved summary.', handle);
    await replaceOpenDrafts(
      recordingId,
      [{ kind: 'recording_metadata', fields: { description: 'A line.' }, provenance: {} }],
      handle,
    );
    await enqueueJob(
      { recordingId, step: 'generate_draft', correlationId: 'a-known-correlation-id' },
      handle,
    );
    await post(recordingPublishPath(recordingId));

    await post(recordingUnpublishPath(recordingId));

    // Everything behind the recording is exactly where it was — one write of `null` and nothing
    // else, which is the whole reason `published_at` is a nullable timestamp rather than a status.
    const [counts] = await sql<{ items: string; jobs: string; transcripts: string }[]>`
      select
        (select count(*)::text from review_item where recording_id = ${recordingId}) as items,
        (select count(*)::text from job where recording_id = ${recordingId}) as jobs,
        (select count(*)::text from transcript where recording_id = ${recordingId}) as transcripts
    `;
    expect(counts).toEqual({ items: '1', jobs: '1', transcripts: '1' });
    expect((await findSummaryByRecording(recordingId, handle))?.content).toBe(
      'The approved summary.',
    );
    const transcript = await sql<{ id: string }[]>`
      select id from transcript where recording_id = ${recordingId}
    `;
    expect(await listSegments(transcript[0]?.id ?? '', handle)).toHaveLength(1);

    // And re-publishing restores visibility rather than rebuilding anything.
    await post(recordingPublishPath(recordingId));
    expect((await readAs(recordingId, memberCookie))?.summary).toBe('The approved summary.');
  });

  it('refuses a member and an anonymous caller on every control', async () => {
    const recordingId = await newRecording();
    await publishSummary(recordingId, 'Approved.', handle);

    for (const path of [
      recordingPublishPath(recordingId),
      recordingUnpublishPath(recordingId),
      recordingSummaryUnpublishPath(recordingId),
    ]) {
      expect((await post(path, memberCookie)).code, path).toBe('forbidden');
      expect((await call(path, { method: 'POST' })).code, path).toBe('unauthenticated');
    }

    const edit = { method: 'PUT', body: JSON.stringify({ content: 'Mine now.' }) } as const;
    expect(
      (await call(recordingSummaryPath(recordingId), { ...edit, cookie: memberCookie })).code,
    ).toBe('forbidden');
    expect((await call(recordingSummaryPath(recordingId), edit)).code).toBe('unauthenticated');

    // Nothing any of them tried actually happened.
    expect((await findSummaryByRecording(recordingId, handle))?.content).toBe('Approved.');
  });
});

describe('what a member is answered', () => {
  it('sees published recordings only, and nothing an operator has business with', async () => {
    const live = await newRecording();
    const hidden = await newRecording();
    await post(recordingPublishPath(live));

    const asMember = await call<RecordingListPayload>(RECORDINGS_PATH, { cookie: memberCookie });
    expect(asMember.status).toBe(200);

    expect(asMember.body.recordings.some((one) => one.id === live)).toBe(true);
    expect(asMember.body.recordings.some((one) => one.id === hidden)).toBe(false);
    // Every row, not only this file's: an unpublished teaching reaching a member is the one failure
    // this product cannot take back.
    expect(asMember.body.recordings.every((one) => one.publishedAt !== null)).toBe(true);

    const row = asMember.body.recordings.find((one) => one.id === live) as RecordingView;
    // The **exact** key set, because a key added later is precisely what an absence check misses.
    expect(Object.keys(row).sort()).toEqual([
      'description',
      'id',
      'publishedAt',
      'recordedAt',
      'summary',
      'title',
    ]);
  });

  it('gives the console the same rows plus the two fields only it needs', async () => {
    const hidden = await newRecording();

    const asAdmin = await call<AdminRecordingListPayload>(RECORDINGS_PATH, { cookie: adminCookie });
    const row = asAdmin.body.recordings.find((one) => one.id === hidden);

    expect(row).toBeDefined();
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'createdAt',
      'description',
      'id',
      'originalMediaKey',
      'publishedAt',
      'recordedAt',
      'summary',
      'title',
    ]);
  });

  it('refuses an anonymous caller, as every route does', async () => {
    expect((await call(RECORDINGS_PATH)).code).toBe('unauthenticated');
  });
});

describe('the two gates over a summary', () => {
  it('shows it only when the recording and the summary are both published', async () => {
    // The four combinations, which is what "two gates" has to mean to be worth having two of.
    const both = await newRecording();
    await publishSummary(both, 'Visible.', handle);
    await post(recordingPublishPath(both));

    const summaryDraft = await newRecording();
    await publishSummary(summaryDraft, 'Not yet.', handle);
    await setSummaryPublication(summaryDraft, false, handle);
    await post(recordingPublishPath(summaryDraft));

    const noSummary = await newRecording();
    await post(recordingPublishPath(noSummary));

    const recordingHidden = await newRecording();
    await publishSummary(recordingHidden, 'Behind a closed gate.', handle);

    expect((await readAs(both, memberCookie))?.summary).toBe('Visible.');
    // A summary returned to draft on a teaching that is still live: the recording is there, its
    // summary is not.
    expect((await readAs(summaryDraft, memberCookie))?.summary).toBeNull();
    expect((await readAs(noSummary, memberCookie))?.summary).toBeNull();
    // The recording's own gate is shut, so the row is absent altogether.
    expect(await readAs(recordingHidden, memberCookie)).toBeUndefined();
  });

  it('shows the description as soon as the recording is live, because it has one gate', async () => {
    const recordingId = await newRecording();
    await sql`update recording set description = 'The approved description.' where id = ${recordingId}`;

    expect(await readAs(recordingId, memberCookie)).toBeUndefined();
    await post(recordingPublishPath(recordingId));
    expect((await readAs(recordingId, memberCookie))?.description).toBe(
      'The approved description.',
    );
  });
});

describe('the summary controls', () => {
  it('edits a published summary without touching its gate', async () => {
    const recordingId = await newRecording();
    const before = await publishSummary(recordingId, 'The first wording.', handle);
    await post(recordingPublishPath(recordingId));

    const edited = await call<PublicationPayload>(recordingSummaryPath(recordingId), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ content: 'The wording an admin preferred.' }),
    });

    expect(edited.status).toBe(200);
    const after = await findSummaryByRecording(recordingId, handle);
    expect(after?.content).toBe('The wording an admin preferred.');
    // Still live, and live since the same moment: editing is not re-publishing.
    expect(after?.publishedAt?.toISOString()).toBe(before.publishedAt?.toISOString());
    expect((await readAs(recordingId, memberCookie))?.summary).toBe(
      'The wording an admin preferred.',
    );
  });

  it('returns a published summary to draft, keeping the text and the teaching', async () => {
    const recordingId = await newRecording();
    await publishSummary(recordingId, 'The approved summary.', handle);
    await post(recordingPublishPath(recordingId));

    const down = await post<PublicationPayload>(recordingSummaryUnpublishPath(recordingId));

    expect(down.status).toBe(200);
    expect(down.body.summaryPublishedAt).toBeNull();
    // Retained, not deleted — re-publishing is the same write with a timestamp.
    expect((await findSummaryByRecording(recordingId, handle))?.content).toBe(
      'The approved summary.',
    );
    const asMember = await readAs(recordingId, memberCookie);
    expect(asMember).toBeDefined();
    expect(asMember?.summary).toBeNull();
  });

  it('refuses to edit a summary into existence, so the gate stays the only way one is made', async () => {
    const recordingId = await newRecording();

    const refused = await call(recordingSummaryPath(recordingId), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ content: 'Written from nowhere.' }),
    });

    expect(refused.status).toBe(404);
    expect(refused.code).toBe('not_found');
    expect(await findSummaryByRecording(recordingId, handle)).toBeNull();
  });

  it('refuses an empty edit', async () => {
    const recordingId = await newRecording();
    await publishSummary(recordingId, 'Something.', handle);

    const refused = await call(recordingSummaryPath(recordingId), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ content: '   ' }),
    });
    expect(refused.status).toBe(400);
    expect(refused.code).toBe('invalid_input');
  });
});

describe('what the log records', () => {
  it('names actor, action and target on publish, unpublish and the summary controls', async () => {
    const offset = logOffset(logPath);
    const recordingId = await newRecording();
    await publishSummary(recordingId, 'Approved.', handle);

    await post(recordingPublishPath(recordingId));
    await call(recordingSummaryPath(recordingId), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ content: 'Edited.' }),
    });
    await post(recordingSummaryUnpublishPath(recordingId));
    await post(recordingUnpublishPath(recordingId));

    const wanted = ['recording.publish', 'recording.unpublish', 'summary.edit', 'summary.unpublish'];
    const lines = await waitForLogLines(logPath, offset, (found) =>
      wanted.every((message) => found.some((line) => line.message === message)),
    );

    for (const message of wanted) {
      const line = lines.find(
        (one) => one.message === message && one['target'] === `recording:${recordingId}`,
      );
      expect(line, message).toBeDefined();
      expect(line).toMatchObject({ actorId: admin.id, actorEmail: admin.email, action: message });
      expect(typeof line?.time).toBe('string');
      expect(typeof line?.correlationId).toBe('string');
    }
  }, 120_000);

  it('emits a domain event on publish that nothing subscribes to', async () => {
    const offset = logOffset(logPath);
    const recordingId = await newRecording();

    await post(recordingPublishPath(recordingId));

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some(
        (line) => line.message === DOMAIN_EVENT_MESSAGE && line['recordingId'] === recordingId,
      ),
    );
    // docs/epics/epic-core-listening/architecture.md § Extension points: §3.17's "a teaching you
    // follow has been published" fans out from this exact event. Nothing consumes it, and no
    // notification row exists.
    const event = lines.find(
      (line) => line.message === DOMAIN_EVENT_MESSAGE && line['recordingId'] === recordingId,
    );
    expect(event).toMatchObject({ event: 'recording_published', type: 'recording_published' });
  });

  it('names the member it refused', async () => {
    const offset = logOffset(logPath);
    const recordingId = await newRecording();

    await post(recordingPublishPath(recordingId), memberCookie);

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some(
        (line) => line.message === 'authorisation.refused' && line['actorId'] === member.id,
      ),
    );
    expect(
      lines.some(
        (line) =>
          line.message === 'authorisation.refused' && line['action'] === 'recording.publish',
      ),
    ).toBe(true);
  });
});

/** The one field name each kind carries, used above and asserted here so it is not a coincidence. */
describe('the field names both writers agree on', () => {
  it('are the ones the shared map declares', () => {
    expect(REVIEW_FIELD).toEqual({ summary: 'summary', recording_metadata: 'description' });
  });
});
