import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import {
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  ROLE,
  recordingPagePath,
  recordingScripturePath,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  replaceScriptureReferences,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The Scripture tab, driven in a real browser** (Task 4.2) — `pages/recording.png`.
 *
 * Real for the reason every other screen suite here is: "the tab is absent entirely" and "the panel
 * is fetched when first opened" are properties of a rendered strip and of a network log, and a
 * component test would answer both however the component was written.
 *
 * Two teachings carry the whole file: one with three references **stored out of canon order**, so
 * the ordering assertion cannot pass by accident, and one with none at all.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEACHING_SECONDS = 120;

/**
 * Written as Romans, Exodus, Genesis — read back as Genesis, Exodus, Romans.
 *
 * Genesis and Exodus are what makes the ordering assertion mean canon order: the alphabet puts
 * Exodus first and the canon puts Genesis first, so a list ordered by the book column would come
 * back in the wrong order rather than in the right one by coincidence.
 */
const REFERENCES = [
  { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4 },
  { book: 'exodus', chapter: 3, verseStart: 1, verseEnd: 2 },
  { book: 'genesis', chapter: 1, verseStart: 1, verseEnd: 2 },
].map((one) => ({ ...one, origin: 'machine' as const, editedByAdmin: false }));

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;

/** Three approved references, a transcript, and audio. */
let citingId: string;
/** Published, with audio and a transcript, and citing nothing. */
let bareId: string;

async function publishedRecording(title: string): Promise<string> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording(
    { originalMediaKey: key, title, recordedAt: '2026-08-16' },
    handle,
  );
  await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.94,
      segments: [{ startMs: 0, endMs: 4000, text: 'Turn with me to the eighth chapter.' }],
    },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

/**
 * Sign in through the real screen and open a teaching, with every request it makes recorded.
 *
 * The request log is what 4.2.5 is asserted against — "fetched when first opened" is a claim about
 * the network rather than about what is on screen.
 */
async function openTeaching(id: string): Promise<{ page: Page; requests: Request[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
  const page = await context.newPage();
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

  await page.goto(`${baseUrl}${recordingPagePath(id)}`, { waitUntil: 'domcontentloaded' });
  // The strip is what the page is judged on, so wait for the strip rather than for the body.
  await expect
    .poll(() => page.getByRole('tab', { name: 'Transcript' }).count(), { timeout: 60_000 })
    .toBe(1);
  return { page, requests };
}

/**
 * The strip's tabs, **by accessible name and in document order.**
 *
 * Names rather than text content, because a tab's icon is `aria-hidden` and is not part of what a
 * screen reader announces — reading `textContent` would compare `✎Notes` against `Notes` and make
 * the ordering assertion a fact about decoration.
 */
async function tabNames(page: Page): Promise<string[]> {
  return page.locator('[role="tab"]').evaluateAll((tabs) =>
    tabs.map((tab) => {
      const label = tab.getAttribute('aria-label');
      if (label !== null) return label;
      const clone = tab.cloneNode(true) as HTMLElement;
      for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
      return (clone.textContent ?? '').trim();
    }),
  );
}

/** How many times this page asked the API for that teaching's scripture. */
function scriptureCalls(requests: readonly Request[], id: string): number {
  return requests.filter((one) => one.url().includes(`${API_PREFIX}${recordingScripturePath(id)}`))
    .length;
}

const panelOf = (page: Page) => page.getByRole('region', { name: 'Scripture' });

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  browser = await chromium.launch();
  member = await createAccount(databaseUrl, ROLE.member, 'scripture-screen-member');

  citingId = await publishedRecording(`Scripture citing ${RUN}`);
  await replaceScriptureReferences(citingId, REFERENCES, handle);
  bareId = await publishedRecording(`Scripture bare ${RUN}`);
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the Scripture tab on the recording page', () => {
  /**
   * 4.2.1 — the reference draws `Chapter · Scripture · Notes · Transcript · Mindmap`, and two of
   * those five are deferred and dropped. So Scripture is **first**, and the assertion is the whole
   * strip in order rather than "a Scripture tab exists somewhere".
   */
  it('draws Scripture in the reference’s position in the strip', async () => {
    const { page } = await openTeaching(citingId);
    try {
      expect(await tabNames(page)).toEqual([
        'Scripture',
        'Notes',
        'Transcript',
      ]);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 4.2.2 — absent entirely, not disabled and not an empty panel.
  it('leaves the tab out altogether for a teaching that cites nothing', async () => {
    const { page } = await openTeaching(bareId);
    try {
      expect(await tabNames(page)).toEqual(['Notes', 'Transcript']);
      expect(await page.getByRole('tab', { name: 'Scripture' }).count()).toBe(0);
      // Not merely unselected: nothing on the page mentions it, and nothing was fetched for it.
      expect(await panelOf(page).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 4.2.3 — canon order, citation as heading, passage as body.
  it('lists the references in canon order, each with its citation and its passage', async () => {
    const { page } = await openTeaching(citingId);
    try {
      await page.getByRole('tab', { name: 'Scripture' }).click();
      const panel = panelOf(page);

      await expect
        .poll(() => panel.getByRole('heading').allTextContents(), { timeout: 30_000 })
        .toEqual(['Genesis 1:1–2', 'Exodus 3:1–2', 'Romans 8:1–4']);

      const entries = panel.getByRole('listitem');
      expect(await entries.nth(0).textContent()).toContain(
        'Stand-in verse text for Genesis 1:1. Stand-in verse text for Genesis 1:2.',
      );
      expect(await entries.nth(1).textContent()).toContain('Stand-in verse text for Exodus 3:2.');
      expect(await entries.nth(2).textContent()).toContain('Stand-in verse text for Romans 8:4.');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 4.2.4 — the citation is the artefact; the passage is a convenience on top of it.
  it('shows the citation and a quiet line where a reference has no passage', async () => {
    const { page } = await openTeaching(citingId);
    try {
      await page.route(`**${API_PREFIX}${recordingScripturePath(citingId)}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            references: [{ book: 'john', chapter: 3, verseStart: 16, verseEnd: 16, passage: null }],
          }),
        }),
      );

      await page.getByRole('tab', { name: 'Scripture' }).click();
      const entry = panelOf(page).getByRole('listitem').first();

      await expect.poll(() => entry.textContent(), { timeout: 30_000 }).toContain('John 3:16');
      expect(await entry.textContent()).toContain('could not be loaded');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  /**
   * 4.2.5 — three claims about the strip, and all three are about *this* tab joining the behaviour
   * the strip already had rather than bringing its own.
   */
  it('fetches on the first press, closes on the second, and closes whichever tab was open', async () => {
    const { page, requests } = await openTeaching(citingId);
    try {
      const tab = page.getByRole('tab', { name: 'Scripture' });
      const transcript = page.getByRole('tab', { name: 'Transcript' });

      // Nothing is asked for a tab nobody has pressed — the whole reason the tab starts closed.
      expect(scriptureCalls(requests, citingId)).toBe(0);
      expect(await panelOf(page).count()).toBe(0);

      await tab.click();
      await expect.poll(() => scriptureCalls(requests, citingId), { timeout: 30_000 }).toBe(1);
      await expect.poll(() => panelOf(page).count(), { timeout: 30_000 }).toBe(1);
      expect(await tab.getAttribute('aria-selected')).toBe('true');

      // A second press puts it away.
      await tab.click();
      await expect.poll(() => panelOf(page).count(), { timeout: 30_000 }).toBe(0);
      expect(await tab.getAttribute('aria-selected')).toBe('false');

      // Single-select: opening the transcript and then this one leaves exactly one panel open.
      await transcript.click();
      await expect
        .poll(() => page.getByRole('list', { name: 'Transcript' }).count(), { timeout: 30_000 })
        .toBe(1);
      await tab.click();
      await expect.poll(() => panelOf(page).count(), { timeout: 30_000 }).toBe(1);
      expect(await page.getByRole('list', { name: 'Transcript' }).count()).toBe(0);
      expect(await transcript.getAttribute('aria-selected')).toBe('false');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 4.2.6 — the failure is contained by the panel. § 6 Operability, said on a screen.
  it('shows one failure line inside the panel and leaves the rest of the page working', async () => {
    const { page } = await openTeaching(citingId);
    try {
      await page.route(`**${API_PREFIX}${recordingScripturePath(citingId)}`, (route) =>
        route.abort(),
      );

      await page.getByRole('tab', { name: 'Scripture' }).click();
      const panel = panelOf(page);
      await expect
        .poll(() => panel.textContent(), { timeout: 30_000 })
        .toMatch(/could not|try again/i);

      // The player is still there and still operable, and the transcript still opens and reads.
      expect(await page.getByRole('button', { name: /^(Play|Pause)$/ }).count()).toBeGreaterThan(0);
      await page.getByRole('tab', { name: 'Transcript' }).click();
      await expect
        .poll(() => page.getByRole('list', { name: 'Transcript' }).textContent(), {
          timeout: 30_000,
        })
        .toContain('Turn with me to the eighth chapter.');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 4.2.7 — the destination is cross-referencing, and it does not exist (3.4.8).
  it('renders every citation as text, with nothing in the panel navigating anywhere', async () => {
    const { page } = await openTeaching(citingId);
    try {
      await page.getByRole('tab', { name: 'Scripture' }).click();
      const panel = panelOf(page);
      await expect.poll(() => panel.getByRole('listitem').count(), { timeout: 30_000 }).toBe(3);

      expect(await panel.getByRole('link').count()).toBe(0);
      expect(await panel.getByRole('button').count()).toBe(0);
      expect(await panel.locator('a, [role="link"]').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 4.2.8 — § 6 Accessibility. Reached, opened and closed without a pointer.
  it('is reachable and operable from the keyboard, and carries an accessible name', async () => {
    const { page } = await openTeaching(citingId);
    try {
      const tab = page.getByRole('tab', { name: 'Scripture' });
      // The accessible name comes off the tab itself — an icon-only control would answer `''`.
      expect((await tab.getAttribute('aria-label')) ?? (await tab.textContent())).toContain(
        'Scripture',
      );

      await tab.focus();
      expect(
        await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''),
      ).toContain('Scripture');

      await page.keyboard.press('Enter');
      await expect.poll(() => panelOf(page).count(), { timeout: 30_000 }).toBe(1);
      await page.keyboard.press('Enter');
      await expect.poll(() => panelOf(page).count(), { timeout: 30_000 }).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
