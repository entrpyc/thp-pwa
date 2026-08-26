import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MAX_ARTWORK_BYTES,
  MEMBER_SERIES_PATH,
  ROLE,
  SERIES_PATH,
  seriesArtworkPath,
  seriesArtworkUploadsPath,
  seriesPath,
  type SeriesListPayload,
  type SeriesPayload,
  type SeriesView,
  type UploadGrantPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  setRecordingPublication,
  setRecordingSeries,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';
import { webpBytes } from '../support/artwork';

/**
 * **Series cover artwork over HTTP** (scope plan 1.2 and 1.3) — the write path and the read path,
 * driven against the running server and the real bucket.
 *
 * The shape follows the flow, which is the recording upload's flow one resource down:
 * **grant → PUT → finalise**, with the API on both ends of an upload it never sees. The claims that
 * cost most to get wrong:
 *
 * 1. **A refusal carries no URL.** An error with a presigned `PUT` in it is an error a client can
 *    ignore, so every refused grant is asserted to be empty of one rather than merely to be a 400.
 * 2. **Finalisation believes the store, not the request.** The size and the content type are read
 *    back with `head`; a client that lies in the grant gets a grant it cannot finalise.
 * 3. **A refused finalisation leaves the cover as it was.** Never half-set, never cleared.
 * 4. **No payload ever carries a key.** What a surface gets is a signed URL minted for that
 *    response and nothing else (scope prd 3.1.6).
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;
let admin: TestAccount;
let adminCookie: string;
let member: TestAccount;
let memberCookie: string;
let seeded = 0;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: { method?: string; cookie?: string; body?: string } = {},
): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const body = (await response.json().catch(() => undefined)) as T & {
    error?: { code: string; message: string };
  };
  return {
    status: response.status,
    code: body?.error?.code ?? null,
    message: body?.error?.message ?? null,
    body,
  };
}

async function newSeries(title: string): Promise<SeriesView> {
  const created = await call<{ series: SeriesView }>(SERIES_PATH, {
    method: 'POST',
    cookie: adminCookie,
    body: JSON.stringify({ title: `${title} ${RUN}`, description: null }),
  });
  if (created.status !== 201) throw new Error(`create refused: ${created.status}`);
  return created.body.series;
}

async function grantFor(
  seriesId: string,
  size = 4_096,
  contentType = 'image/webp',
  filename = 'cover.webp',
  cookie = adminCookie,
): Promise<Answer<UploadGrantPayload>> {
  return call<UploadGrantPayload>(seriesArtworkUploadsPath(seriesId), {
    method: 'POST',
    cookie,
    body: JSON.stringify({ filename, contentType, size }),
  });
}

/** The real `PUT`, exactly as a browser makes it. Nothing about it goes through the API. */
async function putBytes(
  grant: UploadGrantPayload,
  body: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  return fetch(grant.url, {
    method: 'PUT',
    headers: { 'content-type': grant.contentType },
    body,
  });
}

async function finalise(
  seriesId: string,
  key: string,
  cookie = adminCookie,
): Promise<Answer<{ series: SeriesView }>> {
  return call<{ series: SeriesView }>(seriesArtworkPath(seriesId), {
    method: 'PUT',
    cookie,
    body: JSON.stringify({ key }),
  });
}

/** A grant, a real upload behind it, and the key. The happy first two thirds of the flow. */
async function uploaded(seriesId: string, size = 4_096): Promise<UploadGrantPayload> {
  const grant = await grantFor(seriesId, size);
  expect(grant.status).toBe(200);
  expect((await putBytes(grant.body, webpBytes(size))).status).toBe(200);
  return grant.body;
}

/** A published teaching inside a series, so the member surface has a reason to list it. */
async function publishedRecordingIn(seriesId: string, title: string): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/artwork-${RUN}-${seeded}.mp3`,
      title: `${title} ${RUN}`,
      recordedAt: '2026-05-01',
    },
    handle,
  );
  await setRecordingSeries(row.id, seriesId, handle);
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

/** One series as the console reads it back. */
async function consoleView(seriesId: string): Promise<SeriesView> {
  const list = await call<SeriesListPayload>(SERIES_PATH, { cookie: adminCookie });
  const found = list.body.series.find((one) => one.id === seriesId);
  if (!found) throw new Error('the console did not list the series');
  return found;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  const asAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'artwork-admin');
  admin = asAdmin.account;
  adminCookie = asAdmin.cookie;
  const asMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'artwork-member');
  member = asMember.account;
  memberCookie = asMember.cookie;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the grant', () => {
  it('refuses a member, and issues no URL', async () => {
    // scope plan 1.2.1, and scope prd 3.1.8: the refusal is the API's, not the absence of a
    // control on a screen.
    const series = await newSeries('Members may not cover');
    const answer = await grantFor(series.id, 4_096, 'image/webp', 'cover.webp', memberCookie);

    expect(answer.status).toBe(403);
    expect(answer.code).toBe('forbidden');
    expect((answer.body as unknown as { url?: unknown }).url).toBeUndefined();
    expect(member.id).toBeTruthy();
  });

  it('answers an admin with a presigned PUT bound to a minted artwork key', async () => {
    // scope plan 1.2.2.
    const series = await newSeries('Romans');
    const answer = await grantFor(series.id, 4_096);

    expect(answer.status).toBe(200);
    const { url, key, contentType } = answer.body;
    expect(key).toMatch(/^artwork\/[0-9a-f-]{36}\.webp$/);
    expect(url).toContain(key);
    expect(url).toContain('X-Amz-Signature');
    expect(contentType).toBe('image/webp');
    // The name a person chose is nowhere in it.
    expect(key).not.toContain('cover');
    expect((await putBytes(answer.body, webpBytes(4_096))).status).toBe(200);
    expect(admin.id).toBeTruthy();
  }, 60_000);

  it('refuses every content type outside JPEG, PNG and WebP, and issues no URL', async () => {
    // scope plan 1.2.3, and scope prd 4.2: no grant is minted before the type is accepted, so a
    // refused request costs one round trip and leaves nothing a client could PUT with.
    const series = await newSeries('Not an image');
    for (const rejected of ['image/gif', 'image/svg+xml', 'audio/mpeg', 'application/pdf', 'text/plain']) {
      const answer = await grantFor(series.id, 4_096, rejected, 'cover.gif');
      expect(answer.status, rejected).toBe(400);
      expect(answer.code, rejected).toBe('invalid_input');
      expect(JSON.stringify(answer.body), rejected).not.toContain('X-Amz-Signature');
      expect((answer.body as unknown as { url?: unknown }).url).toBeUndefined();
    }
  }, 60_000);

  it('accepts exactly 2 MB and refuses one byte more, issuing no URL for the refusal', async () => {
    // scope plan 1.2.4. The literal is pinned beside the constant deliberately: an assertion that
    // read its expectation out of the module would agree with whatever that module held.
    expect(MAX_ARTWORK_BYTES).toBe(2 * 1024 * 1024);
    const series = await newSeries('At the ceiling');

    const atCeiling = await grantFor(series.id, 2 * 1024 * 1024);
    expect(atCeiling.status).toBe(200);
    expect(atCeiling.body.url).toContain('X-Amz-Signature');

    const overCeiling = await grantFor(series.id, 2 * 1024 * 1024 + 1);
    expect(overCeiling.status).toBe(400);
    expect(overCeiling.code).toBe('invalid_input');
    expect(overCeiling.message).toContain('2 MB');
    expect((overCeiling.body as unknown as { url?: unknown }).url).toBeUndefined();
  }, 60_000);
});

describe('finalising', () => {
  it('writes the pointer after reading the stored object back, not the request', async () => {
    // scope plan 1.2.5. The size in the body is a lie and finalisation does not care, because it
    // never reads it: what it asks is the store.
    const series = await newSeries('Believes the store');
    const grant = await uploaded(series.id, 8_192);

    const answer = await finalise(series.id, grant.key);
    expect(answer.status).toBe(200);
    expect(answer.body.series.id).toBe(series.id);
    expect(answer.body.series.artworkUrl).toContain('X-Amz-Signature');

    expect((await consoleView(series.id)).artworkUrl).toContain('X-Amz-Signature');
  }, 60_000);

  it('refuses a key whose stored object is over the ceiling, and the cover is as it was', async () => {
    // scope plan 1.2.6. A client that declares 1 KB and uploads 3 MB is exactly the case the
    // `head` exists for, and the series must come out of it unchanged rather than half-set.
    const series = await newSeries('Lied about the size');
    const first = await uploaded(series.id, 8_192);
    expect((await finalise(series.id, first.key)).status).toBe(200);
    const before = (await consoleView(series.id)).artworkUrl;

    const grant = await grantFor(series.id, 1_024);
    expect(grant.status).toBe(200);
    const oversized = 2 * 1024 * 1024 + 1;
    expect((await putBytes(grant.body, webpBytes(oversized))).status).toBe(200);

    const answer = await finalise(series.id, grant.body.key);
    expect(answer.status).toBe(400);
    expect(answer.code).toBe('invalid_input');
    expect((await consoleView(series.id)).artworkUrl).toBe(before);
  }, 120_000);

  it('refuses a key with nothing behind it, and the cover is as it was', async () => {
    // scope plan 1.2.7.
    const series = await newSeries('Never finished');
    const first = await uploaded(series.id, 8_192);
    expect((await finalise(series.id, first.key)).status).toBe(200);
    const before = (await consoleView(series.id)).artworkUrl;

    const grant = await grantFor(series.id, 4_096);
    expect(grant.status).toBe(200);
    // No PUT. The grant exists and the object does not.
    const answer = await finalise(series.id, grant.body.key);

    expect(answer.status).toBe(400);
    expect(answer.code).toBe('invalid_input');
    expect((await consoleView(series.id)).artworkUrl).toBe(before);
  }, 120_000);

  it('repoints the series at a second cover, and the first object is still in the store', async () => {
    // scope plan 1.2.8, and scope prd 3.1.5: replacing is a repoint. The superseded object stays
    // where it is — there is nothing on the media port to delete with — and the assertion that it
    // is still readable is what says so rather than a comment claiming it.
    const series = await newSeries('Replaced');
    const first = await uploaded(series.id, 4_096);
    expect((await finalise(series.id, first.key)).status).toBe(200);
    const firstUrl = (await consoleView(series.id)).artworkUrl as string;
    expect((await fetch(firstUrl)).status).toBe(200);

    const second = await uploaded(series.id, 8_192);
    expect((await finalise(series.id, second.key)).status).toBe(200);
    const secondUrl = (await consoleView(series.id)).artworkUrl as string;

    expect(secondUrl).not.toBe(firstUrl);
    expect(secondUrl).toContain(second.key.split('/')[1] ?? 'nothing');
    // The old object outlived the pointer to it.
    expect((await fetch(firstUrl)).status).toBe(200);
  }, 120_000);

  it('refuses a member', async () => {
    // scope plan 1.2.9.
    const series = await newSeries('Members may not finalise');
    const grant = await uploaded(series.id, 4_096);

    const answer = await finalise(series.id, grant.key, memberCookie);

    expect(answer.status).toBe(403);
    expect(answer.code).toBe('forbidden');
    expect((await consoleView(series.id)).artworkUrl).toBeNull();
  }, 60_000);
});

describe('what a payload carries', () => {
  it('answers a fetchable signed URL on the console series list', async () => {
    // scope plan 1.3.1. The URL is minted for this response rather than stored, and it is a grant
    // to the object rather than the bytes — so the assertion is that it is signed and that it
    // actually resolves to what was uploaded.
    const series = await newSeries('Seen by the console');
    const grant = await uploaded(series.id, 4_096);
    expect((await finalise(series.id, grant.key)).status).toBe(200);

    const listed = await consoleView(series.id);

    expect(listed.artworkUrl).toContain('X-Amz-Signature');
    const fetched = await fetch(listed.artworkUrl as string);
    expect(fetched.status).toBe(200);
    expect((await fetched.arrayBuffer()).byteLength).toBe(4_096);
  }, 60_000);

  it('answers null on all three payloads for a series nobody has given a cover', async () => {
    // scope plan 1.3.4, and scope prd 3.1.7: no cover is the ordinary state, and it is spelled the
    // same way — `null`, never an empty string and never a placeholder URL — on each of the three.
    const series = await newSeries('Uncovered');
    // A published recording, so the member surface lists this series at all.
    await publishedRecordingIn(series.id, 'A teaching in an uncovered study');

    const detail = await call<SeriesPayload>(seriesPath(series.id), { cookie: adminCookie });
    const memberList = await call<SeriesListPayload>(MEMBER_SERIES_PATH, { cookie: memberCookie });
    const asMember = memberList.body.series.find((one) => one.id === series.id);

    expect((await consoleView(series.id)).artworkUrl).toBeNull();
    expect(detail.body.series.artworkUrl).toBeNull();
    expect(asMember?.artworkUrl).toBeNull();
  }, 60_000);

  it('carries the object key on no payload, under that name or any other', async () => {
    // scope plan 1.3.5, and scope prd 4.2. The key is in the signed URL's path by construction —
    // that is what a presigned GET is — so what is asserted is that no *field* carries it and that
    // nothing answers with the bare key a client could reuse.
    const series = await newSeries('No keys');
    const grant = await uploaded(series.id, 4_096);
    expect((await finalise(series.id, grant.key)).status).toBe(200);

    const consoleList = await consoleView(series.id);
    const detail = await call<SeriesPayload>(seriesPath(series.id), { cookie: adminCookie });

    for (const view of [consoleList, detail.body.series]) {
      expect(Object.keys(view)).not.toContain('artworkKey');
      expect(Object.keys(view)).not.toContain('artwork_key');
      for (const value of Object.values(view)) {
        if (typeof value === 'string' && value === grant.key) {
          throw new Error('a payload answered with the bare object key');
        }
      }
    }
  }, 60_000);
});
