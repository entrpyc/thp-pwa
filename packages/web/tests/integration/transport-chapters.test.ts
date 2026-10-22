import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  MEMBER_LIBRARY_PAGE_PATH,
  ROLE,
  recordingPagePath,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  replaceChapters,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The chapters quick action on the transport**, driven in a real browser against real audio.
 *
 * The transport's `···` menu carries a Chapters tool that opens the playing teaching's chapters as
 * a sheet over whatever screen the member is on, and pressing a row seeks to that chapter's start
 * and plays ([3.22.12](docs/project/prd.md)) without leaving the screen for the recording page's
 * tab. Three of those are claims about a live media element — that a row press *starts sound at
 * a moment*, that the bar then names the chapter it landed in ([3.22.16](docs/project/prd.md)),
 * and that the mark in the list follows the position — and none of them is true of anything but
 * an element that is decoding audio, which is why this suite is real for the reason every player
 * suite is.
 *
 * **The teaching is two minutes long and its chapters are forty seconds each**, exactly as in
 * `chapters-screen.test.ts`: [3.22.4](docs/project/prd.md)'s length range is a rule about what the
 * worker proposes, and it is asserted there.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const TEACHING_SECONDS = 120;
const LINE_MS = 10_000;
const CHAPTER_MS = 40_000;

const CHAPTERED_TITLE = `Transport chaptered ${RUN}`;
const PLAIN_TITLE = `Transport unchaptered ${RUN}`;

const GENERATED = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' };

const THREE = [
  { startMs: 0, title: 'The vine', summary: 'What abiding means.' },
  { startMs: CHAPTER_MS, title: 'The branches', summary: 'The cost of pruning.' },
  { startMs: 2 * CHAPTER_MS, title: 'The gardener', summary: 'Who tends the field.' },
];

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let chapteredId: string;
/** 3.22.4's case: no chapters, and so no tool. */
let plainId: string;

interface Snapshot {
  readonly currentTime: number;
  readonly paused: boolean;
  /** `0` until the element has metadata — the signal the stored position has been restored. */
  readonly duration: number;
}

async function audioState(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const element = document.querySelector('audio');
    return {
      currentTime: element?.currentTime ?? -1,
      paused: element?.paused ?? true,
      duration: Number.isFinite(element?.duration) ? (element?.duration ?? 0) : 0,
    };
  });
}

/** A published teaching with a real audio file, a transcript, and the chapters given. */
async function publishedTeaching(
  title: string,
  chapters: readonly { startMs: number; title: string; summary: string }[],
): Promise<string> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording(
    { originalMediaKey: key, title, recordedAt: '2026-08-16' },
    handle,
  );

  // Chapters tile the transcript (3.22.2), so the teaching has one even where no test reads it.
  await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.95,
      segments: Array.from(
        { length: (TEACHING_SECONDS * 1000) / LINE_MS },
        (_unused, index) => ({
          startMs: index * LINE_MS,
          endMs: (index + 1) * LINE_MS,
          text: `Line ${index + 1} of ${title}.`,
        }),
      ),
    },
    handle,
  );

  await replaceChapters(row.id, chapters, GENERATED, handle);
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

/**
 * Sign in and open a teaching, waiting until the element has metadata — **and rewind it**.
 *
 * Opening a teaching restores the member's stored position (3.2.12), and this suite plays into the
 * same teaching on the same account several times over, so without the rewind every test after the
 * first would start wherever the last one stopped and "the chapter marked now" would be whichever
 * chapter test order chose. The wait is for the duration rather than for a position, because the
 * restore lands on `loadedmetadata` and a rewind issued before it is overwritten a moment later.
 */
async function openTeaching(id: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
  const page = await context.newPage();

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

  await page.goto(`${baseUrl}${recordingPagePath(id)}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(async () => (await audioState(page)).duration, { timeout: 60_000 })
    .toBeGreaterThan(0);

  await seekTo(page, 0);
  await expect
    .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
    .toBe(0);
  return page;
}

/** Move the element directly, the way a fixture would rather than the way a member's finger would. */
async function seekTo(page: Page, ms: number): Promise<void> {
  await page.evaluate((at: number) => {
    const element = document.querySelector('audio');
    if (element !== null) element.currentTime = at / 1000;
  }, ms);
}

const bar = (page: Page): Locator => page.getByRole('region', { name: 'Player' });
const toolbar = (page: Page): Locator => page.getByRole('navigation', { name: 'Player tools' });
/**
 * The sheet the tool opens. Its own name rather than "Chapters", because the recording page's
 * Chapters tab is a region of that name and the two can be on screen together — which is exactly
 * the situation half of this file is about.
 */
const sheet = (page: Page): Locator => page.getByRole('region', { name: 'Jump to a chapter' });

/** Open the `···` menu. A click rather than the press-drag gesture: this suite is about the tool. */
async function openTools(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'More player controls' }).click();
  await expect.poll(() => toolbar(page).count(), { timeout: 30_000 }).toBe(1);
}

/** Open the menu and press the Chapters tool, waiting for the sheet behind it. */
async function openSheet(page: Page): Promise<void> {
  await openTools(page);
  await toolbar(page).getByRole('button', { name: 'Chapters' }).click();
  await expect.poll(() => sheet(page).count(), { timeout: 30_000 }).toBe(1);
}

/**
 * Walk from the recording page back to the library **through the page's own control**, so the
 * member surface and the player it mounts survive the move — a fresh `goto` would remount both.
 */
async function leaveForTheLibrary(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Back to recordings' }).click();
  await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  member = await createAccount(databaseUrl, ROLE.member, `transport-chapters-member-${RUN}`);

  [chapteredId, plainId] = await Promise.all([
    publishedTeaching(CHAPTERED_TITLE, THREE),
    publishedTeaching(PLAIN_TITLE, []),
  ]);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

describe('the Chapters tool in the transport menu', () => {
  it('shows for a teaching with chapters, and opens the list as a sheet in the transport', async () => {
    const page = await openTeaching(chapteredId);
    try {
      expect(await sheet(page).count()).toBe(0);
      await openTools(page);

      // Three tools now, where the strip held two: the list icon joins the speech bubble and CC.
      expect(await toolbar(page).getByRole('button').count()).toBe(3);
      const tool = toolbar(page).getByRole('button', { name: 'Chapters' });
      expect(await tool.count()).toBe(1);
      expect(await tool.getAttribute('aria-pressed')).toBe('false');

      await tool.click();
      await expect.poll(() => sheet(page).count(), { timeout: 30_000 }).toBe(1);
      // The press closes the menu behind it, the way every tool on the strip does.
      expect(await toolbar(page).count()).toBe(0);

      // Every chapter in order, with its number, its title and the time it starts (3.22.10's row).
      const rows = sheet(page).getByRole('listitem');
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(3);
      const text = await sheet(page).innerText();
      const vine = text.indexOf('The vine');
      const branches = text.indexOf('The branches');
      const gardener = text.indexOf('The gardener');
      expect(vine).toBeGreaterThanOrEqual(0);
      expect(branches).toBeGreaterThan(vine);
      expect(gardener).toBeGreaterThan(branches);
      for (const expected of ['1', '2', '3', '00:00', '00:40', '01:20', CHAPTERED_TITLE]) {
        expect(text).toContain(expected);
      }

      // At the start of the teaching the first chapter is the one playing, and it is the one marked.
      expect(
        await sheet(page).getByRole('button', { name: /The vine/ }).getAttribute('aria-current'),
      ).toBe('true');
      expect(await sheet(page).locator('[aria-current="true"]').count()).toBe(1);

      // Entirely in the transport: the page has not moved, and its own Chapters tab is still shut.
      expect(page.url()).toBe(`${baseUrl}${recordingPagePath(chapteredId)}`);
      expect(
        await page.getByRole('tab', { name: 'Chapters' }).getAttribute('aria-selected'),
      ).toBe('false');

      // The tool says the sheet is open, and the same press puts it away.
      await openTools(page);
      expect(await tool.getAttribute('aria-pressed')).toBe('true');
      await tool.click();
      await expect.poll(() => sheet(page).count(), { timeout: 30_000 }).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /** A recording with no chapters (3.22.4) leaves the tool out — absent, not disabled. */
  it('is absent for a teaching with no chapters', async () => {
    const page = await openTeaching(plainId);
    try {
      await openTools(page);
      // The two tools the strip held before, so this is the menu having decided rather than failed.
      expect(await toolbar(page).getByRole('button').count()).toBe(2);
      expect(await toolbar(page).getByRole('button', { name: 'Chapters' }).count()).toBe(0);
      expect(await sheet(page).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('seeks to the chapter’s start and plays from a row, then puts the sheet away', async () => {
    const page = await openTeaching(chapteredId);
    try {
      expect((await audioState(page)).paused).toBe(true);
      await openSheet(page);

      await sheet(page).getByRole('button', { name: /The gardener/ }).click();

      // The sheet is gone — a member who chose a chapter has finished choosing.
      await expect.poll(() => sheet(page).count(), { timeout: 30_000 }).toBe(0);

      // Playing, from the chapter rather than from the beginning (3.22.12).
      await expect
        .poll(async () => (await audioState(page)).paused, { timeout: 30_000 })
        .toBe(false);
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan((2 * CHAPTER_MS) / 1000);

      // And the bar's second line now names where it landed (3.22.16).
      await expect
        .poll(async () => (await bar(page).textContent()) ?? '', { timeout: 30_000 })
        .toContain('The gardener');

      // Still on the recording page, and its Chapters tab was never opened.
      expect(page.url()).toBe(`${baseUrl}${recordingPagePath(chapteredId)}`);
      expect(
        await page.getByRole('tab', { name: 'Chapters' }).getAttribute('aria-selected'),
      ).toBe('false');
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('marks the chapter playing now, wherever the teaching has reached', async () => {
    const page = await openTeaching(chapteredId);
    try {
      // Into the third chapter, by position rather than by playing there: what is under test is the
      // mark following the position, not the element advancing.
      await seekTo(page, 2 * CHAPTER_MS + 5_000);
      await expect
        .poll(async () => (await bar(page).textContent()) ?? '', { timeout: 30_000 })
        .toContain('The gardener');

      await openSheet(page);
      expect(
        await sheet(page).getByRole('button', { name: /The gardener/ }).getAttribute('aria-current'),
      ).toBe('true');
      expect(
        await sheet(page).getByRole('button', { name: /The vine/ }).getAttribute('aria-current'),
      ).toBeNull();
      expect(await sheet(page).locator('[aria-current="true"]').count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * The whole point of a quick action on a bar that travels (3.2.14): a chapter is reachable from a
   * screen that has no chapters on it, and reaching it does not take the member away.
   */
  it('works from another screen, and stays there', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await leaveForTheLibrary(page);
      expect(await page.getByRole('tab', { name: 'Chapters' }).count()).toBe(0);

      await openSheet(page);
      await sheet(page).getByRole('button', { name: /The branches/ }).click();
      await expect.poll(() => sheet(page).count(), { timeout: 30_000 }).toBe(0);

      await expect
        .poll(async () => (await audioState(page)).paused, { timeout: 30_000 })
        .toBe(false);
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(CHAPTER_MS / 1000);
      await expect
        .poll(async () => (await bar(page).textContent()) ?? '', { timeout: 30_000 })
        .toContain('The branches');

      // Still in the library — nothing navigated.
      expect(page.url()).toBe(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /** The keyboard half of the tool: a native button, reached and pressed, and Escape to put it away. */
  it('opens from the keyboard and closes on Escape', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await openTools(page);
      const tool = toolbar(page).getByRole('button', { name: 'Chapters' });
      await tool.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => sheet(page).count(), { timeout: 30_000 }).toBe(1);

      await page.keyboard.press('Escape');
      await expect.poll(() => sheet(page).count(), { timeout: 30_000 }).toBe(0);
      // Nothing played: a sheet opened and closed is not a press on a chapter.
      expect((await audioState(page)).paused).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});
