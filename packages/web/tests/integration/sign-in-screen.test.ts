import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ROLE } from '@thp/shared';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';

/**
 * The sign-in screen, driven in a real browser.
 *
 * A DOM simulation cannot answer any of the four things this file has to answer — whether the form
 * submits without reloading, whether the layout overflows at a phone width, whether the fields have
 * accessible names, whether tabbing reaches the button — so the suite drives Chromium against the
 * same production build the API tests use.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

/** Phone, tablet, desktop — the responsive standing constraint of the implementation plan. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

let browser: Browser;
let account: TestAccount;

beforeAll(async () => {
  browser = await chromium.launch();
  account = await createAccount(databaseUrl, ROLE.member, 'browser');
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await closeTestDatabase();
});

async function openSignIn(width = 1280, height = 800): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function fillAndSubmit(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

describe('the sign-in screen', () => {
  it('renders email, password and submit', async () => {
    const page = await openSignIn();
    try {
      await expect.poll(() => page.getByLabel('Email').count()).toBe(1);
      expect(await page.getByLabel('Password').count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Sign in' }).count()).toBe(1);
      expect(await page.getByRole('heading', { level: 1 }).textContent()).toContain('Sign in');
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('signs a person in and lands them on an authenticated view', async () => {
    const page = await openSignIn();
    try {
      await fillAndSubmit(page, account.email, account.password);
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
      // Scoped to the heading rather than counting matches on the page. Signing in is a *soft*
      // navigation (`router.replace`), and Next.js copies the new page's `h1` into its
      // `#__next-route-announcer__` live region roughly 250ms afterwards — so an unscoped text
      // locator finds it twice from then on, and a count of 1 is a race the fast machine wins and
      // the slow one loses. Asserting the heading is also what this test means.
      //
      // The heading used to read "Signed in as …". Story 4 Ticket 01 retired that placeholder, and
      // `/` is now the member landing — whose title `pages/dashboard.png` deliberately does not
      // paint, because the breadcrumb bar is the heading a member reads.
      await expect
        .poll(() => page.getByRole('heading', { level: 1 }).textContent())
        .toBe('Dashboard');
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('shows a failure on the screen without clearing the email or reloading the page', async () => {
    const page = await openSignIn();
    try {
      // A mark that only survives if the document is never replaced.
      await page.evaluate(() => {
        (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
      });

      await fillAndSubmit(page, account.email, 'definitely not the password');

      // Scoped to the form: Next.js renders its own empty `role="alert"` route announcer, and an
      // unscoped alert locator finds that instead.
      const error = page.locator('form').getByRole('alert');
      await expect
        .poll(async () => ((await error.textContent().catch(() => '')) ?? '').trim().length, {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);

      // What you typed survives being refused.
      expect(await page.getByLabel('Email').inputValue()).toBe(account.email);
      expect(new URL(page.url()).pathname).toBe('/sign-in');
      expect(
        await page.evaluate(
          () => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true,
        ),
      ).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('says nothing about whether the address has an account', async () => {
    const page = await openSignIn();
    try {
      await fillAndSubmit(page, 'nobody-here@example.test', 'whatever at all');
      // Scoped to the form: Next.js renders its own empty `role="alert"` route announcer, and an
      // unscoped alert locator finds that instead.
      const error = page.locator('form').getByRole('alert');
      const message = async () => ((await error.textContent().catch(() => '')) ?? '').trim();
      await expect.poll(async () => (await message()).length, { timeout: 20_000 }).toBeGreaterThan(0);

      const unknownMessage = await message();
      await page.getByLabel('Email').fill(account.email);
      await page.getByLabel('Password').fill('wrong password');
      await page.getByRole('button', { name: 'Sign in' }).click();
      // Same words for "no such account" and "wrong password" — the screen discloses no more than
      // the API does.
      await expect.poll(message, { timeout: 20_000 }).toBe(unknownMessage);
      expect(unknownMessage.length).toBeGreaterThan(0);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('is operable by keyboard alone, and every field has an accessible name', async () => {
    const page = await openSignIn();
    try {
      await page.getByLabel('Email').focus();
      await page.keyboard.type(account.email);
      await page.keyboard.press('Tab');
      await page.keyboard.type(account.password);
      await page.keyboard.press('Tab');

      const focused = await page.evaluate(() => {
        const element = document.activeElement;
        return {
          tag: element?.tagName ?? '',
          text: element?.textContent?.trim() ?? '',
          type: element?.getAttribute('type') ?? '',
        };
      });
      expect(focused.tag).toBe('BUTTON');
      expect(focused.type).toBe('submit');

      // Names come from real labels, not from placeholders.
      const names = await page.evaluate(() =>
        [...document.querySelectorAll('input')].map((input) => {
          const label = input.labels?.[0]?.textContent?.trim() ?? '';
          return { label, placeholder: input.getAttribute('placeholder') };
        }),
      );
      expect(names.map((entry) => entry.label)).toEqual(['Email', 'Password']);

      await page.keyboard.press('Enter');
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it.each(VIEWPORTS)('fits a $label viewport with no horizontal scroll', async (viewport) => {
    const page = await openSignIn(viewport.width, viewport.height);
    try {
      await expect.poll(() => page.getByLabel('Email').count()).toBe(1);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

      const box = await page.getByRole('button', { name: 'Sign in' }).boundingBox();
      expect(box, 'the submit button must be on screen').not.toBeNull();
      expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});

describe('signing out', () => {
  it('is reachable from the authenticated view and returns to sign-in', async () => {
    const page = await openSignIn();
    try {
      await fillAndSubmit(page, account.email, account.password);
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });

      // Sign-out moved into the member navigation menu when the placeholder landing retired.
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.waitForURL(`${baseUrl}/sign-in`, { timeout: 30_000 });
      await expect.poll(() => page.getByLabel('Email').count()).toBe(1);

      // And the authenticated view is genuinely gone, not merely navigated away from.
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(`${baseUrl}/sign-in`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('keeps the session across a reload until it is ended', async () => {
    const page = await openSignIn();
    try {
      await fillAndSubmit(page, account.email, account.password);
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });

      await page.reload({ waitUntil: 'domcontentloaded' });
      // Scoped for the same reason as above. A reload empties the route announcer, so this one is
      // not racy today — but it is the same fragile shape, and the next soft navigation added ahead
      // of it would break it silently.
      await expect
        .poll(() => page.getByRole('heading', { level: 1 }).textContent())
        .toBe('Dashboard');

      // Visiting sign-in with a live session sends you on rather than asking again.
      await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 90_000);
});
