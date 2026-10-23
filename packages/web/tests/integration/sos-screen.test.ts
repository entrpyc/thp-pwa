import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { DASHBOARD_PAGE_PATH, ROLE, SOS_NEW_PAGE_PATH, SOS_PAGE_PATH } from '@thp/shared';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';

/**
 * **The SOS channel, driven in a real browser** ([3.16](docs/project/prd.md)). The API's half is
 * `sos.test.ts`; this file asks what a fetch cannot: whether the home card is the way in, whether
 * the form raises a signal and lands on its page, whether Praying and a reply work from the page,
 * whether the author can close it with a note, and whether the board then lists it under Resolved.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let browser: Browser;
let author: TestAccount;
let friend: TestAccount;

async function signInAs(who: TestAccount): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return page;
}

beforeAll(async () => {
  browser = await chromium.launch();
  author = await createAccount(databaseUrl, ROLE.member, `sos-screen-author-${RUN}`);
  friend = await createAccount(databaseUrl, ROLE.member, `sos-screen-friend-${RUN}`);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await closeTestDatabase();
});

describe('from the home card to a resolved signal', () => {
  it('raises from the form, is prayed for and replied to by a friend, and is closed with a note', async () => {
    const description = `Screen test ${RUN}: please pray for a hard week.`;

    // The author: the card, the form, the signal page.
    const page = await signInAs(author);
    try {
      const card = page.getByRole('region', { name: 'Prayer requests' });
      await expect.poll(() => card.count(), { timeout: 60_000 }).toBe(1);
      await card.getByRole('link', { name: 'Raise a prayer request' }).click();
      await page.waitForURL(`${baseUrl}${SOS_NEW_PAGE_PATH}`, { timeout: 30_000 });

      await page.getByRole('button', { name: 'Orange' }).click();
      await page.getByLabel('What prayer is needed').fill(description);
      await page.getByRole('button', { name: 'Raise' }).click();
      await page.waitForURL(new RegExp(`${SOS_PAGE_PATH}/[0-9a-f-]{36}$`), { timeout: 30_000 });

      await expect
        .poll(() => page.getByRole('heading', { name: 'Orange prayer request' }).count(), { timeout: 30_000 })
        .toBe(1);
      expect(await page.getByText(description).count()).toBe(1);
      expect(await page.getByText('Open', { exact: true }).count()).toBe(1);
    } finally {
      await page.context().close();
    }

    // The friend: the board lists it; Praying and a reply from its page.
    const theirs = await signInAs(friend);
    let signalUrl = '';
    try {
      await theirs.goto(`${baseUrl}${SOS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const row = theirs.getByRole('link').filter({ hasText: description });
      await expect.poll(() => row.count(), { timeout: 60_000 }).toBe(1);
      await row.click();
      await theirs.waitForURL(new RegExp(`${SOS_PAGE_PATH}/[0-9a-f-]{36}$`), { timeout: 30_000 });
      signalUrl = theirs.url();

      const praying = theirs.getByRole('button', { name: /praying/i });
      await expect.poll(() => praying.count(), { timeout: 30_000 }).toBe(1);
      await praying.click();
      await expect.poll(() => praying.getAttribute('aria-pressed'), { timeout: 30_000 }).toBe('true');
      await expect.poll(() => theirs.getByText('1 member praying').count(), { timeout: 30_000 }).toBe(1);

      await theirs.getByLabel('A word of encouragement or scripture').fill(`Standing with you ${RUN}`);
      await theirs.getByRole('button', { name: 'Reply', exact: true }).click();
      await expect
        .poll(() => theirs.getByText(`Standing with you ${RUN}`).count(), { timeout: 30_000 })
        .toBe(1);
      // No Close for somebody else's signal, and no Remove for a member.
      expect(await theirs.getByRole('button', { name: 'Close this prayer request' }).count()).toBe(0);
      expect(await theirs.getByRole('button', { name: 'Remove prayer request' }).count()).toBe(0);
    } finally {
      await theirs.context().close();
    }

    // The author again: the reply and the count are there; close with a note; the board agrees.
    const back = await signInAs(author);
    try {
      await back.goto(signalUrl, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => back.getByText(`Standing with you ${RUN}`).count(), { timeout: 60_000 })
        .toBe(1);
      expect(await back.getByText(friend.displayName).count()).toBeGreaterThan(0);

      await back.getByRole('button', { name: 'Close this prayer request' }).click();
      await back.getByLabel('Closing note (optional)').fill(`Resolved, thank you ${RUN}`);
      await back.getByRole('button', { name: 'Mark as resolved' }).click();
      await expect
        .poll(() => back.getByText(`Resolved, thank you ${RUN}`).count(), { timeout: 30_000 })
        .toBe(1);
      // The badge beside the heading flips from Open to Resolved with the same answer.
      await expect
        .poll(() => back.getByText('Open', { exact: true }).count(), { timeout: 30_000 })
        .toBe(0);
      expect(await back.getByText('Resolved', { exact: true }).count()).toBeGreaterThan(0);

      await back.goto(`${baseUrl}${SOS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => back.getByRole('tab', { name: 'Open' }).count(), { timeout: 60_000 }).toBe(1);
      // Not under Open any more…
      await expect
        .poll(() => back.getByRole('link').filter({ hasText: description }).count(), { timeout: 30_000 })
        .toBe(0);
      // …and listed under Resolved.
      await back.getByRole('tab', { name: 'Resolved' }).click();
      await expect
        .poll(() => back.getByRole('link').filter({ hasText: description }).count(), { timeout: 30_000 })
        .toBe(1);
    } finally {
      await back.context().close();
    }
  }, 240_000);
});
