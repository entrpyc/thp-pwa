import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import {
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  ROLE,
  formatTimecode,
  recordingPagePath,
  recordingProgressPath,
} from '@thp/shared';
import {
  createDatabase,
  findPlaybackProgress,
  insertRecording,
  setRecordingDescription,
  setRecordingPublication,
  upsertPlaybackProgress,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **Picking a teaching back up, in a real browser** (Story 4 Ticket 04).
 *
 * Four claims:
 *
 * 1. Opening a teaching with a stored position **seeks to it and does not play**. Both halves
 *    matter — a member who opens a teaching on a phone in company has not asked for sound.
 * 2. The seek waits for metadata. Seeking before that is silently clamped to zero, and a test that
 *    did not use real audio could not tell the difference between "restored" and "clamped".
 * 3. The position is pushed on a **bounded cadence** and on the events that matter — which is
 *    counted here, against the real endpoint, over real playback.
 * 4. The landing offers the most recently updated teaching that is **still published**.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEACHING_SECONDS = 120;

const RESUMABLE_TITLE = `Resume teaching ${RUN}`;
const OTHER_TITLE = `Resume other ${RUN}`;

let browser: Browser;
let handle: DatabaseHandle;
let listener: TestAccount;
let resumableId: string;
let otherId: string;
/** Never opened by any test but the floor one, so its request count is about the floor alone. */
let freshId: string;

async function publishedRecording(title: string, description: string): Promise<string> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording(
    { originalMediaKey: key, title, recordedAt: '2026-08-16' },
    handle,
  );
  await setRecordingDescription(row.id, description, handle);
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function signedInPage(): Promise<{ page: Page; requests: Request[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(listener.email);
  await page.getByLabel('Password').fill(listener.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return { page, requests };
}

async function audioState(page: Page): Promise<{ currentTime: number; paused: boolean; ready: boolean }> {
  return page.evaluate(() => {
    const element = document.querySelector('audio');
    return {
      currentTime: element?.currentTime ?? -1,
      paused: element?.paused ?? true,
      ready: (element?.readyState ?? 0) >= 1,
    };
  });
}

/** Writes to the progress endpoint for one recording, counted from the browser's own requests. */
function writesFor(requests: readonly Request[], id: string): Request[] {
  const path = `${baseUrl}${API_PREFIX}${recordingProgressPath(id)}`;
  return requests.filter((request) => request.method() === 'PUT' && request.url() === path);
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  listener = await createAccount(databaseUrl, ROLE.member, 'resume-listener');

  resumableId = await publishedRecording(RESUMABLE_TITLE, 'The teaching to pick back up.');
  otherId = await publishedRecording(OTHER_TITLE, 'The other one.');
  freshId = await publishedRecording(`Resume untouched ${RUN}`, 'Never opened.');
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('opening a teaching restores the position and does not start playing', () => {
  it('seeks to the stored second, once the element has metadata', async () => {
    await upsertPlaybackProgress(
      { userId: listener.id, recordingId: resumableId, positionMs: 83_000 },
      handle,
    );

    const { page } = await signedInPage();
    try {
      await page.goto(`${baseUrl}${recordingPagePath(resumableId)}`, {
        waitUntil: 'domcontentloaded',
      });

      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 60_000 })
        .toBeGreaterThan(82);
      const state = await audioState(page);
      expect(state.currentTime).toBeLessThan(85);
      // The seek waited for metadata. Doing it earlier is silently clamped to zero, which real
      // audio is what makes visible.
      expect(state.ready).toBe(true);
      // No autoplay.
      expect(state.paused).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('starts at the beginning for a teaching this member has never opened', async () => {
    const { page } = await signedInPage();
    try {
      await page.goto(`${baseUrl}${recordingPagePath(otherId)}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(async () => (await audioState(page)).ready, { timeout: 60_000 }).toBe(true);
      const state = await audioState(page);
      expect(state.currentTime).toBe(0);
      expect(state.paused).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

describe('the position is pushed on a bounded cadence and on the events that matter', () => {
  it('writes at most once every ten seconds while playing, and once on pause', async () => {
    const { page, requests } = await signedInPage();
    try {
      await page.goto(`${baseUrl}${recordingPagePath(otherId)}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(async () => (await audioState(page)).ready, { timeout: 60_000 }).toBe(true);

      // Start past the floor, so the very first tick is writable and the count below is about the
      // cadence rather than about the floor.
      await page.getByRole('slider', { name: 'Position' }).fill('20000');
      await page.getByRole('button', { name: 'Play', exact: true }).first().click();
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(24);

      // Roughly five seconds of playback. One tick write at most — the rate limit is ten seconds,
      // and `timeupdate` fires about four times a second.
      const whilePlaying = writesFor(requests, otherId).length;
      expect(whilePlaying).toBeGreaterThan(0);
      expect(whilePlaying).toBeLessThanOrEqual(2);

      await page.getByRole('button', { name: 'Pause', exact: true }).first().click();
      // Pausing is a decision, and it is never dropped for having happened too soon after a tick.
      await expect
        .poll(() => writesFor(requests, otherId).length, { timeout: 30_000 })
        .toBeGreaterThan(whilePlaying);

      const stored = await findPlaybackProgress(listener.id, otherId, handle);
      expect(stored?.positionMs).toBeGreaterThan(24_000);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('writes when the page is hidden', async () => {
    const { page, requests } = await signedInPage();
    try {
      await page.goto(`${baseUrl}${recordingPagePath(resumableId)}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 60_000 })
        .toBeGreaterThan(82);

      const before = writesFor(requests, resumableId).length;
      // The tab going away is the last moment anything is guaranteed to run, and on a phone it is
      // usually the end of the sitting.
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await expect
        .poll(() => writesFor(requests, resumableId).length, { timeout: 30_000 })
        .toBe(before + 1);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('does not write a position too near the start', async () => {
    // A teaching with no stored position, so the count below is about the floor alone. Restoring a
    // stored position is itself a seek, and a seek past the floor is a write — which would make a
    // previously-opened teaching the wrong subject for this assertion.
    const { page, requests } = await signedInPage();
    try {
      await page.goto(`${baseUrl}${recordingPagePath(freshId)}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(async () => (await audioState(page)).ready, { timeout: 60_000 }).toBe(true);

      await page.getByRole('slider', { name: 'Position' }).fill('1000');
      await page.getByRole('button', { name: 'Play', exact: true }).first().click();
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(2);
      await page.getByRole('button', { name: 'Pause', exact: true }).first().click();

      // Opening a teaching and closing it must not create a resume point at the very beginning.
      expect(writesFor(requests, freshId)).toHaveLength(0);
      expect(await findPlaybackProgress(listener.id, freshId, handle)).toBeNull();
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

describe('the landing offers the teaching the member was part-way through', () => {
  it('offers the most recently updated one, with its title, description and elapsed', async () => {
    await upsertPlaybackProgress(
      { userId: listener.id, recordingId: otherId, positionMs: 45_000 },
      handle,
    );
    await upsertPlaybackProgress(
      { userId: listener.id, recordingId: resumableId, positionMs: 83_000 },
      handle,
    );

    const { page } = await signedInPage();
    try {
      const card = page.getByRole('region', { name: 'Resume recording' });
      await expect.poll(() => card.count(), { timeout: 30_000 }).toBe(1);

      const text = (await card.textContent()) ?? '';
      expect(text).toContain(RESUMABLE_TITLE);
      expect(text).toContain('The teaching to pick back up.');
      // Elapsed only — `pages/dashboard.png` prints `01:23 / 02:30`, and nothing in this epic
      // stores a duration to put on the right of that slash.
      expect(text).toContain(`Resume at ${formatTimecode(83_000)}`);
      expect(text).not.toContain('/');

      await card.getByRole('link', { name: new RegExp(RESUMABLE_TITLE) }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(resumableId)}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('offers the other teaching once the newer one is taken down', async () => {
    // 3.2.11 — a teaching taken back down does not reappear through a resume card.
    await setRecordingPublication(resumableId, null, handle);
    try {
      const { page } = await signedInPage();
      try {
        const card = page.getByRole('region', { name: 'Resume recording' });
        await expect.poll(() => card.count(), { timeout: 30_000 }).toBe(1);
        const text = (await card.textContent()) ?? '';
        expect(text).toContain(OTHER_TITLE);
        expect(text).not.toContain(RESUMABLE_TITLE);
      } finally {
        await page.context().close();
      }
    } finally {
      await setRecordingPublication(resumableId, new Date(), handle);
    }
  }, 240_000);

  it('renders no card for a member with no progress on any published teaching', async () => {
    const newcomer = await createAccount(databaseUrl, ROLE.member, 'resume-newcomer');
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email').fill(newcomer.email);
      await page.getByLabel('Password').fill(newcomer.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

      // The way into the library is what tells us the landing has finished rendering; the card is
      // absent rather than merely not yet there.
      await expect
        .poll(() => page.getByRole('link', { name: 'View all series' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(await page.getByRole('region', { name: 'Resume recording' }).count()).toBe(0);
      expect(await page.getByText('Resume at').count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 240_000);
});
