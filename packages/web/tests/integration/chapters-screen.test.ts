import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  NOW_PLAYING_PAGE_PATH,
  ROLE,
  chapterPagePath,
  recordingPagePath,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  listChapters,
  replaceChapters,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The chapter surfaces, driven in a real browser** ([3.22.10](docs/project/prd.md)–
 * [3.22.19](docs/project/prd.md)).
 *
 * Real for the reason every player suite here is real: four of these requirements are claims about a
 * *live media element* — that selecting a chapter does not start it (3.22.12), that the play control
 * does, that the transport names the chapter it has reached (3.22.16), and that the track names the
 * chapter under a thumb being dragged (3.22.18). None of those is a claim a component test can make,
 * because none of them is true of anything but an element that is actually decoding audio.
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

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let admin: TestAccount;
let chapteredId: string;
let plainId: string;
/** A third teaching, so the admin suite can rewrite a list without disturbing the others. */
let editableId: string;
let chapterIds: string[] = [];

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
      // The other tabs are there, so this is the strip having decided rather than not having drawn.
      await expect
        .poll(() => strip(page).getByRole('tab', { name: 'Transcript' }).count(), { timeout: 30_000 })
        .toBe(1);
      expect(await strip(page).getByRole('tab', { name: 'Chapters' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

describe('the search over the list (3.22.11)', () => {
  it('narrows the list as the member types, on the title and on the summary', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await openChapters(page);
      const field = panel(page).getByLabel('Search these chapters');
      const rows = panel(page).getByRole('listitem');

      await field.fill('vine');
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(1);
      expect(await panel(page).textContent()).toContain('The vine');

      // A word that appears in a *summary* and in no title — the filter reads both (3.22.11).
      await field.fill('pruning');
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(1);
      expect(await panel(page).textContent()).toContain('The branches');

      // Clearing the field is the way back rather than a control of its own.
      await field.fill('');
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(3);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('says so when nothing matches, rather than showing an empty box', async () => {
    const page = await openTeaching(chapteredId);
    try {
      await openChapters(page);
      await panel(page).getByLabel('Search these chapters').fill('ezekiel');
      await expect
        .poll(async () => (await panel(page).textContent()) ?? '', { timeout: 30_000 })
        .toContain('No chapter of this teaching matches');
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

      // 3.22.13's route back — to the teaching this chapter divides, rather than to the library.
      await page.getByRole('link', { name: 'Back to the teaching' }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(chapteredId)}`, { timeout: 30_000 });
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
      expect(await tabs.getByRole('tab', { name: 'Transcript' }).count()).toBe(1);
      expect(await tabs.getByRole('tab', { name: 'Chapters' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /** **The transcript shows that chapter's lines and stops at its boundaries** (3.22.14). */
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

describe('what the transport says and draws (3.22.16, 3.22.17, 3.22.18)', () => {
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
   * **Scrubbing the track names the chapter under the thumb alongside the position**
   * ([3.22.18](docs/project/prd.md)) — so a member dragging toward a part of the teaching sees what
   * they are dragging into rather than a timecode alone.
   */
  it('names the chapter under the thumb while the track is being moved', async () => {
    const page = await openTeaching(chapteredId);
    try {
      const elapsed = bar(page).locator('[class*="time"]').first();
      // Before any gesture it is the timecode it has always been.
      await expect
        .poll(async () => (await elapsed.textContent()) ?? '', { timeout: 30_000 })
        .toBe('00:00');

      // Hovering over the last third of the track: the same answer the drag gives (3.22.18).
      const track = bar(page).getByRole('slider', { name: 'Position' });
      const box = await track.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width * 0.9, box!.y + box!.height / 2);

      await expect
        .poll(async () => (await elapsed.textContent()) ?? '', { timeout: 30_000 })
        .toContain('The gardener');
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /**
   * The other half of 3.22.18 — the **drag**, which is the case the requirement is written about.
   * The hover above is what "where a pointer can hover" adds to it, and both come through one
   * function precisely so a member on a phone and a member on a desktop are told the same thing.
   *
   * Driven from the keyboard, because that is a drag of the slider that needs no pointer: the
   * scrubber is a real range input, so an arrow key is a move of the thumb.
   */
  it('names the chapter under the thumb while the track is being dragged', async () => {
    const page = await openTeaching(chapteredId);
    try {
      const elapsed = bar(page).locator('[class*="time"]').first();
      const track = bar(page).getByRole('slider', { name: 'Position' });

      await track.focus();
      // The scrubber steps in seconds, so this walks the thumb into the second chapter.
      for (let press = 0; press < CHAPTER_MS / 1000 + 2; press += 1) {
        await track.press('ArrowRight');
      }

      await expect
        .poll(async () => (await elapsed.textContent()) ?? '', { timeout: 30_000 })
        .toContain('The branches');
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
