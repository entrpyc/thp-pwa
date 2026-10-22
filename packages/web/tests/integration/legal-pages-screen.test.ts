import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  PRIVACY_PAGE_PATH,
  ROLE,
  SUPPORT_EMAIL,
  SUPPORT_PAGE_PATH,
  TERMS_PAGE_PATH,
} from '@thp/shared';
import { POSTING_RULES } from '@/app/(public)/terms/posting-rules';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';

/**
 * **The three public documents, driven in a real browser** — the privacy policy, the terms and the
 * support page the app stores require.
 *
 * `public-document.test.ts` proves the component's markup against a stubbed session. What only
 * the running product can answer is what this file asks: that each page is actually served at its
 * path to somebody with no session, which is the store reviewer's position; that the same page
 * reached with a session is the same page, with its way back now leading into the app rather than
 * to the door; and that the links the stores will follow are on the sign-in screen, in the order
 * the list gives them.
 *
 * One file rather than three because the pages are one shape and the assertions are one list run
 * three times; a page that needs something the others do not gets its own `describe` below.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const PAGES = [
  { path: PRIVACY_PAGE_PATH, title: 'Privacy policy' },
  { path: TERMS_PAGE_PATH, title: 'Terms of use' },
  { path: SUPPORT_PAGE_PATH, title: 'Support' },
] as const;

/**
 * What the sign-in footer is expected to list, restated here rather than imported from
 * `legal-links.tsx`: the integration project has no JSX transform (only the unit project renders
 * components, and names the transform for it in vitest.config.ts), so a `.tsx` import fails to
 * parse before any test runs. The unit test pins `LEGAL_LINKS` to the same three entries; this
 * file pins what the browser shows.
 */
const LEGAL_LINKS = [
  { href: PRIVACY_PAGE_PATH, label: 'Privacy policy' },
  { href: TERMS_PAGE_PATH, label: 'Terms' },
  { href: SUPPORT_PAGE_PATH, label: 'Support' },
] as const;

let browser: Browser;
let account: TestAccount;

beforeAll(async () => {
  browser = await chromium.launch();
  account = await createAccount(databaseUrl, ROLE.member, 'legal');
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await closeTestDatabase();
});

async function signedOut(path: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function signedIn(path: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  return page;
}

/** The `href` of the one link reading "Back", resolved to a path. */
async function backLeadsTo(page: Page): Promise<string> {
  const href = await page.getByRole('link', { name: 'Back', exact: true }).getAttribute('href');
  return new URL(href ?? '', baseUrl).pathname;
}

describe.each(PAGES)('$path', ({ path, title }) => {
  it('renders for a reader with no session, dated, with the way back leading to sign-in', async () => {
    const page = await signedOut(path);
    try {
      await expect
        .poll(() => page.getByRole('heading', { level: 1 }).textContent(), { timeout: 30_000 })
        .toBe(title);
      expect(new URL(page.url()).pathname).toBe(path);
      expect(await page.locator('time[datetime]').count()).toBe(1);
      expect(await page.getByText('Last updated').count()).toBe(1);
      // Every section is a landmark with a heading, so a screen reader can walk them.
      expect(await page.getByRole('heading', { level: 2 }).count()).toBeGreaterThan(2);
      expect(await backLeadsTo(page)).toBe('/sign-in');
      // No horizontal overflow at a phone width: a document is read, not panned.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('renders the same page for a member with a session, with the way back leading into the app', async () => {
    const page = await signedIn(path);
    try {
      await expect
        .poll(() => page.getByRole('heading', { level: 1 }).textContent(), { timeout: 30_000 })
        .toBe(title);
      expect(new URL(page.url()).pathname).toBe(path);
      expect(await backLeadsTo(page)).toBe(DASHBOARD_PAGE_PATH);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});

describe('the links to them', () => {
  it('appear under the sign-in form, in the order the list gives them', async () => {
    const page = await signedOut('/sign-in');
    try {
      const legal = page.getByRole('navigation', { name: 'Legal' });
      await expect.poll(() => legal.count(), { timeout: 30_000 }).toBe(1);
      const links = legal.getByRole('link');
      expect(await links.count()).toBe(LEGAL_LINKS.length);
      for (const [index, link] of LEGAL_LINKS.entries()) {
        const anchor = links.nth(index);
        expect(await anchor.textContent()).toBe(link.label);
        expect(new URL((await anchor.getAttribute('href')) ?? '', baseUrl).pathname).toBe(link.href);
      }
      // Following one from the door lands on the page, and the page's way back leads to the door.
      await links.first().click();
      await page.waitForURL(`${baseUrl}${LEGAL_LINKS[0]!.href}`, { timeout: 30_000 });
      expect(await backLeadsTo(page)).toBe('/sign-in');
    } finally {
      await page.context().close();
    }
  }, 60_000);
});

describe('what each page has to carry', () => {
  it('the privacy policy names the contact address and the analytics opt-out', async () => {
    const page = await signedOut(PRIVACY_PAGE_PATH);
    try {
      await expect
        .poll(() => page.locator(`a[href="mailto:${SUPPORT_EMAIL}"]`).count(), { timeout: 30_000 })
        .toBeGreaterThan(0);
      expect(await page.getByRole('heading', { level: 2, name: 'Product analytics' }).count()).toBe(1);
      expect(await page.getByRole('heading', { level: 2, name: 'Deleting your account' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('the terms publish the posting rules the acceptance control will cite, verbatim and in order', async () => {
    const page = await signedOut(TERMS_PAGE_PATH);
    try {
      const rules = page.getByRole('heading', { level: 2, name: 'Posting rules' });
      await expect.poll(() => rules.count(), { timeout: 30_000 }).toBe(1);
      const items = page.locator('ol > li');
      expect(await items.allTextContents()).toEqual([...POSTING_RULES]);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('the support page carries the address and links to the other two', async () => {
    const page = await signedOut(SUPPORT_PAGE_PATH);
    try {
      await expect
        .poll(() => page.locator(`a[href="mailto:${SUPPORT_EMAIL}"]`).count(), { timeout: 30_000 })
        .toBeGreaterThan(0);
      const article = page.locator('article');
      expect(await article.locator(`a[href="${PRIVACY_PAGE_PATH}"]`).count()).toBeGreaterThan(0);
      expect(await article.locator(`a[href="${TERMS_PAGE_PATH}"]`).count()).toBeGreaterThan(0);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
