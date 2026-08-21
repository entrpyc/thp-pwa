import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import postgres from 'postgres';
import {
  API_PREFIX,
  FORGOT_PASSWORD_PAGE_PATH,
  MINIMUM_PASSWORD_LENGTH,
  PASSWORD_RESET_PATH,
  RESET_PASSWORD_PAGE_PATH,
  RESET_TOKEN_PARAM,
  ROLE,
} from '@thp/shared';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { mailOffset, waitForMail, type CapturedMail } from '../support/mail';

/**
 * The two reset screens, driven in a real browser.
 *
 * There is no `pages/forgot-password.png` or `pages/reset-password.png`; by operator decision they
 * are composed from the style guide, on step 2's token layer. What a PNG could not answer anyway is
 * what this file asks: whether a dead link shows a password field, whether either form submits
 * without reloading, whether they fit a phone, and whether they are operable by keyboard alone.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const mailPath = inject('mailCapturePath');

/** Phone, tablet, desktop — the responsive standing constraint of the implementation plan. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

const NEW_PASSWORD = 'chosen-in-the-browser-again';

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

function resetTokenFrom(message: CapturedMail): string {
  const link = /https?:\/\/\S+/.exec(message.text)?.[0];
  if (link === undefined) throw new Error('the plain-text part carries no link');
  const token = new URL(link).searchParams.get(RESET_TOKEN_PARAM);
  if (token === null || token === '') throw new Error(`no token in ${link}`);
  return token;
}

/** Ask over the API and pull the token out of the captured message, exactly as a person would. */
async function askForReset(label: string): Promise<{ account: TestAccount; token: string }> {
  const account = await createAccount(databaseUrl, ROLE.member, `screen-reset-${label}`);
  const offset = mailOffset(mailPath);
  const response = await fetch(`${baseUrl}${API_PREFIX}${PASSWORD_RESET_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email }),
  });
  if (response.status !== 200) throw new Error(`requesting answered ${response.status}`);

  const messages = await waitForMail(mailPath, offset, (found) => found.length > 0);
  const message = messages.at(-1);
  if (message === undefined) throw new Error(`no reset message captured for ${account.email}`);
  return { account, token: resetTokenFrom(message) };
}

async function open(path: string, width = 1280, height = 800): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function openReset(token: string, width = 1280, height = 800): Promise<Page> {
  const url = new URL(`${baseUrl}${RESET_PASSWORD_PAGE_PATH}`);
  url.searchParams.set(RESET_TOKEN_PARAM, token);
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  return page;
}

describe('the sign-in screen offers the way out', () => {
  it('links to the forgot-password screen, and the link lands there', async () => {
    // A reset flow nobody can reach from where they failed is a flow that does not exist.
    const page = await open('/sign-in');
    try {
      const link = page.getByRole('link', { name: /forgot/i });
      await expect.poll(() => link.count()).toBe(1);

      await link.click();
      await page.waitForURL(`${baseUrl}${FORGOT_PASSWORD_PAGE_PATH}`, { timeout: 30_000 });
      expect(await page.getByLabel('Email').count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 90_000);
});

describe('the forgot-password screen', () => {
  it('renders an email field and a submit', async () => {
    const page = await open(FORGOT_PASSWORD_PAGE_PATH);
    try {
      await expect.poll(() => page.getByLabel('Email').count()).toBe(1);
      expect(await page.getByRole('button', { name: /send me a link/i }).count()).toBe(1);
      expect(await page.getByRole('heading', { level: 1 }).textContent()).toMatch(/reset/i);
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('lands on the same neutral confirmation for a known and an unknown address', async () => {
    const account = await createAccount(databaseUrl, ROLE.member, 'screen-neutral');

    async function submit(email: string): Promise<{ heading: string; body: string }> {
      const page = await open(FORGOT_PASSWORD_PAGE_PATH);
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
          body: ((await page.textContent('body')) ?? '').replace(email, '(the address)'),
        };
      } finally {
        await page.context().close();
      }
    }

    const known = await submit(account.email);
    const unknown = await submit(`nobody-${Date.now().toString(36)}@example.test`);

    expect(unknown.heading).toBe(known.heading);
    expect(unknown.body).toBe(known.body);
    // And it reads as care rather than a shrug: it says what happens next and where to look.
    expect(known.body.toLowerCase()).toContain('spam');
    expect(known.body.toLowerCase()).toContain('hour');
  }, 120_000);

  it('is operable by keyboard alone, and the field has a programmatic label', async () => {
    const page = await open(FORGOT_PASSWORD_PAGE_PATH);
    try {
      await expect.poll(() => page.getByLabel('Email').count()).toBe(1);

      const labels = await page.evaluate(() =>
        [...document.querySelectorAll('input')].map(
          (input) => input.labels?.[0]?.textContent?.trim() ?? '',
        ),
      );
      expect(labels).toEqual(['Email']);

      await page.getByLabel('Email').focus();
      await page.keyboard.type('somebody@example.test');
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? '',
        type: document.activeElement?.getAttribute('type') ?? '',
      }));
      expect(focused.tag).toBe('BUTTON');
      expect(focused.type).toBe('submit');

      await page.keyboard.press('Enter');
      await expect
        .poll(
          async () => ((await page.getByRole('heading', { level: 1 }).textContent()) ?? '').trim(),
          { timeout: 20_000 },
        )
        .toMatch(/check your email/i);
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it.each(VIEWPORTS)('fits a $label viewport with no horizontal scroll', async (viewport) => {
    const page = await open(FORGOT_PASSWORD_PAGE_PATH, viewport.width, viewport.height);
    try {
      await expect.poll(() => page.getByLabel('Email').count()).toBe(1);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

      const box = await page.getByRole('button', { name: /send me a link/i }).boundingBox();
      expect(box, 'the submit button must be on screen').not.toBeNull();
      expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    } finally {
      await page.context().close();
    }
  }, 90_000);
});

describe('the reset-password screen', () => {
  it('shows the address as read-only context, a password field and a submit', async () => {
    const { account, token } = await askForReset('render');
    const page = await openReset(token);
    try {
      await expect.poll(() => page.getByLabel('New password').count()).toBe(1);

      const emailField = page.getByLabel('Email');
      expect(await emailField.inputValue()).toBe(account.email);
      // Context, not a question. It cannot be edited.
      expect(await emailField.getAttribute('readonly')).not.toBeNull();

      expect(await page.getByRole('button', { name: /set password/i }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('sets a new password and lands the person on an authenticated view, in one motion', async () => {
    const { account, token } = await askForReset('completes');
    const page = await openReset(token);
    try {
      await page.getByLabel('New password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: /set password/i }).click();

      // Straight to the authenticated landing. Never via the sign-in form.
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
      await expect.poll(() => page.getByText(account.email).count()).toBe(1);
      expect(new URL(page.url()).pathname).not.toBe('/sign-in');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('shows a rejected password on the screen without a full page reload', async () => {
    const { token } = await askForReset('weak');
    const page = await openReset(token);
    try {
      // A mark that only survives if the document is never replaced.
      await page.evaluate(() => {
        (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
      });

      await page.getByLabel('New password').fill('x'.repeat(MINIMUM_PASSWORD_LENGTH - 1));
      await page.getByRole('button', { name: /set password/i }).click();

      const error = page.locator('form').getByRole('alert');
      await expect
        .poll(async () => ((await error.textContent().catch(() => '')) ?? '').trim().length, {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);

      expect(new URL(page.url()).pathname).toBe(RESET_PASSWORD_PAGE_PATH);
      expect(
        await page.evaluate(
          () => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true,
        ),
      ).toBe(true);

      // And the link still works afterwards, so a bad guess is not fatal.
      await page.getByLabel('New password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: /set password/i }).click();
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('is operable by keyboard alone, and every field has a programmatic label', async () => {
    const { token } = await askForReset('keyboard');
    const page = await openReset(token);
    try {
      await expect.poll(() => page.getByLabel('New password').count()).toBe(1);

      const labels = await page.evaluate(() =>
        [...document.querySelectorAll('input')].map(
          (input) => input.labels?.[0]?.textContent?.trim() ?? '',
        ),
      );
      expect(labels).toEqual(['Email', 'New password']);

      await page.getByLabel('Email').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.type(NEW_PASSWORD);
      await page.keyboard.press('Tab');

      const focused = await page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? '',
        type: document.activeElement?.getAttribute('type') ?? '',
      }));
      expect(focused.tag).toBe('BUTTON');
      expect(focused.type).toBe('submit');

      await page.keyboard.press('Enter');
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it.each(VIEWPORTS)('fits a $label viewport with no horizontal scroll', async (viewport) => {
    const { token } = await askForReset(`viewport-${viewport.label}`);
    const page = await openReset(token, viewport.width, viewport.height);
    try {
      await expect.poll(() => page.getByLabel('New password').count()).toBe(1);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

      const box = await page.getByRole('button', { name: /set password/i }).boundingBox();
      expect(box, 'the submit button must be on screen').not.toBeNull();
      expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('a dead reset link is a dead end', () => {
  /** Every case asserts the same thing first: no password field. Nobody types into nothing. */
  async function deadEnd(page: Page): Promise<string> {
    await expect.poll(() => page.getByRole('heading', { level: 1 }).count()).toBe(1);
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    return ((await page.getByRole('heading', { level: 1 }).textContent()) ?? '').toLowerCase();
  }

  it('says the link expired, offers another from that screen, and shows no password field', async () => {
    const { account, token } = await askForReset('expired');
    await sql`update password_reset set expires_at = now() - interval '1 minute' where user_id = ${account.id}`;

    const page = await openReset(token);
    try {
      expect(await deadEnd(page)).toContain('expired');
      // "Ask for another" has to be *doable here*, not described. An hour-late link that tells you
      // to go and find the sign-in screen is a dead end with homework.
      const again = page.getByRole('link', { name: /another link/i });
      expect(await again.count()).toBe(1);
      await again.click();
      await page.waitForURL(`${baseUrl}${FORGOT_PASSWORD_PAGE_PATH}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('says the link is not valid after it has been used', async () => {
    const { token } = await askForReset('used');
    const first = await openReset(token);
    try {
      await first.getByLabel('New password').fill(NEW_PASSWORD);
      await first.getByRole('button', { name: /set password/i }).click();
      await first.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
    } finally {
      await first.context().close();
    }

    const second = await openReset(token);
    try {
      expect(await deadEnd(second)).not.toContain('expired');
    } finally {
      await second.context().close();
    }
  }, 150_000);

  it('says the link is not valid after it has been revoked', async () => {
    const { account, token } = await askForReset('revoked');
    await sql`update password_reset set revoked_at = now() where user_id = ${account.id}`;

    const page = await openReset(token);
    try {
      expect(await deadEnd(page)).not.toContain('expired');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('says the link is not valid for a token nobody was ever sent', async () => {
    const page = await openReset('this-token-was-never-issued');
    try {
      const heading = await deadEnd(page);
      expect(heading.length).toBeGreaterThan(0);
      expect(await page.getByRole('link', { name: /another link/i }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('explains a deactivated account rather than leaving somebody guessing', async () => {
    const { account, token } = await askForReset('deactivated');
    await sql`update "user" set deactivated_at = now() where id = ${account.id}`;

    const page = await openReset(token);
    try {
      expect(await deadEnd(page)).toContain('no longer active');
      // Being deactivated is explained, not stonewalled: it says who to ask.
      expect(((await page.textContent('body')) ?? '').toLowerCase()).toContain('admin');
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
