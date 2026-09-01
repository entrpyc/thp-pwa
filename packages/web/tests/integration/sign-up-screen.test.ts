import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ROLE, SIGN_UP_PAGE_PATH } from '@thp/shared';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';

/**
 * The sign-up screen, driven in a real browser (docs/project/prd.md, 3.1.15).
 *
 * A DOM simulation cannot answer what this file has to answer — whether the form submits without
 * reloading, whether the layout holds at a phone width, whether the fields have accessible names,
 * whether the route out to sign-in is reachable — so it drives Chromium against the same production
 * build the API tests use, exactly as `sign-in-screen.test.ts` does.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

/** Phone, tablet, desktop — the responsive standing constraint of the implementation plan. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

/** Long enough for the shipped rule, and obviously not a real password. */
const PASSWORD = 'chosen-in-the-browser';

let browser: Browser;
let existing: TestAccount;

beforeAll(async () => {
  browser = await chromium.launch();
  existing = await createAccount(databaseUrl, ROLE.member, 'signup-browser');
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await closeTestDatabase();
});

async function openSignUp(width = 1280, height = 800): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}${SIGN_UP_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
  return page;
}

function freshEmail(label: string): string {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  return `${label}-${suffix}@example.test`;
}

async function fillAndSubmit(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

describe('the sign-up screen', () => {
  it('renders email, password, the rule and a submit', async () => {
    const page = await openSignUp();
    try {
      await expect.poll(() => page.getByLabel('Email').count()).toBe(1);
      expect(await page.getByLabel('Password').count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Create account' }).count()).toBe(1);
      expect(await page.getByRole('heading', { level: 1 }).textContent()).toContain(
        'Create your account',
      );
      // The rule is on screen before anything has been typed, not revealed by failing it.
      expect(await page.getByText('At least', { exact: false }).count()).toBeGreaterThan(0);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('registers somebody and lands them on an authenticated view', async () => {
    const page = await openSignUp();
    try {
      await fillAndSubmit(page, freshEmail('browser-signup'), PASSWORD);
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
      // Scoped to the heading rather than counting matches: registering is a soft navigation, and
      // Next copies the new page's `h1` into its route announcer shortly afterwards — the same race
      // `sign-in-screen.test.ts` documents.
      await expect
        .poll(() => page.getByRole('heading', { level: 1 }).textContent())
        .toBe('Dashboard');
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('refuses a weak password on the screen, before anything is sent', async () => {
    const page = await openSignUp();
    try {
      await fillAndSubmit(page, freshEmail('browser-weak'), 'short');

      const error = page.locator('form').getByRole('alert');
      await expect
        .poll(async () => ((await error.textContent().catch(() => '')) ?? '').trim().length, {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
      expect(new URL(page.url()).pathname).toBe(SIGN_UP_PAGE_PATH);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('says plainly that an address is taken, without clearing it or reloading the page', async () => {
    const page = await openSignUp();
    try {
      // A mark that only survives if the document is never replaced.
      await page.evaluate(() => {
        (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
      });

      await fillAndSubmit(page, existing.email, PASSWORD);

      const error = page.locator('form').getByRole('alert');
      await expect
        .poll(async () => ((await error.textContent().catch(() => '')) ?? '').trim(), {
          timeout: 20_000,
        })
        .toContain('already has an account');

      // What you typed survives being refused, and the page never reloaded under you.
      expect(await page.getByLabel('Email').inputValue()).toBe(existing.email);
      expect(new URL(page.url()).pathname).toBe(SIGN_UP_PAGE_PATH);
      expect(
        await page.evaluate(
          () => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true,
        ),
      ).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('is reachable from sign-in, and offers the way back', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('link', { name: /create an account/i }).click();
      await page.waitForURL(`${baseUrl}${SIGN_UP_PAGE_PATH}`, { timeout: 30_000 });

      await page.getByRole('link', { name: /sign in/i }).click();
      await page.waitForURL(`${baseUrl}/sign-in`, { timeout: 30_000 });
    } finally {
      await context.close();
    }
  }, 60_000);

  it.each(VIEWPORTS)('does not overflow sideways at $label', async ({ width, height }) => {
    const page = await openSignUp(width, height);
    try {
      await expect.poll(() => page.getByLabel('Email').count()).toBe(1);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('reaches the submit button by keyboard alone', async () => {
    const page = await openSignUp();
    try {
      await page.getByLabel('Email').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
      expect(focused).toContain('Create account');
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
