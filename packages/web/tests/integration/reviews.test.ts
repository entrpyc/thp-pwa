import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  REVIEWS_PATH,
  REVIEW_FIELD,
  REVIEW_KINDS,
  ROLE,
  reviewPath,
  reviewRegeneratePath,
  type RegenerateReviewPayload,
  type ResolveReviewPayload,
  type ReviewItemView,
  type ReviewKind,
  type ReviewListPayload,
} from '@thp/shared';
import {
  createDatabase,
  findRecordingById,
  findSummaryByRecording,
  insertRecording,
  replaceOpenDrafts,
  replaceTranscript,
  type DatabaseHandle,
  type ReviewItemRow,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

/**
 * The review gate over HTTP.
 *
 * Two halves, and the split is the design:
 *
 * 1. **Reading the queue** — one route, admin-only, answering both kinds together.
 * 2. **Acting on an item** — approve, edit-then-approve, discard, regenerate. Each writes through
 *    to something and closes the item, and **each is refused on an item that is already closed**,
 *    which is what stops a console reporting an action it did not take.
 *
 * Rows are seeded through `@thp/db` rather than by running the worker: what is under test is the
 * API over the gate, and driving a provider call for each case would be testing Ticket 01 again.
 * Everything is scoped to the recordings this file creates — the suite shares one database, so
 * asserting a total would be asserting what the rest of the run happened to do that second.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');

const REVIEWS_URL = `${baseUrl}${API_PREFIX}${REVIEWS_PATH}`;

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
  readonly message: string | null;
  readonly body: T;
}

async function call<T>(
  url: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Answer<T>> {
  const { cookie, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...rest.headers,
    },
  });
  const body: unknown = await response.json().catch(() => undefined);
  const error = (body as { error?: { code?: string; message?: string } })?.error;
  return {
    status: response.status,
    code: error?.code ?? null,
    message: error?.message ?? null,
    body: body as T,
  };
}

/** An API-relative path, absolute. The path helpers in `@thp/shared` are prefix-relative. */
const api = (path: string) => `${baseUrl}${API_PREFIX}${path}`;

const post = <T>(path: string, body: unknown, cookie = adminCookie) =>
  call<T>(api(path), { method: 'POST', cookie, body: JSON.stringify(body) });

/** A recording with a transcript, so the queue's word count has something to count. */
async function newRecording(title?: string): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/api-review-${seeded}-${Date.now().toString(36)}.mp3`,
      title: title ?? `Review subject ${seeded} ${Date.now().toString(36)}`,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.94,
      segments: [
        { startMs: 0, endMs: 4000, text: 'Good morning and welcome to this teaching.' },
        { startMs: 4000, endMs: 8000, text: 'We are picking up in the second chapter.' },
      ],
    },
    handle,
  );
  return row.id;
}

const MACHINE = {
  summary: 'What the machine wrote about this teaching.',
  recording_metadata: 'A line the machine wrote.',
  // A list-shaped draft, keyed by the same field name the handler writes it under. The book is the
  // canon identity by the time it reaches a row; the model's words stopped at the worker.
  scripture: [
    { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4 },
    { book: 'john', chapter: 3, verseStart: 16, verseEnd: 16 },
  ],
} as const;

/** Drafts written the way the handler writes them. */
async function drafts(
  recordingId: string,
  kinds: readonly ReviewKind[],
): Promise<ReviewItemRow[]> {
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

async function draft(kind: ReviewKind): Promise<{ recordingId: string; item: ReviewItemRow }> {
  const recordingId = await newRecording();
  const [item] = await drafts(recordingId, [kind]);
  return { recordingId, item: item as ReviewItemRow };
}

async function itemRow(id: string) {
  const [row] = await sql<
    { status: string; fields: unknown; provenance: unknown; reviewed_by: string | null; reviewed_at: Date | null }[]
  >`select status::text as status, fields, provenance, reviewed_by, reviewed_at
      from review_item where id = ${id}`;
  return row;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'review-admin');
  admin = signedInAdmin.account;
  adminCookie = signedInAdmin.cookie;

  const signedInMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'review-member');
  member = signedInMember.account;
  memberCookie = signedInMember.cookie;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

// =================================================================================================

describe('reading the queue', () => {
  it('answers with everything waiting, of both kinds, and what it is about', async () => {
    const recordingId = await newRecording('Both kinds waiting');
    await drafts(recordingId, REVIEW_KINDS);

    const listed = await call<ReviewListPayload>(REVIEWS_URL, { cookie: adminCookie });

    expect(listed.status).toBe(200);
    const mine = listed.body.reviews.filter((one) => one.recordingId === recordingId);
    expect(mine.map((one) => one.kind).sort()).toEqual([...REVIEW_KINDS].sort());

    const summary = mine.find((one) => one.kind === 'summary') as ReviewItemView;
    expect(summary.recordingTitle).toBe('Both kinds waiting');
    expect(summary.recordedAt).toBe('2026-08-16');
    expect(summary.status).toBe('draft');
    expect(summary.fields).toEqual({ summary: MACHINE.summary });
    expect(summary.provenance.model).toBe('fake');
    // The transcript's word count, computed at read time — the fourth thing 3.6.5 asks the form to
    // show beside the draft.
    expect(summary.wordCount).toBe(15);

    // 1.2.4 — the scripture item comes back from the same one read, with its citations as
    // structured entries rather than as a block of text.
    const scripture = mine.find((one) => one.kind === 'scripture') as ReviewItemView;
    expect(scripture.fields).toEqual({ citations: MACHINE.scripture });
    expect(Array.isArray(scripture.fields['citations'])).toBe(true);
    expect(scripture.recordingTitle).toBe('Both kinds waiting');
    expect(scripture.wordCount).toBe(15);
  });

  it('drops an item as soon as it is closed', async () => {
    const { recordingId, item } = await draft('summary');
    expect((await post(reviewPath(item.id), { action: 'discard' })).status).toBe(200);

    const listed = await call<ReviewListPayload>(REVIEWS_URL, { cookie: adminCookie });
    expect(listed.body.reviews.filter((one) => one.recordingId === recordingId)).toHaveLength(0);
  });

  it('refuses a member and an anonymous caller', async () => {
    const asMember = await call(REVIEWS_URL, { cookie: memberCookie });
    expect(asMember.status).toBe(403);
    expect(asMember.code).toBe('forbidden');

    const anonymous = await call(REVIEWS_URL);
    expect(anonymous.status).toBe(401);
    expect(anonymous.code).toBe('unauthenticated');
  });
});

describe('approving a draft', () => {
  it('writes the summary through, published, and closes the item', async () => {
    const { recordingId, item } = await draft('summary');

    const resolved = await post<ResolveReviewPayload>(reviewPath(item.id), { action: 'approve' });

    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('published');

    // The canonical entity, which is what a member will read — approving the summary publishes the
    // summary; the teaching's own gate is the separate decision.
    const summary = await findSummaryByRecording(recordingId, handle);
    expect(summary?.content).toBe(MACHINE.summary);
    expect(summary?.publishedAt).toBeInstanceOf(Date);

    const row = await itemRow(item.id);
    expect(row?.status).toBe('published');
    expect(row?.reviewed_by).toBe(admin.id);
    expect(row?.reviewed_at).toBeInstanceOf(Date);
  });

  it('writes the description through onto the recording, and closes the item', async () => {
    const { recordingId, item } = await draft('recording_metadata');

    expect((await post(reviewPath(item.id), { action: 'approve' })).status).toBe(200);

    // A column on the recording rather than a row of its own, because unlike the summary it has no
    // second gate: it rides the recording's publish state.
    expect((await findRecordingById(recordingId, handle))?.description).toBe(
      MACHINE.recording_metadata,
    );
    expect((await itemRow(item.id))?.status).toBe('published');
  });

  it('writes the admin’s text when they edited it, and records that they did', async () => {
    const { recordingId, item } = await draft('summary');
    const mine = 'What the admin wrote instead, in their own words.';

    expect(
      (await post(reviewPath(item.id), { action: 'approve', fields: { summary: mine } })).status,
    ).toBe(200);

    expect((await findSummaryByRecording(recordingId, handle))?.content).toBe(mine);

    const row = await itemRow(item.id);
    // docs/project/prd.md 4.17.5: per field, that it was AI-suggested and that an admin changed it.
    expect((row?.provenance as { fields: Record<string, unknown> }).fields['summary']).toEqual({
      aiSuggested: true,
      editedByAdmin: true,
    });
    expect(row?.fields).toEqual({ summary: mine });
  });

  it('records no edit when the admin sent back exactly what the machine wrote', async () => {
    const { item } = await draft('summary');

    await post(reviewPath(item.id), { action: 'approve', fields: { summary: MACHINE.summary } });

    const row = await itemRow(item.id);
    expect((row?.provenance as { fields: Record<string, unknown> }).fields['summary']).toEqual({
      aiSuggested: true,
      editedByAdmin: false,
    });
  });

  it('refuses an empty approval rather than publishing nothing', async () => {
    const { item } = await draft('summary');

    const refused = await post(reviewPath(item.id), { action: 'approve', fields: { summary: '  ' } });

    expect(refused.status).toBe(400);
    expect(refused.code).toBe('invalid_input');
    expect((await itemRow(item.id))?.status).toBe('draft');
  });
});

describe('discarding a draft', () => {
  it('closes the item with no replacement, and leaves the recording publishable', async () => {
    const { recordingId, item } = await draft('summary');

    const resolved = await post<ResolveReviewPayload>(reviewPath(item.id), { action: 'discard' });

    expect(resolved.body.status).toBe('discarded');
    // What 3.6.10 is protecting: no summary exists and nothing is member-visible.
    expect(await findSummaryByRecording(recordingId, handle)).toBeNull();
    expect((await findRecordingById(recordingId, handle))?.description).toBeNull();

    // And the draft text stays in the closed row as the record of what was rejected.
    expect((await itemRow(item.id))?.fields).toEqual({ summary: MACHINE.summary });

    // Publishing immediately afterwards succeeds — a discarded draft is not a precondition.
    const published = await post(`/recordings/${recordingId}/publish`, undefined);
    expect(published.status).toBe(200);
  });
});

describe('acting on an item that is already closed', () => {
  it('is refused for approve, edit-approve and discard, on both closed statuses', async () => {
    for (const how of ['approve', 'discard'] as const) {
      const { item } = await draft('summary');
      // Close it once, either way.
      expect((await post(reviewPath(item.id), { action: how })).status).toBe(200);

      for (const body of [
        { action: 'approve' },
        { action: 'approve', fields: { summary: 'Second thoughts.' } },
        { action: 'discard' },
      ]) {
        const refused = await post(reviewPath(item.id), body);
        // A refusal rather than a silent re-apply, so a console cannot report an action it did not
        // take — the same argument `account_state_conflict` is made on.
        expect(refused.status, `${how} then ${JSON.stringify(body)}`).toBe(409);
        expect(refused.code).toBe('review_closed');
      }
    }
  }, 120_000);

  it('answers not_found for an item that never existed', async () => {
    const missing = await post(reviewPath('00000000-0000-0000-0000-000000000000'), {
      action: 'approve',
    });
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('not_found');
  });

  it('refuses a member and an anonymous caller', async () => {
    const { item } = await draft('summary');

    const asMember = await post(reviewPath(item.id), { action: 'approve' }, memberCookie);
    expect(asMember.status).toBe(403);
    expect(asMember.code).toBe('forbidden');

    const anonymous = await call(api(reviewPath(item.id)), {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.code).toBe('unauthenticated');

    // Neither of them changed anything.
    expect((await itemRow(item.id))?.status).toBe('draft');
  });
});

describe('regenerating a draft', () => {
  it('discards the current one and queues the same step, carrying the kind and the prompt', async () => {
    const { recordingId, item } = await draft('summary');

    const again = await post<RegenerateReviewPayload>(reviewRegeneratePath(item.id), {
      prompt: 'It missed the point about the second half.',
    });

    expect(again.status).toBe(200);
    expect(again.body.kind).toBe('summary');
    expect((await itemRow(item.id))?.status).toBe('discarded');

    const [job] = await sql<{ step: string; status: string; payload: unknown; correlation_id: string }[]>`
      select step::text as step, status::text as status, payload, correlation_id
      from job where id = ${again.body.jobId}
    `;
    // The same handler the chain runs, told which kind to draft and what to change — which is what
    // makes Story 5's regeneration offer a call to something that already exists.
    expect(job?.step).toBe('generate_draft');
    expect(job?.status).toBe('pending');
    expect(job?.payload).toEqual({
      kinds: ['summary'],
      prompt: 'It missed the point about the second half.',
    });
    expect(job?.correlation_id).not.toBe('');
    expect(again.body.recordingId).toBe(recordingId);
  });

  it('is legal with no prompt at all', async () => {
    const { item } = await draft('summary');

    const again = await post<RegenerateReviewPayload>(reviewRegeneratePath(item.id), {});

    expect(again.status).toBe(200);
    const [job] = await sql<{ payload: unknown }[]>`
      select payload from job where id = ${again.body.jobId}
    `;
    expect(job?.payload).toEqual({ kinds: ['summary'] });
  });

  it('refuses a second regeneration while one is unfinished, with a named error', async () => {
    const recordingId = await newRecording();
    const [summary, metadata] = await drafts(recordingId, REVIEW_KINDS);

    expect((await post(reviewRegeneratePath(summary?.id ?? ''), {})).status).toBe(200);

    // The partial unique index allows one unfinished `generate_draft` per recording, so answering
    // with the existing job would hand back work for the *other* kind. Refusing is the honest
    // answer at 4.3 recordings a month.
    const second = await post(reviewRegeneratePath(metadata?.id ?? ''), {});
    expect(second.status).toBe(409);
    expect(second.code).toBe('generation_in_flight');
    // And the item it refused is untouched — nothing was discarded on the way to the refusal.
    expect((await itemRow(metadata?.id ?? ''))?.status).toBe('draft');
  });

  it('is refused on an item that is already closed', async () => {
    const { item } = await draft('summary');
    await post(reviewPath(item.id), { action: 'discard' });

    const refused = await post(reviewRegeneratePath(item.id), {});
    expect(refused.status).toBe(409);
    expect(refused.code).toBe('review_closed');
  });

  it('refuses a steering sentence sent as an essay', async () => {
    const { item } = await draft('summary');

    const refused = await post(reviewRegeneratePath(item.id), { prompt: 'x'.repeat(5000) });
    expect(refused.status).toBe(400);
    expect(refused.code).toBe('invalid_input');
    expect((await itemRow(item.id))?.status).toBe('draft');
  });

  it('refuses a member and an anonymous caller', async () => {
    const { item } = await draft('summary');

    const asMember = await post(reviewRegeneratePath(item.id), {}, memberCookie);
    expect(asMember.status).toBe(403);
    expect(asMember.code).toBe('forbidden');

    const anonymous = await call(api(reviewRegeneratePath(item.id)), {
      method: 'POST',
      body: '{}',
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.code).toBe('unauthenticated');
  });
});

describe('what the log records', () => {
  it('names actor, action and target on every transition', async () => {
    const offset = logOffset(logPath);

    const approved = await draft('summary');
    await post(reviewPath(approved.item.id), { action: 'approve' });

    const discarded = await draft('summary');
    await post(reviewPath(discarded.item.id), { action: 'discard' });

    const regenerated = await draft('summary');
    await post(reviewRegeneratePath(regenerated.item.id), { prompt: 'Try again.' });

    const lines = await waitForLogLines(logPath, offset, (found) =>
      ['review.approve', 'review.discard', 'review.regenerate'].every((message) =>
        found.some((line) => line.message === message),
      ),
    );

    // The standing constraint of the implementation plan: actor, action, target and timestamp. The
    // logger supplies the last, under this request's correlation id.
    for (const [message, action, id] of [
      ['review.approve', 'review.resolve', approved.item.id],
      ['review.discard', 'review.resolve', discarded.item.id],
      ['review.regenerate', 'review.regenerate', regenerated.item.id],
    ] as const) {
      const line = lines.find((one) => one.message === message && one['target'] === `review_item:${id}`);
      expect(line, message).toBeDefined();
      expect(line).toMatchObject({ actorId: admin.id, actorEmail: admin.email, action });
      expect(typeof line?.time).toBe('string');
      expect(typeof line?.correlationId).toBe('string');
    }
  }, 120_000);

  it('names the member it refused, so a refusal is readable as one', async () => {
    const offset = logOffset(logPath);
    await call(REVIEWS_URL, { cookie: memberCookie });

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some((line) => line.message === 'authorisation.refused' && line['actorId'] === member.id),
    );
    expect(
      lines.some(
        (line) => line.message === 'authorisation.refused' && line['action'] === 'review.list',
      ),
    ).toBe(true);
  });
});
