import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  REVIEW_FIELD,
  ROLE,
  passagePath,
  reviewPath,
  reviewRegeneratePath,
  type RegenerateReviewPayload,
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

// =================================================================================================

/**
 * **An admin corrects the list before approving** (Task 2.1, Task 2.2), over HTTP.
 *
 * The form sends the list it rendered, one entry per row, each naming the proposal it came from —
 * `from` is the index in the machine's list, or `null` for a reference a person added. That one
 * field is what lets the server say which of the three things [3.2.9](docs/active-scope/prd.md)
 * asks about happened to each reference, without trusting a client to assert it.
 */
describe('approving an edited list', () => {
  /** Romans corrected, John kept exactly as proposed, Ephesians added by hand. */
  const CORRECTED = [
    { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 5, from: 0 },
    { book: 'john', chapter: 3, verseStart: 16, verseEnd: 16, from: 1 },
    { book: 'ephesians', chapter: 2, verseStart: 8, verseEnd: 9, from: null },
  ];

  // 2.1.4 — what lands is what the admin approved, and what the machine said is still readable.
  it('writes the admin’s list rather than the machine’s, and keeps the proposal on the closed row', async () => {
    const { recordingId, item } = await draft();

    const approved = await post<ResolveReviewPayload>(reviewPath(item.id), {
      action: 'approve',
      // John removed by the admin: a row the form dropped simply is not in what it sends.
      fields: { [FIELD]: CORRECTED.filter((one) => one.book !== 'john') },
    });

    expect(approved.status).toBe(200);
    expect(
      (await references(recordingId)).map(
        (one) => `${one.book} ${one.chapter}:${one.verse_start}-${one.verse_end}`,
      ),
    ).toEqual(['ephesians 2:8-9', 'romans 8:1-5']);

    // The machine's original, untouched, on the closed item — the correction is a fact about what
    // the admin approved, not an overwrite of what was proposed.
    expect((await itemRow(item.id))?.fields).toEqual({ [FIELD]: PROPOSED });
  });

  // 2.2.3 — three distinct facts, one per reference.
  it('records per reference whether the machine proposed it, an admin edited it, or an admin added it', async () => {
    const { recordingId, item } = await draft();

    expect(
      (await post(reviewPath(item.id), { action: 'approve', fields: { [FIELD]: CORRECTED } })).status,
    ).toBe(200);

    expect(
      (await references(recordingId)).map((one) => [one.book, one.origin, one.edited_by_admin]),
    ).toEqual([
      // Added by a person, so nothing about it is the machine's and nothing was edited.
      ['ephesians', 'person', false],
      // Taken exactly as proposed.
      ['john', 'machine', false],
      // The machine's, changed before it was approved.
      ['romans', 'machine', true],
    ]);
  });

  // 2.2.4 — and the same record survives where the model and the versions live.
  it('keeps that per-reference record on the closed item, beside the model and the prompt version', async () => {
    const { item } = await draft();

    await post(reviewPath(item.id), { action: 'approve', fields: { [FIELD]: CORRECTED } });

    const closed = await itemRow(item.id);
    const provenance = closed?.provenance as Record<string, unknown>;
    expect(provenance['model']).toBe(PROVENANCE.model);
    expect(provenance['modelVersion']).toBe(PROVENANCE.modelVersion);
    expect(provenance['promptVersion']).toBe(PROVENANCE.promptVersion);
    expect(provenance['steeringPrompt']).toBe(PROVENANCE.steeringPrompt);

    const field = (provenance['fields'] as Record<string, unknown>)[FIELD] as Record<string, unknown>;
    expect(field['aiSuggested']).toBe(true);
    // The list as a whole was changed before it was approved, which is what the field-level flag
    // has always meant.
    expect(field['editedByAdmin']).toBe(true);
    expect(field['entries']).toEqual([
      { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 5, origin: 'machine', editedByAdmin: true },
      { book: 'john', chapter: 3, verseStart: 16, verseEnd: 16, origin: 'machine', editedByAdmin: false },
      { book: 'ephesians', chapter: 2, verseStart: 8, verseEnd: 9, origin: 'person', editedByAdmin: false },
    ]);
  });

  // 2.1.5 — the screen's validator is not the product's. Every citation is checked again here.
  it('refuses a list holding a citation the client would not have allowed, and writes nothing', async () => {
    const refusals = [
      { entry: { book: 'Hezekiah', chapter: 1, verseStart: 1, verseEnd: 1, from: null }, says: 'Hezekiah' },
      { entry: { book: 'romans', chapter: 99, verseStart: 1, verseEnd: 1, from: null }, says: 'chapter 99' },
      { entry: { book: 'romans', chapter: 8, verseStart: 4, verseEnd: 1, from: null }, says: 'end at or after' },
      { entry: { book: 'john', chapter: 3, verseStart: 16, verseEnd: 999, from: null }, says: 'verse 999' },
    ];

    for (const { entry, says } of refusals) {
      const { recordingId, item } = await draft();

      const refused = await post(reviewPath(item.id), {
        action: 'approve',
        fields: { [FIELD]: [entry] },
      });

      expect(refused.status).toBe(400);
      expect(refused.code).toBe('invalid_input');
      expect((refused.body as { error?: { message?: string } }).error?.message).toContain(says);
      // Refused before anything is written: no reference, and the draft is still waiting.
      expect(await references(recordingId)).toHaveLength(0);
      expect((await itemRow(item.id))?.status).toBe('draft');
    }
  });

  // The same passage twice is a list the form would not have let an admin build (2.2.2), and it is
  // also the one shape the table's unique index would answer with a crash rather than a refusal.
  it('refuses a list naming the same passage twice', async () => {
    const { recordingId, item } = await draft();

    const refused = await post(reviewPath(item.id), {
      action: 'approve',
      fields: {
        [FIELD]: [
          { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4, from: 0 },
          { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4, from: null },
        ],
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.code).toBe('invalid_input');
    expect(await references(recordingId)).toHaveLength(0);
    expect((await itemRow(item.id))?.status).toBe('draft');
  });
});

/**
 * **Asking for the scripture references again** (Task 2.3).
 *
 * The route is the one [3.6.9](docs/project/prd.md) already built for a summary; what these assert
 * is that a scripture item reaching it re-drafts *scripture alone* and leaves the teaching's other
 * open drafts where they are.
 */
describe('asking for the scripture references again', () => {
  /** A teaching whose scripture and summary are both waiting on an admin. */
  async function bothOpen(): Promise<{ scripture: ReviewItemRow; summary: ReviewItemRow }> {
    const recordingId = await newRecording();
    const [scripture, summary] = await replaceOpenDrafts(
      recordingId,
      [
        { kind: 'scripture', fields: { [FIELD]: PROPOSED }, provenance: PROVENANCE },
        { kind: 'summary', fields: { summary: 'What the machine heard.' }, provenance: PROVENANCE },
      ],
      handle,
    );
    return { scripture: scripture as ReviewItemRow, summary: summary as ReviewItemRow };
  }

  // 2.3.1 — scripture alone, with the steer, and the summary untouched.
  it('discards the open item and enqueues the step for scripture alone', async () => {
    const { scripture, summary } = await bothOpen();

    const again = await post<RegenerateReviewPayload>(reviewRegeneratePath(scripture.id), {
      prompt: 'It missed the passage the whole teaching was built on.',
    });

    expect(again.status).toBe(200);
    expect(again.body.kind).toBe('scripture');
    expect((await itemRow(scripture.id))?.status).toBe('discarded');

    const [job] = await sql<{ step: string; payload: unknown }[]>`
      select step::text as step, payload from job where id = ${again.body.jobId}
    `;
    expect(job?.step).toBe('generate_draft');
    expect(job?.payload).toEqual({
      kinds: ['scripture'],
      prompt: 'It missed the passage the whole teaching was built on.',
    });

    // The summary is not re-drafted and its draft is not discarded: asking for one artefact again
    // is not asking for the other.
    expect((await itemRow(summary.id))?.status).toBe('draft');
  });

  // 2.3.4 — the existing one-in-flight rule, checked from the scripture side.
  it('refuses a second request while one is unfinished rather than answering with the first one’s job', async () => {
    const { scripture, summary } = await bothOpen();

    expect((await post(reviewRegeneratePath(scripture.id), {})).status).toBe(200);

    const second = await post(reviewRegeneratePath(summary.id), {});
    expect(second.status).toBe(409);
    expect(second.code).toBe('generation_in_flight');
    // And the item it refused is untouched — nothing was discarded on the way to the refusal.
    expect((await itemRow(summary.id))?.status).toBe('draft');
  });
});

/**
 * **Verse text is editable nowhere** ([3.3.4](docs/active-scope/implementation-plan.md),
 * [3.3.8](docs/active-scope/prd.md)).
 *
 * The half of that which is a fact about the API rather than about a screen: nothing in the product
 * accepts verse text, so correcting a passage means correcting the citation. Asserted from the
 * outside, over HTTP, because a rule that only holds in the client is a rule a `curl` breaks.
 */
describe('nothing accepts verse text', () => {
  const passageUrl = (citation: ScriptureCitation) =>
    `${baseUrl}${API_PREFIX}${passagePath(citation)}`;

  const JOHN: ScriptureCitation = { book: 'john', chapter: 3, verseStart: 16, verseEnd: 16 };

  /** Every verse held for a chapter, so "nothing wrote one" is a comparison rather than a claim. */
  async function heldText(book: string, chapter: number): Promise<string[]> {
    const rows = await sql<{ text: string }[]>`
      select text from verse_text where book = ${book} and chapter = ${chapter} order by verse
    `;
    return rows.map((row) => row.text);
  }

  it('reads a passage and offers no way to write one', async () => {
    const read = await call<{ passage: string | null }>(passageUrl(JOHN), { cookie: adminCookie });
    expect(read.status).toBe(200);
    expect(read.body.passage).toContain('John 3:16');
    // Reading held exactly what it read, and nothing beside it.
    expect(await heldText('john', 3)).toContain(read.body.passage);

    // Compared before and after rather than against a list, because this chapter is shared with
    // every other file in the run — what is asserted is that these calls changed nothing, which is
    // the claim, not how many verses happen to be held.
    const before = await heldText('john', 3);

    // The only verb the route has. Everything else is refused by the framework because there is no
    // handler to refuse it — which is the strongest form of "there is no write here".
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const written = await call(passageUrl(JOHN), {
        method,
        cookie: adminCookie,
        body: JSON.stringify({ passage: 'Words nobody translated.' }),
      });
      expect(written.status, method).toBe(405);
    }

    expect(await heldText('john', 3)).toEqual(before);
  });

  it('ignores text sent alongside a reference, and stores none', async () => {
    const { recordingId, item } = await draft();

    const resolved = await post<ResolveReviewPayload>(reviewPath(item.id), {
      action: 'approve',
      fields: {
        [FIELD]: [
          {
            book: 'john',
            chapter: 3,
            verseStart: 16,
            verseEnd: 16,
            from: 1,
            // What a client would send if it thought it could correct a passage.
            text: 'For God so loved the client that sent this.',
          },
        ],
      },
    });

    expect(resolved.status).toBe(200);
    expect(await references(recordingId)).toEqual([
      { book: 'john', chapter: 3, verse_start: 16, verse_end: 16, origin: 'machine', edited_by_admin: false },
    ]);
    // Not on the reference — the table has no column for it — and not in the cache either.
    expect(await heldText('john', 3)).not.toContain('For God so loved the client that sent this.');
  });

  it('refuses a reader the review queue would refuse', async () => {
    // The same one-place decision every other admin read goes through, so the lookup cannot become
    // a way around it.
    expect((await call(passageUrl(JOHN), { cookie: memberCookie })).status).toBe(403);
    expect((await call(passageUrl(JOHN))).status).toBe(401);
  });

  it('refuses a citation that is not one, rather than inventing a passage for it', async () => {
    const refused = await call<{ passage: string | null }>(
      `${baseUrl}${API_PREFIX}${passagePath({ book: 'john', chapter: 3, verseStart: 16, verseEnd: 16 })}`.replace(
        'chapter=3',
        'chapter=99',
      ),
      { cookie: adminCookie },
    );
    expect(refused.status).toBe(400);
    expect(refused.code).toBe('invalid_input');
  });
});
