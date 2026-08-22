import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  ACCEPTED_AUDIO_FORMATS,
  API_PREFIX,
  CORRELATION_ID_HEADER,
  MAX_UPLOAD_BYTES,
  RECORDINGS_PATH,
  RECORDING_UPLOADS_PATH,
  ROLE,
  isApiErrorBody,
  type AdminRecordingListPayload,
  type RecordingSummary,
  type UploadGrantPayload,
} from '@thp/shared';
import { mediaStore, type MediaStore } from '@thp/media';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

/**
 * Uploading a recording, end to end against a real object store.
 *
 * The shape of this suite follows the shape of the flow: **grant → PUT → finalise**, with the API
 * present for the first and third and absent for the second. That absence is the design — the bytes
 * never pass through the application — and it is what makes every server-side check here a check
 * against the *store's* metadata rather than against anything a client said.
 *
 * So the interesting cases are the ones where the client and the store disagree. A grant obtained
 * honestly and then used to upload something far larger. A key with nothing behind it. A key that
 * is already a recording. In each, two things are asserted together: **no row is written**, and
 * **the object is left exactly where it is** — this product has no delete path against the bucket,
 * and a refusal that quietly tidied up would be the first one.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');
const settings = inject('mediaSettings');

const UPLOADS_URL = `${baseUrl}${API_PREFIX}${RECORDING_UPLOADS_PATH}`;
const RECORDINGS_URL = `${baseUrl}${API_PREFIX}${RECORDINGS_PATH}`;

let admin: TestAccount;
let adminCookie: string;
let member: TestAccount;
let memberCookie: string;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly correlationId: string | null;
  readonly body: T;
}

async function call<T>(
  url: string,
  init: RequestInit & { cookie?: string; correlationId?: string } = {},
): Promise<Answer<T>> {
  const { cookie, correlationId, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...(correlationId === undefined ? {} : { [CORRELATION_ID_HEADER]: correlationId }),
      ...rest.headers,
    },
  });
  const body: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    code: isApiErrorBody(body) ? body.error.code : null,
    message: isApiErrorBody(body) ? body.error.message : null,
    correlationId: response.headers.get(CORRELATION_ID_HEADER),
    body: body as T,
  };
}

/**
 * Whether an object is behind this key.
 *
 * Asked through the media store's own port, because the bucket answers `403` to every unsigned
 * request whether the object is there or not — which is exactly the property §6 Security wanted,
 * and which makes an unsigned probe useless for this particular question.
 */
let store: MediaStore;

async function objectExists(key: string): Promise<boolean> {
  return (await store.head(key)) !== null;
}

async function grantFor(
  size: number,
  contentType: string = ACCEPTED_AUDIO_FORMATS.mp3,
  filename = 'sunday-teaching.mp3',
): Promise<Answer<UploadGrantPayload>> {
  return call<UploadGrantPayload>(UPLOADS_URL, {
    method: 'POST',
    cookie: adminCookie,
    body: JSON.stringify({ filename, contentType, size }),
  });
}

/** The real `PUT`, exactly as a browser makes it. Nothing about it goes through the API. */
async function putBytes(grant: UploadGrantPayload, body: Uint8Array<ArrayBuffer>): Promise<Response> {
  return fetch(grant.url, {
    method: 'PUT',
    headers: { 'content-type': grant.contentType },
    body,
  });
}

function bytes(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(size)).fill(7);
}

/** A grant, a real upload behind it, and the key. The happy first two thirds of the flow. */
async function uploaded(size = 128): Promise<UploadGrantPayload> {
  const grant = await grantFor(size);
  expect(grant.status).toBe(200);
  expect((await putBytes(grant.body, bytes(size))).status).toBe(200);
  return grant.body;
}

async function finalise(
  key: string,
  title = 'Sunday teaching',
  recordedAt = '2026-03-08',
  correlationId?: string,
): Promise<Answer<RecordingSummary>> {
  return call<RecordingSummary>(RECORDINGS_URL, {
    method: 'POST',
    cookie: adminCookie,
    ...(correlationId === undefined ? {} : { correlationId }),
    body: JSON.stringify({ key, title, recordedAt }),
  });
}

/**
 * The console's read. From Story 3 Ticket 04 the route answers both roles, so the payload shape is
 * the caller's — an admin cookie is what makes the wider one the right type here.
 */
async function listRecordings(cookie = adminCookie): Promise<Answer<AdminRecordingListPayload>> {
  return call<AdminRecordingListPayload>(RECORDINGS_URL, { cookie });
}

async function countFor(key: string): Promise<number> {
  const listed = await listRecordings();
  expect(listed.status).toBe(200);
  return listed.body.recordings.filter((entry) => entry.originalMediaKey === key).length;
}

beforeAll(async () => {
  // The store reads its five values from the environment with no defaults, and the suite's bucket
  // is not the one `.env` names — so the worker is given the same configuration the servers got.
  Object.assign(process.env, settings);
  store = mediaStore();

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'recordings-admin');
  admin = signedInAdmin.account;
  adminCookie = signedInAdmin.cookie;

  const signedInMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'recordings-member');
  member = signedInMember.account;
  memberCookie = signedInMember.cookie;
}, 180_000);

afterAll(async () => {
  await closeTestDatabase();
});

// =================================================================================================

describe('who may ask for a grant', () => {
  it('refuses an anonymous caller', async () => {
    const answer = await call(UPLOADS_URL, {
      method: 'POST',
      body: JSON.stringify({ filename: 'a.mp3', contentType: 'audio/mpeg', size: 10 }),
    });
    expect(answer.status).toBe(401);
    expect(answer.code).toBe('unauthenticated');
  });

  it('refuses a member — the API refuses, not the screen', async () => {
    const answer = await call(UPLOADS_URL, {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ filename: 'a.mp3', contentType: 'audio/mpeg', size: 10 }),
    });
    expect(answer.status).toBe(403);
    expect(answer.code).toBe('forbidden');
  });

  it('logs the member refusal with actor, action and target under the request correlation id', async () => {
    const offset = logOffset(logPath);
    const correlationId = `recordings-refusal-${Date.now().toString(36)}`;
    await call(UPLOADS_URL, {
      method: 'POST',
      cookie: memberCookie,
      correlationId,
      body: JSON.stringify({ filename: 'a.mp3', contentType: 'audio/mpeg', size: 10 }),
    });

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some(
        (line) => line.message === 'authorisation.refused' && line['correlationId'] === correlationId,
      ),
    );
    const refusal = lines.find(
      (line) => line.message === 'authorisation.refused' && line['correlationId'] === correlationId,
    );

    expect(refusal).toBeDefined();
    expect(refusal?.['actorId']).toBe(member.id);
    expect(refusal?.['action']).toBe('recording.upload');
    expect(refusal?.['target']).toBe(`route:${API_PREFIX}${RECORDING_UPLOADS_PATH}`);
    expect(refusal?.['time']).toBeTruthy();
  }, 60_000);
});

describe('the grant itself', () => {
  it('answers with a URL, the key and the expiry, and the URL completes a real PUT', async () => {
    const answer = await grantFor(256);
    expect(answer.status).toBe(200);

    const { url, key, contentType, expiresAt } = answer.body;
    expect(url).toContain(key);
    expect(contentType).toBe(ACCEPTED_AUDIO_FORMATS.mp3);
    expect(key).toMatch(/^originals\/[0-9a-f-]{36}\.mp3$/);

    // One hour from when the server issued it. Read against this process's clock, which is why the
    // window has a few seconds of slack at each end rather than being asserted exactly — the
    // store's own enforcement is asserted precisely, against `X-Amz-Expires`, in media-store.test.ts.
    const expiry = new Date(expiresAt).getTime() - Date.now();
    expect(expiry).toBeGreaterThan(59 * 60 * 1000);
    expect(expiry).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);

    expect((await putBytes(answer.body, bytes(256))).status).toBe(200);
  }, 60_000);

  it('mints a key that owes nothing to the filename', async () => {
    const [first, second] = await Promise.all([
      grantFor(10, ACCEPTED_AUDIO_FORMATS.mp3, 'the-same-name.mp3'),
      grantFor(10, ACCEPTED_AUDIO_FORMATS.mp3, 'the-same-name.mp3'),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.key).not.toBe(second.body.key);
    // Not merely different — the name is nowhere in either.
    expect(first.body.key).not.toContain('the-same-name');
    expect(second.body.key).not.toContain('the-same-name');
  });

  it('accepts every format the product accepts', async () => {
    for (const [extension, contentType] of Object.entries(ACCEPTED_AUDIO_FORMATS)) {
      const answer = await grantFor(1_000, contentType, `teaching.${extension}`);
      expect(answer.status, contentType).toBe(200);
      expect(answer.body.key, contentType).toMatch(new RegExp(`\\.${extension}$`));
    }
  }, 60_000);

  it('refuses every content type outside them, and issues no URL', async () => {
    for (const rejected of ['video/mp4', 'audio/ogg', 'audio/webm', 'application/pdf', 'text/plain']) {
      const answer = await grantFor(1_000, rejected, 'teaching.mp3');
      expect(answer.status, rejected).toBe(400);
      expect(answer.code, rejected).toBe('invalid_input');
      // The refusal carries nothing a client could PUT with. An error with a URL in it is an error
      // a client can ignore.
      expect(JSON.stringify(answer.body), rejected).not.toContain('X-Amz-Signature');
      expect((answer.body as unknown as { url?: unknown }).url).toBeUndefined();
    }
  });

  it('accepts exactly 200 MB and refuses one byte more', async () => {
    const atCeiling = await grantFor(MAX_UPLOAD_BYTES);
    expect(atCeiling.status).toBe(200);
    expect(atCeiling.body.url).toContain('X-Amz-Signature');

    const overCeiling = await grantFor(MAX_UPLOAD_BYTES + 1);
    expect(overCeiling.status).toBe(400);
    expect(overCeiling.code).toBe('invalid_input');
    expect(overCeiling.message).toContain('200 MB');
    expect((overCeiling.body as unknown as { url?: unknown }).url).toBeUndefined();
  });

  it('refuses a request that is missing a field', async () => {
    for (const body of [
      {},
      { contentType: 'audio/mpeg', size: 10 },
      { filename: 'a.mp3', size: 10 },
      { filename: 'a.mp3', contentType: 'audio/mpeg' },
      { filename: 'a.mp3', contentType: 'audio/mpeg', size: 0 },
      { filename: 'a.mp3', contentType: 'audio/mpeg', size: -1 },
    ]) {
      const answer = await call(UPLOADS_URL, {
        method: 'POST',
        cookie: adminCookie,
        body: JSON.stringify(body),
      });
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.code, JSON.stringify(body)).toBe('invalid_input');
    }
  });
});

describe('finalising the upload', () => {
  it('creates the recording and answers with it', async () => {
    const grant = await uploaded(512);
    const created = await finalise(grant.key, 'The kindness of God', '2026-02-15');

    expect(created.status).toBe(201);
    expect(created.body.originalMediaKey).toBe(grant.key);
    expect(created.body.title).toBe('The kindness of God');
    expect(created.body.recordedAt).toBe('2026-02-15');
    // Nothing in this ticket writes either, and both ship nullable for Story 3.
    expect(created.body.publishedAt).toBeNull();
    expect(created.body.description).toBeNull();

    // And it is genuinely persisted, not merely echoed.
    const listed = await listRecordings();
    const persisted = listed.body.recordings.find((entry) => entry.id === created.body.id);
    expect(persisted).toEqual(created.body);
  }, 60_000);

  it('re-checks the size against the store, not against what the client said', async () => {
    // An honest grant for a small file, then an upload far larger than the ceiling. The client
    // said 100 bytes and the store holds 200 MB and a byte; only the second is authoritative.
    const grant = await grantFor(100);
    expect(grant.status).toBe(200);
    expect((await putBytes(grant.body, bytes(MAX_UPLOAD_BYTES + 1))).status).toBe(200);

    const refused = await finalise(grant.body.key);
    expect(refused.status).toBe(409);
    expect(refused.code).toBe('upload_invalid');
    expect(refused.message).toContain('200 MB');
    expect(await countFor(grant.body.key)).toBe(0);
    // Refused, and left exactly where it is. There is no delete anywhere in this product.
    expect(await objectExists(grant.body.key)).toBe(true);
  }, 180_000);

  it('refuses a key with no object behind it, and writes no row', async () => {
    const grant = await grantFor(100);
    expect(grant.status).toBe(200);
    // The grant was issued and never used — which is the ordinary shape of an abandoned upload.

    const refused = await finalise(grant.body.key);
    expect(refused.status).toBe(409);
    expect(refused.code).toBe('upload_invalid');
    expect(await countFor(grant.body.key)).toBe(0);
  }, 60_000);

  it('produces exactly one row when the same key is finalised twice', async () => {
    const grant = await uploaded();
    const first = await finalise(grant.key, 'Once');
    expect(first.status).toBe(201);

    const second = await finalise(grant.key, 'Twice');
    expect(second.status).toBe(409);
    expect(second.code).toBe('upload_invalid');

    expect(await countFor(grant.key)).toBe(1);
    const listed = await listRecordings();
    expect(listed.body.recordings.find((entry) => entry.originalMediaKey === grant.key)?.title).toBe(
      'Once',
    );
    expect(await objectExists(grant.key)).toBe(true);
  }, 90_000);

  it('refuses a missing or unreadable title or date, and writes no row', async () => {
    const grant = await uploaded();

    for (const body of [
      { key: grant.key, recordedAt: '2026-03-08' },
      { key: grant.key, title: '', recordedAt: '2026-03-08' },
      { key: grant.key, title: '   ', recordedAt: '2026-03-08' },
      { key: grant.key, title: 'Fine' },
      { key: grant.key, title: 'Fine', recordedAt: 'last Sunday' },
      { key: grant.key, title: 'Fine', recordedAt: '2026-02-30' },
      { key: grant.key, title: 'Fine', recordedAt: '08/03/2026' },
      { title: 'Fine', recordedAt: '2026-03-08' },
    ]) {
      const answer = await call(RECORDINGS_URL, {
        method: 'POST',
        cookie: adminCookie,
        body: JSON.stringify(body),
      });
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.code, JSON.stringify(body)).toBe('invalid_input');
    }

    expect(await countFor(grant.key)).toBe(0);
    // Still finalisable afterwards — a rejected form is not a lost upload.
    expect((await finalise(grant.key)).status).toBe(201);
  }, 90_000);

  it('refuses an anonymous caller and a member', async () => {
    const anonymous = await call(RECORDINGS_URL, {
      method: 'POST',
      body: JSON.stringify({ key: 'originals/x.mp3', title: 'x', recordedAt: '2026-01-01' }),
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.code).toBe('unauthenticated');

    const asMember = await call(RECORDINGS_URL, {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ key: 'originals/x.mp3', title: 'x', recordedAt: '2026-01-01' }),
    });
    expect(asMember.status).toBe(403);
    expect(asMember.code).toBe('forbidden');
  });

  it('carries one correlation id across the grant and the finalise, in the responses and the log', async () => {
    const offset = logOffset(logPath);
    const correlationId = `upload-chain-${Date.now().toString(36)}`;

    const grant = await call<UploadGrantPayload>(UPLOADS_URL, {
      method: 'POST',
      cookie: adminCookie,
      correlationId,
      body: JSON.stringify({
        filename: 'chain.mp3',
        contentType: ACCEPTED_AUDIO_FORMATS.mp3,
        size: 64,
      }),
    });
    expect(grant.status).toBe(200);
    expect(grant.correlationId).toBe(correlationId);

    expect((await putBytes(grant.body, bytes(64))).status).toBe(200);

    const created = await finalise(grant.body.key, 'Chained', '2026-04-05', correlationId);
    expect(created.status).toBe(201);
    // Adopted, not replaced — one id spans the whole causal chain.
    expect(created.correlationId).toBe(correlationId);

    const lines = await waitForLogLines(logPath, offset, (found) => {
      const mine = found.filter((line) => line['correlationId'] === correlationId);
      return (
        mine.some((line) => line.message === 'recording.upload.granted') &&
        mine.some((line) => line.message === 'recording.create')
      );
    });

    const mine = lines.filter((line) => line['correlationId'] === correlationId);
    const granted = mine.find((line) => line.message === 'recording.upload.granted');
    const wrote = mine.find((line) => line.message === 'recording.create');

    expect(granted?.['actorId']).toBe(admin.id);
    expect(granted?.['target']).toBe(`media:${grant.body.key}`);
    expect(wrote?.['actorId']).toBe(admin.id);
    expect(wrote?.['mediaKey']).toBe(grant.body.key);
  }, 90_000);
});

describe('the recordings list', () => {
  it('returns every recording, newest date recorded first', async () => {
    const label = `ordering-${Date.now().toString(36)}`;
    const days = ['2025-12-24', '2026-07-19', '2026-01-05'] as const;

    for (const day of days) {
      const grant = await uploaded(48);
      expect((await finalise(grant.key, `${label} ${day}`, day)).status).toBe(201);
    }

    const listed = await listRecordings();
    expect(listed.status).toBe(200);
    const mine = listed.body.recordings.filter((entry) => entry.title.startsWith(label));
    expect(mine.map((entry) => entry.recordedAt)).toEqual(['2026-07-19', '2026-01-05', '2025-12-24']);

    // And the ordering is the whole list's, not just this file's rows: every neighbouring pair is
    // in order, so a row somebody else's test wrote cannot be sitting out of place between them.
    const all = listed.body.recordings.map((entry) => entry.recordedAt);
    expect([...all].sort().reverse()).toEqual(all);
  }, 180_000);

  it('answers a member now, and still refuses an anonymous caller', async () => {
    // **Widened in Story 3 Ticket 04.** `GET /api/v1/recordings` is `recording.browse`, which both
    // roles hold — one route, so Story 4's library does not invent a second answer to "what may
    // this person see". What a member actually gets back is asserted in publishing.test.ts, over
    // the four combinations of the two gates; here the point is only that the door is now open to
    // them and still shut to nobody.
    const asMember = await listRecordings(memberCookie);
    expect(asMember.status).toBe(200);

    const anonymous = await call(RECORDINGS_URL);
    expect(anonymous.status).toBe(401);
    expect(anonymous.code).toBe('unauthenticated');
  });
});
