import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  FLOW_RATING_ENDS,
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
 * - whether the dashboard tile carries the way in ([3.14.1](docs/project/prd.md)) and the page offers Start;
 * - whether the start screen lists the teachings, lets several be picked, says what the pick
 *   covers, and starts ([3.14.2](docs/project/prd.md));
 * - whether the transport is out of sight on the start screen and while the session asks, and back
 *   on the reading list ([3.14.5](docs/project/prd.md));
 * - whether the session shows **one question per screen** with the chapter's title, summary and the
 *   scale of 1 to 5, moves on when a rung is chosen, and steps back ([3.14.5](docs/project/prd.md),
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

/** The transport bar, which renders only once a teaching is loaded. */
const bar = (page: Page) => page.getByRole('region', { name: 'Player' });

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
  it('starts from the dashboard tile, picks two teachings, asks one question per screen with the transport away, and ends on a reading list that keeps its ticks', async () => {
    const page = await signInAs(member);
    try {
      // Load a teaching into the player first, so the transport has something to show — and
      // something to hide.
      await page.goto(`${baseUrl}${recordingPagePath(editableId)}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => bar(page).count(), { timeout: 60_000 }).toBe(1);

      // 3.14.1 — the way in is the dashboard's tile; the menu no longer lists it.
      // Client-side, through the top bar, so the loaded player survives the walk.
      await page.getByRole('link', { name: 'Dashboard', exact: true }).first().click();
      await page.getByRole('link', { name: 'View Flow Tracker' }).click();
      await page.waitForURL(`${baseUrl}${FLOW_TRACKER_PAGE_PATH}`, { timeout: 30_000 });
      expect(await page.textContent('body')).toContain('Examine yourself against the teachings.');
      await expect.poll(() => page.getByRole('heading', { name: 'Introspection' }).count(), { timeout: 30_000 }).toBe(1);
      expect(await bar(page).count()).toBe(1);
      await page.getByRole('link', { name: 'Start' }).click();
      await page.waitForURL(`${baseUrl}${FLOW_TRACKER_START_PAGE_PATH}`, { timeout: 30_000 });

      // 3.14.2 — the list, newest first; several can be picked, and the foot says what the pick covers.
      const list = page.getByRole('list', { name: 'Teachings, newest first' });
      const covers = page.getByRole('region', { name: 'Pick teachings' }).getByRole('status');
      await expect.poll(() => list.getByRole('button').count(), { timeout: 30_000 }).toBeGreaterThan(0);
      // 3.14.5 — the transport is out of sight here.
      await expect.poll(() => bar(page).count(), { timeout: 10_000 }).toBe(0);
      expect(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled()).toBe(true);
      await list.getByRole('button', { name: new RegExp(olderTitle) }).click();
      await expect
        .poll(() => covers.textContent(), { timeout: 10_000 })
        .toBe('1 teaching · 2 questions');
      await list.getByRole('button', { name: new RegExp(newerTitle) }).click();
      await expect
        .poll(() => covers.textContent(), { timeout: 10_000 })
        .toBe('2 teachings · 4 questions');
      expect(await list.getByRole('button', { name: new RegExp(newerTitle) }).getAttribute('aria-pressed')).toBe('true');
      // Unpick and pick again: a press toggles.
      await list.getByRole('button', { name: new RegExp(newerTitle) }).click();
      await expect
        .poll(() => covers.textContent(), { timeout: 10_000 })
        .toBe('1 teaching · 2 questions');
      await list.getByRole('button', { name: new RegExp(newerTitle) }).click();
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await page.waitForURL(/\/flow-tracker\/sessions\//, { timeout: 30_000 });

      // 3.14.5 — the first screen is the newest picked teaching's last chapter, with its summary and
      // the scale; the transport is still away.
      const question = page.getByRole('region', { name: /^Question 1$/ });
      await expect.poll(() => question.count(), { timeout: 30_000 }).toBe(1);
      const firstText = (await question.textContent()) ?? '';
      expect(firstText).toContain(`${newerTitle} part 2`);
      expect(firstText).toMatch(/What .* part 2 teaches\./);
      expect(firstText).toContain('shown up this week?');
      expect(firstText).toContain(FLOW_RATING_ENDS.low);
      expect(firstText).toContain(FLOW_RATING_ENDS.high);
      expect(await question.getByRole('radio').count()).toBe(5);
      expect(await question.getByRole('radio', { name: `1 — ${FLOW_RATING_ENDS.low}` }).count()).toBe(1);
      expect(await question.getByRole('radio', { name: `5 — ${FLOW_RATING_ENDS.high}` }).count()).toBe(1);
      // The first screen has no question before it: its left control cancels rather than goes back.
      expect(await page.getByRole('button', { name: '‹ Back' }).count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Cancel session' }).count()).toBe(1);
      expect(await bar(page).count()).toBe(0);

      // 3.14.6 — choosing a rung moves on; Back returns with the rung chosen.
      await question.getByRole('radio', { name: '4', exact: true }).click();
      await expect.poll(() => page.getByRole('region', { name: /^Question 2$/ }).count(), { timeout: 30_000 }).toBe(1);
      expect(await page.getByRole('button', { name: 'Cancel session' }).count()).toBe(0);
      await page.getByRole('button', { name: '‹ Back' }).click();
      await expect.poll(() => page.getByRole('region', { name: /^Question 1$/ }).count(), { timeout: 30_000 }).toBe(1);
      expect(
        await page.getByRole('region', { name: /^Question 1$/ }).getByRole('radio', { name: '4', exact: true }).isChecked(),
      ).toBe(true);
      // Pressing the rung already chosen keeps it and moves on, as pressing another would.
      await page.getByRole('region', { name: /^Question 1$/ }).getByRole('radio', { name: '4', exact: true }).click();
      await expect.poll(() => page.getByRole('region', { name: /^Question 2$/ }).count(), { timeout: 30_000 }).toBe(1);
      await page.getByRole('button', { name: '‹ Back' }).click();
      await expect.poll(() => page.getByRole('region', { name: /^Question 1$/ }).count(), { timeout: 30_000 }).toBe(1);
      // Change it to the bottom of the scale, and carry on: every remaining question is a 3, a gap.
      await page.getByRole('region', { name: /^Question 1$/ }).getByRole('radio', { name: `1 — ${FLOW_RATING_ENDS.low}` }).click();

      for (;;) {
        const heading = page.getByRole('heading', { name: 'What to live out' });
        if ((await heading.count()) > 0) break;
        const current = page.getByRole('region', { name: /^Question \d+$/ });
        await expect.poll(() => current.count(), { timeout: 30_000 }).toBe(1);
        await current.getByRole('radio', { name: '3', exact: true }).click();
        await page.waitForTimeout(150);
      }

      // 3.14.9 — the reading list: oldest teaching first, first chapter first, the member's own rating.
      const groups = page.getByRole('region', { name: new RegExp(`${olderTitle}|${newerTitle}`) });
      await expect.poll(() => groups.count(), { timeout: 30_000 }).toBe(2);
      const headings = await page.locator('h2').allTextContents();
      expect(headings.indexOf(olderTitle)).toBeLessThan(headings.indexOf(newerTitle));
      const firstGroup = page.getByRole('region', { name: olderTitle });
      const rows = await firstGroup.getByRole('listitem').allTextContents();
      expect(rows[0]).toContain(`${olderTitle} part 1`);
      expect(rows[0]).toContain('You rated this 3 of 5');
      // The chapter's title is the way to its page, and the group's head the way to the teaching's.
      expect(await firstGroup.getByRole('link', { name: `${olderTitle} part 1`, exact: true }).count()).toBe(1);
      expect(await firstGroup.locator('a').filter({ has: page.getByRole('heading', { name: olderTitle }) }).count()).toBe(1);
      // 3.14.5 — the transport is back, because this list offers playback.
      await expect.poll(() => bar(page).count(), { timeout: 10_000 }).toBe(1);

      // The tick is written, and is still there after a reload.
      const tick = firstGroup.getByRole('checkbox', { name: `Done: ${olderTitle} part 1` });
      await tick.click();
      await expect.poll(() => tick.isChecked(), { timeout: 10_000 }).toBe(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByRole('checkbox', { name: `Done: ${olderTitle} part 1` }).isChecked(), { timeout: 30_000 })
        .toBe(true);

      // The page lists it among the past sessions, naming both teachings.
      await page.goto(`${baseUrl}${FLOW_TRACKER_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.getByRole('list', { name: 'Completed sessions' }).count(), { timeout: 30_000 }).toBe(1);
      const past = (await page.getByRole('list', { name: 'Completed sessions' }).textContent()) ?? '';
      expect(past).toContain(`${newerTitle} and ${olderTitle}`);
      expect(past).toContain('2 teachings');
      expect(await page.getByRole('link', { name: 'Start' }).count()).toBe(1);

      const sessions = await listFlowSessionsForMember(member.id, handle);
      expect(sessions.map((one) => one.status)).toEqual(['complete']);
    } finally {
      await page.context().close();
    }
  }, 300_000);
});

describe('cancelling from the first screen (3.14.10)', () => {
  it('abandons the session after a confirmation and lands on the Flow Tracker page', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${FLOW_TRACKER_START_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const list = page.getByRole('list', { name: 'Teachings, newest first' });
      await expect.poll(() => list.getByRole('button').count(), { timeout: 30_000 }).toBeGreaterThan(0);
      await list.getByRole('button', { name: new RegExp(olderTitle) }).click();
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await page.waitForURL(/\/flow-tracker\/sessions\//, { timeout: 30_000 });
      await expect.poll(() => page.getByRole('region', { name: /^Question 1$/ }).count(), { timeout: 30_000 }).toBe(1);

      await page.getByRole('button', { name: 'Cancel session' }).click();
      // Keep going closes the question without abandoning anything.
      await page.getByRole('button', { name: 'Keep going' }).click();
      expect(await page.getByRole('button', { name: 'Yes, cancel it' }).count()).toBe(0);
      await page.getByRole('button', { name: 'Cancel session' }).click();
      await page.getByRole('button', { name: 'Yes, cancel it' }).click();
      await page.waitForURL(`${baseUrl}${FLOW_TRACKER_PAGE_PATH}`, { timeout: 30_000 });
      await expect.poll(() => page.getByRole('link', { name: 'Start' }).count(), { timeout: 30_000 }).toBe(1);

      const sessions = await listFlowSessionsForMember(member.id, handle);
      expect(sessions.map((one) => one.status)).toEqual(['abandoned', 'complete']);
    } finally {
      await page.context().close();
    }
  }, 180_000);
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
      // Exact, because the teaching is called “Editable” and the highlighter on each row names it.
      await panel.getByRole('button', { name: 'Edit', exact: true }).first().click();

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
