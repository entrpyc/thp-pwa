import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  ADMIN_ANNOUNCEMENTS_PAGE_PATH,
  DASHBOARD_PAGE_PATH,
  NOTIFICATIONS_PAGE_PATH,
  ROLE,
  onboardingPagePath,
  recordingPagePath,
} from '@thp/shared';
import {
  createDatabase,
  insertNotification,
  insertRecording,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';

/**
 * **The bell and the centre, driven in a real browser** ([3.17.2](docs/project/prd.md),
 * [3.17.3](docs/project/prd.md)).
 *
 * The API's half is `notifications.test.ts`; what a fetch cannot answer is what this file asks.
 * Whether the bell shows the count. Whether pressing a row goes where the row says and takes one
 * off the bell. Whether an admin can compose a new feature from the console and a member is then
 * taken into the onboarding by pressing it.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const DESKTOP = { width: 1280, height: 800 };

let browser: Browser;
let handle: DatabaseHandle;

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 2 });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

async function signInAs(account: TestAccount): Promise<Page> {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return page;
}

describe('the bell and the centre', () => {
  it('counts the unread, opens the centre, and a press lands on the teaching and clears one', async () => {
    const member = await createAccount(databaseUrl, ROLE.member, `bell-${RUN}`);
    const teaching = await insertRecording(
      {
        originalMediaKey: `originals/notif-screen-${RUN}.mp3`,
        title: `Teaching ${RUN}`,
        recordedAt: '2026-08-16',
      },
      handle,
    );
    await setRecordingPublication(teaching.id, new Date(), handle);
    const recordingId = teaching.id;
    await insertNotification(
      member.id,
      { kind: 'announcement', title: `Hello ${RUN}`, body: 'Everybody', href: null },
      handle,
    );
    await insertNotification(
      member.id,
      {
        kind: 'recording_published',
        title: 'New recording published',
        body: `Teaching ${RUN}`,
        href: recordingPagePath(recordingId),
      },
      handle,
    );

    const page = await signInAs(member);
    try {
      const bell = page.getByRole('link', { name: 'Notifications, 2 unread' });
      await expect.poll(() => bell.count(), { timeout: 30_000 }).toBe(1);
      await bell.click();
      await page.waitForURL(`${baseUrl}${NOTIFICATIONS_PAGE_PATH}`, { timeout: 30_000 });
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: 'Notifications' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      const list = page.getByRole('list', { name: 'Notifications' });
      await expect.poll(() => list.getByText(`Teaching ${RUN}`).count(), { timeout: 30_000 }).toBe(1);

      // The one with a destination is a link, and pressing it goes there.
      await list.getByRole('link', { name: new RegExp(`Teaching ${RUN}`) }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(recordingId)}`, { timeout: 30_000 });

      // One off the bell.
      await expect
        .poll(() => page.getByRole('link', { name: 'Notifications, 1 unread' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      // The announcement has nowhere to go: pressing it marks it read where it is.
      await page.goto(`${baseUrl}${NOTIFICATIONS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const announcement = page
        .getByRole('list', { name: 'Notifications' })
        .getByRole('button', { name: new RegExp(`Hello ${RUN}`) });
      await expect.poll(() => announcement.count(), { timeout: 30_000 }).toBe(1);
      await announcement.click();
      await expect
        .poll(() => page.getByRole('link', { name: 'Notifications', exact: true }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(await page.getByRole('button', { name: 'Mark all as read' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('a new feature, end to end', () => {
  it('is composed on the console and takes a member into the onboarding it names', async () => {
    const admin = await createAccount(databaseUrl, ROLE.admin, `feature-admin-${RUN}`);
    const member = await createAccount(databaseUrl, ROLE.member, `feature-member-${RUN}`);
    const title = `Tour again ${RUN}`;

    const panel = await signInAs(admin);
    try {
      await panel.goto(`${baseUrl}${ADMIN_ANNOUNCEMENTS_PAGE_PATH}`, {
        waitUntil: 'domcontentloaded',
      });
      await panel.getByRole('button', { name: 'New feature', exact: true }).click();
      await panel.getByLabel('Title').fill(title);
      await panel.getByLabel('Message').fill('The tour has new slides.');
      await panel.getByLabel('Onboarding id').fill('new-user');
      await panel.getByRole('button', { name: 'Send to all members' }).click();
      await panel.getByRole('button', { name: 'Yes, send it' }).click();
      await expect.poll(() => panel.getByRole('status').count(), { timeout: 30_000 }).toBe(1);
      expect(await panel.getByRole('status').textContent()).toContain('is sent to');
      // Listed under Sent, newest first, as a new feature that opens the tour.
      await expect
        .poll(() => panel.getByText(title).count(), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(1);
    } finally {
      await panel.context().close();
    }

    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${NOTIFICATIONS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const row = page
        .getByRole('list', { name: 'Notifications' })
        .getByRole('link', { name: new RegExp(title) });
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
      expect(await row.textContent()).toContain('New feature');
      await row.click();
      await page.waitForURL(`${baseUrl}${onboardingPagePath('new-user')}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 180_000);
});
