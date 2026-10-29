import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { API_PREFIX, SIGN_UP_PAGE_PATH, SUPPORT_EMAIL, isApiErrorBody } from '@thp/shared';

/**
 * The closed sign-up screen, driven in a real browser.
 *
 * Registration was withdrawn so that only people the group already knows can sign in: the screen
 * at `/sign-up` is a message rather than a form, and the route that created accounts is gone. This
 * file pins both halves — that the page says who to ask and offers the way back to sign-in, and
 * that nothing on the server will register an account however it is asked.
 */

const baseUrl = inject('apiBaseUrl');

/** Phone, tablet, desktop — the responsive standing constraint of the implementation plan. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function openSignUp(width = 1280, height = 800): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}${SIGN_UP_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
  return page;
}

describe('the sign-up screen', () => {
  it('says registration is closed, who to ask, and where to write', async () => {
    const page = await openSignUp();
    try {
      await expect
        .poll(() => page.getByRole('heading', { level: 1 }).textContent())
        .toContain('Registration is closed');
      expect(await page.getByText('ask someone from the group', { exact: false }).count()).toBe(1);
      expect(await page.getByRole('link', { name: SUPPORT_EMAIL }).getAttribute('href')).toBe(
        `mailto:${SUPPORT_EMAIL}`,
      );
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('offers no form: nothing to type into and nothing to submit', async () => {
    const page = await openSignUp();
    try {
      await expect.poll(() => page.getByRole('heading', { level: 1 }).count()).toBe(1);
      expect(await page.locator('form').count()).toBe(0);
      expect(await page.locator('input').count()).toBe(0);
      expect(await page.getByRole('button').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('is reachable from sign-in, and offers the way back', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('link', { name: /get access/i }).click();
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
      await expect.poll(() => page.getByRole('heading', { level: 1 }).count()).toBe(1);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});

describe('the registration route', () => {
  it('no longer exists, however it is asked', async () => {
    // The old path, with a body that would once have created an account. Not a refusal from a
    // closed route — no route at all, so there is nothing to probe, rate-limit or re-enable by
    // configuration. The catch-all answers an anonymous caller the way it answers every path no
    // route claims: `unauthenticated`, before saying whether anything is there.
    const response = await fetch(`${baseUrl}${API_PREFIX}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        email: `closed-${Date.now().toString(36)}@example.test`,
        password: 'a-perfectly-good-passphrase',
        termsVersion: '2026-01-01',
      }),
    });
    expect([401, 404]).toContain(response.status);
    expect(response.headers.get('set-cookie')).toBeNull();
    const body: unknown = await response.json().catch(() => undefined);
    expect(isApiErrorBody(body) ? body.error.code : null).not.toBe('rate_limited');
    expect(JSON.stringify(body ?? null)).not.toContain('"user"');
  });
});
