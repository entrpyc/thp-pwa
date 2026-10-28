import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import {
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  ROLE,
  chapterPagePath,
  recordingMindMapPath,
  recordingPagePath,
  type MindMapNode,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  publishMindMap,
  replaceChapters,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The Mindmap tab, driven in a real browser** ([3.8.3](docs/project/prd.md),
 * [3.8.4](docs/project/prd.md)) — `pages/recording.png`, and the chapter page's reading of it.
 *
 * Real for the reason every other screen suite here is: "the tab is absent entirely", "every
 * branch opens unfolded and only the fold control folds it" and "the panel is fetched when first
 * opened" are properties of a rendered strip, a rendered canvas and a network log, and a
 * component test would answer all three however the component was written.
 *
 * Two teachings carry the file: one with an approved map and the chapters it is built on, one
 * with none.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEACHING_SECONDS = 120;

/** Four levels: the teaching, two chapters, a theme under the first, two concepts under it. */
const MAP: MindMapNode = {
  id: 'n1',
  label: `Mapped teaching ${RUN}`,
  anchorMs: null,
  children: [
    {
      id: 'n2',
      label: 'Where we left off',
      anchorMs: 0,
      children: [
        {
          id: 'n3',
          label: 'Grace that cannot be earned',
          anchorMs: 4000,
          children: [
            { id: 'n4', label: 'Given before it is asked for', anchorMs: 4000, children: [] },
            { id: 'n5', label: 'Received, never taken', anchorMs: null, children: [] },
          ],
        },
      ],
    },
    { id: 'n6', label: 'The law and what it is for', anchorMs: 8000, children: [] },
  ],
};

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;

/** Published, with audio, a transcript, two chapters and an approved map. */
let mappedId: string;
/** The first chapter of the mapped teaching — the one with a branch under it. */
let chapterId: string;
/** Published, with audio and a transcript, and no map. */
let bareId: string;

async function publishedRecording(title: string): Promise<string> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording({ originalMediaKey: key, title, recordedAt: '2026-08-16' }, handle);
  await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.94,
      segments: [
        { startMs: 0, endMs: 4000, text: 'Turn with me to the eighth chapter.' },
        { startMs: 4000, endMs: 8000, text: 'Grace is the whole of it.' },
        { startMs: 8000, endMs: 12000, text: 'And the law shows us why.' },
      ],
    },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function signIn(): Promise<{ page: Page; requests: Request[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
  const page = await context.newPage();
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return { page, requests };
}

async function openTeaching(id: string): Promise<{ page: Page; requests: Request[] }> {
  const opened = await signIn();
  await opened.page.goto(`${baseUrl}${recordingPagePath(id)}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => opened.page.getByRole('tab', { name: 'Notes' }).count(), { timeout: 60_000 })
    .toBe(1);
  return opened;
}

async function openChapter(id: string, chapter: string): Promise<{ page: Page; requests: Request[] }> {
  const opened = await signIn();
  await opened.page.goto(`${baseUrl}${chapterPagePath(id, chapter)}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => opened.page.getByRole('tablist', { name: 'Chapter contents' }).count(), {
      timeout: 60_000,
    })
    .toBe(1);
  return opened;
}

async function tabNames(page: Page, list: string): Promise<string[]> {
  return page
    .locator(`[role="tablist"][aria-label="${list}"] [role="tab"]`)
    .evaluateAll((tabs) =>
      tabs.map((tab) => {
        const label = tab.getAttribute('aria-label');
        if (label !== null) return label;
        const clone = tab.cloneNode(true) as HTMLElement;
        for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
        return (clone.textContent ?? '').trim();
      }),
    );
}

function mapCalls(requests: readonly Request[], id: string): number {
  return requests.filter((one) => one.url().includes(`${API_PREFIX}${recordingMindMapPath(id)}`)).length;
}

const panelOf = (page: Page) => page.getByRole('region', { name: 'Mind map' });
const canvasOf = (page: Page, subject = 'this teaching') =>
  page.getByRole('group', { name: `Mind map of ${subject}` });
const nodeOf = (page: Page, id: string, subject = 'this teaching') =>
  canvasOf(page, subject).locator(`[data-node-id="${id}"]`);
const foldOf = (page: Page, id: string, subject = 'this teaching') =>
  nodeOf(page, id, subject).getByRole('button', { name: /^(Collapse|Expand) / });

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  browser = await chromium.launch();
  member = await createAccount(databaseUrl, ROLE.member, 'mind-map-screen-member');

  mappedId = await publishedRecording(MAP.label);
  const chapters = await replaceChapters(
    mappedId,
    [
      { startMs: 0, title: 'Where we left off', summary: 'The opening.', editedByAdmin: false },
      { startMs: 8000, title: 'The law and what it is for', summary: 'The close.', editedByAdmin: false },
    ],
    { model: 'test', modelVersion: '1', promptVersion: 'test' },
    handle,
  );
  chapterId = chapters[0]!.id;
  await publishMindMap(mappedId, MAP, false, handle);
  bareId = await publishedRecording(`Unmapped teaching ${RUN}`);
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the Mindmap tab on the recording page', () => {
  it('draws Mindmap last in the strip for a teaching with an approved map, and not at all without one', async () => {
    const { page } = await openTeaching(mappedId);
    try {
      // `Chapters` arrives once the chapter list is fetched, so the strip is read once it has.
      await expect
        .poll(() => tabNames(page, 'Teaching contents'), { timeout: 30_000 })
        .toEqual(['Notes', 'Chapters', 'Transcript', 'Mindmap']);
    } finally {
      await page.context().close();
    }

    const bare = await openTeaching(bareId);
    try {
      expect(await tabNames(bare.page, 'Teaching contents')).toEqual(['Notes', 'Transcript']);
      expect(await panelOf(bare.page).count()).toBe(0);
    } finally {
      await bare.page.context().close();
    }
  }, 180_000);

  it('fetches the map when the tab is first opened, and not before', async () => {
    const { page, requests } = await openTeaching(mappedId);
    try {
      expect(mapCalls(requests, mappedId)).toBe(0);
      expect(await panelOf(page).count()).toBe(0);

      await page.getByRole('tab', { name: 'Mindmap' }).click();
      await expect.poll(() => mapCalls(requests, mappedId), { timeout: 30_000 }).toBe(1);
      await expect.poll(() => panelOf(page).count(), { timeout: 30_000 }).toBe(1);

      // Pressing it again puts it away.
      await page.getByRole('tab', { name: 'Mindmap' }).click();
      await expect.poll(() => panelOf(page).count(), { timeout: 30_000 }).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('opens with every branch unfolded, folds only from the control on the right, and never folds the root', async () => {
    const { page } = await openTeaching(mappedId);
    try {
      await page.getByRole('tab', { name: 'Mindmap' }).click();
      await expect.poll(() => nodeOf(page, 'n1').count(), { timeout: 30_000 }).toBe(1);

      // All four levels drawn at once: root, both chapters, the theme and its concepts.
      for (const id of ['n2', 'n3', 'n4', 'n5', 'n6']) {
        expect(await nodeOf(page, id).count()).toBe(1);
      }
      // Each level to the right of the one before it.
      const root = await nodeOf(page, 'n1').boundingBox();
      const chapter = await nodeOf(page, 'n2').boundingBox();
      const theme = await nodeOf(page, 'n3').boundingBox();
      const concept = await nodeOf(page, 'n4').boundingBox();
      expect(chapter!.x).toBeGreaterThan(root!.x + root!.width);
      expect(theme!.x).toBeGreaterThan(chapter!.x + chapter!.width);
      expect(concept!.x).toBeGreaterThan(theme!.x + theme!.width);

      // The root has no fold control; neither does a node with nothing under it.
      expect(await foldOf(page, 'n1').count()).toBe(0);
      expect(await foldOf(page, 'n6').count()).toBe(0);

      // The theme's control sits at the right edge of its box, reads as open, and folds on a press.
      const fold = foldOf(page, 'n3');
      expect(await fold.getAttribute('aria-expanded')).toBe('true');
      const foldBox = await fold.boundingBox();
      // Flush with the box's right edge, give or take its border.
      expect(Math.abs(foldBox!.x + foldBox!.width - (theme!.x + theme!.width))).toBeLessThanOrEqual(2);
      // Pressing the words does nothing: the label is not a control.
      await nodeOf(page, 'n3').getByText('Grace that cannot be earned').click();
      expect(await nodeOf(page, 'n4').count()).toBe(1);

      await fold.click();
      await expect.poll(() => nodeOf(page, 'n4').count(), { timeout: 10_000 }).toBe(0);
      expect(await nodeOf(page, 'n5').count()).toBe(0);
      expect(await fold.getAttribute('aria-expanded')).toBe('false');

      // And pressing it again opens them back up.
      await fold.click();
      await expect.poll(() => nodeOf(page, 'n4').count(), { timeout: 10_000 }).toBe(1);
      expect(await fold.getAttribute('aria-expanded')).toBe('true');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('carries a timecode on a placed node, which goes to the moment without starting sound, and a play control that plays', async () => {
    const { page } = await openTeaching(mappedId);
    try {
      await page.getByRole('tab', { name: 'Mindmap' }).click();
      await expect.poll(() => nodeOf(page, 'n6').count(), { timeout: 30_000 }).toBe(1);

      // 3.8.4 — the moment the chapter names, as a control.
      const chip = nodeOf(page, 'n6').getByRole('button', { name: 'Go to 00:08' });
      expect(await chip.count()).toBe(1);
      // An unplaced node carries none: the root has no chip at all.
      expect(await nodeOf(page, 'n1').getByRole('button', { name: /Go to/ }).count()).toBe(0);
      expect(await nodeOf(page, 'n1').getByRole('button', { name: /Play from/ }).count()).toBe(0);

      await chip.click();

      // Seeking, not playing: the element moves and stays paused (3.5.4's rule, kept here).
      await expect
        .poll(() => page.evaluate(() => Math.round(document.querySelector('audio')?.currentTime ?? -1)), { timeout: 30_000 })
        .toBe(8);
      expect(await page.evaluate(() => document.querySelector('audio')?.paused)).toBe(true);

      // The play control before the time goes to the theme's moment and starts sound.
      await nodeOf(page, 'n3').getByRole('button', { name: 'Play from 00:04' }).click();
      await expect
        .poll(() => page.evaluate(() => document.querySelector('audio')?.paused), { timeout: 30_000 })
        .toBe(false);
      expect(
        await page.evaluate(() => Math.floor(document.querySelector('audio')?.currentTime ?? -1)),
      ).toBeGreaterThanOrEqual(4);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('takes the same canvas full screen and back, keeping what was folded', async () => {
    const { page } = await openTeaching(mappedId);
    try {
      await page.getByRole('tab', { name: 'Mindmap' }).click();
      await expect.poll(() => nodeOf(page, 'n3').count(), { timeout: 30_000 }).toBe(1);
      await foldOf(page, 'n3').click();
      await expect.poll(() => nodeOf(page, 'n4').count(), { timeout: 10_000 }).toBe(0);

      await page.getByRole('button', { name: 'Full screen' }).click();
      const dialog = page.getByRole('dialog', { name: 'Mind map, full screen' });
      await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(1);
      // The whole viewport, less the page's own scrollbar where the browser draws one.
      const box = await dialog.boundingBox();
      const inner = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        height: window.innerHeight,
      }));
      expect(Math.round(box!.x)).toBe(0);
      expect(Math.round(box!.y)).toBe(0);
      // A classic scrollbar on the page costs the overlay its width and nothing more.
      expect(box!.width).toBeGreaterThanOrEqual(inner.width - 20);
      expect(Math.round(box!.height)).toBe(inner.height);
      // The folded theme is still folded: same element, larger.
      expect(await nodeOf(page, 'n3').count()).toBe(1);
      expect(await nodeOf(page, 'n4').count()).toBe(0);

      await page.keyboard.press('Escape');
      await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0);
      expect(await nodeOf(page, 'n4').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('the Mindmap tab on the chapter page', () => {
  it('draws the chapter’s own branch with the chapter as a root that cannot be folded', async () => {
    const { page, requests } = await openChapter(mappedId, chapterId);
    try {
      expect(await tabNames(page, 'Chapter contents')).toEqual(['Notes', 'Scripture', 'Transcript', 'Mindmap']);
      expect(mapCalls(requests, mappedId)).toBe(0);

      await page.getByRole('tab', { name: 'Mindmap' }).click();
      await expect.poll(() => mapCalls(requests, mappedId), { timeout: 30_000 }).toBe(1);
      await expect
        .poll(() => nodeOf(page, 'n2', 'this chapter').count(), { timeout: 30_000 })
        .toBe(1);

      // The chapter at the left, its theme and concepts to the right — and nothing of the
      // teaching outside it: neither the teaching's root nor the other chapter.
      for (const id of ['n3', 'n4', 'n5']) {
        expect(await nodeOf(page, id, 'this chapter').count()).toBe(1);
      }
      expect(await nodeOf(page, 'n1', 'this chapter').count()).toBe(0);
      expect(await nodeOf(page, 'n6', 'this chapter').count()).toBe(0);
      const chapter = await nodeOf(page, 'n2', 'this chapter').boundingBox();
      const theme = await nodeOf(page, 'n3', 'this chapter').boundingBox();
      expect(theme!.x).toBeGreaterThan(chapter!.x + chapter!.width);

      // The chapter is the root here, so it has no fold control; the theme under it still does.
      expect(await foldOf(page, 'n2', 'this chapter').count()).toBe(0);
      expect(await foldOf(page, 'n3', 'this chapter').count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('offers no Mindmap tab on a chapter of a teaching without a map', async () => {
    const chapters = await replaceChapters(
      bareId,
      [{ startMs: 0, title: 'Only chapter', summary: 'All of it.', editedByAdmin: false }],
      { model: 'test', modelVersion: '1', promptVersion: 'test' },
      handle,
    );
    const { page } = await openChapter(bareId, chapters[0]!.id);
    try {
      expect(await tabNames(page, 'Chapter contents')).toEqual(['Notes', 'Scripture', 'Transcript']);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
