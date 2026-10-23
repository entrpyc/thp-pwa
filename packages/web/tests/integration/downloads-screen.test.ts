import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  MEMBER_LIBRARY_PAGE_PATH,
  PROFILE_DOWNLOADS_PAGE_PATH,
  ROLE,
  describeBytes,
  recordingPagePath,
  seriesPagePath,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  insertSeries,
  setRecordingPublication,
  setRecordingSeries,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **Downloads and offline, driven in a real browser** (docs/project/prd.md 3.18.5, 3.18.6,
 * 3.18.9–3.18.11, 3.18.13, 3.18.16).
 *
 * The API's half is `offline-sync.test.ts`. What only a browser can answer: that the control on
 * the recording page fetches the real bytes into the device and reads *Downloaded*; that the mark
 * then appears on the library row and the series row; that the profile section lists the entry
 * with its size and deletes it; that "Download all" sizes the series up and asks first; and that
 * with the network cut the app says it is offline and still lists the downloaded teaching —
 * served by the worker from what the page stored.
 */
const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEACHING_SECONDS = 2;

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let seriesId: string;
let recordingId: string;
let otherId: string;
let bytes: number;

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 4 });
  member = await createAccount(databaseUrl, ROLE.member, 'downloads-member');
  seriesId = (await insertSeries({ title: `Downloads study ${RUN}`, description: null }, handle)).id;
  const upload = await uploadTestAudio(settings, TEACHING_SECONDS);
  bytes = upload.bytes;
  recordingId = (await insertRecording({ originalMediaKey: upload.key, title: `Held teaching ${RUN}`, recordedAt: '2026-03-03' }, handle)).id;
  const other = await uploadTestAudio(settings, TEACHING_SECONDS);
  otherId = (await insertRecording({ originalMediaKey: other.key, title: `Streamed teaching ${RUN}`, recordedAt: '2026-02-02' }, handle)).id;
  await setRecordingSeries(recordingId, seriesId, handle);
  await setRecordingSeries(otherId, seriesId, handle);
  await setRecordingPublication(recordingId, new Date(), handle);
  await setRecordingPublication(otherId, new Date(), handle);
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

async function signedIn(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return { context, page };
}

/** The locator's text once it has one, polled — vitest's expect carries no Playwright matchers. */
async function textOf(locator: Locator): Promise<string> {
  await expect.poll(() => locator.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  return locator.first().innerText();
}

async function countOf(locator: Locator, expected: number, timeout = 30_000): Promise<void> {
  await expect.poll(() => locator.count(), { timeout }).toBe(expected);
}

async function downloadFromRecordingPage(page: Page, id: string): Promise<Locator> {
  await page.goto(`${baseUrl}${recordingPagePath(id)}`, { waitUntil: 'domcontentloaded' });
  const control = page.getByLabel('Download', { exact: true });
  await countOf(control.getByRole('button', { name: 'Download' }), 1);
  await control.getByRole('button', { name: 'Download' }).click();
  await countOf(control.getByText(/Downloaded · /), 1, 60_000);
  return control;
}

async function deleteEveryDownload(page: Page): Promise<void> {
  await page.goto(`${baseUrl}${PROFILE_DOWNLOADS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
  // The list is read from the device after mount; the page's lead is there from the server, so
  // what is waited for is the list itself — a row's delete, or the empty state.
  const deletes = page.getByRole('button', { name: /^Delete download of / });
  const empty = page.getByText('Nothing is downloaded on this device.');
  await expect.poll(async () => (await deletes.count()) + (await empty.count()), { timeout: 30_000 }).toBeGreaterThan(0);
  for (const name of [`Held teaching ${RUN}`, `Streamed teaching ${RUN}`]) {
    const button = page.getByRole('button', { name: `Delete download of ${name}` });
    if ((await button.count()) === 0) continue;
    await button.click();
    await countOf(button, 0);
  }
  await countOf(empty, 1);
}

describe('downloading a teaching', () => {
  it('fetches it on one tap, marks it everywhere it appears, and lists it in the profile with its size', async () => {
    const { context, page } = await signedIn();
    try {
      const control = await downloadFromRecordingPage(page, recordingId);
      expect(await textOf(control)).toContain(describeBytes(bytes));

      await page.goto(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const rows = page.getByRole('list', { name: 'Recordings' });
      await countOf(rows.getByLabel('Downloaded'), 1);
      await countOf(rows.getByRole('listitem').filter({ hasText: `Held teaching ${RUN}` }).getByLabel('Downloaded'), 1);
      await countOf(rows.getByRole('listitem').filter({ hasText: `Streamed teaching ${RUN}` }).getByLabel('Downloaded'), 0);

      await page.goto(`${baseUrl}${seriesPagePath(seriesId)}`, { waitUntil: 'domcontentloaded' });
      await countOf(page.getByRole('list', { name: 'Recordings' }).getByLabel('Downloaded'), 1);

      await page.goto(`${baseUrl}${PROFILE_DOWNLOADS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const current = page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: 'Downloads' });
      await countOf(current, 1);
      expect(await current.getAttribute('aria-current')).toBe('page');
      const list = page.getByRole('list', { name: 'Downloads' });
      await countOf(list.getByRole('listitem'), 1);
      const row = await textOf(list);
      expect(row).toContain(`Held teaching ${RUN}`);
      expect(row).toContain(`Downloads study ${RUN}`);
      expect(row).toContain(describeBytes(bytes));
      expect(row).toContain('Downloaded ');
      await countOf(page.getByText(`1 teaching · ${describeBytes(bytes)} on this device`), 1);

      await page.getByRole('button', { name: `Delete download of Held teaching ${RUN}` }).click();
      await countOf(page.getByText('Nothing is downloaded on this device.'), 1);
      await countOf(list, 0);
    } finally {
      await context.close();
    }
  });

  it('"Download all" sizes the series up and asks before fetching', async () => {
    const { context, page } = await signedIn();
    try {
      await page.goto(`${baseUrl}${seriesPagePath(seriesId)}`, { waitUntil: 'domcontentloaded' });
      await countOf(page.getByRole('button', { name: 'Download all' }), 1);
      await page.getByRole('button', { name: 'Download all' }).click();
      const sheet = page.getByRole('dialog', { name: 'Download all' });
      const asked = await textOf(sheet);
      expect(asked).toContain('2 recordings');
      expect(asked).toContain(describeBytes(bytes * 2));
      await sheet.getByRole('button', { name: 'Not now' }).click();
      await countOf(sheet, 0);

      await page.getByRole('button', { name: 'Download all' }).click();
      await countOf(sheet, 1);
      await sheet.getByRole('button', { name: /^Download \d/ }).click();
      await countOf(page.getByRole('list', { name: 'Recordings' }).getByLabel('Downloaded'), 2, 90_000);

      await page.goto(`${baseUrl}${PROFILE_DOWNLOADS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await countOf(page.getByRole('list', { name: 'Downloads' }).getByRole('listitem'), 2);
      await deleteEveryDownload(page);
    } finally {
      await context.close();
    }
  });
});

describe('offline', () => {
  it('says so, and shows only what is downloaded', async () => {
    const { context, page } = await signedIn();
    try {
      // The worker has to be in control before the network goes: the download warms the pages
      // through it, and the library below is answered by it.
      await page.goto(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 30_000 }).toBe(true);
      await downloadFromRecordingPage(page, recordingId);
      await page.goto(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      // The library holds every published teaching in the suite's shared database, so what is
      // asserted online is that both of this test's are among them.
      const library = page.getByRole('list', { name: 'Recordings' });
      await countOf(library.getByRole('listitem').filter({ hasText: `Held teaching ${RUN}` }), 1);
      await countOf(library.getByRole('listitem').filter({ hasText: `Streamed teaching ${RUN}` }), 1);

      await context.setOffline(true);
      // The document comes from the worker's page cache; the library's rows from its IndexedDB
      // answer. `navigator.onLine` stays true under Playwright's emulation, so what turns the
      // strip on here is the failed flush — the manager's second reading of "offline".
      await page.reload({ waitUntil: 'domcontentloaded' });
      const status = page.getByRole('status', { name: 'Offline status' });
      expect(await textOf(status)).toContain('You are offline. Showing your downloaded teachings.');
      const rows = page.getByRole('list', { name: 'Recordings' });
      await countOf(rows.getByRole('listitem'), 1);
      const held = await textOf(rows);
      expect(held).toContain(`Held teaching ${RUN}`);
      expect(held).not.toContain(`Streamed teaching ${RUN}`);

      await context.setOffline(false);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await countOf(page.getByRole('list', { name: 'Recordings' }).getByRole('listitem').filter({ hasText: `Streamed teaching ${RUN}` }), 1);
      await deleteEveryDownload(page);
    } finally {
      await context.close();
    }
  }, 180_000);
});
