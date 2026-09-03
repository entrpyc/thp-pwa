import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  AUTH_SESSION_PATH,
  AVATAR_PATH,
  AVATAR_UPLOADS_PATH,
  MAX_ARTWORK_BYTES,
  ROLE,
  recordingNotesPath,
  type NotesPayload,
  type SessionPayload,
  type UploadGrantPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import postgres from 'postgres';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';
import { webpBytes } from '../support/artwork';

/**
 * **The avatar over HTTP** (docs/project/prd.md 3.1.12) — the write path, the removal, and where
 * the picture is then read from.
 *
 * The series cover's suite, one resource over, and the claims that cost most to get wrong are the
 * same four: a refusal carries no URL; finalisation believes the store, not the request; a refused
 * finalisation leaves the avatar as it was; and no payload ever carries a key. What is new is the
 * fifth — **the picture reaches the one place the requirement puts it**, the author line of a
 * public note — and the sixth, that the route is `me`: there is no path by which anybody, admin
 * included, sets a picture on somebody else.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;
let sql: ReturnType<typeof postgres>;
let member: TestAccount;
let memberCookie: string;
let admin: TestAccount;
let adminCookie: string;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly body: T;
  readonly rawBody: string;
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
  const rawBody = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = undefined;
  }
  const error = (body as { error?: { code: string; message: string } } | undefined)?.error;
  return {
    status: response.status,
    code: error?.code ?? null,
    message: error?.message ?? null,
    body: body as T,
    rawBody,
  };
}

async function grantFor(
  cookie: string,
  size = 4_096,
  contentType = 'image/webp',
  filename = 'me.webp',
): Promise<Answer<UploadGrantPayload>> {
  return call<UploadGrantPayload>(AVATAR_UPLOADS_PATH, {
    method: 'POST',
    cookie,
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

async function finalise(cookie: string, key: string): Promise<Answer<SessionPayload>> {
  return call<SessionPayload>(AVATAR_PATH, { method: 'PUT', cookie, body: JSON.stringify({ key }) });
}

async function remove(cookie: string): Promise<Answer<SessionPayload>> {
  return call<SessionPayload>(AVATAR_PATH, { method: 'DELETE', cookie });
}

async function session(cookie: string): Promise<Answer<SessionPayload>> {
  return call<SessionPayload>(AUTH_SESSION_PATH, { cookie });
}

/** A grant, a real upload behind it, and the key. The happy first two thirds of the flow. */
async function uploaded(cookie: string, size = 4_096): Promise<UploadGrantPayload> {
  const grant = await grantFor(cookie, size);
  expect(grant.status).toBe(200);
  expect((await putBytes(grant.body, webpBytes(size))).status).toBe(200);
  return grant.body;
}

async function storedKeyOf(id: string): Promise<string | null> {
  const rows = await sql<{ avatar_key: string | null }[]>`
    select avatar_key from "user" where id = ${id}
  `;
  return rows[0]?.avatar_key ?? null;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  const asMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'avatar-member');
  member = asMember.account;
  memberCookie = asMember.cookie;
  const asAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'avatar-admin');
  admin = asAdmin.account;
  adminCookie = asAdmin.cookie;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the session carries the picture, never the key', () => {
  it('starts every account with no picture', async () => {
    const fresh = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'no-picture');
    const answer = await session(fresh.cookie);
    expect(answer.status).toBe(200);
    expect(answer.body.user.avatarUrl).toBeNull();
    expect(Object.keys(answer.body.user)).toContain('avatarUrl');
    expect(Object.keys(answer.body.user)).not.toContain('avatarKey');
  });
});

describe('the grant', () => {
  it('answers any signed-in member with a presigned PUT bound to a minted avatars key', async () => {
    const answer = await grantFor(memberCookie);

    expect(answer.status).toBe(200);
    const { url, key, contentType } = answer.body;
    expect(key).toMatch(/^avatars\/[0-9a-f-]{36}\.webp$/);
    expect(url).toContain(key);
    expect(url).toContain('X-Amz-Signature');
    expect(contentType).toBe('image/webp');
    // The name a person chose is nowhere in it.
    expect(key).not.toContain('me');
    expect((await putBytes(answer.body, webpBytes(4_096))).status).toBe(200);
  }, 60_000);

  it('refuses every content type outside JPEG, PNG and WebP, and issues no URL', async () => {
    for (const rejected of ['image/gif', 'image/svg+xml', 'audio/mpeg', 'text/plain']) {
      const answer = await grantFor(memberCookie, 4_096, rejected, 'me.gif');
      expect(answer.status, rejected).toBe(400);
      expect(answer.code, rejected).toBe('invalid_input');
      expect(answer.rawBody, rejected).not.toContain('X-Amz-Signature');
      expect((answer.body as unknown as { url?: unknown }).url).toBeUndefined();
    }
  }, 60_000);

  it('accepts exactly the shared 4 MB ceiling and refuses one byte more, issuing no URL', async () => {
    expect(MAX_ARTWORK_BYTES).toBe(4 * 1024 * 1024);

    const atCeiling = await grantFor(memberCookie, 4 * 1024 * 1024);
    expect(atCeiling.status).toBe(200);

    const overCeiling = await grantFor(memberCookie, 4 * 1024 * 1024 + 1);
    expect(overCeiling.status).toBe(400);
    expect(overCeiling.code).toBe('invalid_input');
    expect(overCeiling.message).toContain('4 MB');
    expect((overCeiling.body as unknown as { url?: unknown }).url).toBeUndefined();
  }, 60_000);

  it('refuses an anonymous caller', async () => {
    const answer = await grantFor('');
    expect(answer.status).toBe(401);
    expect((answer.body as unknown as { url?: unknown }).url).toBeUndefined();
  });
});

describe('finalising', () => {
  it('writes the pointer after reading the stored object back, and the session shows the picture', async () => {
    const person = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'gets-picture');
    const grant = await uploaded(person.cookie, 8_192);

    const answer = await finalise(person.cookie, grant.key);
    expect(answer.status).toBe(200);
    expect(answer.body.user.id).toBe(person.account.id);
    expect(answer.body.user.avatarUrl).toContain('X-Amz-Signature');
    expect(answer.body.user.avatarUrl).toContain(grant.key.replace('avatars/', ''));
    // The URL is a grant to the object, not the object's name.
    expect(answer.rawBody).not.toContain('"avatarKey"');

    expect(await storedKeyOf(person.account.id)).toBe(grant.key);
    expect((await session(person.cookie)).body.user.avatarUrl).toContain('X-Amz-Signature');
  }, 60_000);

  it('refuses a key nothing was uploaded to, and the avatar is as it was', async () => {
    const person = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'nothing-there');
    const grant = await grantFor(person.cookie);
    expect(grant.status).toBe(200);

    const answer = await finalise(person.cookie, grant.body.key);
    expect(answer.status).toBe(400);
    expect(answer.code).toBe('invalid_input');
    expect(await storedKeyOf(person.account.id)).toBeNull();
    expect((await session(person.cookie)).body.user.avatarUrl).toBeNull();
  }, 60_000);

  it('refuses a key whose stored object is over the ceiling — the declaration was a lie', async () => {
    const person = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'lied-about-size');
    const grant = await grantFor(person.cookie, 1_024);
    expect(grant.status).toBe(200);
    expect((await putBytes(grant.body, webpBytes(MAX_ARTWORK_BYTES + 1))).status).toBe(200);

    const answer = await finalise(person.cookie, grant.body.key);
    expect(answer.status).toBe(400);
    expect(answer.code).toBe('invalid_input');
    expect(answer.message).toContain('4 MB');
    expect(await storedKeyOf(person.account.id)).toBeNull();
  }, 60_000);

  it('replaces a picture by repointing, and refuses a bad replacement without losing the good one', async () => {
    const person = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'replaces');
    const first = await uploaded(person.cookie);
    expect((await finalise(person.cookie, first.key)).status).toBe(200);

    const second = await uploaded(person.cookie);
    expect((await finalise(person.cookie, second.key)).status).toBe(200);
    expect(await storedKeyOf(person.account.id)).toBe(second.key);

    const unfinished = await grantFor(person.cookie);
    expect((await finalise(person.cookie, unfinished.body.key)).status).toBe(400);
    expect(await storedKeyOf(person.account.id)).toBe(second.key);
  }, 60_000);

  it('refuses a malformed body without asking the store', async () => {
    for (const body of ['null', '{}', '{"key":""}', '{"key":42}', 'not json']) {
      const answer = await call<unknown>(AVATAR_PATH, { method: 'PUT', cookie: memberCookie, body });
      expect(answer.status, body).toBe(400);
      expect(answer.code, body).toBe('invalid_input');
    }
  });
});

describe('removing', () => {
  it('takes the picture away, and taking it away twice is not an error', async () => {
    const person = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'removes');
    const grant = await uploaded(person.cookie);
    expect((await finalise(person.cookie, grant.key)).status).toBe(200);

    const removed = await remove(person.cookie);
    expect(removed.status).toBe(200);
    expect(removed.body.user.avatarUrl).toBeNull();
    expect(await storedKeyOf(person.account.id)).toBeNull();

    const again = await remove(person.cookie);
    expect(again.status).toBe(200);
    expect(again.body.user.avatarUrl).toBeNull();
  }, 60_000);
});

describe('whose picture it is', () => {
  it('is only ever the caller’s — an admin setting one sets their own, not a member’s', async () => {
    const before = await storedKeyOf(member.id);
    const grant = await uploaded(adminCookie);
    expect((await finalise(adminCookie, grant.key)).status).toBe(200);

    expect(await storedKeyOf(admin.id)).toBe(grant.key);
    expect(await storedKeyOf(member.id)).toBe(before);

    // Undone, so the admin's picture does not leak into later assertions about this account.
    expect((await remove(adminCookie)).status).toBe(200);
  }, 60_000);

  it('has no per-id route: the account routes do not take an avatar', async () => {
    // The only avatar route is `me`. A body naming a key on the account PATCH is not a field that
    // route reads, and a key is not something anybody may hand the product for another person.
    const answer = await call<unknown>(`/users/${member.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ avatarKey: 'avatars/anything.webp' }),
    });
    expect(answer.status).toBe(400);
    expect(await storedKeyOf(member.id)).toBeNull();
  });
});

describe('where the picture is then read from', () => {
  it('is the author line of a public note, signed, and absent when the author has none', async () => {
    const author = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'pictured-author');
    const bare = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'bare-author');
    const grant = await uploaded(author.cookie);
    expect((await finalise(author.cookie, grant.key)).status).toBe(200);

    const recording = await insertRecording(
      {
        originalMediaKey: `originals/avatar-${RUN}.mp3`,
        title: `Pictured notes ${RUN}`,
        recordedAt: '2026-05-01',
      },
      handle,
    );
    await setRecordingPublication(recording.id, new Date(), handle);

    const write = async (cookie: string, text: string) =>
      call<unknown>(recordingNotesPath(recording.id), {
        method: 'POST',
        cookie,
        body: JSON.stringify({ text, visibility: 'public', timestampMs: 1_000 }),
      });
    expect((await write(author.cookie, 'With a picture')).status).toBe(200);
    expect((await write(bare.cookie, 'Without one')).status).toBe(200);

    const listed = await call<NotesPayload>(recordingNotesPath(recording.id), {
      cookie: memberCookie,
    });
    expect(listed.status).toBe(200);
    const pictured = listed.body.notes.find((note) => note.text === 'With a picture');
    const unpictured = listed.body.notes.find((note) => note.text === 'Without one');
    expect(pictured?.authorAvatarUrl).toContain('X-Amz-Signature');
    expect(unpictured?.authorAvatarUrl).toBeNull();
    // What travels is a grant to the object — a signed URL, which necessarily names the path it
    // is signed for — and never the key as a field of its own that a client could build from.
    expect(pictured?.authorAvatarUrl).toContain('X-Amz-Signature');
    expect(listed.rawBody).not.toContain('"authorAvatarKey"');
    expect(listed.rawBody).not.toContain('"avatarKey"');
  }, 90_000);
});
