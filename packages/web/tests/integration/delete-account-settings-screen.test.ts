import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import postgres from 'postgres';
import {
  ACCOUNT_DELETED_PAGE_PATH,
  DASHBOARD_PAGE_PATH,
  PROFILE_PAGE_PATH,
  REMOVED_MEMBER_DISPLAY_NAME,
  ROLE,
  type Role,
} from '@thp/shared';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';

/**
 * **The delete-account card on `/profile/settings`, driven in a real browser** (docs/project/prd.md
 * 3.1.8; Apple 5.1.1(v)).
 *
 * The API's half — what the erasure does to every table — is `account-deletion.test.ts`. What a
 * fetch cannot answer is what this file asks: that the card says what the convention does before
 * anything can be pressed; that a first press deletes nothing and only opens the form; that the
 * button stays locked until the password *and* the typed word are there; that the two refusals
 * arrive on the card in the API's own words with the page still standing; and that success leaves
 * the member on the public confirmation with a session that no longer exists.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const SETTINGS_PATH = `${PROFILE_PAGE_PATH}/settings`;

let browser: Browser;
let sql: postgres.Sql;

beforeAll(async () => {
  browser = await chromium.launch();
  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

/** A brand-new browser context that signs in through the real screen and opens the settings page. */
async function onSettings(account: TestAccount): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  await page.goto(`${baseUrl}${SETTINGS_PATH}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('heading', { level: 3, name: 'Delete account' }).count(), {
      timeout: 30_000,
    })
    .toBe(1);
  return page;
}

function card(page: Page) {
  return page.getByRole('region', { name: 'Delete account' });
}

function submit(page: Page) {
  return card(page).getByRole('button', { name: 'Yes, delete my account' });
}

/** Open the form, and fill it the way a person would: password first, then the word. */
async function fillForm(page: Page, password: string, word = 'delete'): Promise<void> {
  await card(page).getByRole('button', { name: 'Delete my account' }).click();
  await card(page).getByLabel('Current password').fill(password);
  await card(page).getByLabel(/type delete to confirm/i).fill(word);
}

async function accountExists(id: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`select id from "user" where id = ${id}`;
  return rows.length === 1;
}

async function member(label: string, role: Role = ROLE.member): Promise<TestAccount> {
  return createAccount(databaseUrl, role, `delete-screen-${label}`);
}

describe('the card at rest', () => {
  it('says what the convention does, and shows no password field until asked', async () => {
    const page = await onSettings(await member('rest'));
    try {
      const section = card(page);
      const text = (await section.textContent()) ?? '';
      // The convention's two halves, in the card's words: what goes, and what stays under whom.
      expect(text).toContain('private notes');
      expect(text).toContain(REMOVED_MEMBER_DISPLAY_NAME);
      expect(text.toLowerCase()).toContain('immediate');
      // The last card on the page: the one button nobody can undo is never the first under a thumb.
      const titles = await page.getByRole('heading', { level: 3 }).allTextContents();
      expect(titles.at(-1)).toBe('Delete account');

      expect(await section.locator('input[type="password"]').count()).toBe(0);
      expect(await section.getByRole('button', { name: 'Delete my account' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('opens the form on a press, keeps the submit locked until both proofs are there, and cancels clean', async () => {
    const page = await onSettings(await member('locked'));
    try {
      await card(page).getByRole('button', { name: 'Delete my account' }).click();
      await expect.poll(() => card(page).getByLabel('Current password').count()).toBe(1);
      expect(await submit(page).isDisabled()).toBe(true);

      await card(page).getByLabel('Current password').fill('anything');
      expect(await submit(page).isDisabled()).toBe(true);

      await card(page).getByLabel(/type delete to confirm/i).fill('delet');
      expect(await submit(page).isDisabled()).toBe(true);

      // Case and a stray capital are forgiven; a phone capitalises the first letter of a field.
      await card(page).getByLabel(/type delete to confirm/i).fill('Delete');
      await expect.poll(() => submit(page).isDisabled()).toBe(false);

      await card(page).getByRole('button', { name: 'Cancel' }).click();
      await expect.poll(() => card(page).locator('input[type="password"]').count()).toBe(0);
      // And reopening starts from nothing — a cancelled password is not kept around.
      await card(page).getByRole('button', { name: 'Delete my account' }).click();
      expect(await card(page).getByLabel('Current password').inputValue()).toBe('');
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('what refuses', () => {
  it('shows a wrong password in the API’s words, without a reload, and changes nothing', async () => {
    const account = await member('wrong-password');
    const page = await onSettings(account);
    try {
      await page.evaluate(() => {
        (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
      });
      await fillForm(page, 'not-the-password');
      await submit(page).click();

      const alert = card(page).getByRole('alert');
      await expect
        .poll(async () => ((await alert.textContent().catch(() => '')) ?? '').trim(), {
          timeout: 20_000,
        })
        .toMatch(/not your current password/i);

      expect(new URL(page.url()).pathname).toBe(SETTINGS_PATH);
      expect(
        await page.evaluate(
          () => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true,
        ),
      ).toBe(true);
      expect(await accountExists(account.id)).toBe(true);
      // The form stays, with the word still typed: being refused costs a second attempt, not a restart.
      expect(await card(page).getByLabel(/type delete to confirm/i).inputValue()).toBe('delete');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('shows the last-admin refusal in the API’s words and leaves the admin signed in', async () => {
    const only = await member('only-admin', ROLE.admin);
    const others = await sql<{ id: string }[]>`
      select id from "user" where role = 'admin' and deactivated_at is null and id <> ${only.id}
    `;
    const ids = others.map((row) => row.id);
    if (ids.length > 0) {
      await sql`update "user" set deactivated_at = now() where id = any(${sql.array(ids)}::uuid[])`;
    }
    const page = await onSettings(only);
    try {
      await fillForm(page, only.password);
      await submit(page).click();

      const alert = card(page).getByRole('alert');
      await expect
        .poll(async () => ((await alert.textContent().catch(() => '')) ?? '').trim(), {
          timeout: 20_000,
        })
        .toMatch(/only active admin/i);
      expect(await accountExists(only.id)).toBe(true);

      // Still signed in: a reload lands on the same page, not on the door.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByRole('heading', { level: 3, name: 'Delete account' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
    } finally {
      await page.context().close();
      if (ids.length > 0) {
        await sql`update "user" set deactivated_at = null where id = any(${sql.array(ids)}::uuid[])`;
      }
    }
  }, 150_000);
});

describe('success', () => {
  it('deletes the account, lands on the public confirmation, and the session is gone with it', async () => {
    const account = await member('success');
    const page = await onSettings(account);
    try {
      await fillForm(page, account.password);
      await submit(page).click();

      await page.waitForURL(`${baseUrl}${ACCOUNT_DELETED_PAGE_PATH}`, { timeout: 30_000 });
      await expect
        .poll(() => page.getByRole('heading', { level: 1 }).textContent(), { timeout: 30_000 })
        .toMatch(/deleted/i);
      const body = (await page.textContent('body')) ?? '';
      expect(body).toContain(REMOVED_MEMBER_DISPLAY_NAME);
      expect(await page.getByRole('link', { name: /back to sign in/i }).count()).toBe(1);
      expect(await accountExists(account.id)).toBe(false);

      // The cookie this browser still holds resolves to nothing: the member surface is the door now.
      await page.goto(`${baseUrl}${SETTINGS_PATH}`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(`${baseUrl}/sign-in`, { timeout: 30_000 });

      // And the credentials are no credentials: the address is free, the password proves nobody.
      expect((await signIn(baseUrl, account.email, account.password)).status).toBe(401);
    } finally {
      await page.context().close();
    }
  }, 150_000);
});
