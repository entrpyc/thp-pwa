import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { DASHBOARD_PAGE_PATH, NOTIFICATION_SETTINGS_PAGE_PATH, ROLE } from '@thp/shared';
import { createDatabase, listPushPreferences, type DatabaseHandle } from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';

/**
 * **The notifications section, driven in a real browser** ([3.17.13](docs/project/prd.md),
 * [3.17.14](docs/project/prd.md)).
 *
 * The API's half is `push.test.ts`; what a fetch cannot answer is what this file asks. Whether
 * the section is in the profile strip and renders at `/profile/notifications` with one switch per
 * category — three for a member, four for an admin. Whether one press turns a category off on the
 * account, says so without a reload, and survives a fresh sign-in. And whether the device line
 * says push is not available here rather than offering a button, because the suite's servers
 * carry no VAPID pair — which is also what keeps this file from ever raising a permission prompt
 * in a headless browser that has no push service to answer it.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let admin: TestAccount;

async function freshSessionOn(account: TestAccount): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  await page.goto(`${baseUrl}${NOTIFICATION_SETTINGS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('heading', { level: 3, name: 'Push notifications' }).count(), { timeout: 30_000 })
    .toBe(1);
  return page;
}

function card(page: Page) {
  return page.getByRole('region', { name: 'Push notifications' });
}

function switches(page: Page) {
  return card(page).getByRole('switch');
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 4 });
  [member, admin] = await Promise.all([
    createAccount(databaseUrl, ROLE.member, 'push-screen-member'),
    createAccount(databaseUrl, ROLE.admin, 'push-screen-admin'),
  ]);
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

describe('the notifications section', () => {
  it('is in the profile strip, lists one switch per category, all on, and explains the device', async () => {
    const page = await freshSessionOn(member);
    try {
      const strip = page.getByRole('navigation', { name: 'Profile sections' });
      expect(await strip.getByRole('link', { name: 'Notifications' }).getAttribute('aria-current')).toBe('page');

      await expect.poll(() => switches(page).count(), { timeout: 30_000 }).toBe(3);
      expect(await switches(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-checked')))).toEqual(['true', 'true', 'true']);
      expect(await card(page).getByText('New recordings').count()).toBe(1);
      expect(await card(page).getByText('Announcements').count()).toBe(1);
      expect(await card(page).getByText('Admin alerts').count()).toBe(0);

      // No VAPID pair on the suite's servers: the line says so, and no button asks for anything.
      expect(await card(page).getByRole('status').first().textContent()).toMatch(/not set up for browsers/);
      expect(await card(page).getByRole('button', { name: /Turn on push/ }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('lists the admin-only category for an admin', async () => {
    const page = await freshSessionOn(admin);
    try {
      await expect.poll(() => switches(page).count(), { timeout: 30_000 }).toBe(4);
      expect(await card(page).getByText('Admin alerts').count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('turns a category off on one press, holds across a fresh sign-in, and comes back on the same way', async () => {
    const first = await freshSessionOn(member);
    try {
      await expect.poll(() => switches(first).count(), { timeout: 30_000 }).toBe(3);
      const recordings = card(first).getByRole('switch', { name: 'New recordings' });
      await recordings.click();
      await expect.poll(() => recordings.getAttribute('aria-checked'), { timeout: 30_000 }).toBe('false');
      expect(await listPushPreferences(member.id, handle)).toEqual([{ category: 'recordings', pushEnabled: false }]);
    } finally {
      await first.context().close();
    }

    const second = await freshSessionOn(member);
    try {
      const recordings = card(second).getByRole('switch', { name: 'New recordings' });
      await expect.poll(() => recordings.getAttribute('aria-checked'), { timeout: 30_000 }).toBe('false');
      expect(await card(second).getByRole('switch', { name: 'Announcements' }).getAttribute('aria-checked')).toBe('true');

      await recordings.click();
      await expect.poll(() => recordings.getAttribute('aria-checked'), { timeout: 30_000 }).toBe('true');
      expect(await listPushPreferences(member.id, handle)).toEqual([{ category: 'recordings', pushEnabled: true }]);
    } finally {
      await second.context().close();
    }
  }, 180_000);
});
