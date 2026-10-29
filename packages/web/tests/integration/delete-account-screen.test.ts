import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import postgres from 'postgres';
import {
  ACCOUNT_DELETED_PAGE_PATH,
  DASHBOARD_PAGE_PATH,
  DELETE_ACCOUNT_PAGE_PATH,
  DELETION_TOKEN_PARAM,
  PROFILE_PAGE_PATH,
  REMOVED_MEMBER_DISPLAY_NAME,
  ROLE,
  type Role,
} from '@thp/shared';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { mailOffset, waitForMail, type CapturedMail } from '../support/mail';

/**
 * **The public delete-account page, driven in a real browser** (docs/project/prd.md 3.1.8; the page
 * Google Play shows on the store listing).
 *
 * The routes behind it are `account-deletion.test.ts`'s, budget included. What only the screen can
 * answer is what this file asks: that a reader with no session gets the explanation and the form;
 * that a known and an unknown address land on one confirmation, character for character; that a
 * member with a session is sent to the in-app door instead; that the mailed link opens a form with
 * the address as context and a button locked until the password and the word are there; that the
 * two refusals arrive in the API's words and leave the link alive; and that a dead link is prose
 * with no password field and the way to ask again on it.
 *
 * The rate limit is not driven from here: the browser bundle calls the primary origin, whose
 * budget the harness lifts, and the refusal itself is asserted over HTTP in the API file.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const mailPath = inject('mailCapturePath');

const SETTINGS_PATH = `${PROFILE_PAGE_PATH}/settings`;

/** Phone, tablet, desktop — the responsive standing constraint of the implementation plan. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

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

async function open(path: string, width = 1280, height = 800): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function openLink(token: string, width = 1280, height = 800): Promise<Page> {
  const url = new URL(`${baseUrl}${DELETE_ACCOUNT_PAGE_PATH}`);
  url.searchParams.set(DELETION_TOKEN_PARAM, token);
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  return page;
}

function tokenFrom(message: CapturedMail): string {
  const link = /https?:\/\/\S+/.exec(message.text)?.[0];
  if (link === undefined) throw new Error('the plain-text part carries no link');
  const url = new URL(link);
  expect(url.pathname).toBe(DELETE_ACCOUNT_PAGE_PATH);
  const token = url.searchParams.get(DELETION_TOKEN_PARAM);
  if (token === null || token === '') throw new Error(`no token in ${link}`);
  return token;
}

/** Submit the request form and wait for the confirmation. Returns what the screen said. */
async function askThroughTheScreen(email: string): Promise<{ heading: string; body: string }> {
  const page = await open(DELETE_ACCOUNT_PAGE_PATH);
  try {
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: /send me a link/i }).click();
    const heading = page.getByRole('heading', { level: 1 });
    await expect
      .poll(async () => ((await heading.textContent()) ?? '').trim(), { timeout: 20_000 })
      .toMatch(/check your email/i);
    return {
      heading: ((await heading.textContent()) ?? '').trim(),
      // The address is echoed back, so it is removed before comparing — what must match is
      // everything the screen says *about the outcome*.
      // The rendered text, not the DOM's: `textContent` would include Next's inline bootstrap
      // scripts, which carry a per-request CSP nonce and so never compare equal.
      body: (await page.innerText('body')).replace(email, '(the address)'),
    };
  } finally {
    await page.context().close();
  }
}

/** Ask from the screen, as a person would, and pull the token out of the message that followed. */
async function linkFor(label: string, role: Role = ROLE.member): Promise<{ account: TestAccount; token: string }> {
  const account = await createAccount(databaseUrl, role, `public-delete-${label}`);
  const offset = mailOffset(mailPath);
  await askThroughTheScreen(account.email);
  const messages = await waitForMail(mailPath, offset, (found) =>
    found.some((one) => one.to === account.email),
  );
  const message = messages.find((one) => one.to === account.email);
  if (message === undefined) throw new Error(`no deletion message captured for ${account.email}`);
  return { account, token: tokenFrom(message) };
}

async function accountExists(id: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`select id from "user" where id = ${id}`;
  return rows.length === 1;
}

function submit(page: Page) {
  return page.getByRole('button', { name: 'Yes, delete my account' });
}

async function fillLinkForm(page: Page, password: string): Promise<void> {
  await page.getByLabel('Current password').fill(password);
  await page.getByLabel(/type delete to confirm/i).fill('delete');
}

describe('the request page', () => {
  it('explains the convention and offers an email field and a submit to a reader with no session', async () => {
    const page = await open(DELETE_ACCOUNT_PAGE_PATH);
    try {
      await expect.poll(() => page.getByLabel('Email').count()).toBe(1);
      expect(await page.getByRole('heading', { level: 1 }).textContent()).toMatch(/delete your account/i);
      const body = (await page.textContent('body')) ?? '';
      expect(body).toContain('private notes');
      expect(body).toContain(REMOVED_MEMBER_DISPLAY_NAME);
      expect(body.toLowerCase()).toContain('immediate');
      expect(await page.getByRole('button', { name: /send me a link/i }).count()).toBe(1);
      expect(await page.locator('input[type="password"]').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('lands on the same neutral confirmation for a known and an unknown address', async () => {
    const account = await createAccount(databaseUrl, ROLE.member, 'public-delete-neutral');
    const known = await askThroughTheScreen(account.email);
    const unknown = await askThroughTheScreen(`nobody-${Date.now().toString(36)}@example.test`);

    expect(unknown.heading).toBe(known.heading);
    expect(unknown.body).toBe(known.body);
    // It reads as care rather than a shrug, and it says the one thing a deletion message owes:
    // the link alone does nothing.
    expect(known.body.toLowerCase()).toContain('hour');
    expect(known.body.toLowerCase()).toContain('spam');
    expect(known.body.toLowerCase()).toContain('password');
  }, 120_000);

  it('sends a signed-in member to the settings page instead', async () => {
    const account = await createAccount(databaseUrl, ROLE.member, 'public-delete-signed-in');
    const page = await open('/sign-in');
    try {
      await page.getByLabel('Email').fill(account.email);
      await page.getByLabel('Password').fill(account.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

      await page.goto(`${baseUrl}${DELETE_ACCOUNT_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(`${baseUrl}${SETTINGS_PATH}`, { timeout: 30_000 });
      await expect
        .poll(() => page.getByRole('heading', { level: 3, name: 'Delete account' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it.each(VIEWPORTS)('fits a $label viewport with no horizontal scroll', async (viewport) => {
    const page = await open(DELETE_ACCOUNT_PAGE_PATH, viewport.width, viewport.height);
    try {
      await expect.poll(() => page.getByLabel('Email').count()).toBe(1);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    } finally {
      await page.context().close();
    }
  }, 90_000);
});

describe('the mailed link', () => {
  it('shows the address read-only and keeps the button locked until the password and the word are there', async () => {
    const { account, token } = await linkFor('render');
    const page = await openLink(token);
    try {
      await expect.poll(() => page.getByLabel('Current password').count()).toBe(1);
      const emailField = page.getByLabel('Email');
      expect(await emailField.inputValue()).toBe(account.email);
      expect(await emailField.getAttribute('readonly')).not.toBeNull();
      expect(((await page.textContent('body')) ?? '')).toContain(REMOVED_MEMBER_DISPLAY_NAME);

      expect(await submit(page).isDisabled()).toBe(true);
      await page.getByLabel('Current password').fill(account.password);
      expect(await submit(page).isDisabled()).toBe(true);
      await page.getByLabel(/type delete to confirm/i).fill('delete');
      await expect.poll(() => submit(page).isDisabled()).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('refuses a wrong password in the API’s words, keeps the link alive, then deletes with the right one', async () => {
    const { account, token } = await linkFor('wrong-then-right');
    const page = await openLink(token);
    try {
      await fillLinkForm(page, 'not-the-password');
      await submit(page).click();
      const alert = page.locator('form').getByRole('alert');
      await expect
        .poll(async () => ((await alert.textContent().catch(() => '')) ?? '').trim(), {
          timeout: 20_000,
        })
        .toMatch(/not your current password/i);
      expect(await accountExists(account.id)).toBe(true);
      expect(new URL(page.url()).pathname).toBe(DELETE_ACCOUNT_PAGE_PATH);

      await page.getByLabel('Current password').fill(account.password);
      await submit(page).click();
      await page.waitForURL(`${baseUrl}${ACCOUNT_DELETED_PAGE_PATH}`, { timeout: 30_000 });
      await expect
        .poll(() => page.getByRole('heading', { level: 1 }).textContent(), { timeout: 30_000 })
        .toMatch(/deleted/i);
      expect(await accountExists(account.id)).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 150_000);

  it('refuses the only active admin in the API’s words and leaves the same link usable afterwards', async () => {
    const { account: only, token } = await linkFor('only-admin', ROLE.admin);
    // Somebody to restore afterwards, whatever ran before this test in the shared database: the
    // seeded admin is not guaranteed to be active by the time this file runs on its own.
    await createAccount(databaseUrl, ROLE.admin, 'public-delete-spare-admin');
    const others = await sql<{ id: string }[]>`
      select id from "user" where role = 'admin' and deactivated_at is null and id <> ${only.id}
    `;
    const ids = others.map((row) => row.id);
    if (ids.length > 0) {
      await sql`update "user" set deactivated_at = now() where id = any(${sql.array(ids)}::uuid[])`;
    }
    const page = await openLink(token);
    try {
      await fillLinkForm(page, only.password);
      await submit(page).click();
      const alert = page.locator('form').getByRole('alert');
      await expect
        .poll(async () => ((await alert.textContent().catch(() => '')) ?? '').trim(), {
          timeout: 20_000,
        })
        .toMatch(/only active admin/i);
      expect(await accountExists(only.id)).toBe(true);

      // Promote somebody — here, restore the others — and the same link finishes the job.
      if (ids.length > 0) {
        await sql`update "user" set deactivated_at = null where id = any(${sql.array(ids)}::uuid[])`;
      }
      await submit(page).click();
      await page.waitForURL(`${baseUrl}${ACCOUNT_DELETED_PAGE_PATH}`, { timeout: 30_000 });
      expect(await accountExists(only.id)).toBe(false);
    } finally {
      await page.context().close();
      if (ids.length > 0) {
        await sql`update "user" set deactivated_at = null where id = any(${sql.array(ids)}::uuid[])`;
      }
    }
  }, 150_000);
});

describe('a dead link is a dead end', () => {
  /** Every case asserts the same thing first: no password field. Nobody types into nothing. */
  async function deadEnd(page: Page): Promise<string> {
    await expect.poll(() => page.getByRole('heading', { level: 1 }).count()).toBe(1);
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    return ((await page.getByRole('heading', { level: 1 }).textContent()) ?? '').toLowerCase();
  }

  it('says the link expired, and the way to another one is on the screen', async () => {
    const { account, token } = await linkFor('expired');
    await sql`update account_deletion_request set expires_at = now() - interval '1 minute' where user_id = ${account.id}`;
    const page = await openLink(token);
    try {
      expect(await deadEnd(page)).toContain('expired');
      const again = page.getByRole('link', { name: /another link/i });
      expect(await again.count()).toBe(1);
      await again.click();
      await page.waitForURL(`${baseUrl}${DELETE_ACCOUNT_PAGE_PATH}`, { timeout: 30_000 });
      expect(await page.getByLabel('Email').count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('says the link is not valid after it has been used, and says the account is already gone', async () => {
    const { account, token } = await linkFor('used');
    const first = await openLink(token);
    try {
      await fillLinkForm(first, account.password);
      await submit(first).click();
      await first.waitForURL(`${baseUrl}${ACCOUNT_DELETED_PAGE_PATH}`, { timeout: 30_000 });
    } finally {
      await first.context().close();
    }

    const second = await openLink(token);
    try {
      expect(await deadEnd(second)).not.toContain('expired');
      expect(((await second.textContent('body')) ?? '').toLowerCase()).toContain('already');
    } finally {
      await second.context().close();
    }
  }, 150_000);

  it('says the link is not valid for a token nobody was ever sent', async () => {
    const page = await openLink('this-token-was-never-issued');
    try {
      expect(await deadEnd(page)).toContain('not valid');
      expect(await page.getByRole('link', { name: /another link/i }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 90_000);
});
