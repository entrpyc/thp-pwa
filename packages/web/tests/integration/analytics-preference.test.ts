import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  ANALYTICS_PREFERENCE_PATH,
  API_PREFIX,
  AUTH_SESSION_PATH,
  ROLE,
  type AnalyticsPreferencePayload,
  type SessionPayload,
} from '@thp/shared';
import { createDatabase, findUserById, type DatabaseHandle } from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';

/**
 * **The analytics preference is the account's** (Apple guideline 5.1.1(ii)): written through one
 * route, read back in the session payload, refused from anyone who is not the account.
 *
 * The screen's half is `analytics-settings-screen.test.ts`; this file holds the route to what it
 * stores and what it refuses — including the one coercion it must never make, a string that
 * spells a boolean.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

let handle: DatabaseHandle;
let member: TestAccount;
let cookie: string;

async function write(body: unknown, withCookie = true): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${ANALYTICS_PREFERENCE_PATH}`, {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(withCookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json().catch(() => undefined) };
}

async function whoAmI(): Promise<SessionPayload> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${AUTH_SESSION_PATH}`, {
    headers: { accept: 'application/json', cookie },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as SessionPayload;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  member = await createAccount(databaseUrl, ROLE.member, 'analytics-preference');
  const signedIn = await signIn(baseUrl, member.email, member.password);
  if (signedIn.cookie === null) throw new Error('could not sign in');
  cookie = signedIn.cookie;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

describe('the preference on the account', () => {
  it('is off by default, meaning analytics on, and the session says so', async () => {
    expect((await findUserById(member.id, handle))?.analyticsOptedOut).toBe(false);
    expect((await whoAmI()).user.analyticsOptedOut).toBe(false);
  });

  it('is turned off and on through the route, and each answer is what the row now holds', async () => {
    const off = await write({ optedOut: true });
    expect(off.status).toBe(200);
    expect(off.payload as AnalyticsPreferencePayload).toEqual({ optedOut: true });
    expect((await findUserById(member.id, handle))?.analyticsOptedOut).toBe(true);
    // The session payload is how the client learns it before its first event, so it has to say
    // the same as the row — from a different route than the one that wrote it.
    expect((await whoAmI()).user.analyticsOptedOut).toBe(true);

    // Saying "off" again is still "off", not a refusal and not a flip.
    const again = await write({ optedOut: true });
    expect(again.status).toBe(200);
    expect(again.payload as AnalyticsPreferencePayload).toEqual({ optedOut: true });

    const on = await write({ optedOut: false });
    expect(on.status).toBe(200);
    expect(on.payload as AnalyticsPreferencePayload).toEqual({ optedOut: false });
    expect((await findUserById(member.id, handle))?.analyticsOptedOut).toBe(false);
    expect((await whoAmI()).user.analyticsOptedOut).toBe(false);
  });

  it('refuses anything but a boolean, and writes nothing for it', async () => {
    expect((await write({ optedOut: true })).status).toBe(200);

    // `"false"` is the one that matters: a string that reads as consent withdrawn and would be
    // stored as consent given, if anything along the way coerced it.
    for (const body of [{ optedOut: 'false' }, { optedOut: 0 }, { optedOut: null }, {}, null, 'true', []]) {
      expect((await write(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await findUserById(member.id, handle))?.analyticsOptedOut).toBe(true);
  });

  it('refuses an anonymous caller', async () => {
    expect((await write({ optedOut: true }, false)).status).toBe(401);
  });
});
