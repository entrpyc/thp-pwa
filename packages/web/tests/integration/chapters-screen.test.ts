import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  NOW_PLAYING_PAGE_PATH,
  ROLE,
  chapterPagePath,
  recordingPagePath,
  seriesPagePath,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  insertSeries,
  listChapters,
  replaceChapters,
  replaceTranscript,
  setRecordingPublication,
  setRecordingSeries,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The chapter surfaces, driven in a real browser** ([3.22.10](docs/project/prd.md)–
 * [3.22.19](docs/project/prd.md)).
 *
 * Real for the reason every player suite here is real: three of these requirements are claims about
 * a *live media element* — that selecting a chapter does not start it (3.22.12), that the play
 * control does, and that the transport names the chapter it has reached as the teaching moves
 * (3.22.16). None of those is a claim a component test can make, because none of them is true of
 * anything but an element that is actually decoding audio.
 *
 * **3.22.18 is withdrawn** — the operator asked for the chapter to be named on the transport's
 * second line and in that one place, so the position label beside the scrubber is a bare timecode.
 * The test that used to assert the chapter there now asserts that it is *not* there, which is what
 * stops it coming back by accident.
 *
 * **The teaching is two minutes long and its chapters are forty seconds each.** The length range of
 * [3.22.4](docs/project/prd.md) is a rule about what the *worker* proposes, and it is asserted
 * there; seeding a ninety-minute WAV to satisfy it here would put half a gigabyte through the bucket
 * to prove something about a screen.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Long enough to hold three forty-second chapters and to have somewhere to seek to. */
const TEACHING_SECONDS = 120;
const LINE_MS = 10_000;
const CHAPTER_MS = 40_000;

const CHAPTERED_TITLE = `Chaptered teaching ${RUN}`;
const PLAIN_TITLE = `Unchaptered teaching ${RUN}`;
const EDITABLE_TITLE = `Editable teaching ${RUN}`;
/** A fourth teaching, in a study, so the chapter page's full trail has three ancestors to name. */
const IN_SERIES_TITLE = `Chaptered teaching in a series ${RUN}`;
const SERIES_TITLE = `Chapters screen series ${RUN}`;
/** A fifth, with twelve chapters, for the round trip — see `TWELVE`. */
const LONG_TITLE = `Long teaching ${RUN}`;

const GENERATED = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' };

/**
 * Three chapters with words a search can tell apart
 * ([3.22.11](docs/project/prd.md)) — one word unique to a title, one unique to a summary, so the
 * filter is shown to read both rather than only the first.
 */
const THREE = [
  { startMs: 0, title: 'The vine', summary: 'What abiding means.' },
  { startMs: CHAPTER_MS, title: 'The branches', summary: 'The cost of pruning.' },
  { startMs: 2 * CHAPTER_MS, title: 'The gardener', summary: 'Who tends the field.' },
];

/**
 * Twelve chapters, a line each. The count is the point: a list long enough to outrun a window, so
 * the round trip below has somewhere to scroll to and something to put back. Three forty-second
 * chapters fit in a window with room to spare, and an offset that cannot be reached cannot be
 * restored either.
 */
const TWELVE = Array.from({ length: 12 }, (_unused, index) => ({
  startMs: index * LINE_MS,
  title: `Part ${index + 1} of twelve`,
  summary: `The ten seconds from ${index * 10} on.`,
}));

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let admin: TestAccount;
let chapteredId: string;
let plainId: string;
/** A third teaching, so the admin suite can rewrite a list without disturbing the others. */
let editableId: string;
let chapterIds: string[] = [];
/**
 * A fourth, in a study, and its own chapters.
 *
 * Its own rather than the chaptered teaching moved into a series: every assertion above about the
 * hero band, the transport tile and the strip is written against a teaching in none, and giving that
 * one a study would change what half this file is looking at to prove one thing about a breadcrumb.
 */
let inSeriesId: string;
let seriesId: string;
let inSeriesChapterIds: string[] = [];
let longId: string;

interface Snapshot {
  readonly currentTime: number;
  readonly paused: boolean;
  /** `0` until the element has metadata — which is the signal the restore has happened. */
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
 * The rewind is not tidying. Opening a teaching restores the member's stored position
 * ([3.2.12](docs/project/prd.md)), and this suite plays and seeks through the same teaching on the
 * same account several times over — so without it, the second test to open it starts wherever the
 * first one left off, and every assertion about *the chapter playing now* would be about a chapter
 * chosen by test order. What is under test is the surfaces, not the resume, which
 * `resume-screen.test.ts` owns.
 */
async function openTeaching(id: string, as: TestAccount = member): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
  const page = await context.newPage();

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(as.email);
  await page.getByLabel('Password').fill(as.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

  await page.goto(`${baseUrl}${recordingPagePath(id)}`, { waitUntil: 'domcontentloaded' });
  /*
   * **Wait for the duration, not merely for a position.** The stored position is applied on
   * `loadedmetadata`, so a rewind issued before that arrives is overwritten by the restore a moment
   * later — which is the player working and the test racing it. A finite duration is the signal that
   * metadata has landed and the restore has already happened.
   */
  await expect
    .poll(async () => (await audioState(page)).duration, { timeout: 60_000 })
    .toBeGreaterThan(0);

  await seekTo(page, 0);
  await expect
    .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
    .toBe(0);
  return page;
}

/** Move the element, the way a member's finger would rather than the way a fixture would. */
async function seekTo(page: Page, ms: number): Promise<void> {
  await page.evaluate((at: number) => {
    const element = document.querySelector('audio');
    if (element !== null) element.currentTime = at / 1000;
  }, ms);
}

const bar = (page: Page): Locator => page.getByRole('region', { name: 'Player' });
const panel = (page: Page): Locator => page.getByRole('region', { name: 'Chapters' });
const strip = (page: Page): Locator => page.getByRole('tablist', { name: 'Teaching contents' });

/** Open the Chapters tab and wait for the panel behind it. */
async function openChapters(page: Page): Promise<void> {
  await strip(page).getByRole('tab', { name: 'Chapters' }).click();
  await expect.poll(() => panel(page).count(), { timeout: 30_000 }).toBe(1);
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  member = await createAccount(databaseUrl, ROLE.member, 'chapters-screen-member');
  admin = await createAccount(databaseUrl, ROLE.admin, 'chapters-screen-admin');

  chapteredId = await publishedTeaching(CHAPTERED_TITLE, THREE);
  // 3.22.4's case, and the one every surface has to leave chapters out of.
  plainId = await publishedTeaching(PLAIN_TITLE, []);
  editableId = await publishedTeaching(EDITABLE_TITLE, THREE);

  chapterIds = (await listChapters(chapteredId, handle)).map((one) => one.id);

  inSeriesId = await publishedTeaching(IN_SERIES_TITLE, THREE);
  seriesId = (await insertSeries({ title: SERIES_TITLE, description: null }, handle)).id;
  await setRecordingSeries(inSeriesId, seriesId, handle);
  inSeriesChapterIds = (await listChapters(inSeriesId, handle)).map((one) => one.id);

  longId = await publishedTeaching(LONG_TITLE, TWELVE);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

describe('the Chapters tab on the recording page (3.22.10)', () => {
  it('lists every chapter in order, with its number, its title and the time it starts', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await openChapters(page);

      const rows = panel(page).getByRole('listitem');
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(3);

      const text = (await panel(page).textContent()) ?? '';
      expect(text).toContain('The vine');
      expect(text).toContain('The branches');
      expect(text).toContain('The gardener');
      // The number the list shows, and the time it starts.
      expect(text).toContain('00:00');
      expect(text).toContain('00:40');
      expect(text).toContain('01:20');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * **A recording with no chapters does not show the tab at all** — the line the page already draws
   * for a teaching that cites no scripture, rather than a tab that opens on an empty box.
   */
  it('draws no tab at all for a teaching with no chapters', async () => {
    const page = await openTeaching(plainId);
    try {
      await expect.poll(() => strip(page).count(), { timeout: 30_000 }).toBe(1);
      // Another tab is there, so this is the strip having decided rather than not having drawn.
      // `Notes`, because it is the one entry that is always present whatever a teaching holds —
      // which is what this needs it for.
      await expect
        .poll(() => strip(page).getByRole('tab', { name: 'Notes' }).count(), { timeout: 30_000 })
        .toBe(1);
      expect(await strip(page).getByRole('tab', { name: 'Chapters' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

describe('selecting a chapter, and playing one (3.22.12)', () => {
  /**
   * **A member who tapped a chapter has not asked for sound** — the rule opening a teaching (3.2.12)
   * and selecting a transcript line (3.5.4) already follow.
   */
  it('opens the chapter’s page and does not start playback', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await openChapters(page);
      expect((await audioState(page)).paused).toBe(true);

      await panel(page).getByRole('link', { name: /The branches/ }).click();
      await page.waitForURL(`${baseUrl}${chapterPagePath(chapteredId, chapterIds[1]!)}`, {
        timeout: 30_000,
      });

      // Still silent, and still where it was — the page opened the teaching without playing it.
      const state = await audioState(page);
      expect(state.paused).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /** The one control on the row that asks for sound: it seeks to the chapter's start and plays. */
  it('seeks to the chapter and plays from the row’s play control', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await openChapters(page);
      await panel(page).getByRole('button', { name: 'Play from The gardener' }).click();

      await expect
        .poll(async () => (await audioState(page)).paused, { timeout: 30_000 })
        .toBe(false);
      // At the chapter rather than at the beginning, and moving.
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan((2 * CHAPTER_MS) / 1000);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

describe('the chapter page (3.22.13, 3.22.14, 3.22.15)', () => {
  it('shows the chapter’s title and summary, and a route back to the teaching', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await page.goto(`${baseUrl}${chapterPagePath(chapteredId, chapterIds[1]!)}`, {
        waitUntil: 'domcontentloaded',
      });

      await expect
        .poll(async () => (await page.textContent('body')) ?? '', { timeout: 30_000 })
        .toContain('The cost of pruning.');
      expect(await page.getByRole('heading', { name: 'The branches' }).count()).toBe(1);

      // 3.22.13's route back goes back through history, and this page was opened on top of the
      // teaching's own entry — so back lands on that entry, and the stack is no longer than it was.
      const entries = await page.evaluate(() => window.history.length);
      await page.getByRole('link', { name: 'Back to the teaching' }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(chapteredId)}`, { timeout: 30_000 });
      expect(await page.evaluate(() => window.history.length)).toBe(entries);

      // Opened from a link in a fresh tab, there is no entry behind it to go back to, and the
      // control navigates instead — to the teaching with its chapter list open, which is the list
      // this chapter is a row of, rather than to the library. The stack grows by one.
      const fresh = await page.context().newPage();
      await fresh.goto(`${baseUrl}${chapterPagePath(chapteredId, chapterIds[1]!)}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect
        .poll(async () => (await fresh.textContent('body')) ?? '', { timeout: 30_000 })
        .toContain('The cost of pruning.');
      // Playwright's fresh tab starts on about:blank, which is why the proof is `canGoBack` and a
      // stack that grows by one, rather than a stack of exactly one entry.
      expect(await fresh.evaluate(() => (window as { navigation?: { canGoBack: boolean } }).navigation?.canGoBack)).toBe(false);
      const before = await fresh.evaluate(() => window.history.length);
      await fresh.getByRole('link', { name: 'Back to the teaching' }).click();
      await fresh.waitForURL(
        (url) =>
          url.pathname === recordingPagePath(chapteredId) && url.searchParams.get('tab') === 'chapters',
        { timeout: 30_000 },
      );
      await expect.poll(() => panel(fresh).count(), { timeout: 30_000 }).toBe(1);
      expect(await fresh.evaluate(() => window.history.length)).toBe(before + 1);
      expect(await fresh.evaluate(() => window.scrollY)).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /**
   * **The breadcrumb draws the whole path down to the chapter** — `home › series › recording ›
   * chapter`.
   *
   * A different question from the one the back control answers, and the assertion is written so the
   * two cannot be confused: the trail names the study *and* the teaching, in that order, while back
   * still goes one step up to the teaching. Every ancestor is a link, because a segment you cannot
   * press is a segment that only tells you where you are.
   */
  it('reads home › series › recording › chapter for a chapter of a teaching in a series', async () => {
    const page = await openTeaching(inSeriesId);
    try {
      await page.goto(`${baseUrl}${chapterPagePath(inSeriesId, inSeriesChapterIds[1]!)}`, {
        waitUntil: 'domcontentloaded',
      });

      const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
      const current = crumbs.locator('[aria-current="page"]');
      await expect.poll(() => current.count(), { timeout: 30_000 }).toBe(1);
      expect(await current.textContent()).toBe('The branches');

      // Home, the series, the teaching, the chapter — four segments, in that order.
      await expect.poll(() => crumbs.getByRole('listitem').count(), { timeout: 30_000 }).toBe(4);

      const series = crumbs.getByRole('link', { name: SERIES_TITLE });
      expect(await series.getAttribute('href')).toBe(seriesPagePath(seriesId));
      const teaching = crumbs.getByRole('link', { name: IN_SERIES_TITLE });
      expect(await teaching.getAttribute('href')).toBe(recordingPagePath(inSeriesId));

      // The study is above the teaching, not beside or below it.
      const order = await crumbs
        .getByRole('link')
        .evaluateAll((links) => links.map((link) => link.textContent?.trim() ?? ''));
      expect(order.indexOf(SERIES_TITLE)).toBeLessThan(order.indexOf(IN_SERIES_TITLE));

      // And it is a route, not a label.
      await series.click();
      await page.waitForURL(`${baseUrl}${seriesPagePath(seriesId)}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /** A chapter of a teaching in no study names one fewer ancestor, and nothing else changes. */
  it('reads home › recording › chapter when the teaching is in no series', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await page.goto(`${baseUrl}${chapterPagePath(chapteredId, chapterIds[1]!)}`, {
        waitUntil: 'domcontentloaded',
      });

      const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
      await expect
        .poll(() => crumbs.locator('[aria-current="page"]').count(), { timeout: 30_000 })
        .toBe(1);
      await expect.poll(() => crumbs.getByRole('listitem').count(), { timeout: 30_000 }).toBe(3);
      expect(await crumbs.getByRole('link', { name: CHAPTERED_TITLE }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /** The recording's tabs, minus `Chapters` — a chapter does not divide into chapters. */
  it('carries the recording’s tabs beside it', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await page.goto(`${baseUrl}${chapterPagePath(chapteredId, chapterIds[0]!)}`, {
        waitUntil: 'domcontentloaded',
      });
      const tabs = page.getByRole('tablist', { name: 'Chapter contents' });
      await expect.poll(() => tabs.count(), { timeout: 30_000 }).toBe(1);

      expect(await tabs.getByRole('tab', { name: 'Notes' }).count()).toBe(1);
      expect(await tabs.getByRole('tab', { name: 'Scripture' }).count()).toBe(1);
      // Drawn on this strip exactly as it is on the recording page's — the two are one control a
      // member reads twice, so the entry is present on both or on neither.
      expect(await tabs.getByRole('tab', { name: 'Transcript' }).count()).toBe(1);
      expect(await tabs.getByRole('tab', { name: 'Chapters' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /**
   * **The transcript shows that chapter's lines and stops at its boundaries** (3.22.14).
   *
   * The screen half of a rule `chapters.test.ts` asserts against the API. It was skipped while the
   * `Transcript` tab was hidden — the tab is the only way into the panel — and came back with it.
   */
  it('shows only this chapter’s transcript lines', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await page.goto(`${baseUrl}${chapterPagePath(chapteredId, chapterIds[1]!)}`, {
        waitUntil: 'domcontentloaded',
      });
      const tabs = page.getByRole('tablist', { name: 'Chapter contents' });
      await expect.poll(() => tabs.count(), { timeout: 30_000 }).toBe(1);
      await tabs.getByRole('tab', { name: 'Transcript' }).click();

      // Lines 5–8 are the second forty seconds; 1 and 9 belong to the chapters either side.
      const lines = page.getByRole('button', { name: /Line \d+ of/ });
      await expect.poll(() => lines.count(), { timeout: 30_000 }).toBe(4);
      const text = (await page.textContent('body')) ?? '';
      expect(text).toContain('Line 5 of');
      expect(text).toContain('Line 8 of');
      expect(text).not.toContain('Line 4 of');
      expect(text).not.toContain('Line 9 of');
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /**
   * **A member writing a note from a chapter page anchors it to the playback position**
   * ([3.22.15](docs/project/prd.md)) — not to the chapter's start. A chapter is a lens over member
   * content, never its owner.
   */
  it('anchors a note written here to where the player is, not to the chapter', async () => {
    const page = await openTeaching(chapteredId);
    try {
      // Play into the third chapter, then open the *second* chapter's page and write a note.
      await bar(page).getByRole('button', { name: 'Play', exact: true }).click();
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 60_000 })
        .toBeGreaterThan(2);
      await bar(page).getByRole('button', { name: 'Pause' }).click();

      const at = (await audioState(page)).currentTime;
      await page.goto(`${baseUrl}${chapterPagePath(chapteredId, chapterIds[0]!)}`, {
        waitUntil: 'domcontentloaded',
      });
      const tabs = page.getByRole('tablist', { name: 'Chapter contents' });
      await expect.poll(() => tabs.count(), { timeout: 30_000 }).toBe(1);

      const composer = page.getByRole('textbox').first();
      await composer.fill(`A note from a chapter page ${RUN}`);
      await page.getByRole('button', { name: 'Save note' }).click();

      // The moment it took is the player's, which is a moment inside the first chapter here — so the
      // note appears on this page, anchored where the teaching was rather than at 00:00.
      await expect
        .poll(async () => (await page.textContent('body')) ?? '', { timeout: 30_000 })
        .toContain(`A note from a chapter page ${RUN}`);
      expect(at).toBeGreaterThan(0);
    } finally {
      await page.context().close();
    }
  }, 300_000);
});

/**
 * **Coming back from a chapter lands where the member left** — the `Chapters` tab open and the list
 * at the offset it had when the row was pressed — by the page's own control and by the browser's,
 * while a direct link to the teaching still opens `Notes` at the top.
 *
 * Against the twelve-chapter teaching in a window six hundred pixels tall, so the list genuinely
 * scrolls (see `TWELVE`). The offset asserted is the one the window actually had at the press,
 * read back from it rather than assumed from the `scrollTo`, and the row pressed is one in the
 * middle of the window at that offset — clear of the sticky navigation above and the docked
 * transport below. Playwright scrolls a row into view when its press does not land, and a press
 * that moved the list first would note an offset this test never saw: the first row, half under
 * the navigation, was pressed that way and noted an offset of zero.
 */
describe('coming back from a chapter', () => {
  const chapterOf = (id: string) => (url: URL) =>
    url.pathname.startsWith(`${recordingPagePath(id)}/`);
  const listOf = (id: string) => (url: URL) =>
    url.pathname === recordingPagePath(id) && url.searchParams.get('tab') === 'chapters';
  const scrollY = (page: Page) => page.evaluate(() => window.scrollY);
  const chaptersSelected = (page: Page) =>
    strip(page).getByRole('tab', { name: 'Chapters' }).getAttribute('aria-selected');

  /** Open the long teaching in a short window, open `Chapters`, and scroll partway down the list. */
  async function downTheList(): Promise<{ page: Page; offset: number }> {
    const page = await openTeaching(longId);
    await page.setViewportSize({ width: 1280, height: 600 });
    await openChapters(page);
    await expect
      .poll(() => panel(page).getByRole('listitem').count(), { timeout: 30_000 })
      .toBe(12);
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(() => scrollY(page), { timeout: 30_000 }).toBe(400);
    return { page, offset: await scrollY(page) };
  }

  /** The first row wholly inside the middle band of the window — the second quarter to the third. */
  async function rowInView(page: Page): Promise<Locator> {
    const rows = panel(page).getByRole('link', { name: /Part \d+ of twelve/ });
    const height = await page.evaluate(() => window.innerHeight);
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      const box = await rows.nth(index).boundingBox();
      if (box !== null && box.y >= height / 4 && box.y + box.height <= (3 * height) / 4) {
        return rows.nth(index);
      }
    }
    throw new Error('no chapter row is wholly inside the middle band of the window');
  }

  it('reopens Chapters at the offset the list was left at, by the page’s own back control', async () => {
    const { page, offset } = await downTheList();
    try {
      await (await rowInView(page)).click();
      await page.waitForURL(chapterOf(longId), { timeout: 30_000 });
      const tabs = page.getByRole('tablist', { name: 'Chapter contents' });
      await expect.poll(() => tabs.count(), { timeout: 30_000 }).toBe(1);
      // Pressing a tab here rewrites this page's own address; the way back has to survive that.
      await tabs.getByRole('tab', { name: 'Scripture' }).click();
      const entries = await page.evaluate(() => window.history.length);

      await page.getByRole('link', { name: 'Back to the teaching' }).click();
      await page.waitForURL(listOf(longId), { timeout: 30_000 });
      await expect.poll(() => panel(page).count(), { timeout: 30_000 }).toBe(1);
      expect(await chaptersSelected(page)).toBe('true');
      await expect.poll(() => scrollY(page), { timeout: 30_000 }).toBe(offset);
      // Back *through history* rather than to a third entry: the stack is no longer than it was on
      // the chapter page, so the browser's own back from here does not loop to the chapter again.
      expect(await page.evaluate(() => window.history.length)).toBe(entries);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('reopens Chapters at the same offset by the browser’s own back', async () => {
    const { page, offset } = await downTheList();
    try {
      await (await rowInView(page)).click();
      await page.waitForURL(chapterOf(longId), { timeout: 30_000 });
      await expect
        .poll(() => page.getByRole('tablist', { name: 'Chapter contents' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      await page.goBack();
      await page.waitForURL(listOf(longId), { timeout: 30_000 });
      await expect.poll(() => panel(page).count(), { timeout: 30_000 }).toBe(1);
      expect(await chaptersSelected(page)).toBe('true');
      await expect.poll(() => scrollY(page), { timeout: 30_000 }).toBe(offset);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /**
   * A fresh navigation to the teaching is not a return, whatever the last visit left: the bare
   * address opens `Notes` at the top, and the address the chapter page's control points at opens
   * the list — at the top too, because nothing was left on a fresh entry.
   */
  it('still opens Notes at the top from a direct link, and the list at the top from one naming it', async () => {
    const { page } = await downTheList();
    try {
      await (await rowInView(page)).click();
      await page.waitForURL(chapterOf(longId), { timeout: 30_000 });

      await page.goto(`${baseUrl}${recordingPagePath(longId)}`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => strip(page).getByRole('tab', { name: 'Chapters' }).count(), { timeout: 30_000 })
        .toBe(1);
      expect(await strip(page).getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(await chaptersSelected(page)).toBe('false');
      expect(await scrollY(page)).toBe(0);

      await page.goto(`${baseUrl}${recordingPagePath(longId)}?tab=chapters`, {
        waitUntil: 'domcontentloaded',
      });
      await expect.poll(() => panel(page).count(), { timeout: 30_000 }).toBe(1);
      expect(await chaptersSelected(page)).toBe('true');
      expect(await scrollY(page)).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

describe('what the transport says and draws (3.22.16, 3.22.17)', () => {
  /**
   * **The docked transport names the recording playing and, beneath it, the chapter playing now.**
   * Driven by playing into the teaching rather than by seeding a position, because the requirement
   * is about what the bar says *as the teaching moves*.
   */
  it('names the chapter playing beneath the teaching, and follows the teaching into the next one', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await expect
        .poll(async () => (await bar(page).textContent()) ?? '', { timeout: 30_000 })
        .toContain('The vine');

      // Seek past the second boundary; the line follows without a request.
      await seekTo(page, 2 * CHAPTER_MS + 5_000);

      await expect
        .poll(async () => (await bar(page).textContent()) ?? '', { timeout: 30_000 })
        .toContain('The gardener');
      // And the teaching is still named above it.
      expect(await bar(page).textContent()).toContain(CHAPTERED_TITLE);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /** A recording with no chapters shows the series name on that second line — what it held before. */
  it('leaves the second line as it was for a teaching with no chapters', async () => {
    const page = await openTeaching(plainId);
    try {
      await expect
        .poll(async () => (await bar(page).textContent()) ?? '', { timeout: 30_000 })
        .toContain(PLAIN_TITLE);
      // No chapter is named, because there are none — not a blank line where one would be.
      expect(await bar(page).textContent()).not.toContain('The vine');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * **The progress track marks every chapter boundary, distinguishable from the note markers**
   * ([3.22.17](docs/project/prd.md)) — "chapters divide the track, notes sit on it". Two boundaries
   * for three chapters: the first chapter's start divides the track from nothing.
   */
  it('draws a division on the track at every boundary but the first', async () => {
    const page = await openTeaching(chapteredId);
    try {
      const divisions = bar(page).locator('[class*="boundary"]');
      await expect.poll(() => divisions.count(), { timeout: 30_000 }).toBe(2);

      // Placed by where they are, not evenly: the second chapter is a third of the way in.
      const left = await divisions.first().evaluate((node) => (node as HTMLElement).style.left);
      expect(Number.parseFloat(left)).toBeGreaterThan(30);
      expect(Number.parseFloat(left)).toBeLessThan(37);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * **A division is drawn where the playhead actually stands at that moment**, which is a stronger
   * claim than the one above and the one a member checks by pressing a chapter's play control.
   *
   * A range thumb's *centre* travels from half a thumb in to half a thumb short of the end — it has
   * to stay inside the control — so a tick placed across the full width sits where the thumb never
   * quite is: furthest out at the ends, exact only at the midpoint. The tick layers are inset by
   * half a thumb to correct for it.
   *
   * Asserted by **pressing the track at the pixel the division is drawn at** and reading the value
   * that produces. That is the mapping from screen position to moment as the browser itself computes
   * it, so this cannot pass by restating the arithmetic the stylesheet uses — if the tick and the
   * thumb ever part company again, the press lands on a different second and this fails.
   *
   * **Against a teaching nobody has annotated**, which keeps the track free of note ticks over the
   * pixels this test presses. Neither layer takes a pointer now, so a tick could not swallow the
   * press — but a bare track is the plainest thing to measure the alignment against, and
   * `chapteredId` collects notes from the blocks above it.
   */
  it('draws each division at the pixel the playhead occupies for that moment', async () => {
    const page = await openTeaching(inSeriesId);
    try {
      const track = bar(page).getByRole('slider', { name: 'Position' });
      const divisions = bar(page).locator('[class*="boundary"]');
      await expect.poll(() => divisions.count(), { timeout: 30_000 }).toBe(2);

      const trackBox = await track.boundingBox();
      expect(trackBox).not.toBeNull();
      const midY = (trackBox as { y: number; height: number }).y +
        (trackBox as { height: number }).height / 2;

      // The two divisions are the starts of chapters two and three.
      const expected = [CHAPTER_MS, 2 * CHAPTER_MS];

      for (const [index, startMs] of expected.entries()) {
        const box = await divisions.nth(index).boundingBox();
        expect(box, `division ${index}`).not.toBeNull();
        const centreX =
          (box as { x: number; width: number }).x + (box as { width: number }).width / 2;

        await page.mouse.click(centreX, midY);

        /*
         * Polled, because the slider is controlled: the press seeks the element and the value comes
         * back through the player's state, so reading once races the render and reads the value the
         * *previous* press left behind.
         *
         * Within a second — the slider's own step, so this is "the nearest moment the control can
         * represent". The teaching is two minutes across roughly six hundred pixels, so a second is
         * about five pixels: the misalignment this guards against was more than one, and a tick that
         * drifts back to the full-width span never settles inside this and fails.
         */
        await expect
          .poll(async () => Math.abs(Number(await track.inputValue()) - startMs), {
            timeout: 30_000,
            message: `division ${index} should land on ${startMs}ms`,
          })
          .toBeLessThan(1_000);
      }
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * **The chapter is named on the second line and nowhere else on the bar.**
   *
   * The operator dropped [3.22.18](docs/project/prd.md) — the chapter beside the scrubber's
   * position — so the elapsed label is a bare timecode again, and this is what stops it coming back
   * by accident. The second line above is where a member reads which chapter is playing.
   */
  it('leaves the position label a bare timecode', async () => {
    const page = await openTeaching(chapteredId);
    try {
      const elapsed = bar(page).locator('[class*="time"]').first();
      await expect
        .poll(async () => (await elapsed.textContent()) ?? '', { timeout: 30_000 })
        .toBe('00:00');

      // Walk the thumb into the second chapter: the label follows the position and names nothing.
      const track = bar(page).getByRole('slider', { name: 'Position' });
      await track.focus();
      for (let press = 0; press < CHAPTER_MS / 1000 + 2; press += 1) {
        await track.press('ArrowRight');
      }

      const shown = (await elapsed.textContent()) ?? '';
      expect(shown).toMatch(/^\d{2}:\d{2}$/);
      expect(shown).not.toContain('The branches');
      // And the second line is still naming it, which is where it belongs (3.22.16).
      expect(await bar(page).textContent()).toContain('The vine');
    } finally {
      await page.context().close();
    }
  }, 300_000);
});

/** **The expanded now-playing view names the chapter playing** ([3.22.19](docs/project/prd.md)). */
describe('the now-playing view (3.22.19)', () => {
  it('names the chapter on the same footing as the recording', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await bar(page).getByRole('link', { name: 'Open the full player' }).click();
      await page.waitForURL(`${baseUrl}${NOW_PLAYING_PAGE_PATH}`, { timeout: 30_000 });

      const view = page.getByRole('region', { name: 'Now playing' });
      await expect.poll(() => view.count(), { timeout: 30_000 }).toBe(1);

      // The heading names both — the teaching and the part of it playing — and the chapter is drawn
      // where a member can see it.
      await expect
        .poll(
          async () =>
            (await view.getByRole('heading', { level: 1 }).textContent({ timeout: 5_000 })) ?? '',
          { timeout: 30_000 },
        )
        .toContain('The vine');
      expect(await view.textContent()).toContain('The vine');
      expect(await view.getByRole('heading', { level: 1 }).textContent()).toContain(CHAPTERED_TITLE);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

/**
 * **Editing chapters in place on the recording** ([3.22.7](docs/project/prd.md),
 * [3.19.14](docs/project/prd.md)).
 *
 * The controls are drawn for an admin and absent for a member. The member half is what matters: the
 * API refuses either way (asserted in `chapters.test.ts`), so what is under test here is that a
 * member is not offered a control that would not work.
 */
describe('editing chapters in place (3.22.7, 3.19.14)', () => {
  it('offers no editing controls to a member', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await openChapters(page);
      expect(await panel(page).getByRole('button', { name: 'Edit' }).count()).toBe(0);
      expect(await panel(page).getByRole('button', { name: 'Split' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('lets an admin retitle a chapter, and the transport says so at once', async () => {
    // Its own teaching, so rewriting the list disturbs nothing the suites above read.
    const page = await openTeaching(editableId, admin);
    try {
      await openChapters(page);
      await panel(page).getByRole('button', { name: 'Edit' }).first().click();

      const title = panel(page).getByLabel('Title');
      await title.fill(`The vine, renamed ${RUN}`);
      await panel(page).getByRole('button', { name: 'Save' }).click();

      await expect
        .poll(async () => (await panel(page).textContent()) ?? '', { timeout: 30_000 })
        .toContain(`The vine, renamed ${RUN}`);

      // The list the transport draws from is the list the write answered with, so the bar's second
      // line changed without the page being reloaded.
      await expect
        .poll(async () => (await bar(page).textContent()) ?? '', { timeout: 30_000 })
        .toContain(`The vine, renamed ${RUN}`);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});
