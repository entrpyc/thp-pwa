import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  REVIEW_FIELD,
  ROLE,
  memberRecordingPath,
  recordingMindMapPath,
  reviewPath,
  type MindMapNode,
  type RecordingMindMapPayload,
  type RecordingPayload,
  type ResolveReviewPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  replaceOpenDrafts,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
  type ReviewItemRow,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';

/**
 * **Approving a tree makes it the teaching's mind map, and a member reads it**
 * ([3.8.1](docs/project/prd.md)–[3.8.4](docs/project/prd.md)), over HTTP.
 *
 * The gate's fourth kind, and the properties that follow from it being a tree rather than text or
 * a list:
 *
 * 1. **Approving as-is publishes the machine's tree**; approving a curated one publishes that, and
 *    the item records that an admin changed it.
 * 2. **A tree the server would not store is refused, not trimmed** — too many themes, a blank
 *    label, a fourth level — and nothing is published.
 * 3. **A member reads the map only on a published teaching**, and the recording payload says
 *    whether there is one before they ask.
 * 4. **A discard writes nothing**, and a second approval replaces rather than grows.
 *
 * Rows are seeded through `@thp/db` rather than by running the worker: what is under test is the
 * API over the gate and the read behind it.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

let admin: TestAccount;
let adminCookie: string;
let member: TestAccount;
let memberCookie: string;
let handle: DatabaseHandle;
let sql: postgres.Sql;
let seeded = 0;

const FIELD = REVIEW_FIELD.mind_map.name;

const PROPOSED: MindMapNode = {
  id: 'n1',
  label: 'The teaching',
  anchorMs: null,
  children: [
    {
      id: 'n2',
      label: 'Grace',
      anchorMs: 4000,
      children: [
        { id: 'n3', label: 'Unearned', anchorMs: 4000, children: [] },
        { id: 'n4', label: 'Given, not taken', anchorMs: null, children: [] },
      ],
    },
    { id: 'n5', label: 'Law', anchorMs: null, children: [] },
  ],
};

const PROVENANCE = {
  model: 'fake',
  modelVersion: 'fake-1',
  promptVersion: 'draft-2',
  steeringPrompt: null,
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

const get = <T>(path: string, cookie = memberCookie) =>
  call<T>(`${baseUrl}${API_PREFIX}${path}`, { cookie });

async function newRecording(published: boolean): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/mind-map-${seeded}-${Date.now().toString(36)}.mp3`,
      title: `Mind map subject ${seeded} ${Date.now().toString(36)}`,
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
  if (published) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function draft(recordingId: string, tree: MindMapNode = PROPOSED): Promise<ReviewItemRow> {
  const [item] = await replaceOpenDrafts(
    recordingId,
    [{ kind: 'mind_map', fields: { [FIELD]: tree }, provenance: PROVENANCE }],
    handle,
  );
  return item as ReviewItemRow;
}

async function stored(recordingId: string) {
  return sql<{ root: MindMapNode; edited_by_admin: boolean }[]>`
    select root, edited_by_admin from mind_map where recording_id = ${recordingId}
  `;
}

/** The tree without its ids, which is how two trees are compared for what they say. */
function words(node: MindMapNode): unknown {
  return [node.label, node.anchorMs, node.children.map(words)];
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  ({ account: admin, cookie: adminCookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'mind-map-admin'));
  ({ account: member, cookie: memberCookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'mind-map-member'));
  void admin;
  void member;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

// =================================================================================================

describe('approving a mind map draft', () => {
  it('publishes the machine’s tree as it stands, and a member reads it', async () => {
    const recordingId = await newRecording(true);
    const item = await draft(recordingId);

    const before = await get<RecordingPayload>(memberRecordingPath(recordingId));
    expect(before.status).toBe(200);
    expect(before.body.recording.hasMindMap).toBe(false);

    const approved = await post<ResolveReviewPayload>(reviewPath(item.id), { action: 'approve' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('published');

    const rows = await stored(recordingId);
    expect(rows).toHaveLength(1);
    expect(words(rows[0]!.root)).toEqual(words(PROPOSED));
    expect(rows[0]!.edited_by_admin).toBe(false);

    const after = await get<RecordingPayload>(memberRecordingPath(recordingId));
    expect(after.body.recording.hasMindMap).toBe(true);

    const read = await get<RecordingMindMapPayload>(recordingMindMapPath(recordingId));
    expect(read.status).toBe(200);
    expect(read.body.mindMap?.editedByAdmin).toBe(false);
    expect(words(read.body.mindMap!.root)).toEqual(words(PROPOSED));
  });

  it('publishes a curated tree and records that an admin changed it', async () => {
    const recordingId = await newRecording(true);
    const item = await draft(recordingId);

    // Renamed one point, removed the other, moved `Law` to sit under `Grace`, added a theme with no
    // id — every edit the form makes, in one tree.
    const curated = {
      ...PROPOSED,
      children: [
        {
          id: 'n2',
          label: 'Grace',
          anchorMs: 4000,
          children: [
            { id: 'n3', label: 'Unearned, always', anchorMs: 4000, children: [] },
            { id: 'n5', label: 'Law', anchorMs: null, children: [] },
          ],
        },
        { label: 'Hope', anchorMs: null, children: [] },
      ],
    };

    const approved = await post(reviewPath(item.id), { action: 'approve', fields: { [FIELD]: curated } });
    expect(approved.status).toBe(200);

    const [row] = await stored(recordingId);
    expect(row?.edited_by_admin).toBe(true);
    expect(row?.root.children.map((one) => one.label)).toEqual(['Grace', 'Hope']);
    expect(row?.root.children[0]?.children.map((one) => one.label)).toEqual(['Unearned, always', 'Law']);
    // The added theme was given an id the server minted, distinct from every other.
    const ids = [row!.root.id, ...row!.root.children.map((one) => one.id)];
    expect(new Set(ids).size).toBe(ids.length);

    const [closed] = await sql<{ status: string; fields: { mindMap: MindMapNode }; provenance: { fields: Record<string, { editedByAdmin: boolean }> } }[]>`
      select status::text as status, fields, provenance from review_item where id = ${item.id}
    `;
    expect(closed?.status).toBe('published');
    expect(closed?.provenance.fields[FIELD]?.editedByAdmin).toBe(true);
    expect(closed?.fields.mindMap.children.map((one) => one.label)).toEqual(['Grace', 'Hope']);
  });

  it('refuses a tree the map cannot hold, and publishes nothing', async () => {
    const recordingId = await newRecording(true);
    const item = await draft(recordingId);

    // Seventeen chapters under the root — one past what a map holds at its first level.
    const tooWide = {
      ...PROPOSED,
      children: Array.from({ length: 17 }, (_, index) => ({
        id: `c${index}`,
        label: `Chapter ${index + 1}`,
        anchorMs: null,
        children: [],
      })),
    };
    const wide = await post(reviewPath(item.id), { action: 'approve', fields: { [FIELD]: tooWide } });
    expect(wide.status).toBe(400);
    expect(wide.code).toBe('invalid_input');

    const blank = {
      ...PROPOSED,
      children: [{ id: 'x', label: '   ', anchorMs: null, children: [] }],
    };
    expect((await post(reviewPath(item.id), { action: 'approve', fields: { [FIELD]: blank } })).status).toBe(400);

    // Five levels: chapter, theme, concept — and one more under the concept, which no map holds.
    const deep = {
      ...PROPOSED,
      children: [
        {
          id: 'c',
          label: 'Chapter',
          anchorMs: null,
          children: [
            {
              id: 't',
              label: 'Theme',
              anchorMs: null,
              children: [
                { id: 'p', label: 'Point', anchorMs: null, children: [{ id: 'q', label: 'Too deep', anchorMs: null, children: [] }] },
              ],
            },
          ],
        },
      ],
    };
    expect((await post(reviewPath(item.id), { action: 'approve', fields: { [FIELD]: deep } })).status).toBe(400);

    const empty = { ...PROPOSED, children: [] };
    expect((await post(reviewPath(item.id), { action: 'approve', fields: { [FIELD]: empty } })).status).toBe(400);

    const prose = await post(reviewPath(item.id), { action: 'approve', fields: { [FIELD]: 'Grace, then law.' } });
    expect(prose.status).toBe(400);

    expect(await stored(recordingId)).toHaveLength(0);
    const [still] = await sql<{ status: string }[]>`select status::text as status from review_item where id = ${item.id}`;
    expect(still?.status).toBe('draft');
  });

  it('discards without writing, and a later approval replaces rather than grows', async () => {
    const recordingId = await newRecording(true);
    const first = await draft(recordingId);
    expect((await post(reviewPath(first.id), { action: 'discard' })).status).toBe(200);
    expect(await stored(recordingId)).toHaveLength(0);

    const second = await draft(recordingId);
    expect((await post(reviewPath(second.id), { action: 'approve' })).status).toBe(200);
    const third = await draft(recordingId, { ...PROPOSED, children: [PROPOSED.children[1]!] });
    expect((await post(reviewPath(third.id), { action: 'approve' })).status).toBe(200);

    const rows = await stored(recordingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.root.children.map((one) => one.label)).toEqual(['Law']);
  });

  it('refuses a member', async () => {
    const recordingId = await newRecording(true);
    const item = await draft(recordingId);
    const refused = await post(reviewPath(item.id), { action: 'approve' }, memberCookie);
    expect(refused.status).toBe(403);
    expect(await stored(recordingId)).toHaveLength(0);
  });
});

describe('reading a mind map', () => {
  it('answers null for a published teaching with no approved map', async () => {
    const recordingId = await newRecording(true);
    await draft(recordingId);
    const read = await get<RecordingMindMapPayload>(recordingMindMapPath(recordingId));
    expect(read.status).toBe(200);
    expect(read.body.mindMap).toBeNull();
  });

  it('answers not_found for an unpublished teaching, approved map or not', async () => {
    const recordingId = await newRecording(false);
    const item = await draft(recordingId);
    expect((await post(reviewPath(item.id), { action: 'approve' })).status).toBe(200);
    expect(await stored(recordingId)).toHaveLength(1);

    const read = await get(recordingMindMapPath(recordingId));
    expect(read.status).toBe(404);
    expect(read.code).toBe('not_found');
  });

  it('refuses an anonymous request', async () => {
    const recordingId = await newRecording(true);
    const read = await call(`${baseUrl}${API_PREFIX}${recordingMindMapPath(recordingId)}`);
    expect(read.status).toBe(401);
  });
});
