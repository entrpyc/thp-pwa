import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  REVIEW_FIELD,
  ROLE,
  formatCitation,
  memberRecordingPath,
  recordingScripturePath,
  reviewPath,
  type RecordingPayload,
  type RecordingScripturePayload,
  type ScriptureCitation,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  replaceOpenDrafts,
  setRecordingPublication,
  type DatabaseHandle,
  type ReviewItemRow,
} from '@thp/db';
import { closeTestDatabase, signedInAccount } from '../support/accounts';

/**
 * **The member-facing read of a teaching's scripture** (Task 4.1), over HTTP.
 *
 * The whole of what this file is for is the gate rather than the list: a reference reaches a member
 * only when an admin approved the list it was in **and** the recording is published
 * ([3.2.13](docs/active-scope/prd.md), [3.4.5](docs/active-scope/prd.md)). Every case below is one
 * of the ways that can fail to be true.
 *
 * Rows are seeded through `@thp/db`, but the **approve and discard presses go through the real
 * review route**: what is under test is what an approval makes visible, and seeding the references
 * directly would test a table rather than the gate in front of it.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const FIELD = REVIEW_FIELD.scripture.name;

/**
 * Deliberately **not** in canon order, and deliberately **not sortable alphabetically either**.
 *
 * Genesis and Exodus are the point: canon puts Genesis first, the alphabet puts Exodus first. A
 * response that came back in the order it was stored, or ordered by the book column, would fail the
 * assertion below rather than pass it by luck.
 */
const PROPOSED: readonly ScriptureCitation[] = [
  { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4 },
  { book: 'exodus', chapter: 3, verseStart: 1, verseEnd: 2 },
  { book: 'genesis', chapter: 1, verseStart: 1, verseEnd: 2 },
];

const PROVENANCE = {
  model: 'fake',
  modelVersion: 'fake-1',
  promptVersion: 'draft-1',
  steeringPrompt: null,
  fields: { [FIELD]: { aiSuggested: true, editedByAdmin: false } },
};

let handle: DatabaseHandle;
let adminCookie: string;
let memberCookie: string;
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

/**
 * The member's read of one teaching's scripture. **`null` means anonymous** rather than
 * `undefined` — a default parameter would swallow `undefined` and quietly send the member's cookie,
 * which would make the anonymous case a signed-in one wearing its name.
 */
const readScripture = (recordingId: string, cookie: string | null = memberCookie) =>
  call<RecordingScripturePayload>(
    recordingScripturePath(recordingId),
    cookie === null ? {} : { cookie },
  );

async function newRecording(): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/scripture-read-${seeded}-${Date.now().toString(36)}.mp3`,
      title: `Scripture read ${seeded} ${Date.now().toString(36)}`,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  return row.id;
}

/** An open scripture draft on a fresh teaching. */
async function draft(
  citations: readonly ScriptureCitation[] = PROPOSED,
): Promise<{ recordingId: string; item: ReviewItemRow }> {
  const recordingId = await newRecording();
  const [item] = await replaceOpenDrafts(
    recordingId,
    [{ kind: 'scripture', fields: { [FIELD]: citations }, provenance: PROVENANCE }],
    handle,
  );
  return { recordingId, item: item as ReviewItemRow };
}

/** Resolve a draft the way an admin does — through the route, not through the table. */
const resolve = (item: ReviewItemRow, action: 'approve' | 'discard') =>
  call(reviewPath(item.id), {
    method: 'POST',
    cookie: adminCookie,
    body: JSON.stringify({ action }),
  });

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });

  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'scripture-read-admin'))
    .cookie;
  memberCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'scripture-read-member'))
    .cookie;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('a member reads a published teaching’s scripture', () => {
  // 4.1.1 — the approved references, in canon order, each with its passage.
  it('answers with the approved references in canon order, each carrying its passage', async () => {
    const { recordingId, item } = await draft();
    expect((await resolve(item, 'approve')).status).toBe(200);
    await setRecordingPublication(recordingId, new Date(), handle);

    const answer = await readScripture(recordingId);

    expect(answer.status).toBe(200);
    // Genesis, Exodus, Romans — the canon's order. Neither the order they were proposed in nor the
    // alphabet's, which would have put Exodus first.
    expect(answer.body.references.map((one) => formatCitation(one))).toEqual([
      'Genesis 1:1–2',
      'Exodus 3:1–2',
      'Romans 8:1–4',
    ]);
    expect(answer.body.references.map((one) => one.passage)).toEqual([
      'Stand-in verse text for Genesis 1:1. Stand-in verse text for Genesis 1:2.',
      'Stand-in verse text for Exodus 3:1. Stand-in verse text for Exodus 3:2.',
      'Stand-in verse text for Romans 8:1. Stand-in verse text for Romans 8:2. ' +
        'Stand-in verse text for Romans 8:3. Stand-in verse text for Romans 8:4.',
    ]);
  });

  // 4.1.2, first half — approved by nobody is nothing to read, on a teaching that is otherwise fine.
  it('answers with nothing for a published teaching whose draft nobody has approved', async () => {
    const { recordingId } = await draft();
    await setRecordingPublication(recordingId, new Date(), handle);

    const answer = await readScripture(recordingId);

    expect(answer.status).toBe(200);
    expect(answer.body.references).toEqual([]);
  });

  /**
   * 4.1.2, second half — **the reference rides the recording's publication**. This is the case a
   * separate publish gate would have been invented for: the admin has approved, and the teaching is
   * still not live, so there is nothing for a member here.
   */
  it('answers with nothing for an unpublished teaching even when its references were approved', async () => {
    const { recordingId, item } = await draft();
    expect((await resolve(item, 'approve')).status).toBe(200);

    const answer = await readScripture(recordingId);

    expect(answer.status).toBe(404);
    expect(answer.code).toBe('not_found');
    expect(JSON.stringify(answer.body)).not.toContain('romans');

    // And publishing it is the only thing that changes the answer — nothing else was missing.
    await setRecordingPublication(recordingId, new Date(), handle);
    expect((await readScripture(recordingId)).body.references).toHaveLength(3);
  });

  // 4.1.3 — a discarded draft leaves its citations in the closed row and nowhere a reader can go.
  it('never returns a discarded draft’s citations, to a member or to an admin', async () => {
    const { recordingId, item } = await draft();
    expect((await resolve(item, 'discard')).status).toBe(200);
    await setRecordingPublication(recordingId, new Date(), handle);

    for (const [who, cookie] of [
      ['member', memberCookie],
      ['admin', adminCookie],
    ] as const) {
      const answer = await readScripture(recordingId, cookie);
      expect(answer.status, who).toBe(200);
      expect(answer.body.references, who).toEqual([]);
      expect(JSON.stringify(answer.body), who).not.toContain('romans');
    }
  });

  /**
   * 4.1.4 — the read goes through `recording.browse`, the same decision the recording itself and
   * its transcript go through. The proof that it is *that* decision rather than a second one: an
   * unpublished teaching answers `not_found` here exactly as it does on the recording read, and an
   * anonymous caller is refused before either is asked.
   */
  it('refuses an unauthenticated caller and answers an unpublished id as the recording read does', async () => {
    const { recordingId, item } = await draft();
    expect((await resolve(item, 'approve')).status).toBe(200);

    const anonymous = await readScripture(recordingId, null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.code).toBe('unauthenticated');
    expect(JSON.stringify(anonymous.body)).not.toContain('romans');

    const recording = await call<RecordingPayload>(memberRecordingPath(recordingId), {
      cookie: memberCookie,
    });
    const scripture = await readScripture(recordingId);
    expect(scripture.status).toBe(recording.status);
    expect(scripture.code).toBe(recording.code);
  });

  /**
   * 4.2.2's server half — the recording payload says whether there is a tab to draw, so the page
   * can leave the tab out without downloading a passage first.
   */
  it('tells the recording payload whether the teaching has any references at all', async () => {
    const { recordingId, item } = await draft();
    await setRecordingPublication(recordingId, new Date(), handle);

    const before = await call<RecordingPayload>(memberRecordingPath(recordingId), {
      cookie: memberCookie,
    });
    expect(before.body.recording.hasScripture).toBe(false);

    expect((await resolve(item, 'approve')).status).toBe(200);

    const after = await call<RecordingPayload>(memberRecordingPath(recordingId), {
      cookie: memberCookie,
    });
    expect(after.body.recording.hasScripture).toBe(true);
  });
});
