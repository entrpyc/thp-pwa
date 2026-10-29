import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  ANNOUNCEMENTS_PATH,
  API_PREFIX,
  AUTH_SESSION_PATH,
  NOTIFICATION_CATEGORIES,
  PUSH_PREFERENCES_PATH,
  PUSH_SUBSCRIPTIONS_PATH,
  ROLE,
  isApiErrorBody,
  recordingNotesPath,
  recordingPagePath,
  recordingPublishPath,
  type CreateNotePayload,
  type PushPreferencesPayload,
  type RegisterPushSubscriptionPayload,
  type UnregisterPushSubscriptionPayload,
} from '@thp/shared';
import { createDatabase, insertRecording, listPushSubscriptionsForUser, setRecordingPublication, type DatabaseHandle } from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';
import { pushOffset, readCapturedPush, waitForCapturedPush } from '../support/push';

/**
 * **Push over HTTP** ([3.17.1](docs/project/prd.md), [3.17.13](docs/project/prd.md),
 * [3.17.14](docs/project/prd.md)) — the switches, the devices, and the second delivery, driven
 * through the routes that raise events and read back from the capture the primary server writes
 * instead of reaching a push service.
 *
 * Five claims:
 *
 * 1. **Switches are on by default and per account.** A member reads four categories, an admin
 *    four; a member cannot set the admin one; a set switch reads back on a fresh request.
 * 2. **A device registers once.** The same endpoint registered twice is one row; registered by
 *    another account it moves; a web registration without keys is refused; `DELETE` forgets it
 *    for its owner only.
 * 3. **Delivery follows the switches.** A reply reaches the author's devices and nobody else's; a
 *    category switched off reaches no device while the centre still lists the row; a broadcast
 *    reaches every registered device.
 * 4. **A dead device is removed** when the transport says it is gone.
 * 5. **A row never written is never pushed** — the block rule costs push nothing extra.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const capturePath = inject('pushCapturePath');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;

interface Signed extends TestAccount {
  readonly cookie: string;
}

let admin: Signed;
let author: Signed;
let other: Signed;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: { method?: string; cookie: string; body?: unknown },
): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: { accept: 'application/json', 'content-type': 'application/json', cookie: init.cookie },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  return { status: response.status, code: isApiErrorBody(body) ? body.error.code : null, body: body as T };
}

async function signedIn(role: 'admin' | 'member', label: string): Promise<Signed> {
  const account = await createAccount(databaseUrl, ROLE[role], `${label}-${RUN}`);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`no cookie for ${account.email}`);
  return { ...account, cookie: result.cookie };
}

/** A web endpoint unique to this run. Only the capture ever sees it, so the host is invented. */
function endpoint(label: string): string {
  return `https://push.example.test/${RUN}/${label}`;
}

/**
 * A subscription's two keys, **minted per run** rather than pasted from a browser: the capture
 * transport never encrypts, so the server only ever checks their shape, and a real-looking key
 * literal in the tree is a thing every secret scanner flags and nobody can tell from a leak. The
 * same lengths a browser issues — a 65-byte uncompressed P-256 point and a 16-byte auth secret.
 */
const KEYS = { p256dh: randomBase64Url(65), auth: randomBase64Url(16) };

function randomBase64Url(bytes: number): string {
  return Buffer.from(randomBytes(bytes)).toString('base64url');
}

async function registerWeb(who: Signed, label: string): Promise<string> {
  const address = endpoint(label);
  const answer = await call<RegisterPushSubscriptionPayload>(PUSH_SUBSCRIPTIONS_PATH, {
    method: 'PUT',
    cookie: who.cookie,
    body: { platform: 'web', endpoint: address, keys: KEYS },
  });
  if (answer.status !== 200) throw new Error(`register refused ${answer.status} ${answer.code}`);
  return address;
}

async function preferences(who: Signed): Promise<PushPreferencesPayload> {
  const answer = await call<PushPreferencesPayload>(PUSH_PREFERENCES_PATH, { cookie: who.cookie });
  if (answer.status !== 200) throw new Error(`preferences refused ${answer.status}`);
  return answer.body;
}

async function setPreference(who: Signed, category: string, pushEnabled: boolean) {
  return call<PushPreferencesPayload>(PUSH_PREFERENCES_PATH, {
    method: 'PUT',
    cookie: who.cookie,
    body: { category, pushEnabled },
  });
}

async function recording(title: string, published: boolean): Promise<string> {
  const row = await insertRecording(
    { originalMediaKey: `originals/push-${title.replace(/\W+/g, '-')}-${RUN}.mp3`, title, recordedAt: '2026-08-16' },
    handle,
  );
  if (published) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function writeNote(recordingId: string, who: Signed, body: Record<string, unknown>): Promise<string> {
  const answer = await call<CreateNotePayload>(recordingNotesPath(recordingId), { method: 'POST', cookie: who.cookie, body });
  if (answer.status !== 200) throw new Error(`note refused ${answer.status} ${answer.code}`);
  return answer.body.note.id;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  [admin, author, other] = await Promise.all([
    signedIn('admin', 'push-admin'),
    signedIn('member', 'push-author'),
    signedIn('member', 'push-other'),
  ]);
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the switches', () => {
  it('read as on by default: four categories for a member, five for an admin', async () => {
    const mine = await preferences(author);
    expect(mine.categories.map((one) => one.category)).toEqual(['recordings', 'notes', 'announcements', 'sos']);
    expect(mine.categories.every((one) => one.pushEnabled)).toBe(true);
    // The suite's servers carry no VAPID pair, so a browser is told there is nothing to subscribe to.
    expect(mine.webPush).toBeNull();

    const theirs = await preferences(admin);
    expect(theirs.categories.map((one) => one.category)).toEqual([...NOTIFICATION_CATEGORIES]);
  });

  it('sets one category on the account and reads it back; refuses what is not a category or not yours', async () => {
    const set = await setPreference(author, 'recordings', false);
    expect(set.status).toBe(200);
    expect(set.body.categories.find((one) => one.category === 'recordings')?.pushEnabled).toBe(false);
    expect((await preferences(author)).categories.find((one) => one.category === 'recordings')?.pushEnabled).toBe(false);

    const back = await setPreference(author, 'recordings', true);
    expect(back.body.categories.find((one) => one.category === 'recordings')?.pushEnabled).toBe(true);

    expect((await setPreference(author, 'admin_alerts', false)).code).toBe('invalid_input');
    expect((await setPreference(author, 'videos', false)).code).toBe('invalid_input');
    expect((await call(PUSH_PREFERENCES_PATH, { method: 'PUT', cookie: author.cookie, body: { category: 'notes', pushEnabled: 'no' } })).code).toBe('invalid_input');
    // An admin may set the admin-only one.
    expect((await setPreference(admin, 'admin_alerts', false)).status).toBe(200);
    expect((await setPreference(admin, 'admin_alerts', true)).status).toBe(200);
  });

  it('needs a session', async () => {
    const response = await fetch(`${baseUrl}${API_PREFIX}${PUSH_PREFERENCES_PATH}`);
    expect(response.status).toBe(401);
  });
});

describe('a device', () => {
  it('registers once however many times it is sent, and moves to whoever signs in on it', async () => {
    const address = await registerWeb(author, 'shared-phone');
    await registerWeb(author, 'shared-phone');
    expect((await listPushSubscriptionsForUser(author.id, handle)).filter((one) => one.endpoint === address)).toHaveLength(1);

    await registerWeb(other, 'shared-phone');
    expect((await listPushSubscriptionsForUser(author.id, handle)).filter((one) => one.endpoint === address)).toHaveLength(0);
    expect((await listPushSubscriptionsForUser(other.id, handle)).filter((one) => one.endpoint === address)).toHaveLength(1);
  });

  it('refuses a web registration without keys, a store registration with them, and an unknown platform', async () => {
    const noKeys = await call(PUSH_SUBSCRIPTIONS_PATH, { method: 'PUT', cookie: author.cookie, body: { platform: 'web', endpoint: endpoint('no-keys') } });
    expect(noKeys.code).toBe('invalid_input');
    const withKeys = await call(PUSH_SUBSCRIPTIONS_PATH, { method: 'PUT', cookie: author.cookie, body: { platform: 'ios', endpoint: 'abc123', keys: KEYS } });
    expect(withKeys.code).toBe('invalid_input');
    const wrong = await call(PUSH_SUBSCRIPTIONS_PATH, { method: 'PUT', cookie: author.cookie, body: { platform: 'windows', endpoint: 'abc123' } });
    expect(wrong.code).toBe('invalid_input');
    const token = await call<RegisterPushSubscriptionPayload>(PUSH_SUBSCRIPTIONS_PATH, { method: 'PUT', cookie: author.cookie, body: { platform: 'android', endpoint: `token-${RUN}` } });
    expect(token.status).toBe(200);
    expect(token.body.subscription.platform).toBe('android');
  });

  it('is forgotten by its owner and by nobody else', async () => {
    const address = await registerWeb(author, 'to-forget');
    const theirs = await call<UnregisterPushSubscriptionPayload>(PUSH_SUBSCRIPTIONS_PATH, { method: 'DELETE', cookie: other.cookie, body: { endpoint: address } });
    expect(theirs.body.removed).toBe(false);
    const mine = await call<UnregisterPushSubscriptionPayload>(PUSH_SUBSCRIPTIONS_PATH, { method: 'DELETE', cookie: author.cookie, body: { endpoint: address } });
    expect(mine.body.removed).toBe(true);
    expect((await listPushSubscriptionsForUser(author.id, handle)).filter((one) => one.endpoint === address)).toHaveLength(0);
  });

  it('goes with the account: deleting the account leaves no device behind', async () => {
    const leaver = await signedIn('member', 'push-leaver');
    const address = await registerWeb(leaver, 'leaver-phone');
    expect((await listPushSubscriptionsForUser(leaver.id, handle)).map((one) => one.endpoint)).toContain(address);
    const gone = await call(`${AUTH_SESSION_PATH}`, { method: 'DELETE', cookie: leaver.cookie });
    expect(gone.status).toBe(200);
    // Sign-out over HTTP alone leaves the row (the client forgets the device before it signs
    // out); what proves the cascade is the account going.
    await handle.sql`delete from "user" where id = ${leaver.id}`;
    expect(await listPushSubscriptionsForUser(leaver.id, handle)).toEqual([]);
  });
});

describe('the second delivery', () => {
  it('reaches every device of the author of a replied-to note, with the row\'s own words, and nobody else', async () => {
    const phone = await registerWeb(author, 'author-phone');
    const laptop = await registerWeb(author, 'author-laptop');
    const otherPhone = await registerWeb(other, 'other-phone');
    const id = await recording(`Push replies ${RUN}`, true);
    const noteId = await writeNote(id, author, { text: `A thought ${RUN}`, visibility: 'public', timestampMs: 1_000 });

    const offset = pushOffset(capturePath);
    await writeNote(id, other, { text: `Reply for push ${RUN}`, parentId: noteId });

    const onPhone = await waitForCapturedPush(capturePath, offset, phone, 1);
    const onLaptop = await waitForCapturedPush(capturePath, offset, laptop, 1);
    expect(onPhone).toHaveLength(1);
    expect(onLaptop).toHaveLength(1);
    expect(onPhone[0]?.message).toMatchObject({
      kind: 'note_reply',
      title: `${other.displayName} replied to your note`,
      body: `Reply for push ${RUN}`,
      href: recordingPagePath(id),
    });
    expect(onPhone[0]?.platform).toBe('web');
    expect(readCapturedPush(capturePath, offset).filter((one) => one.endpoint === otherPhone)).toEqual([]);
  });

  it('is silenced by the category switch while the centre still lists the row', async () => {
    const phone = await registerWeb(author, 'author-muted-phone');
    expect((await setPreference(author, 'notes', false)).status).toBe(200);
    const id = await recording(`Push muted ${RUN}`, true);
    const noteId = await writeNote(id, author, { text: `Quiet thought ${RUN}`, visibility: 'public', timestampMs: 1_000 });

    const offset = pushOffset(capturePath);
    await writeNote(id, other, { text: `Muted reply ${RUN}`, parentId: noteId });
    // A publish is another category and still arrives, which is what "per category" means.
    const published = await recording(`Push still published ${RUN}`, false);
    await call(recordingPublishPath(published), { method: 'POST', cookie: admin.cookie });

    const arrived = await waitForCapturedPush(capturePath, offset, phone, 1);
    expect(arrived.map((one) => one.message.kind)).toEqual(['recording_published']);
    expect((await handle.sql`select count(*)::int as n from notification where user_id = ${author.id} and body = ${`Muted reply ${RUN}`}`)[0]?.['n']).toBe(1);

    await setPreference(author, 'notes', true);
  });

  it('reaches every registered device on a broadcast, and lands an announcement on nothing', async () => {
    const phone = await registerWeb(author, 'broadcast-author');
    const otherPhone = await registerWeb(other, 'broadcast-other');
    const offset = pushOffset(capturePath);
    const sent = await call(ANNOUNCEMENTS_PATH, { method: 'POST', cookie: admin.cookie, body: { kind: 'announcement', title: `Hello ${RUN}`, body: 'From the admins.' } });
    expect(sent.status).toBe(201);

    for (const address of [phone, otherPhone]) {
      const lines = await waitForCapturedPush(capturePath, offset, address, 1);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.message).toMatchObject({ kind: 'announcement', title: `Hello ${RUN}`, body: 'From the admins.', href: null });
    }
  });

  it('removes a device the transport reports gone, and keeps the others', async () => {
    const dead = await registerWeb(author, 'dead-phone#gone');
    const live = await registerWeb(author, 'live-phone');
    const offset = pushOffset(capturePath);
    await call(ANNOUNCEMENTS_PATH, { method: 'POST', cookie: admin.cookie, body: { kind: 'announcement', title: `Prune ${RUN}`, body: 'One device is gone.' } });
    await waitForCapturedPush(capturePath, offset, live, 1);

    const remaining = (await listPushSubscriptionsForUser(author.id, handle)).map((one) => one.endpoint);
    expect(remaining).toContain(live);
    expect(remaining).not.toContain(dead);
  });

  it('pushes nothing across a block, because no row is written', async () => {
    const blocker = await signedIn('member', 'push-blocker');
    const blocked = await signedIn('member', 'push-blocked');
    const phone = await registerWeb(blocker, 'blocker-phone');
    const id = await recording(`Push blocked ${RUN}`, true);
    const noteId = await writeNote(id, blocker, { text: `Before the block ${RUN}`, visibility: 'public', timestampMs: 1_000 });
    await handle.sql`insert into member_block (blocker_id, blocked_id) values (${blocker.id}, ${blocked.id})`;

    const offset = pushOffset(capturePath);
    const refused = await call(recordingNotesPath(id), { method: 'POST', cookie: blocked.cookie, body: { text: `Across the block ${RUN}`, parentId: noteId } });
    expect(refused.status).not.toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readCapturedPush(capturePath, offset).filter((one) => one.endpoint === phone)).toEqual([]);
  });
});
