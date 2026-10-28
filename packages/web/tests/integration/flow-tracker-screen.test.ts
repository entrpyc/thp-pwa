import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  FLOW_ANSWER_LABEL,
  FLOW_TRACKER_PAGE_PATH,
  FLOW_TRACKER_START_PAGE_PATH,
  ROLE,
  recordingPagePath,
} from '@thp/shared';
import {
  createDatabase,
  insertGeneratedQuestions,
  insertRecording,
  listChapterQuestionsForRecording,
  listFlowSessionsForMember,
  replaceChapters,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The Flow Tracker, driven in a real browser** ([3.14](docs/project/prd.md)). The API's half is
 * `flow-tracker.test.ts`; this file asks what a fetch cannot:
 *
 * - whether the menu carries the way in ([3.14.1](docs/project/prd.md)) and the page offers Start;
 * - whether the start screen lists the teachings, says what a pick covers, and starts
 *   ([3.14.2](docs/project/prd.md));
 * - whether the session shows **one question per screen** with the chapter's title, summary and the
 *   five answers, moves on when one is pressed, and steps back ([3.14.5](docs/project/prd.md),
 *   [3.14.6](docs/project/prd.md));
 * - whether finishing lands on the reading list with the gaps alone, oldest first, each with a tick
 *   that survives a reload ([3.14.9](docs/project/prd.md));
 * - whether an admin's chapter editor carries the question and saves it ([3.14.11](docs/project/prd.md)).
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MINUTE = 60_000;
const GENERATED = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'reflections-1' };
const CHAPTERS_BY = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' };
/** The 2080s: newer than every other suite's teachings, older than the API suite's 2090s. */
const YEAR = 2085;

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let admin: TestAccount;
let olderTitle: string;
let newerTitle: string;
let editableId: string;

async function teaching(title: string, recordedAt: string, chapters: number, audio = false): Promise<string> {
  const key = audio
    ? (await uploadTestAudio(settings, 60)).key
    : `originals/flow-screen-${title.replace(/\W+/g, '-')}-${RUN}.mp3`;
  const row = await insertRecording({ originalMediaKey: key, title, recordedAt }, handle);
  await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.95,
      segments: Array.from({ length: 6 }, (_unused, index) => ({
        startMs: index * 10 * MINUTE,
        endMs: (index + 1) * 10 * MINUTE,
        text: `Line ${index + 1} of ${title}.`,
      })),
    },
    handle,
  );
  const written = await replaceChapters(
    row.id,
    Array.from({ length: chapters }, (_unused, index) => ({
      startMs: index * 20 * MINUTE,
      title: `${title} part ${index + 1}`,
      summary: `What ${title} part ${index + 1} teaches.`,
    })),
    CHAPTERS_BY,
    handle,
  );
  await insertGeneratedQuestions(
    written.map((one) => ({ scope: 'chapter' as const, chapterId: one.id, text: `How has ${one.title} shown up this week?`, generatedBy: GENERATED })),
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

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
  handle = createDatabase({ url: databaseUrl, max: 6 });
  member = await createAccount(databaseUrl, ROLE.member, `flow-screen-member-${RUN}`);
  admin = await createAccount(databaseUrl, ROLE.admin, `flow-screen-admin-${RUN}`);
  olderTitle = `Walking ${RUN}`;
  newerTitle = `Standing ${RUN}`;
  await teaching(olderTitle, `${YEAR}-01-01`, 2);
  await teaching(newerTitle, `${YEAR}-02-01`, 2);
  editableId = await teaching(`Editable ${RUN}`, `${YEAR}-03-01`, 2, true);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('a whole session, in the browser', () => {
  it('starts from the dashboard tile, asks one question per screen, and ends on a reading list that keeps its ticks', async () => {
    const page = await signInAs(member);
    try {
      // 3.14.1 — the way in is the dashboard's tile; the menu no longer lists it.
      await page.getByRole('button', { name: 'Menu' }).click();
      expect(await page.getByRole('link', { name: 'Flow Tracker', exact: true }).count()).toBe(0);
      await page.keyboard.press('Escape');
      await page.getByRole('link', { name: 'View Flow Tracker' }).click();
      await page.waitForURL(`${baseUrl}${FLOW_TRACKER_PAGE_PATH}`, { timeout: 30_000 });
      await page.getByRole('link', { name: 'Start' }).click();
      await page.waitForURL(`${baseUrl}${FLOW_TRACKER_START_PAGE_PATH}`, { timeout: 30_000 });

      // 3.14.2 — the list, newest first; the pick says what it covers.
      const list = page.getByRole('list', { name: 'Teachings, newest first' });
      await expect.poll(() => list.getByRole('button').count(), { timeout: 30_000 }).toBeGreaterThan(0);
      await list.getByRole('button', { name: new RegExp(olderTitle) }).click();
      // The range runs from the picked teaching to the latest: at least these three, six questions.
      await expect
        .poll(() => page.getByRole('status').first().textContent(), { timeout: 10_000 })
        .toMatch(/\d+ teachings · \d+ questions/);
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await page.waitForURL(/\/flow-tracker\/sessions\//, { timeout: 30_000 });

      // 3.14.5 — the first screen is the newest teaching's last chapter, with its summary and the five answers.
      const question = page.getByRole('region', { name: /^Question 1$/ });
      await expect.poll(() => question.count(), { timeout: 30_000 }).toBe(1);
      const firstText = (await question.textContent()) ?? '';
      expect(firstText).toContain('part 2');
      expect(firstText).toMatch(/What .* part 2 teaches\./);
      expect(firstText).toContain('shown up this week?');
      for (const label of Object.values(FLOW_ANSWER_LABEL)) {
        expect(await question.getByRole('button', { name: label }).count()).toBe(1);
      }
      expect(await page.getByRole('button', { name: '‹ Back' }).isDisabled()).toBe(true);

      // 3.14.6 — pressing an answer moves on; Back returns with the answer pressed.
      await question.getByRole('button', { name: FLOW_ANSWER_LABEL.remember_well }).click();
      await expect.poll(() => page.getByRole('region', { name: /^Question 2$/ }).count(), { timeout: 30_000 }).toBe(1);
      await page.getByRole('button', { name: '‹ Back' }).click();
      await expect.poll(() => page.getByRole('region', { name: /^Question 1$/ }).count(), { timeout: 30_000 }).toBe(1);
      expect(
        await page.getByRole('region', { name: /^Question 1$/ }).getByRole('button', { name: FLOW_ANSWER_LABEL.remember_well }).getAttribute('aria-pressed'),
      ).toBe('true');
      // Change it, and carry on: every remaining question is a gap.
      await page.getByRole('region', { name: /^Question 1$/ }).getByRole('button', { name: FLOW_ANSWER_LABEL.dont_remember }).click();

      for (;;) {
        const heading = page.getByRole('heading', { name: 'Your route back in' });
        if ((await heading.count()) > 0) break;
        const current = page.getByRole('region', { name: /^Question \d+$/ });
        await expect.poll(() => current.count(), { timeout: 30_000 }).toBe(1);
        await current.getByRole('button', { name: FLOW_ANSWER_LABEL.not_embodied }).click();
        await page.waitForTimeout(150);
      }

      // 3.14.9 — the reading list: oldest teaching first, first chapter first, the member's own words.
      const groups = page.getByRole('region', { name: new RegExp(`${olderTitle}|${newerTitle}`) });
      await expect.poll(() => groups.count(), { timeout: 30_000 }).toBe(2);
      const headings = await page.locator('h2').allTextContents();
      expect(headings.indexOf(olderTitle)).toBeLessThan(headings.indexOf(newerTitle));
      const firstGroup = page.getByRole('region', { name: olderTitle });
      const rows = await firstGroup.getByRole('listitem').allTextContents();
      expect(rows[0]).toContain(`${olderTitle} part 1`);
      expect(rows[0]).toContain(`You said: ${FLOW_ANSWER_LABEL.not_embodied}`);
      expect(await firstGroup.getByRole('link', { name: 'Open chapter' }).count()).toBe(2);

      // The tick is written, and is still there after a reload.
      const tick = firstGroup.getByRole('checkbox', { name: `Done: ${olderTitle} part 1` });
      await tick.check();
      await expect.poll(() => tick.isChecked(), { timeout: 10_000 }).toBe(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByRole('checkbox', { name: `Done: ${olderTitle} part 1` }).isChecked(), { timeout: 30_000 })
        .toBe(true);

      // The page lists it among the past sessions.
      await page.goto(`${baseUrl}${FLOW_TRACKER_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.getByRole('list', { name: 'Completed sessions' }).count(), { timeout: 30_000 }).toBe(1);
      expect(await page.getByRole('list', { name: 'Completed sessions' }).textContent()).toContain(`From ${olderTitle}`);
      expect(await page.getByRole('link', { name: 'Start' }).count()).toBe(1);

      const sessions = await listFlowSessionsForMember(member.id, handle);
      expect(sessions.map((one) => one.status)).toEqual(['complete']);
    } finally {
      await page.context().close();
    }
  }, 300_000);
});

describe('an admin rewrites a chapter’s question (3.14.11)', () => {
  it('shows the question in the chapter editor and saves it with the chapter', async () => {
    const page = await signInAs(admin);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(editableId)}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.getByRole('tab', { name: 'Chapters' }).count(), { timeout: 60_000 }).toBe(1);
      await page.getByRole('tab', { name: 'Chapters' }).click();
      const panel = page.getByRole('region', { name: 'Chapters' });
      await expect.poll(() => panel.count(), { timeout: 30_000 }).toBe(1);
      await panel.getByRole('button', { name: 'Edit' }).first().click();

      const field = panel.getByLabel(/Flow Tracker question/);
      expect(await field.inputValue()).toBe(`How has Editable ${RUN} part 1 shown up this week?`);
      await field.fill('Who did you forgive first this week?');
      await panel.getByRole('button', { name: 'Save' }).click();

      await expect
        .poll(async () => {
          const questions = await listChapterQuestionsForRecording(editableId, handle);
          return [...questions.values()].map((one) => one.text).sort();
        }, { timeout: 30_000 })
        .toEqual([`How has Editable ${RUN} part 2 shown up this week?`, 'Who did you forgive first this week?']);
      const saved = [...(await listChapterQuestionsForRecording(editableId, handle)).values()].find(
        (one) => one.text === 'Who did you forgive first this week?',
      );
      expect(saved?.editedByAdmin).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});
