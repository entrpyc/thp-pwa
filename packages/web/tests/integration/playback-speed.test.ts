import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  PLAYBACK_SPEED_PATH,
  ROLE,
  recordingPagePath,
} from '@thp/shared';
import {
  createDatabase,
  findUserById,
  insertRecording,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The speed a member chose is the speed the next teaching plays at** (Story 4 Ticket 03,
 * [3.2.4](docs/project/prd.md)).
 *
 * The claim is about *persistence across recordings and across sessions*, so the test crosses both
 * boundaries for real: the speed is set on one teaching in one browser context, and read back from
 * the element on a **different** teaching in a **fresh context that signed in again**. Nothing is
 * shared between the two but the account.
 *
 * The rate is read off the media element rather than off the pill, because the pill saying `1.5x`
 * and the audio playing at 1.5x are two different claims and only the second one is the feature.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Short: nothing here plays, it only needs the element to reach metadata. */
const TEACHING_SECONDS = 20;

let browser: Browser;
let handle: DatabaseHandle;
let listener: TestAccount;
let firstId: string;
let secondId: string;

async function publishedRecording(title: string): Promise<string> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording(
    { originalMediaKey: key, title, recordedAt: '2026-08-16' },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function playbackRate(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('audio')?.playbackRate ?? -1);
}

async function elementReady(page: Page): Promise<boolean> {
  return page.evaluate(() => (document.querySelector('audio')?.readyState ?? 0) >= 1);
}

/** A brand-new browser context that signs in through the real screen and opens a teaching. */
async function freshSessionOn(id: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(listener.email);
  await page.getByLabel('Password').fill(listener.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

  await page.goto(`${baseUrl}${recordingPagePath(id)}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => elementReady(page), { timeout: 60_000 }).toBe(true);
  return page;
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  listener = await createAccount(databaseUrl, ROLE.member, 'speed-listener');

  firstId = await publishedRecording(`Speed first ${RUN}`);
  secondId = await publishedRecording(`Speed second ${RUN}`);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the speed control takes effect immediately and sticks', () => {
  it('changes the element`s rate on the press, and persists to a different teaching in a new session', async () => {
    const first = await freshSessionOn(firstId);
    try {
      expect(await playbackRate(first)).toBe(1);

      // One pill that cycles: 1x → 1.25x → 1.5x. Two presses, and the element is playing faster
      // before either write has been confirmed.
      const pill = first.getByRole('button', { name: /Playback speed/ });
      await pill.click();
      await expect.poll(() => playbackRate(first), { timeout: 30_000 }).toBe(1.25);
      await pill.click();
      await expect.poll(() => playbackRate(first), { timeout: 30_000 }).toBe(1.5);
      expect(await pill.textContent()).toBe('1.5x');

      // The write reached the account, which is what makes the next assertion about persistence
      // rather than about one browser remembering something.
      await expect
        .poll(async () => (await findUserById(listener.id, handle))?.preferredPlaybackSpeed, {
          timeout: 30_000,
        })
        .toBe(1.5);
    } finally {
      await first.context().close();
    }

    // A fresh context — no cookie, no storage, nothing carried over — signing in again and opening
    // a *different* teaching.
    const second = await freshSessionOn(secondId);
    try {
      expect(await playbackRate(second)).toBe(1.5);
      expect(
        await second.getByRole('button', { name: /Playback speed/ }).textContent(),
      ).toBe('1.5x');
    } finally {
      await second.context().close();
    }
  }, 300_000);
});

describe('the API is what refuses a speed no control could produce', () => {
  it('accepts each of the six and refuses anything else', async () => {
    const signedIn = await signIn(baseUrl, listener.email, listener.password);
    if (signedIn.cookie === null) throw new Error('could not sign in');
    const cookie = signedIn.cookie;

    const write = async (speed: unknown): Promise<number> => {
      const response = await fetch(`${baseUrl}${API_PREFIX}${PLAYBACK_SPEED_PATH}`, {
        method: 'PUT',
        headers: { accept: 'application/json', 'content-type': 'application/json', cookie },
        body: JSON.stringify({ speed }),
      });
      return response.status;
    };

    for (const speed of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
      expect(await write(speed), `${speed}`).toBe(200);
    }
    // The client holds no decision: a caller that is not the player is refused by the API, and the
    // check constraint on the column refuses it a second time if this route were ever bypassed.
    for (const speed of [0, 0.6, 1.75, 3, -1, '1.5', null]) {
      expect(await write(speed), `${String(speed)}`).toBe(400);
    }

    // The last accepted value is what stands; the refusals wrote nothing.
    expect((await findUserById(listener.id, handle))?.preferredPlaybackSpeed).toBe(2);
  }, 120_000);

  it('refuses an anonymous caller', async () => {
    const response = await fetch(`${baseUrl}${API_PREFIX}${PLAYBACK_SPEED_PATH}`, {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ speed: 1.5 }),
    });
    expect(response.status).toBe(401);
  });
});
