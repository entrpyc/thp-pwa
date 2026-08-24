import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  REVIEW_FIELD,
  ROLE,
  reviewPath,
  type ResolveReviewPayload,
  type ScriptureCitation,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  replaceOpenDrafts,
  replaceTranscript,
  type DatabaseHandle,
  type ReviewItemRow,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

/**
 * **Approving a list makes it the teaching's references** (Task 1.4), over HTTP.
 *
 * The half of the review gate that is genuinely new. Approving a summary writes one row of text;
 * approving a list *replaces a set*, and the properties that follow from that are what this file
 * is for:
 *
 * 1. **The references and the close land together**, so no teaching ever carries references from a
 *    draft still sitting in the queue.
 * 2. **An empty list is an answer**, distinguishable from nobody having looked.
 * 3. **A later approval replaces**, rather than growing the union of every draft ever approved.
 * 4. **A second resolve is refused**, by the same `status = 'draft'` predicate that already refuses
 *    a second approval of a summary.
 * 5. **A discard writes nothing and keeps everything** — the citations, the model, the versions.
 *
 * Rows are seeded through `@thp/db` rather than by running the worker: what is under test is the
 * API over the gate.
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

const FIELD = REVIEW_FIELD.scripture.name;

const PROPOSED: readonly ScriptureCitation[] = [
  { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4 },
  { book: 'john', chapter: 3, verseStart: 16, verseEnd: 16 },
];

const PROVENANCE = {
  model: 'fake',
  modelVersion: 'fake-1',
  promptVersion: 'draft-1',
  steeringPrompt: 'It missed the passage in the second half.',
  fields: { [FIELD]: { aiSuggested: true, editedByAdmin: false } },
};

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
}

async function call<T>(url: string, init: RequestInit & { cookie?: string } = {}): Promise<Answer<T>> {
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
  return {
    status: response.status,
    code: (body as { error?: { code?: string } })?.error?.code ?? null,
    body: body as T,
  };
}

const post = <T>(path: string, body: unknown, cookie = adminCookie) =>
  call<T>(`${baseUrl}${API_PREFIX}${path}`, { method: 'POST', cookie, body: JSON.stringify(body) });

async function newRecording(): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/scripture-review-${seeded}-${Date.now().toString(36)}.mp3`,
      title: `Scripture subject ${seeded} ${Date.now().toString(36)}`,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.94,
      segments: [{ startMs: 0, endMs: 4000, text: 'We are picking up in the second chapter.' }],
    },
    handle,
  );
  return row.id;
}

/** An open scripture draft holding these citations. */
async function draft(
  citations: readonly ScriptureCitation[] = PROPOSED,
  recordingId?: string,
): Promise<{ recordingId: string; item: ReviewItemRow }> {
  const id = recordingId ?? (await newRecording());
  const [item] = await replaceOpenDrafts(
    id,
    [{ kind: 'scripture', fields: { [FIELD]: citations }, provenance: PROVENANCE }],
    handle,
  );
  return { recordingId: id, item: item as ReviewItemRow };
}

/** The teaching's references, in a stable order so a comparison is a comparison. */
async function references(recordingId: string) {
  return sql<
    { book: string; chapter: number; verse_start: number; verse_end: number; origin: string; edited_by_admin: boolean }[]
  >`
    select book, chapter, verse_start, verse_end, origin::text as origin, edited_by_admin
    from scripture_reference where recording_id = ${recordingId}
    order by book, chapter, verse_start
  `;
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

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'scripture-admin');
  admin = signedInAdmin.account;
  adminCookie = signedInAdmin.cookie;

  const signedInMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'scripture-member');
  member = signedInMember.account;
  memberCookie = signedInMember.cookie;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

// =================================================================================================

describe('approving a list', () => {
  // 1.4.2 — every reference written, the item closed, and both in one transaction.
  it('writes every reference in the list and closes the item', async () => {
    const { recordingId, item } = await draft();

    const resolved = await post<ResolveReviewPayload>(reviewPath(item.id), { action: 'approve' });

    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('published');

    expect(await references(recordingId)).toEqual([
      { book: 'john', chapter: 3, verse_start: 16, verse_end: 16, origin: 'machine', edited_by_admin: false },
      { book: 'romans', chapter: 8, verse_start: 1, verse_end: 4, origin: 'machine', edited_by_admin: false },
    ]);

    const closed = await itemRow(item.id);
    expect(closed?.status).toBe('published');
    expect(closed?.reviewed_by).toBe(admin.id);
    expect(closed?.reviewed_at).not.toBeNull();
  });

  it('leaves neither the references nor a closed item when the write cannot land', async () => {
    // The transaction, driven by making the *second* statement impossible: the item is closed out
    // from under the request, so the update matches nothing and the whole thing rolls back. If the
    // two were separate writes, the references would already be there.
    const { recordingId, item } = await draft();
    await sql`update review_item set status = 'discarded' where id = ${item.id}`;

    const refused = await post(reviewPath(item.id), { action: 'approve' });

    expect(refused.status).toBe(409);
    expect(await references(recordingId)).toHaveLength(0);
  });

  // 1.4.3 — approving nothing is a real act, and reads differently from nobody having looked.
  it('records an empty list as a teaching with no references, not as a teaching nobody read', async () => {
    const reviewed = await draft([]);
    const approved = await post<ResolveReviewPayload>(reviewPath(reviewed.item.id), {
      action: 'approve',
    });
    expect(approved.status).toBe(200);

    const unread = await draft();

    // Neither teaching has a reference. What tells them apart is the closed item: one has a
    // published scripture review, and one still has it waiting.
    expect(await references(reviewed.recordingId)).toHaveLength(0);
    expect(await references(unread.recordingId)).toHaveLength(0);
    expect((await itemRow(reviewed.item.id))?.status).toBe('published');
    expect((await itemRow(unread.item.id))?.status).toBe('draft');
  });

  // 1.4.4 — the approved list is what the last approval said, in full.
  it('replaces the recording’s references rather than appending to them', async () => {
    const { recordingId, item } = await draft();
    await post(reviewPath(item.id), { action: 'approve' });
    expect(await references(recordingId)).toHaveLength(2);

    const second = await draft([{ book: 'acts', chapter: 2, verseStart: 1, verseEnd: 4 }], recordingId);
    await post(reviewPath(second.item.id), { action: 'approve' });

    const after = await references(recordingId);
    expect(after.map((row) => row.book)).toEqual(['acts']);
  });

  it('empties the references when a later draft is approved with none', async () => {
    const { recordingId, item } = await draft();
    await post(reviewPath(item.id), { action: 'approve' });

    const second = await draft([], recordingId);
    await post(reviewPath(second.item.id), { action: 'approve' });

    expect(await references(recordingId)).toHaveLength(0);
  });

  // 1.4.5 — the close is what refuses it, from the database rather than from a check with a
  // window in it.
  it('refuses a second resolve, and writes nothing twice', async () => {
    const { recordingId, item } = await draft();

    const first = await post<ResolveReviewPayload>(reviewPath(item.id), { action: 'approve' });
    const second = await post(reviewPath(item.id), { action: 'approve' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.code).toBe('review_closed');
    expect(await references(recordingId)).toHaveLength(2);
  });

  it('refuses two simultaneous approvals of the same item, and one of them wins', async () => {
    const { recordingId, item } = await draft();

    const [one, two] = await Promise.all([
      post(reviewPath(item.id), { action: 'approve' }),
      post(reviewPath(item.id), { action: 'approve' }),
    ]);

    expect([one.status, two.status].sort()).toEqual([200, 409]);
    // Two admins pressing at the same moment leaves one set of references, not two.
    expect(await references(recordingId)).toHaveLength(2);
  });
});

describe('discarding a list', () => {
  // 1.4.6 — nothing written, and everything the machine said kept.
  it('writes no reference and leaves the proposal and its provenance in the closed row', async () => {
    const { recordingId, item } = await draft();

    const discarded = await post<ResolveReviewPayload>(reviewPath(item.id), { action: 'discard' });

    expect(discarded.status).toBe(200);
    expect(discarded.body.status).toBe('discarded');
    expect(await references(recordingId)).toHaveLength(0);

    const closed = await itemRow(item.id);
    // A rejected draft leaves a record rather than nothing: what was proposed, which model, which
    // versions, and what the admin steered the last attempt with.
    expect(closed?.fields).toEqual({ [FIELD]: PROPOSED });
    expect(closed?.provenance).toEqual(PROVENANCE);
    expect(closed?.reviewed_by).toBe(admin.id);
  });
});

describe('who may resolve one', () => {
  // 1.4.7 — refused server-side whatever the client sends, and every resolve logged.
  it('refuses a member and an anonymous caller, and writes nothing for either', async () => {
    const { recordingId, item } = await draft();

    const asMember = await post(reviewPath(item.id), { action: 'approve' }, memberCookie);
    expect(asMember.status).toBe(403);
    expect(asMember.code).toBe('forbidden');

    const anonymous = await call(`${baseUrl}${API_PREFIX}${reviewPath(item.id)}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(anonymous.status).toBe(401);

    expect(await references(recordingId)).toHaveLength(0);
    expect((await itemRow(item.id))?.status).toBe('draft');
  });

  it('logs the actor, the action, the target and the time of every resolve', async () => {
    const offset = await logOffset(logPath);
    const approved = await draft();
    await post(reviewPath(approved.item.id), { action: 'approve' });
    const thrown = await draft();
    await post(reviewPath(thrown.item.id), { action: 'discard' });

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some((line) => line['target'] === `review_item:${thrown.item.id}`),
    );
    const mine = lines.filter(
      (line) =>
        line['target'] === `review_item:${approved.item.id}` ||
        line['target'] === `review_item:${thrown.item.id}`,
    );

    expect(mine.map((line) => line.message).sort()).toEqual(['review.approve', 'review.discard']);
    for (const line of mine) {
      expect(line['action']).toBe('review.resolve');
      expect(line['actorId']).toBe(admin.id);
      expect(line['kind']).toBe('scripture');
      expect(line['time']).toBeTruthy();
    }
    // How many references the approval wrote, so the log says what happened rather than only that
    // something did.
    expect(mine.find((line) => line.message === 'review.approve')?.['references']).toBe(2);
  });

  it('refuses a member reading the queue, so the citations never reach one', async () => {
    await draft();
    const asMember = await call(`${baseUrl}${API_PREFIX}/reviews`, { cookie: memberCookie });

    expect(asMember.status).toBe(403);
    expect(asMember.code).toBe('forbidden');
  });
});
