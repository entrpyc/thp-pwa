import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { chromium, type Browser, type Page } from 'playwright';
import { DASHBOARD_PAGE_PATH, ROLE, recordingPagePath } from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  publishSummary,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **Correction on screen** (Story 5 Ticket 02) — the affordance, the form and the offer.
 *
 * Two claims that only a browser can make:
 *
 * 1. **A member is never shown the control.** The API refusing is asserted in
 *    `transcript-correction.test.ts`; this is the other half of the standing constraint — the
 *    client hides what a member cannot do.
 * 2. **Declining the offer does nothing at all.** Not "does nothing visible": the assertion is that
 *    the ledger has no job and the queue has no review item after the admin says *Not now*.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEACHING_SECONDS = 30;

const SEGMENTS = [
  { startMs: 0, endMs: 4000, text: 'Good morning, and welcome.', speaker: 0 },
  { startMs: 4000, endMs: 9000, text: 'A word about Epafras before we begin.', speaker: 0 },
  { startMs: 9000, endMs: 15_000, text: 'Turn with me to the second chapter.', speaker: 1 },
] as const;

const LIVE_SUMMARY = 'The teaching stays with the second chapter throughout.';
const FIXED = 'A word about Epaphras before we begin.';

let browser: Browser;
let handle: DatabaseHandle;
let sql: postgres.Sql;
let admin: TestAccount;
let member: TestAccount;

async function publishedTeaching(title: string): Promise<string> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording(
    { originalMediaKey: key, title, recordedAt: '2026-08-16' },
    handle,
  );
  await replaceTranscript(
    { recordingId: row.id, language: 'en', confidence: 0.94, segments: SEGMENTS },
    handle,
  );
  await publishSummary(row.id, LIVE_SUMMARY, handle);
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

/** Sign in as `who` and open the teaching's transcript tab. */
async function openTranscriptAs(who: TestAccount, recordingId: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

  await page.goto(`${baseUrl}${recordingPagePath(recordingId)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Transcript' }).click();
  await expect
    .poll(() => page.getByRole('list', { name: 'Transcript' }).count(), { timeout: 30_000 })
    .toBe(1);
  return page;
}

async function countRows(table: 'job' | 'review_item', recordingId: string): Promise<number> {
  const rows =
    table === 'job'
      ? await sql<{ count: string }[]>`select count(*)::text as count from job where recording_id = ${recordingId}`
      : await sql<{ count: string }[]>`select count(*)::text as count from review_item where recording_id = ${recordingId}`;
  return Number(rows[0]?.count ?? '-1');
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });
  admin = await createAccount(databaseUrl, ROLE.admin, 'correct-screen-admin');
  member = await createAccount(databaseUrl, ROLE.member, 'correct-screen-member');
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

// =================================================================================================

describe('a member is never shown the affordance', () => {
  it('renders the transcript with no correction control anywhere in it', async () => {
    const recordingId = await publishedTeaching(`Correction member ${RUN}`);
    const page = await openTranscriptAs(member, recordingId);
    try {
      // The lines are all there — this is the transcript, not a refused page.
      expect(
        await page.getByRole('list', { name: 'Transcript' }).locator('li').count(),
      ).toBe(SEGMENTS.length);
      expect(await page.getByRole('button', { name: /^Correct the line/ }).count()).toBe(0);
      expect(await page.getByRole('form', { name: 'Correct this line' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

describe('an admin corrects a line and is offered a fresh summary', () => {
  it('saves the correction, shows the offer only afterwards, and enqueues nothing when declined', async () => {
    const recordingId = await publishedTeaching(`Correction admin ${RUN}`);
    const page = await openTranscriptAs(admin, recordingId);
    try {
      // Nothing is offered before a correction is saved — the offer never fires by itself.
      expect(await page.getByRole('region', { name: 'Regenerate the summary' }).count()).toBe(0);

      await page.getByRole('button', { name: /^Correct the line/ }).nth(1).click();
      const form = page.getByRole('form', { name: 'Correct this line' });
      await expect.poll(() => form.count(), { timeout: 30_000 }).toBe(1);

      await form.getByLabel('Line').fill(FIXED);
      await form.getByRole('button', { name: 'Save correction' }).click();

      // The corrected words are what the list now shows.
      await expect
        .poll(async () => (await page.getByRole('list', { name: 'Transcript' }).textContent()) ?? '', {
          timeout: 30_000,
        })
        .toContain(FIXED);

      const offer = page.getByRole('region', { name: 'Regenerate the summary' });
      await expect.poll(() => offer.count(), { timeout: 30_000 }).toBe(1);
      // It names the summary and nothing else — nothing else derived from the transcript exists.
      expect(await offer.textContent()).toContain('summary');

      await offer.getByRole('button', { name: 'Not now' }).click();
      await expect.poll(() => offer.count(), { timeout: 30_000 }).toBe(0);

      // Declining does nothing at all — not merely nothing visible.
      expect(await countRows('job', recordingId)).toBe(0);
      expect(await countRows('review_item', recordingId)).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('enqueues one generate_draft when the offer is accepted', async () => {
    const recordingId = await publishedTeaching(`Correction accepted ${RUN}`);
    const page = await openTranscriptAs(admin, recordingId);
    try {
      await page.getByRole('button', { name: /^Correct the line/ }).first().click();
      const form = page.getByRole('form', { name: 'Correct this line' });
      await expect.poll(() => form.count(), { timeout: 30_000 }).toBe(1);
      await form.getByLabel('Line').fill('Good morning, everyone.');
      await form.getByRole('button', { name: 'Save correction' }).click();

      const offer = page.getByRole('region', { name: 'Regenerate the summary' });
      await expect.poll(() => offer.count(), { timeout: 30_000 }).toBe(1);
      await offer.getByRole('button', { name: 'Regenerate summary' }).click();

      // The press says what happens next, and it says the live summary is not changing yet.
      await expect
        .poll(
          async () =>
            (await page.getByRole('region', { name: 'Regeneration asked for' }).textContent()) ?? '',
          { timeout: 30_000 },
        )
        .toContain('Pending Reviews');

      const jobs = await sql<{ step: string }[]>`
        select step::text as step from job where recording_id = ${recordingId}
      `;
      expect(jobs.map((one) => one.step)).toEqual(['generate_draft']);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('reports a refused correction beside the transcript and changes nothing', async () => {
    const recordingId = await publishedTeaching(`Correction refused ${RUN}`);
    const page = await openTranscriptAs(admin, recordingId);
    try {
      await page.getByRole('button', { name: /^Correct the line/ }).nth(1).click();
      const form = page.getByRole('form', { name: 'Correct this line' });
      await expect.poll(() => form.count(), { timeout: 30_000 }).toBe(1);

      // The second line runs 4000–9000; 3500 is inside the line before it.
      await form.getByLabel('Start (ms)').fill('3500');
      await form.getByRole('button', { name: 'Save correction' }).click();

      await expect
        .poll(async () => (await page.getByText(/Lines cannot overlap/).count()), {
          timeout: 30_000,
        })
        .toBe(1);
      // No offer, because nothing was corrected.
      expect(await page.getByRole('region', { name: 'Regenerate the summary' }).count()).toBe(0);
      expect(await countRows('job', recordingId)).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});
