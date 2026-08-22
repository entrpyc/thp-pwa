import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import postgres from 'postgres';
import {
  ADMIN_PAGE_PATH,
  ADMIN_RECORDINGS_PAGE_PATH,
  ADMIN_REVIEWS_PAGE_PATH,
  REVIEW_FIELD,
  REVIEW_KINDS,
  REVIEW_RECORDING_PARAM,
  ROLE,
  type ReviewKind,
} from '@thp/shared';
import {
  createDatabase,
  findRecordingById,
  findSummaryByRecording,
  insertRecording,
  replaceOpenDrafts,
  replaceTranscript,
  type DatabaseHandle,
  type ReviewItemRow,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';

/**
 * The Pending Reviews panel, driven in a real browser against the same production build the API
 * suite uses, over the same real tables.
 *
 * The assertions divide in four:
 *
 * 1. **That it is a panel of the console**, reachable from the panel list and refused to a member —
 *    the same two properties every admin screen has to hold.
 * 2. **What the queue says.** Both kinds together, newest recording first, and the recording each
 *    item is about.
 * 3. **What the form shows and what pressing it does.** The draft in full beside the title, the
 *    date and the word count (docs/project/prd.md, 3.6.5), and the four things an admin can do to
 *    a draft — each asserted by what it left in the database rather than by what the screen said
 *    afterwards.
 * 4. **That it is reachable from the recordings row as well as from the queue**
 *    (docs/project/prd.md, 3.6.4) — which is what a per-recording admin page would otherwise have
 *    been for.
 *
 * Rows are seeded through `@thp/db` rather than by running the worker: what is under test is the
 * screen over the gate, and driving a provider call for each case would be testing Ticket 01 again.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const PANEL_URL = `${baseUrl}${ADMIN_REVIEWS_PAGE_PATH}`;
const CONSOLE_URL = `${baseUrl}${ADMIN_PAGE_PATH}`;
const RECORDINGS_URL = `${baseUrl}${ADMIN_RECORDINGS_PAGE_PATH}`;

/** Phone, tablet, desktop — the responsive standing constraint of the implementation plan. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

const DESKTOP = { width: 1280, height: 900 };

let browser: Browser;
let admin: TestAccount;
let member: TestAccount;
let handle: DatabaseHandle;
let sql: postgres.Sql;
let seeded = 0;

function unique(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const MACHINE = {
  summary:
    'The teaching stays with the second chapter of the letter throughout, and opens by naming ' +
    'where last week left off.',
  recording_metadata: 'A close reading of the letter’s second chapter.',
} as const;

/** A recording with a transcript, so the queue's word count has something to count. */
async function newRecording(title: string, recordedAt = '2026-08-16'): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/review-screen-${seeded}-${Date.now().toString(36)}.mp3`,
      title,
      recordedAt,
    },
    handle,
  );
  await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.94,
      segments: [
        { startMs: 0, endMs: 4000, text: 'Good morning and welcome to this teaching.' },
        { startMs: 4000, endMs: 8000, text: 'We are picking up in the second chapter.' },
      ],
    },
    handle,
  );
  return row.id;
}

async function drafts(recordingId: string, kinds: readonly ReviewKind[]): Promise<ReviewItemRow[]> {
  return replaceOpenDrafts(
    recordingId,
    kinds.map((kind) => ({
      kind,
      fields: { [REVIEW_FIELD[kind]]: MACHINE[kind] },
      provenance: {
        model: 'fake',
        modelVersion: 'fake-1',
        promptVersion: 'draft-1',
        steeringPrompt: null,
        fields: { [REVIEW_FIELD[kind]]: { aiSuggested: true, editedByAdmin: false } },
      },
    })),
    handle,
  );
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await sql<{ status: string }[]>`
    select status::text as status from review_item where id = ${id}
  `;
  return row?.status;
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'review-screen-admin');
  admin = signedInAdmin.account;

  const signedInMember = await signedInAccount(
    baseUrl,
    databaseUrl,
    ROLE.member,
    'review-screen-member',
  );
  member = signedInMember.account;
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

/** Sign in through the real screen — never a forged cookie — and hand back the page. */
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
  await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
  return page;
}

/** Signed in, on the panel, with the queue loaded. */
async function openPanel(
  viewport: { width: number; height: number } = DESKTOP,
  url = PANEL_URL,
): Promise<Page> {
  const page = await signInAs(admin, viewport);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('region', { name: 'Pending Reviews' }).count(), { timeout: 30_000 })
    .toBe(1);
  await expect.poll(() => page.getByText('Loading reviews…').count(), { timeout: 30_000 }).toBe(0);
  return page;
}

/** The one row for this recording and kind, by the title nothing else in the run shares. */
function rowFor(page: Page, title: string, kind = 'Summary'): Locator {
  return page
    .getByRole('listitem')
    .filter({ hasText: title })
    .filter({ hasText: kind });
}

/** Open the form on that row. */
async function openForm(page: Page, title: string, kind = 'Summary'): Promise<Locator> {
  const row = rowFor(page, title, kind);
  await row.getByRole('button', { name: 'Review' }).click();
  await expect.poll(() => row.getByRole('textbox').count(), { timeout: 30_000 }).toBeGreaterThan(0);
  return row;
}

// =================================================================================================

describe('the panel and its gate', () => {
  it('is a fourth entry in the console shell, reachable from it', async () => {
    const page = await signInAs(admin);
    try {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: 'Admin console' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      const link = page.getByRole('link', { name: 'Pending Reviews' });
      expect(await link.count()).toBe(1);
      await link.click();
      await page.waitForURL(PANEL_URL, { timeout: 30_000 });

      // The same shell, and the navigation now marks this panel as the current one.
      expect(await page.getByRole('heading', { level: 1, name: 'Admin console' }).count()).toBe(1);
      expect(await page.getByRole('navigation', { name: 'Console panels' }).count()).toBe(1);
      expect(await link.getAttribute('aria-current')).toBe('page');
      expect(await page.getByRole('region', { name: 'Pending Reviews' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('never shows a member the panel, and never sends them its markup', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(PANEL_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
      expect(await page.getByRole('region', { name: 'Pending Reviews' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('what the queue says', () => {
  it('lists both kinds together, newest recording first', async () => {
    const label = unique('Queue order');
    const newest = await newRecording(`${label} newest`, '2026-07-19');
    const oldest = await newRecording(`${label} oldest`, '2025-12-24');
    await drafts(newest, REVIEW_KINDS);
    await drafts(oldest, ['summary']);

    const page = await openPanel();
    try {
      const rows = page.getByRole('listitem').filter({ hasText: label });
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(3);

      const texts = await rows.allTextContents();
      // Both kinds, side by side, with no per-kind screen — which is the property one table buys.
      expect(texts.filter((one) => one.includes('Summary'))).toHaveLength(2);
      expect(texts.filter((one) => one.includes('Description'))).toHaveLength(1);
      // Newest recording first, matching every other admin list.
      expect(texts[0]).toContain(`${label} newest`);
      expect(texts[2]).toContain(`${label} oldest`);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('says so when nothing is waiting', async () => {
    // Drained first, so the empty state is genuinely the empty state rather than a race.
    await sql`update review_item set status = 'discarded' where status = 'draft'`;
    const page = await openPanel();
    try {
      await expect
        .poll(() => page.getByText('Nothing is waiting.').count(), { timeout: 30_000 })
        .toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('the review form', () => {
  it('shows the draft in full beside the title, the date and the word count', async () => {
    const title = unique('Read me in full');
    const recordingId = await newRecording(title, '2026-05-17');
    await drafts(recordingId, ['summary']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title);
      const text = (await row.textContent()) ?? '';

      // The four things 3.6.5 asks for, in one place.
      expect(text).toContain(title);
      expect(text).toContain('17 May 2026');
      expect(text).toContain('15 words');
      // In full, and in the box it is edited in — not truncated, and not behind a second click.
      expect(await row.getByRole('textbox').first().inputValue()).toBe(MACHINE.summary);
      // And what produced it, so an admin comparing two drafts has something to compare.
      expect(text).toContain('prompt draft-1');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('approves the machine’s words, writing through and closing the item', async () => {
    const title = unique('Approve as written');
    const recordingId = await newRecording(title);
    const [item] = await drafts(recordingId, ['summary']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title);
      await row.getByRole('button', { name: 'Approve' }).click();

      await expect.poll(() => statusOf(item?.id ?? ''), { timeout: 30_000 }).toBe('published');
      expect((await findSummaryByRecording(recordingId, handle))?.content).toBe(MACHINE.summary);
      // And it leaves the queue, because the queue is one query over that one column.
      await expect.poll(() => rowFor(page, title).count(), { timeout: 30_000 }).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('approves the admin’s words when they edit first', async () => {
    const title = unique('Approve with edits');
    const recordingId = await newRecording(title);
    const [item] = await drafts(recordingId, ['recording_metadata']);
    const mine = 'The description an admin preferred.';

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Description');
      await row.getByRole('textbox').first().fill(mine);
      // The button says what it is about to do, which is the one difference an edit makes.
      await row.getByRole('button', { name: 'Approve with edits' }).click();

      await expect.poll(() => statusOf(item?.id ?? ''), { timeout: 30_000 }).toBe('published');
      expect((await findRecordingById(recordingId, handle))?.description).toBe(mine);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('takes a confirming press before it discards, and says what is not lost', async () => {
    const title = unique('Discard me');
    const recordingId = await newRecording(title);
    const [item] = await drafts(recordingId, ['summary']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title);
      await row.getByRole('button', { name: 'Discard' }).click();

      // The direction that throws something away gets the second press — the same line every other
      // panel draws. And it names the fact an admin hesitating actually needs.
      expect((await row.textContent()) ?? '').toContain('the recording can still go live without one');
      expect(await statusOf(item?.id ?? '')).toBe('draft');

      await row.getByRole('button', { name: 'Yes, discard it' }).click();
      await expect.poll(() => statusOf(item?.id ?? ''), { timeout: 30_000 }).toBe('discarded');
      // Nothing was written in its place.
      expect(await findSummaryByRecording(recordingId, handle)).toBeNull();
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('regenerates with a steering sentence, queueing the step and closing the item', async () => {
    const title = unique('Try that again');
    const recordingId = await newRecording(title);
    const [item] = await drafts(recordingId, ['summary']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title);
      await row.getByLabel('Ask for another (optional)').fill('It missed the second half.');
      await row.getByRole('button', { name: 'Regenerate' }).click();

      await expect.poll(() => statusOf(item?.id ?? ''), { timeout: 30_000 }).toBe('discarded');

      const [job] = await sql<{ payload: unknown }[]>`
        select payload from job
        where recording_id = ${recordingId} and step = 'generate_draft'
        order by enqueued_at desc limit 1
      `;
      expect(job?.payload).toEqual({ kinds: ['summary'], prompt: 'It missed the second half.' });
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('the second way in', () => {
  it('opens the same form from the recordings row', async () => {
    const title = unique('Reachable from the row');
    const recordingId = await newRecording(title);
    await drafts(recordingId, ['summary']);

    const page = await signInAs(admin);
    try {
      await page.goto(RECORDINGS_URL, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByRole('listitem').filter({ hasText: title }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      // docs/project/prd.md 3.6.4's "from the recording page", served by a control on the row —
      // which is why no per-recording admin page had to exist for it.
      await page
        .getByRole('listitem')
        .filter({ hasText: title })
        .getByRole('link', { name: 'Review drafts' })
        .click();

      await page.waitForURL(`${PANEL_URL}?${REVIEW_RECORDING_PARAM}=${recordingId}`, {
        timeout: 30_000,
      });
      await expect
        .poll(() => page.getByRole('region', { name: 'Pending Reviews' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      // The same form the queue opens, already open on this recording's draft.
      const row = rowFor(page, title);
      await expect.poll(() => row.getByRole('textbox').count(), { timeout: 30_000 }).toBeGreaterThan(0);
      expect(await row.getByRole('textbox').first().inputValue()).toBe(MACHINE.summary);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('at every width', () => {
  for (const viewport of VIEWPORTS) {
    it(`fits and stays usable at ${viewport.label}`, async () => {
      const title = unique(`Width ${viewport.label}`);
      const recordingId = await newRecording(title);
      await drafts(recordingId, ['summary']);

      const page = await openPanel({ width: viewport.width, height: viewport.height });
      try {
        const row = await openForm(page, title);

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        );
        expect(overflow, `${viewport.label} overflows horizontally`).toBe(false);

        // The draft is readable and the decision is reachable, at every width.
        const box = await row.getByRole('button', { name: 'Approve' }).boundingBox();
        expect(box, `${viewport.label} has no approve button`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      } finally {
        await page.context().close();
      }
    }, 120_000);
  }
});
