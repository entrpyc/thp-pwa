import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import postgres from 'postgres';
import {
  ADMIN_PAGE_PATH,
  ADMIN_RECORDINGS_PAGE_PATH,
  ADMIN_REVIEWS_PAGE_PATH,
  API_PREFIX,
  REVIEW_FIELD,
  REVIEW_KINDS,
  REVIEW_RECORDING_PARAM,
  ROLE,
  SCRIPTURE_PASSAGE_PATH,
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
  // A list-shaped draft, in canon order as the worker writes it. `Psalm 23` covers its chapter
  // whole, so the row is also the whole-chapter rendering under test.
  scripture: [
    { book: 'psalm', chapter: 23, verseStart: 1, verseEnd: 6 },
    { book: 'john', chapter: 3, verseStart: 16, verseEnd: 16 },
    { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4 },
  ],
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
      fields: { [REVIEW_FIELD[kind].name]: MACHINE[kind] },
      provenance: {
        model: 'fake',
        modelVersion: 'fake-1',
        promptVersion: 'draft-1',
        steeringPrompt: null,
        fields: { [REVIEW_FIELD[kind].name]: { aiSuggested: true, editedByAdmin: false } },
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
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(REVIEW_KINDS.length + 1);

      const texts = await rows.allTextContents();
      // Every kind, side by side, with no per-kind screen — which is the property one table buys.
      expect(texts.filter((one) => one.includes('Summary'))).toHaveLength(2);
      expect(texts.filter((one) => one.includes('Description'))).toHaveLength(1);
      expect(texts.filter((one) => one.includes('Scripture'))).toHaveLength(1);
      // Newest recording first, matching every other admin list.
      expect(texts[0]).toContain(`${label} newest`);
      expect(texts.at(-1)).toContain(`${label} oldest`);
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

/**
 * **A list-shaped draft on the form** (Task 1.5) — the first thing in this scope an operator can
 * use, and the first artefact whose draft is not a paragraph.
 *
 * The property under test is not "scripture renders": it is that the form chose the renderer from
 * the item's **kind**, so the two text kinds go on rendering exactly as they did and the fourth
 * artefact is a shape rather than a branch.
 */
describe('a scripture item on the form', () => {
  // 1.5.1 — one row per citation, read the way a person says it, in canon order.
  it('renders the list as one row per citation rather than as a block of text', async () => {
    const title = unique('A list of references');
    const recordingId = await newRecording(title, '2026-05-17');
    await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      const list = row.getByRole('list', { name: 'Citations' });

      await expect.poll(() => list.getByRole('listitem').count(), { timeout: 30_000 }).toBe(3);
      // Each row reads as the passage it names, in canon order — its controls are task 2.1's.
      expect(await list.locator('legend').allTextContents()).toEqual([
        'Psalm 23',
        'John 3:16',
        'Romans 8:1–4',
      ]);

      // Not a text box: a citation is structured, and nothing here invites prose. The one textbox
      // on the form is the steering sentence, which every kind has.
      expect(await row.getByRole('textbox').count()).toBe(1);
      expect(await row.getByRole('textbox').first().getAttribute('name')).toBe('prompt');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 1.5.2 — the regression that matters: the widening changed nothing for the kinds that were
  // already there.
  it('leaves the two text kinds rendering as the single box they always did', async () => {
    const title = unique('Still a text box');
    const recordingId = await newRecording(title);
    await drafts(recordingId, ['summary', 'recording_metadata']);

    const page = await openPanel();
    try {
      const summary = await openForm(page, title, 'Summary');
      expect(await summary.getByRole('textbox', { name: 'Summary' }).inputValue()).toBe(
        MACHINE.summary,
      );
      expect(await summary.getByRole('list', { name: 'Summary' }).count()).toBe(0);

      const description = await openForm(page, title, 'Description');
      expect(await description.getByRole('textbox', { name: 'Description' }).inputValue()).toBe(
        MACHINE.recording_metadata,
      );
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 1.5.3 — an empty box would read as a draft that failed. What happened is that the machine read
  // the teaching and found no scripture in it, and that is what the form says.
  it('says the machine found no scripture rather than showing an empty box', async () => {
    const title = unique('Found none');
    const recordingId = await newRecording(title);
    await replaceOpenDrafts(
      recordingId,
      [
        {
          kind: 'scripture',
          fields: { [REVIEW_FIELD.scripture.name]: [] },
          provenance: {
            model: 'fake',
            modelVersion: 'fake-1',
            promptVersion: 'draft-1',
            steeringPrompt: null,
            fields: { [REVIEW_FIELD.scripture.name]: { aiSuggested: true, editedByAdmin: false } },
          },
        },
      ],
      handle,
    );

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');

      expect(await row.textContent()).toContain('found no scripture in this teaching');
      expect(await row.getByRole('list', { name: 'Citations' }).count()).toBe(0);
      // And it is still approvable, which is what makes "none" a fact an admin records.
      expect(await row.getByRole('button', { name: 'Approve' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 1.5.4 — the two presses the form already had, acting on the whole list.
  it('approves the whole list, writing every reference through and closing the item', async () => {
    const title = unique('Approve the list');
    const recordingId = await newRecording(title);
    const [item] = await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      await row.getByRole('button', { name: 'Approve' }).click();

      await expect.poll(() => statusOf(item?.id ?? ''), { timeout: 30_000 }).toBe('published');
      const written = await sql<{ book: string }[]>`
        select book from scripture_reference where recording_id = ${recordingId} order by book
      `;
      expect(written.map((one) => one.book)).toEqual(['john', 'psalm', 'romans']);
      await expect.poll(() => rowFor(page, title, 'Scripture').count(), { timeout: 30_000 }).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('discards the whole list on a second press, writing no reference', async () => {
    const title = unique('Discard the list');
    const recordingId = await newRecording(title);
    const [item] = await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      await row.getByRole('button', { name: 'Discard' }).click();

      // The first press asks; nothing has happened yet, which is the whole of the confirming press.
      expect(await row.textContent()).toContain('Discard this scripture?');
      expect(await statusOf(item?.id ?? '')).toBe('draft');

      await row.getByRole('button', { name: 'Yes, discard it' }).click();
      await expect.poll(() => statusOf(item?.id ?? ''), { timeout: 30_000 }).toBe('discarded');

      const written = await sql`
        select id from scripture_reference where recording_id = ${recordingId}
      `;
      expect(written).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 1.5.5 — a stale screen is told, rather than being allowed to look like it worked.
  it('shows the refusal when another admin has already resolved the item', async () => {
    const title = unique('Already resolved');
    const recordingId = await newRecording(title);
    const [item] = await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      // The other admin, acting between this screen loading and this press.
      await sql`update review_item set status = 'published' where id = ${item?.id ?? ''}`;

      await row.getByRole('button', { name: 'Approve' }).click();

      await expect.poll(() => row.getByRole('alert').count(), { timeout: 30_000 }).toBe(1);
      expect(await row.getByRole('alert').textContent()).toContain('already been dealt with');
      const written = await sql`
        select id from scripture_reference where recording_id = ${recordingId}
      `;
      expect(written).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

/**
 * **An admin corrects the list before approving** (Task 2.1, Task 2.2).
 *
 * The rows the machine proposed stop being read-only here. Each one is book, chapter and verse as
 * separate controls — never a text box, because a citation that can be typed as prose is a citation
 * somebody has to parse back — and each one can be thrown out or replaced before the list is
 * approved.
 *
 * Nothing is saved until the admin approves: removing a row is an edit to a draft, which is why it
 * takes one press where discarding the whole item takes two.
 */
describe('correcting a list before approving', () => {
  /** The three rows the machine proposed, as the form renders their citations. */
  const PROPOSED_LABELS = ['Psalm 23', 'John 3:16', 'Romans 8:1–4'];

  /** An open scripture draft holding no citations at all — the machine found none. */
  async function foundNone(title: string): Promise<{ recordingId: string; item: ReviewItemRow }> {
    const recordingId = await newRecording(title);
    const [item] = await replaceOpenDrafts(
      recordingId,
      [
        {
          kind: 'scripture',
          fields: { [REVIEW_FIELD.scripture.name]: [] },
          provenance: {
            model: 'fake',
            modelVersion: 'fake-1',
            promptVersion: 'draft-1',
            steeringPrompt: null,
            fields: { [REVIEW_FIELD.scripture.name]: { aiSuggested: true, editedByAdmin: false } },
          },
        },
      ],
      handle,
    );
    return { recordingId, item: item as ReviewItemRow };
  }

  /** What each row's citation currently reads as, top to bottom. */
  function labels(row: Locator): Promise<string[]> {
    return row.getByRole('list', { name: 'Citations' }).locator('legend').allTextContents();
  }

  // 2.1.1 — separate inputs, never one free-text box.
  it('edits a row as book, chapter and verse in separate inputs, never as one box', async () => {
    const title = unique('Edit a row');
    const recordingId = await newRecording(title);
    await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      const psalm = row.getByRole('group').first();

      await expect.poll(() => labels(row), { timeout: 30_000 }).toEqual(PROPOSED_LABELS);
      // The citation, taken apart into the four things it is made of.
      expect(await psalm.getByRole('combobox', { name: 'Book' }).inputValue()).toBe('psalm');
      expect(await psalm.getByRole('spinbutton', { name: 'Chapter' }).inputValue()).toBe('23');
      expect(await psalm.getByRole('spinbutton', { name: 'First verse' }).inputValue()).toBe('1');
      expect(await psalm.getByRole('spinbutton', { name: 'Last verse' }).inputValue()).toBe('6');

      await psalm.getByRole('spinbutton', { name: 'Chapter' }).fill('24');
      await psalm.getByRole('spinbutton', { name: 'First verse' }).fill('3');
      await psalm.getByRole('spinbutton', { name: 'Last verse' }).fill('5');

      // The row reads back as the passage it now names, so an admin sees what they typed.
      await expect.poll(() => labels(row), { timeout: 30_000 }).toEqual([
        'Psalm 24:3–5',
        'John 3:16',
        'Romans 8:1–4',
      ]);

      // Still nothing that invites prose: the one text box on the form is the steering sentence.
      expect(await row.getByRole('textbox').count()).toBe(1);
      expect(await row.getByRole('textbox').first().getAttribute('name')).toBe('prompt');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 2.1.2 — one press, and the rest of the list is untouched.
  it('removes a row on one press, leaving the others exactly as they were', async () => {
    const title = unique('Remove a row');
    const recordingId = await newRecording(title);
    const [item] = await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      await expect.poll(() => labels(row), { timeout: 30_000 }).toEqual(PROPOSED_LABELS);

      await row.getByRole('button', { name: 'Remove John 3:16' }).click();

      // Gone on the first press — and the two either side of it are exactly as they were. The
      // second press stays where it belongs, on the button that throws the whole draft away.
      await expect.poll(() => labels(row), { timeout: 30_000 }).toEqual(['Psalm 23', 'Romans 8:1–4']);
      expect(await row.getByRole('button', { name: 'Yes, discard it' }).count()).toBe(0);
      expect(await statusOf(item?.id ?? '')).toBe('draft');

      // And nothing is written until the admin approves, which is what makes removal an edit.
      expect(
        await sql`select id from scripture_reference where recording_id = ${recordingId}`,
      ).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 2.1.3 — refused against its own row, naming what is wrong, and nothing else lost.
  it('refuses an invalid edit against its own row and keeps the admin’s other edits', async () => {
    const title = unique('Refuse a row');
    const recordingId = await newRecording(title);
    const [item] = await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      await expect.poll(() => labels(row), { timeout: 30_000 }).toEqual(PROPOSED_LABELS);

      // A correction the admin makes first, and must not lose.
      const romans = row.getByRole('group').nth(2);
      await romans.getByRole('spinbutton', { name: 'Last verse' }).fill('11');

      // And then a chapter that book does not have.
      const john = row.getByRole('group').nth(1);
      await john.getByRole('spinbutton', { name: 'Chapter' }).fill('99');

      await expect.poll(() => john.getByRole('alert').count(), { timeout: 30_000 }).toBe(1);
      expect(await john.getByRole('alert').textContent()).toContain('there is no chapter 99');

      // Against its own row: the row above it is not complaining, and the edit made in it is
      // exactly where the admin left it.
      expect(await romans.getByRole('alert').count()).toBe(0);
      expect(await romans.getByRole('spinbutton', { name: 'Last verse' }).inputValue()).toBe('11');
      expect(await row.getByRole('group').first().getByRole('alert').count()).toBe(0);

      // And a list holding it cannot be approved.
      await row.getByRole('button', { name: 'Approve' }).click();
      await expect.poll(() => statusOf(item?.id ?? ''), { timeout: 30_000 }).toBe('draft');
      expect(
        await sql`select id from scripture_reference where recording_id = ${recordingId}`,
      ).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 2.1.6 — labelled, and reachable in order without a mouse.
  it('labels every per-row control and reaches all of them by keyboard', async () => {
    const title = unique('Keyboard rows');
    const recordingId = await newRecording(title);
    await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      await expect.poll(() => labels(row), { timeout: 30_000 }).toEqual(PROPOSED_LABELS);

      await row.getByRole('group').first().getByRole('combobox', { name: 'Book' }).focus();

      const reached: string[] = [];
      for (let step = 0; step < 4; step += 1) {
        await page.keyboard.press('Tab');
        reached.push(
          await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''),
        );
      }

      // Every control of the row, in the order it is read in, each saying what it is.
      expect(reached).toEqual(['Chapter', 'First verse', 'Last verse', 'Remove Psalm 23']);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 2.2.1 — added by hand, structurally, to a draft that came back with nothing.
  it('adds a reference by hand to a draft the machine found nothing in', async () => {
    const title = unique('Add to none');
    const { recordingId, item } = await foundNone(title);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      expect(await row.textContent()).toContain('found no scripture in this teaching');

      await row.getByRole('button', { name: 'Add a reference' }).click();

      const added = row.getByRole('group').first();
      await expect.poll(() => added.count(), { timeout: 30_000 }).toBe(1);
      await added.getByRole('combobox', { name: 'Book' }).selectOption('acts');
      await added.getByRole('spinbutton', { name: 'Chapter' }).fill('2');
      await added.getByRole('spinbutton', { name: 'First verse' }).fill('1');
      await added.getByRole('spinbutton', { name: 'Last verse' }).fill('4');
      await expect.poll(() => labels(row), { timeout: 30_000 }).toEqual(['Acts 2:1–4']);

      await row.getByRole('button', { name: 'Approve' }).click();
      await expect.poll(() => statusOf(item.id), { timeout: 30_000 }).toBe('published');

      // A hand-added reference is the same kind of thing as a proposed one, and says so.
      expect(
        await sql`
          select book, chapter, verse_start, verse_end, origin::text as origin
          from scripture_reference where recording_id = ${recordingId}
        `,
      ).toEqual([
        { book: 'acts', chapter: 2, verse_start: 1, verse_end: 4, origin: 'person' },
      ]);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 2.2.2 — an addition is checked the same way an edit is, and against the list it joins.
  it('refuses an added reference that is not a citation, and one the list already holds', async () => {
    const title = unique('Refuse an addition');
    const recordingId = await newRecording(title);
    const [item] = await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      await expect.poll(() => labels(row), { timeout: 30_000 }).toEqual(PROPOSED_LABELS);

      await row.getByRole('button', { name: 'Add a reference' }).click();
      const added = row.getByRole('group').last();
      await expect.poll(() => row.getByRole('group').count(), { timeout: 30_000 }).toBe(4);

      // A chapter that book does not have.
      await added.getByRole('combobox', { name: 'Book' }).selectOption('john');
      await added.getByRole('spinbutton', { name: 'Chapter' }).fill('99');
      await expect.poll(() => added.getByRole('alert').count(), { timeout: 30_000 }).toBe(1);
      expect(await added.getByRole('alert').textContent()).toContain('there is no chapter 99');

      // And a passage the list already holds — a real citation, and still not one to add twice.
      await added.getByRole('spinbutton', { name: 'Chapter' }).fill('3');
      await added.getByRole('spinbutton', { name: 'First verse' }).fill('16');
      await added.getByRole('spinbutton', { name: 'Last verse' }).fill('16');
      await expect
        .poll(() => added.getByRole('alert').textContent(), { timeout: 30_000 })
        .toContain('already in the list');

      await row.getByRole('button', { name: 'Approve' }).click();
      await expect.poll(() => statusOf(item?.id ?? ''), { timeout: 30_000 }).toBe('draft');
      expect(
        await sql`select id from scripture_reference where recording_id = ${recordingId}`,
      ).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

/**
 * **The passage under each citation** ([3.3.1](docs/active-scope/implementation-plan.md)–
 * [3.3.3](docs/active-scope/implementation-plan.md)).
 *
 * The whole point of putting verse text on this screen is that a citation which *reads* right and
 * *is* wrong is catchable — so what is asserted is that the words are under the row, that a row the
 * admin has just typed gets them too, and that a row whose passage will not load still shows what
 * it cites.
 *
 * The server the suite drives is configured with the local fake verse source, so nothing here
 * reaches a Bible API and the text is the fake's stand-in rather than scripture.
 */
describe('the passage under a citation', () => {
  it('shows each reference’s passage beneath it', async () => {
    const title = unique('Passages under the rows');
    const recordingId = await newRecording(title);
    await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      const list = row.getByRole('list', { name: 'Citations' });
      const first = list.getByRole('listitem').first();

      await expect
        .poll(() => first.textContent(), { timeout: 30_000 })
        .toContain('Stand-in verse text for Psalm 23');

      // Every row, not only the first — a list where one row resolved is a list nobody can review.
      for (const wanted of ['Psalm 23', 'John 3:16', 'Romans 8:1–4']) {
        await expect
          .poll(() => list.filter({ hasText: wanted }).first().textContent(), { timeout: 30_000 })
          .toContain('Stand-in verse text');
      }

      // A paragraph, not a control: verse text is what the source says and is editable nowhere.
      expect(await first.getByRole('textbox').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 3.3.2 — the row an admin just typed has no draft to have carried anything, so this is the case
  // that makes the resolution a property of the form rather than of the draft.
  it('resolves the passage of a reference the admin adds, while the form is open', async () => {
    const title = unique('Adding resolves');
    const recordingId = await newRecording(title);
    await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      await row.getByRole('button', { name: 'Add a reference' }).click();

      const list = row.getByRole('list', { name: 'Citations' });
      const added = list.getByRole('listitem').last();
      await expect
        .poll(() => added.textContent(), { timeout: 30_000 })
        .toContain('Stand-in verse text for Genesis 1');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('resolves it again when the admin edits the citation', async () => {
    const title = unique('Editing resolves');
    const recordingId = await newRecording(title);
    await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      const row = await openForm(page, title, 'Scripture');
      const list = row.getByRole('list', { name: 'Citations' });
      const second = list.getByRole('listitem').nth(1);

      await expect
        .poll(() => second.textContent(), { timeout: 30_000 })
        .toContain('Stand-in verse text for John 3:16');

      // `John 3:16` becomes `John 3:1`, and the passage under it follows what was typed.
      await second.getByLabel('First verse').fill('1');
      await second.getByLabel('Last verse').fill('1');
      await expect
        .poll(() => second.textContent(), { timeout: 30_000 })
        .toContain('Stand-in verse text for John 3:1.');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  // 3.3.3 — a source that is down degrades the row, never the form. The citation is the artefact;
  // the passage is a convenience on top of it.
  it('still shows the citation, with a quiet line, when the passage will not load', async () => {
    const title = unique('Passage unavailable');
    const recordingId = await newRecording(title);
    await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      await page.route(`**${API_PREFIX}${SCRIPTURE_PASSAGE_PATH}*`, (route) => route.abort());

      const row = await openForm(page, title, 'Scripture');
      const list = row.getByRole('list', { name: 'Citations' });

      await expect
        .poll(() => list.getByRole('listitem').first().textContent(), { timeout: 30_000 })
        .toContain('could not be loaded');

      // The citation is still there, still correctable, still approvable — which is the whole of
      // what "degrades to citations without text" has to mean.
      expect(await list.locator('legend').allTextContents()).toEqual([
        'Psalm 23',
        'John 3:16',
        'Romans 8:1–4',
      ]);
      expect(await row.getByRole('button', { name: 'Approve' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('says so rather than showing nothing when the source has no text for the passage', async () => {
    const title = unique('No text for it');
    const recordingId = await newRecording(title);
    await drafts(recordingId, ['scripture']);

    const page = await openPanel();
    try {
      // The other half of 3.3.3: the API answered, and the answer is that there is no text. On
      // screen the two are the same, deliberately — the row says what it cites and nothing else.
      await page.route(`**${API_PREFIX}${SCRIPTURE_PASSAGE_PATH}*`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ passage: null }),
        }),
      );

      const row = await openForm(page, title, 'Scripture');
      await expect
        .poll(() => row.getByRole('list', { name: 'Citations' }).getByRole('listitem').first().textContent(), {
          timeout: 30_000,
        })
        .toContain('could not be loaded');
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
