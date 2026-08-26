import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MIN_STORED_POSITION_MS,
  RESUME_PATH,
  ROLE,
  recordingProgressPath,
  type PlaybackProgressPayload,
  type ResumePayload,
} from '@thp/shared';
import {
  createDatabase,
  findPlaybackProgress,
  insertRecording,
  setRecordingDescription,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';

/**
 * **Resume position, across devices** (Story 4 Ticket 04) — the marquee behaviour.
 *
 * "Another device" is modelled the way it actually is: **a second, independently signed-in session
 * for the same account**. That is what a phone and a laptop are to this product, and it is the
 * whole reason the row is keyed on the account rather than on anything the browser holds. A test
 * that reused one cookie would prove nothing about the property being claimed.
 *
 * The other claim here is the one that contradicts a word in the architecture: **last-write-wins,
 * plainly.** A member who scrubs back to re-hear something and closes the tab is returned to where
 * they were listening, not to where they had got to.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;
let listener: TestAccount;
/** Two sessions for the same account — the phone and the laptop. */
let phone: string;
let laptop: string;
/** A different account entirely, so "per user" is checkable. */
let strangerCookie: string;

let recordingId: string;
let secondId: string;
let unpublishedId: string;
let seeded = 0;

async function newRecording(title: string, recordedAt = '2026-08-16'): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    { originalMediaKey: `originals/progress-${RUN}-${seeded}.mp3`, title, recordedAt },
    handle,
  );
  return row.id;
}

async function put(
  cookie: string,
  id: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${recordingProgressPath(id)}`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function read(cookie: string, id: string): Promise<PlaybackProgressPayload> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${recordingProgressPath(id)}`, {
    headers: { accept: 'application/json', cookie },
  });
  return (await response.json()) as PlaybackProgressPayload;
}

async function resume(cookie: string): Promise<ResumePayload> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${RESUME_PATH}`, {
    headers: { accept: 'application/json', cookie },
  });
  return (await response.json()) as ResumePayload;
}

async function secondSession(account: TestAccount): Promise<string> {
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`could not sign ${account.email} in a second time`);
  return result.cookie;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });

  listener = await createAccount(databaseUrl, ROLE.member, 'progress-listener');
  phone = await secondSession(listener);
  laptop = await secondSession(listener);

  const stranger = await createAccount(databaseUrl, ROLE.member, 'progress-stranger');
  strangerCookie = await secondSession(stranger);

  recordingId = await newRecording(`Progress first ${RUN}`, '2026-03-03');
  secondId = await newRecording(`Progress second ${RUN}`, '2026-07-07');
  unpublishedId = await newRecording(`Progress unpublished ${RUN}`, '2026-08-08');

  await setRecordingDescription(recordingId, 'What the first teaching is about.', handle);
  await setRecordingPublication(recordingId, new Date(), handle);
  await setRecordingPublication(secondId, new Date(), handle);
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('a position is stored per user per recording and survives to another device', () => {
  it('is written on the phone and read back on the laptop', async () => {
    const written = await put(phone, recordingId, { positionMs: 12 * 60 * 1000 });
    expect(written.status).toBe(200);

    // A second, independently signed-in session for the same account — which is what "another
    // device" is. No cookie, no local storage and no request state is shared between the two.
    expect(laptop).not.toBe(phone);
    const onTheLaptop = await read(laptop, recordingId);
    expect(onTheLaptop.positionMs).toBe(12 * 60 * 1000);
    expect(onTheLaptop.updatedAt).toBeTruthy();
  });

  it('keeps one row per pairing however many times it is written', async () => {
    await put(phone, recordingId, { positionMs: 20 * 60 * 1000 });
    await put(laptop, recordingId, { positionMs: 21 * 60 * 1000 });

    const row = await findPlaybackProgress(listener.id, recordingId, handle);
    expect(row?.positionMs).toBe(21 * 60 * 1000);
  });

  it('is somebody else`s position on nobody else`s account', async () => {
    await put(phone, secondId, { positionMs: 9 * 60 * 1000 });
    const stranger = await read(strangerCookie, secondId);
    // The id in the path names the recording; the account comes from the session, and there is no
    // shape of request that could ask about another person's position.
    expect(stranger.positionMs).toBeNull();
    expect(stranger.updatedAt).toBeNull();
  });

  it('answers null for a teaching this member has never opened', async () => {
    const never = await read(laptop, unpublishedId);
    expect(never.positionMs).toBeNull();
  });
});

describe('the newest write sets the position, including one that moves it backwards', () => {
  it('stores 10:00 after 40:00', async () => {
    // Last-write-wins, plainly. This is the assertion that contradicts the word *furthest* in
    // core-listening scope tdd § Data model: taken as furthest, a
    // member who scrubbed back to re-hear something would be returned to 40:00, which is the
    // opposite of what 3.2.5 promises.
    await put(phone, recordingId, { positionMs: 40 * 60 * 1000 });
    expect((await read(phone, recordingId)).positionMs).toBe(40 * 60 * 1000);

    await put(phone, recordingId, { positionMs: 10 * 60 * 1000 });
    expect((await read(laptop, recordingId)).positionMs).toBe(10 * 60 * 1000);
  });
});

describe('a trivial position is refused rather than stored', () => {
  it('refuses anything below the floor', async () => {
    const refused = await put(phone, secondId, { positionMs: MIN_STORED_POSITION_MS - 1 });
    expect(refused.status).toBe(400);
    // The client applies the same floor before writing. The API applies it too, so the rule holds
    // for anything holding a session rather than only for this product's player.
    expect((await read(phone, secondId)).positionMs).toBe(9 * 60 * 1000);
  });

  it('refuses a position that is not whole milliseconds from the start', async () => {
    for (const positionMs of [-1, 1.5, '60000', null]) {
      const refused = await put(phone, secondId, { positionMs });
      expect(refused.status, `${String(positionMs)}`).toBe(400);
    }
    expect((await put(phone, secondId, {})).status).toBe(400);
  });

  it('refuses a position against a teaching nobody published', async () => {
    // Otherwise a session is a licence to write rows keyed on any uuid at all.
    expect((await put(phone, unpublishedId, { positionMs: 60_000 })).status).toBe(404);
    expect(
      (await put(phone, '00000000-0000-0000-0000-000000000000', { positionMs: 60_000 })).status,
    ).toBe(404);
  });

  it('refuses an anonymous caller on both the read and the write', async () => {
    const anonymousRead = await fetch(
      `${baseUrl}${API_PREFIX}${recordingProgressPath(recordingId)}`,
      { headers: { accept: 'application/json' } },
    );
    expect(anonymousRead.status).toBe(401);

    const anonymousWrite = await fetch(
      `${baseUrl}${API_PREFIX}${recordingProgressPath(recordingId)}`,
      {
        method: 'PUT',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ positionMs: 60_000 }),
      },
    );
    expect(anonymousWrite.status).toBe(401);
  });
});

describe('the landing is offered the teaching this member was last part-way through', () => {
  it('offers the most recently written position, with its title and description', async () => {
    await put(phone, secondId, { positionMs: 30_000 });
    await put(phone, recordingId, { positionMs: 90_000 });

    const offered = await resume(laptop);
    expect(offered.resume?.recordingId).toBe(recordingId);
    expect(offered.resume?.positionMs).toBe(90_000);
    expect(offered.resume?.description).toBe('What the first teaching is about.');
  });

  it('does not offer a teaching that has been taken back down', async () => {
    // 3.2.11 — unpublishing takes a teaching away from people who may be part-way through it. The
    // row stays where it is, so re-publishing brings the position back rather than losing it.
    await setRecordingPublication(recordingId, null, handle);
    try {
      const offered = await resume(laptop);
      expect(offered.resume?.recordingId).toBe(secondId);
    } finally {
      await setRecordingPublication(recordingId, new Date(), handle);
    }

    const restored = await resume(laptop);
    expect(restored.resume?.recordingId).toBe(recordingId);
    expect(restored.resume?.positionMs).toBe(90_000);
  });

  it('offers nothing to a member with no progress on any published teaching', async () => {
    const offered = await resume(strangerCookie);
    expect(offered.resume).toBeNull();
  });

  it('refuses an anonymous caller', async () => {
    const response = await fetch(`${baseUrl}${API_PREFIX}${RESUME_PATH}`, {
      headers: { accept: 'application/json' },
    });
    expect(response.status).toBe(401);
  });
});
