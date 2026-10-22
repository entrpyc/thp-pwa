import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { DASHBOARD_PAGE_PATH, PRIVACY_PAGE_PATH, PROFILE_PAGE_PATH, ROLE } from '@thp/shared';
import { createDatabase, findUserById, type DatabaseHandle } from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';

/**
 * **The analytics setting, driven in a real browser** (Apple guideline 5.1.1(ii)).
 *
 * The API's half is `analytics-preference.test.ts`; what a fetch cannot answer is what this file
 * asks. Whether the card is on `/profile/settings` with the copy that says what is collected and
 * the link to the privacy policy. Whether one press turns analytics off on the account and the
 * card says so without a reload. Whether a fresh sign-in — no cookie, no storage, nothing carried
 * over but the account — shows the setting off, which is the claim that it lives on the account
 * and not on the device. And whether the way back on is the same button.
 *
 * The suite runs with no analytics key, so the SDK never starts here; what the adapter does with
 * the preference is the unit test's with the SDK stubbed. This file is about the screen and the row.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;

/** A brand-new browser context that signs in through the real screen and opens the settings page. */
async function freshSessionOnSettings(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  await page.goto(`${baseUrl}${PROFILE_PAGE_PATH}/settings`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('heading', { level: 3, name: 'Analytics' }).count(), { timeout: 30_000 })
    .toBe(1);
  return page;
}

function card(page: Page) {
  return page.getByRole('region', { name: 'Analytics' });
}

async function optedOut(): Promise<boolean | undefined> {
  return (await findUserById(member.id, handle))?.analyticsOptedOut;
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 4 });
  member = await createAccount(databaseUrl, ROLE.member, 'analytics-screen');
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

describe('the analytics card on the settings page', () => {
  it('says what is collected, links to the privacy policy, and reads as on by default', async () => {
    const page = await freshSessionOnSettings();
    try {
      const section = card(page);
      await expect.poll(() => section.getByText(/we count plays/i).count()).toBe(1);
      await expect.poll(() => section.getByText(/never your name, your e-mail/i).count()).toBe(1);
      expect(await section.getByRole('link', { name: 'privacy policy' }).getAttribute('href')).toBe(
        PRIVACY_PAGE_PATH,
      );
      expect(await section.getByRole('status').textContent()).toMatch(/Analytics is on/);
      expect(await section.getByRole('button', { name: 'Turn analytics off' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('turns analytics off on one press, holds across a fresh sign-in, and comes back on the same way', async () => {
    const first = await freshSessionOnSettings();
    try {
      await card(first).getByRole('button', { name: 'Turn analytics off' }).click();
      // The card says so without a reload, and only once the account holds it.
      await expect
        .poll(() => card(first).getByRole('status').textContent(), { timeout: 30_000 })
        .toMatch(/Analytics is off for your account/);
      expect(await optedOut()).toBe(true);
      expect(await card(first).getByRole('button', { name: 'Turn analytics on' }).count()).toBe(1);
    } finally {
      await first.context().close();
    }

    // Nothing carried over but the account: the setting is on the account, not on the device.
    const second = await freshSessionOnSettings();
    try {
      expect(await card(second).getByRole('status').textContent()).toMatch(/Analytics is off/);

      await card(second).getByRole('button', { name: 'Turn analytics on' }).click();
      await expect
        .poll(() => card(second).getByRole('status').textContent(), { timeout: 30_000 })
        .toMatch(/Analytics is on/);
      expect(await optedOut()).toBe(false);
    } finally {
      await second.context().close();
    }
  }, 180_000);
});
