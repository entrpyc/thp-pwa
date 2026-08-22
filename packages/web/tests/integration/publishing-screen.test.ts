import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { ADMIN_RECORDINGS_PAGE_PATH, ROLE } from '@thp/shared';
import {
  createDatabase,
  findRecordingById,
  findSummaryByRecording,
  insertRecording,
  publishSummary,
  setSummaryPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';

/**
 * **The publication controls on the recordings row**, driven in a real browser.
 *
 * There is no per-recording admin page in this epic — the recording page itself is Story 4 — so the
 * row carries the whole of publication: whether the teaching is live, the press that changes that,
 * and the summary's own gate beside it.
 *
 * Every assertion is against **what the press left in the database**, not against what the screen
 * said afterwards. A screen that renders "Live" is not the same claim as a recording a member can
 * read, and only the second one matters.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const PANEL_URL = `${baseUrl}${ADMIN_RECORDINGS_PAGE_PATH}`;

/** Phone, tablet, desktop — the responsive standing constraint of the implementation plan. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

const DESKTOP = { width: 1280, height: 900 };

let browser: Browser;
let admin: TestAccount;
let handle: DatabaseHandle;
let seeded = 0;

function unique(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function newRecording(title: string): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/publish-screen-${seeded}-${Date.now().toString(36)}.mp3`,
      title,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  return row.id;
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });

  const signedIn = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'publish-screen-admin');
  admin = signedIn.account;
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

/** Sign in through the real screen — never a forged cookie — and open the panel. */
async function openPanel(viewport: { width: number; height: number } = DESKTOP): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });

  await page.goto(PANEL_URL, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('region', { name: 'Recordings' }).count(), { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(() => page.getByText('Loading recordings…').count(), { timeout: 30_000 })
    .toBe(0);
  return page;
}

/** The one row for this recording, by the title nothing else in the run shares. */
function rowFor(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

async function publishedAt(recordingId: string): Promise<Date | null> {
  return (await findRecordingById(recordingId, handle))?.publishedAt ?? null;
}

// =================================================================================================

describe('the row says whether a teaching is live', () => {
  it('reads Not published until it is, and Live afterwards', async () => {
    const title = unique('Live or not');
    const recordingId = await newRecording(title);

    const page = await openPanel();
    try {
      const row = rowFor(page, title);
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
      expect((await row.textContent()) ?? '').toContain('Not published');

      await row.getByRole('button', { name: 'Publish' }).click();

      // The press is judged by what it wrote, not by what the chip then said.
      await expect.poll(() => publishedAt(recordingId), { timeout: 30_000 }).not.toBeNull();
      await expect
        .poll(async () => ((await row.textContent()) ?? '').includes('Live'), { timeout: 30_000 })
        .toBe(true);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('taking a teaching down', () => {
  it('takes a confirming press, and says what unpublishing does not do', async () => {
    const title = unique('Take me down');
    const recordingId = await newRecording(title);

    const page = await openPanel();
    try {
      const row = rowFor(page, title);
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
      await row.getByRole('button', { name: 'Publish' }).click();
      await expect.poll(() => publishedAt(recordingId), { timeout: 30_000 }).not.toBeNull();

      await row.getByRole('button', { name: 'Unpublish' }).click();

      // The direction that takes something away from people who may be part-way through it gets the
      // second press, and it names the fact an admin hesitating over the button actually needs.
      expect((await row.textContent()) ?? '').toContain('Nothing is deleted');
      expect(await publishedAt(recordingId)).not.toBeNull();

      await row.getByRole('button', { name: 'Yes, unpublish it' }).click();
      await expect.poll(() => publishedAt(recordingId), { timeout: 30_000 }).toBeNull();
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('the summary controls', () => {
  it('offers nothing where there is no summary a member can read', async () => {
    const title = unique('No summary at all');
    const recordingId = await newRecording(title);

    const page = await openPanel();
    try {
      const row = rowFor(page, title);
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
      await row.getByRole('button', { name: 'Publish' }).click();
      await expect.poll(() => publishedAt(recordingId), { timeout: 30_000 }).not.toBeNull();

      // A recording whose draft was discarded is still publishable and has no summary — offering a
      // control that would answer `not_found` would be the screen promising something.
      await expect
        .poll(async () => row.getByRole('button', { name: 'Edit summary' }).count(), {
          timeout: 30_000,
        })
        .toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('edits a live summary in place, and returns it to draft without taking the teaching down', async () => {
    const title = unique('Summary controls');
    const recordingId = await newRecording(title);
    await publishSummary(recordingId, 'The first wording.', handle);

    const page = await openPanel();
    try {
      const row = rowFor(page, title);
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
      await row.getByRole('button', { name: 'Publish' }).click();
      await expect.poll(() => publishedAt(recordingId), { timeout: 30_000 }).not.toBeNull();

      // Both gates open, so the controls appear.
      await expect
        .poll(() => row.getByRole('button', { name: 'Edit summary' }).count(), { timeout: 30_000 })
        .toBe(1);

      await row.getByRole('button', { name: 'Edit summary' }).click();
      await row.getByLabel('Summary').fill('The wording an admin preferred.');
      await row.getByRole('button', { name: 'Save summary' }).click();

      await expect
        .poll(async () => (await findSummaryByRecording(recordingId, handle))?.content, {
          timeout: 30_000,
        })
        .toBe('The wording an admin preferred.');
      // Editing is not re-publishing: the summary is still live and so is the teaching.
      expect((await findSummaryByRecording(recordingId, handle))?.publishedAt).not.toBeNull();

      await row.getByRole('button', { name: 'Summary to draft' }).click();

      await expect
        .poll(async () => (await findSummaryByRecording(recordingId, handle))?.publishedAt, {
          timeout: 30_000,
        })
        .toBeNull();
      // The text is retained and the teaching is still live — one write of `null`, and nothing else.
      expect((await findSummaryByRecording(recordingId, handle))?.content).toBe(
        'The wording an admin preferred.',
      );
      expect(await publishedAt(recordingId)).not.toBeNull();
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

describe('at every width', () => {
  for (const viewport of VIEWPORTS) {
    it(`keeps the publication controls reachable at ${viewport.label}`, async () => {
      const title = unique(`Publish width ${viewport.label}`);
      const recordingId = await newRecording(title);
      await publishSummary(recordingId, 'A summary.', handle);
      await setSummaryPublication(recordingId, true, handle);

      const page = await openPanel({ width: viewport.width, height: viewport.height });
      try {
        const row = rowFor(page, title);
        await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        );
        expect(overflow, `${viewport.label} overflows horizontally`).toBe(false);

        const publish = row.getByRole('button', { name: 'Publish' });
        await publish.scrollIntoViewIfNeeded();
        const box = await publish.boundingBox();
        expect(box, `${viewport.label} has no publish button`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);

        // And the way into the queue, which is this row's other job.
        expect(await row.getByRole('link', { name: 'Review drafts' }).count()).toBe(1);
      } finally {
        await page.context().close();
      }
    }, 120_000);
  }
});
