import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import postgres from 'postgres';
import {
  ACCEPT_INVITATION_PAGE_PATH,
  API_PREFIX,
  INVITATIONS_PATH,
  INVITATION_TOKEN_PARAM,
  MINIMUM_PASSWORD_LENGTH,
  NEW_USER_ONBOARDING_ID,
  ROLE,
  onboardingPagePath,
  type InvitationSummary,
} from '@thp/shared';
import { closeTestDatabase, signedInAccount } from '../support/accounts';
import { mailOffset, tokenFromMail, waitForMail } from '../support/mail';

/**
 * The accept-invitation screen, driven in a real browser.
 *
 * There is no `pages/accept-invitation.png`; by operator decision it is composed from the style
 * guide, on ticket 2's token layer. What a PNG cannot answer anyway is what this file asks: whether a
 * dead invitation shows a password field, whether the form submits without reloading, whether it
 * fits a phone, and whether it is operable by keyboard alone.
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

const CHOSEN_PASSWORD = 'chosen-in-the-browser';

let browser: Browser;
let adminCookie: string;
let sql: postgres.Sql;

beforeAll(async () => {
  browser = await chromium.launch();
  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'screen-inviter')).cookie;
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

function uniqueEmail(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}@example.test`;
}

/** Issue over the API and pull the token out of the captured message, exactly as an invitee would. */
async function invite(label: string): Promise<{ email: string; token: string; id: string }> {
  const email = uniqueEmail(label);
  const offset = mailOffset(mailPath);
  const response = await fetch(`${baseUrl}${API_PREFIX}${INVITATIONS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ email, role: ROLE.member }),
  });
  if (response.status !== 201) throw new Error(`issuing ${email} answered ${response.status}`);
  const invitation = (await response.json()) as InvitationSummary;

  const messages = await waitForMail(mailPath, offset, (found) => found.length > 0);
  const message = messages.at(-1);
  if (message === undefined) throw new Error(`no message captured for ${email}`);
  return { email, token: tokenFromMail(message), id: invitation.id };
}

async function openAccept(token: string, width = 1280, height = 800): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const url = new URL(`${baseUrl}${ACCEPT_INVITATION_PAGE_PATH}`);
  url.searchParams.set(INVITATION_TOKEN_PARAM, token);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  return page;
}

describe('the accept-invitation screen', () => {
  it('shows the invited address as context, a password field and a submit', async () => {
    const { email, token } = await invite('screen-render');
    const page = await openAccept(token);
    try {
      await expect.poll(() => page.getByLabel('Password').count()).toBe(1);

      const emailField = page.getByLabel('Email');
      expect(await emailField.inputValue()).toBe(email);
      // Context, not a question. It cannot be edited.
      expect(await emailField.getAttribute('readonly')).not.toBeNull();

      expect(await page.getByRole('button', { name: /set password/i }).count()).toBe(1);
      expect(await page.getByRole('heading', { level: 1 }).textContent()).toContain('password');
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('prints the password rule before anybody can fail it', async () => {
    const { token } = await invite('screen-rule');
    const page = await openAccept(token);
    try {
      // Visible on load, not after a refusal — the difference between a rule and an exam. Read off
      // the element the field points at, so matching the number somewhere else on the page (an
      // address, a heading) cannot stand in for the rule being shown.
      const describedBy = await page.getByLabel('Password').getAttribute('aria-describedby');
      expect(describedBy, 'the password field must point at its rule').not.toBeNull();

      const ruleText = (
        await page.locator(`#${(describedBy ?? '').split(' ')[0] ?? ''}`).textContent()
      )?.trim();
      expect(ruleText).toContain(String(MINIMUM_PASSWORD_LENGTH));
      expect(ruleText?.toLowerCase()).toContain('characters');

      // And nothing has been refused yet — the rule is not a rendered error.
      expect(await page.locator('form').getByRole('alert').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('sets a password and lands the person, signed in, in the new-user tour', async () => {
    const { email, token } = await invite('screen-accept');
    const page = await openAccept(token);
    try {
      await page.getByLabel('Password').fill(CHOSEN_PASSWORD);
      await page.getByRole('button', { name: /set password/i }).click();

      // Straight to an authenticated view, never via the sign-in form — and for an account this
      // new, that view is the tour: the member layout routes an account that has never finished
      // the new-user onboarding into it before the dashboard renders.
      await page.waitForURL(`${baseUrl}${onboardingPagePath(NEW_USER_ONBOARDING_ID)}`, {
        timeout: 30_000,
      });
      await expect
        .poll(() => page.getByRole('button', { name: 'Skip' }).count(), { timeout: 30_000 })
        .toBe(1);
      expect(new URL(page.url()).pathname).not.toBe('/sign-in');
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('shows a rejected password on the screen without a full page reload', async () => {
    const { token } = await invite('screen-weak');
    const page = await openAccept(token);
    try {
      // A mark that only survives if the document is never replaced.
      await page.evaluate(() => {
        (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
      });

      await page.getByLabel('Password').fill('short');
      await page.getByRole('button', { name: /set password/i }).click();

      const error = page.locator('form').getByRole('alert');
      await expect
        .poll(async () => ((await error.textContent().catch(() => '')) ?? '').trim().length, {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);

      // What was typed survives being refused, and the page never reloaded.
      expect(await page.getByLabel('Password').inputValue()).toBe('short');
      expect(new URL(page.url()).pathname).toBe(ACCEPT_INVITATION_PAGE_PATH);
      expect(
        await page.evaluate(
          () => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true,
        ),
      ).toBe(true);

      // And the invitation still works afterwards, so a bad guess is not fatal.
      await page.getByLabel('Password').fill(CHOSEN_PASSWORD);
      await page.getByRole('button', { name: /set password/i }).click();
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('is operable by keyboard alone, and every field has a programmatic label', async () => {
    const { token } = await invite('screen-keyboard');
    const page = await openAccept(token);
    try {
      await expect.poll(() => page.getByLabel('Password').count()).toBe(1);

      // Names come from real labels, not placeholders.
      const labels = await page.evaluate(() =>
        [...document.querySelectorAll('input')].map(
          (input) => input.labels?.[0]?.textContent?.trim() ?? '',
        ),
      );
      expect(labels).toEqual(['Email', 'Password']);

      // Tabbed into, not focused programmatically: the claim is that the tab order reaches the
      // password field and then the submit, which focusing directly would not exercise.
      await page.getByLabel('Email').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.type(CHOSEN_PASSWORD);
      await page.keyboard.press('Tab');

      const focused = await page.evaluate(() => {
        const element = document.activeElement;
        return { tag: element?.tagName ?? '', type: element?.getAttribute('type') ?? '' };
      });
      expect(focused.tag).toBe('BUTTON');
      expect(focused.type).toBe('submit');

      await page.keyboard.press('Enter');
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it.each(VIEWPORTS)('fits a $label viewport with no horizontal scroll', async (viewport) => {
    const { token } = await invite(`screen-${viewport.label}`);
    const page = await openAccept(token, viewport.width, viewport.height);
    try {
      await expect.poll(() => page.getByLabel('Password').count()).toBe(1);
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
  }, 90_000);
});

describe('a dead invitation is a dead end', () => {
  it('says the invitation expired, and offers no password field', async () => {
    const { token, id } = await invite('screen-expired');
    await sql`update invitation set expires_at = now() - interval '1 hour' where id = ${id}`;

    const page = await openAccept(token);
    try {
      await expect.poll(() => page.getByRole('heading', { level: 1 }).count()).toBe(1);
      const heading = (await page.getByRole('heading', { level: 1 }).textContent()) ?? '';
      expect(heading.toLowerCase()).toContain('expired');

      // Nobody types a password into nothing.
      expect(await page.locator('input[type="password"]').count()).toBe(0);
      // And it says what to do next rather than that something is wrong.
      expect((await page.textContent('body')) ?? '').toMatch(/admin/i);
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('says the link is not valid after it has been revoked, and offers no password field', async () => {
    const { token, id } = await invite('screen-revoked');
    const revoked = await fetch(`${baseUrl}${API_PREFIX}${INVITATIONS_PATH}/${id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(revoked.status).toBe(200);

    const page = await openAccept(token);
    try {
      await expect.poll(() => page.getByRole('heading', { level: 1 }).count()).toBe(1);
      const heading = (await page.getByRole('heading', { level: 1 }).textContent()) ?? '';
      expect(heading.toLowerCase()).not.toContain('expired');
      expect(await page.locator('input[type="password"]').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('says the link is not valid for a token nobody was ever sent', async () => {
    const page = await openAccept('this-token-was-never-issued');
    try {
      await expect.poll(() => page.getByRole('heading', { level: 1 }).count()).toBe(1);
      expect(await page.locator('input[type="password"]').count()).toBe(0);
      expect((await page.textContent('body')) ?? '').toMatch(/admin/i);
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('is a dead end after the invitation has already been accepted', async () => {
    const { token } = await invite('screen-used');
    const page = await openAccept(token);
    try {
      await page.getByLabel('Password').fill(CHOSEN_PASSWORD);
      await page.getByRole('button', { name: /set password/i }).click();
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }

    // The same link, opened again — by whoever else has the email.
    const second = await openAccept(token);
    try {
      await expect.poll(() => second.getByRole('heading', { level: 1 }).count()).toBe(1);
      expect(await second.locator('input[type="password"]').count()).toBe(0);
    } finally {
      await second.context().close();
    }
  }, 120_000);
});
