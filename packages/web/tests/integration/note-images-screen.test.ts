import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { DASHBOARD_PAGE_PATH, ROLE, recordingPagePath } from '@thp/shared';
import { createDatabase, insertRecording, setRecordingPublication, type DatabaseHandle } from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **A picture on a note, driven in a real browser** ([3.12.22](docs/project/prd.md)). The API's
 * half is `note-images.test.ts`; this asks what a fetch cannot: that choosing a file in the
 * composer encodes and uploads it, that the thumbnail and its description field appear, that the
 * saved note shows the strip, and that a press opens the picture full size.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** A real one-pixel PNG, so the browser can decode and re-encode it. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let recordingId: string;

async function signInAs(who: TestAccount): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return page;
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 4 });
  member = await createAccount(databaseUrl, ROLE.member, `img-screen-${RUN}`);
  const { key } = await uploadTestAudio(settings, 30);
  const row = await insertRecording({ originalMediaKey: key, title: `Pictures screen ${RUN}`, recordedAt: '2026-10-01' }, handle);
  await setRecordingPublication(row.id, new Date(), handle);
  recordingId = row.id;
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

describe('the composer with a picture', () => {
  it('encodes and uploads on choosing, saves a note of a picture and words, lists the strip and opens it full size', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(recordingId)}`, { waitUntil: 'domcontentloaded' });
      const tab = page.getByRole('tab', { name: 'Notes' });
      await expect.poll(() => tab.count(), { timeout: 60_000 }).toBe(1);
      if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
      const form = page.getByRole('form', { name: 'Write a note' });
      await expect.poll(() => form.count(), { timeout: 30_000 }).toBe(1);

      await form.locator('input[type="file"]').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG });
      // The tile, its description field, and the state said in words — "Ready" once the key is in hand.
      await expect.poll(() => form.getByLabel('Describe picture 1').count(), { timeout: 30_000 }).toBe(1);
      await expect.poll(() => form.getByText('Ready', { exact: true }).count(), { timeout: 60_000 }).toBe(1);
      await form.getByLabel('Describe picture 1').fill('A single dot');

      await page.getByLabel('Your note').fill(`A note with a picture ${RUN}`);
      await form.getByRole('button', { name: 'Save note' }).click();

      const list = page.getByRole('list', { name: 'Notes' });
      await expect.poll(() => list.getByText(`A note with a picture ${RUN}`).count(), { timeout: 30_000 }).toBe(1);
      const card = list.getByRole('listitem').filter({ hasText: `A note with a picture ${RUN}` }).first();
      const thumb = card.getByRole('button', { name: 'Open A single dot' });
      await expect.poll(() => thumb.count(), { timeout: 30_000 }).toBe(1);

      await thumb.click();
      const dialog = page.getByRole('dialog', { name: 'A single dot' });
      await expect.poll(() => dialog.count(), { timeout: 30_000 }).toBe(1);
      expect(await dialog.getByText('A single dot').count()).toBe(1);
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect.poll(() => page.getByRole('dialog').count(), { timeout: 30_000 }).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});
