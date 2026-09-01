import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  FEEDBACK_PAGE_PATH,
  MAX_FEEDBACK_TITLE_LENGTH,
  ROLE,
  feedbackKindLabel,
} from '@thp/shared';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { mailOffset, waitForMail, type CapturedMail } from '../support/mail';

/**
 * **The report screen, driven in a real browser.**
 *
 * The API's half is `feedback.test.ts`; what a fetch cannot answer is what this file asks. Whether
 * the menu entry actually reaches the form. Whether the toggle changes what is sent rather than only
 * what is highlighted. Whether a member who has just been refused still has their paragraph. Whether
 * the form submits without reloading the page, fits a phone, and can be filled in by keyboard alone.
 *
 * Every assertion here ends at the captured message, because the message is the only record a report
 * leaves — there is no row to read back and no screen that lists what was sent.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const mailPath = inject('mailCapturePath');

/** Phone, tablet, desktop — the responsive standing constraint. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

const DESKTOP = { width: 1280, height: 800 };

let browser: Browser;
let member: TestAccount;

beforeAll(async () => {
  browser = await chromium.launch();
  member = await createAccount(databaseUrl, ROLE.member, 'feedback-screen');
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await closeTestDatabase();
});

async function signInAs(
  account: TestAccount,
  viewport: { width: number; height: number } = DESKTOP,
): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return page;
}

/** Signed in, and on the form — by whichever route the test is not itself about. */
async function onTheForm(viewport: { width: number; height: number } = DESKTOP): Promise<Page> {
  const page = await signInAs(member, viewport);
  await page.goto(`${baseUrl}${FEEDBACK_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('button', { name: 'Send report' }).count(), { timeout: 30_000 })
    .toBe(1);
  return page;
}

/** The one message this title produced. */
async function sentWith(offset: number, title: string): Promise<CapturedMail> {
  const messages = await waitForMail(mailPath, offset, (all) =>
    all.some((one) => one.subject.includes(title)),
  );
  const found = messages.find((one) => one.subject.includes(title));
  if (found === undefined) throw new Error(`no message carrying "${title}" was captured`);
  return found;
}

function uniqueTitle(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

describe('getting to the form', () => {
  it('is reached from the navigation menu, on every screen', async () => {
    const page = await signInAs(member);
    try {
      // From the dashboard, which is where a member lands — but the menu is the same control on
      // every screen, which is the whole reason the entry is in it rather than on a page.
      await page.getByRole('button', { name: 'Menu' }).click();
      await page
        .getByRole('list', { name: 'Navigation' })
        .getByRole('link', { name: 'Report a bug' })
        .click();
      await page.waitForURL(`${baseUrl}${FEEDBACK_PAGE_PATH}`, { timeout: 30_000 });

      await expect
        .poll(
          () =>
            page
              .getByRole('heading', { level: 1, name: 'Report a bug or send feedback' })
              .count(),
          { timeout: 30_000 },
        )
        .toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('sends an anonymous visitor to sign in rather than showing them the form', async () => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}${FEEDBACK_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(`${baseUrl}/sign-in`, { timeout: 30_000 });
      expect(await page.getByRole('button', { name: 'Send report' }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 120_000);
});

describe('sending a report', () => {
  it('sends what was typed and confirms it without a reload', async () => {
    const page = await onTheForm();
    try {
      const title = uniqueTitle('the transport bar overlaps the last row');
      const offset = mailOffset(mailPath);

      // A marker the browser sets and a full page load would destroy — the form has to submit in
      // place, or the confirmation below is a new document rather than a new state.
      await page.evaluate(() => {
        (window as unknown as { didNotReload?: boolean }).didNotReload = true;
      });

      await page.getByLabel('Title').fill(title);
      await page
        .getByLabel('Description')
        .fill('On a phone, the last recording in the list sits underneath the player.');
      await page.getByRole('button', { name: 'Send report' }).click();

      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: 'Thank you' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(
        await page.evaluate(
          () => (window as unknown as { didNotReload?: boolean }).didNotReload === true,
        ),
      ).toBe(true);

      const message = await sentWith(offset, title);
      expect(message.subject).toBe(`${feedbackKindLabel('bug')}: ${title}`);
      expect(message.text).toContain('the last recording in the list sits underneath the player');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('sends what the toggle says, not what it defaults to', async () => {
    const page = await onTheForm();
    try {
      const title = uniqueTitle('group the library by series');
      const offset = mailOffset(mailPath);

      // The default is a bug report, because a member who has come here through *Report a bug* is
      // most likely reporting one. Pressing the other option has to change what is sent.
      const bug = page.getByRole('button', { name: feedbackKindLabel('bug') });
      const feedback = page.getByRole('button', { name: feedbackKindLabel('feedback') });
      expect(await bug.getAttribute('aria-pressed')).toBe('true');

      await feedback.click();
      expect(await feedback.getAttribute('aria-pressed')).toBe('true');
      expect(await bug.getAttribute('aria-pressed')).toBe('false');

      await page.getByLabel('Title').fill(title);
      await page.getByLabel('Description').fill('It would read better as studies than as a list.');
      await page.getByRole('button', { name: 'Send report' }).click();

      const message = await sentWith(offset, title);
      expect(message.subject).toBe(`${feedbackKindLabel('feedback')}: ${title}`);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('will not submit until both fields have something in them', async () => {
    const page = await onTheForm();
    try {
      const submit = page.getByRole('button', { name: 'Send report' });
      expect(await submit.isDisabled()).toBe(true);

      // Whitespace is not something. The API measures the trimmed text, and so does this.
      await page.getByLabel('Title').fill('   ');
      await page.getByLabel('Description').fill('   ');
      expect(await submit.isDisabled()).toBe(true);

      await page.getByLabel('Title').fill('a real title');
      expect(await submit.isDisabled()).toBe(true);

      await page.getByLabel('Description').fill('a real description');
      expect(await submit.isDisabled()).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('keeps the text when the send is refused', async () => {
    const page = await onTheForm();
    try {
      const description = 'Half an hour of typing that must not be thrown away.';

      await page.getByLabel('Title').fill('a title that will not arrive');
      await page.getByLabel('Description').fill(description);

      // The one refusal a browser can cause on demand: the request never reaches the server. What
      // is being checked is not the sentence, it is that the paragraph is still in the box.
      await page.route('**/api/v1/feedback', (route) => route.abort());
      await page.getByRole('button', { name: 'Send report' }).click();

      await expect
        .poll(() => page.getByRole('alert').count(), { timeout: 30_000 })
        .toBeGreaterThan(0);
      expect(await page.getByLabel('Description').inputValue()).toBe(description);
      expect(await page.getByLabel('Title').inputValue()).toBe('a title that will not arrive');
      // Still sendable — a refusal costs a press, not a paragraph.
      expect(await page.getByRole('button', { name: 'Send report' }).isDisabled()).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('offers a way to send another, on an empty form', async () => {
    const page = await onTheForm();
    try {
      const title = uniqueTitle('the first of two');
      await page.getByLabel('Title').fill(title);
      await page.getByLabel('Description').fill('The first report.');
      await page.getByRole('button', { name: 'Send report' }).click();

      await expect
        .poll(() => page.getByRole('button', { name: 'Send another' }).count(), { timeout: 30_000 })
        .toBe(1);
      await page.getByRole('button', { name: 'Send another' }).click();

      await expect
        .poll(() => page.getByRole('button', { name: 'Send report' }).count(), { timeout: 30_000 })
        .toBe(1);
      // Empty, not holding the report that was just sent — a second copy of something already in
      // somebody's inbox is how a report gets sent twice.
      expect(await page.getByLabel('Title').inputValue()).toBe('');
      expect(await page.getByLabel('Description').inputValue()).toBe('');
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

describe('the shape of the screen', () => {
  it.each(VIEWPORTS)('fits a $label without scrolling sideways', async (viewport) => {
    const page = await onTheForm({ width: viewport.width, height: viewport.height });
    try {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('can be filled in and sent by keyboard alone', async () => {
    const page = await onTheForm();
    try {
      const title = uniqueTitle('sent without a mouse');
      const offset = mailOffset(mailPath);

      await page.getByLabel('Title').focus();
      await page.keyboard.type(title);
      await page.keyboard.press('Tab');
      await page.keyboard.type('Typed with the keyboard and sent with the keyboard.');

      // Tab to the submit and press it. The count is small because the form is small; if it grows,
      // this failing is the right way to find out.
      for (let press = 0; press < 6; press += 1) {
        const onSubmit = await page.evaluate(
          () => document.activeElement?.textContent?.trim() === 'Send report',
        );
        if (onSubmit) break;
        await page.keyboard.press('Tab');
      }
      expect(
        await page.evaluate(() => document.activeElement?.textContent?.trim()),
      ).toBe('Send report');
      await page.keyboard.press('Enter');

      const message = await sentWith(offset, title);
      expect(message.text).toContain('Typed with the keyboard');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('stops a title at the ceiling rather than letting one be typed past it', async () => {
    const page = await onTheForm();
    try {
      await page.getByLabel('Title').fill('x'.repeat(MAX_FEEDBACK_TITLE_LENGTH + 50));
      const typed = await page.getByLabel('Title').inputValue();
      expect(typed.length).toBe(MAX_FEEDBACK_TITLE_LENGTH);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
