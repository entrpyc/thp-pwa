import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import {
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  ROLE,
  recordingMindMapPath,
  recordingPagePath,
  type MindMapNode,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  publishMindMap,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The Mindmap tab, driven in a real browser** ([3.8.3](docs/project/prd.md),
 * [3.8.4](docs/project/prd.md)) — `pages/recording.png`.
 *
 * Real for the reason every other screen suite here is: "the tab is absent entirely", "the points
 * are folded until a theme is pressed" and "the panel is fetched when first opened" are properties
 * of a rendered strip, a rendered canvas and a network log, and a component test would answer all
 * three however the component was written.
 *
 * Two teachings carry the file: one with an approved map, one with none.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEACHING_SECONDS = 120;

const MAP: MindMapNode = {
  id: 'n1',
  label: `Mapped teaching ${RUN}`,
  anchorMs: null,
  children: [
    {
      id: 'n2',
      label: 'Grace that cannot be earned',
      anchorMs: 4000,
      children: [
        { id: 'n3', label: 'Given before it is asked for', anchorMs: 4000, children: [] },
        { id: 'n4', label: 'Received, never taken', anchorMs: null, children: [] },
      ],
    },
    { id: 'n5', label: 'The law and what it is for', anchorMs: 8000, children: [] },
  ],
};

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;

/** Published, with audio, a transcript and an approved map. */
let mappedId: string;
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

async function openTeaching(id: string): Promise<{ page: Page; requests: Request[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
  const page = await context.newPage();
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

  await page.goto(`${baseUrl}${recordingPagePath(id)}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('tab', { name: 'Notes' }).count(), { timeout: 60_000 })
    .toBe(1);
  return { page, requests };
}

async function tabNames(page: Page): Promise<string[]> {
  return page
    .locator('[role="tablist"][aria-label="Teaching contents"] [role="tab"]')
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
const canvasOf = (page: Page) => page.getByRole('group', { name: 'Mind map of this teaching' });
const nodeOf = (page: Page, id: string) => canvasOf(page).locator(`[data-node-id="${id}"]`);

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  browser = await chromium.launch();
  member = await createAccount(databaseUrl, ROLE.member, 'mind-map-screen-member');

  mappedId = await publishedRecording(MAP.label);
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
      expect(await tabNames(page)).toEqual(['Notes', 'Transcript', 'Mindmap']);
    } finally {
      await page.context().close();
    }

    const bare = await openTeaching(bareId);
    try {
      expect(await tabNames(bare.page)).toEqual(['Notes', 'Transcript']);
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

  it('opens with the teaching and its themes on screen and the points folded under a count', async () => {
    const { page } = await openTeaching(mappedId);
    try {
      await page.getByRole('tab', { name: 'Mindmap' }).click();
      await expect.poll(() => nodeOf(page, 'n1').count(), { timeout: 30_000 }).toBe(1);

      // Root and both themes drawn; neither point is.
      expect(await nodeOf(page, 'n2').count()).toBe(1);
      expect(await nodeOf(page, 'n5').count()).toBe(1);
      expect(await nodeOf(page, 'n3').count()).toBe(0);
      expect(await nodeOf(page, 'n4').count()).toBe(0);

      // The theme with points says how many it hides, and reads as collapsed.
      const theme = nodeOf(page, 'n2').getByRole('button', { name: /Grace that cannot be earned/ });
      expect(await theme.getAttribute('aria-expanded')).toBe('false');
      expect(await nodeOf(page, 'n2').getByText('+2').count()).toBe(1);

      // A theme with nothing under it is text, not a control that does nothing.
      expect(await nodeOf(page, 'n5').getByRole('button', { name: /law/ }).count()).toBe(0);

      // Pressing the theme reveals its points, to its right.
      await theme.click();
      await expect.poll(() => nodeOf(page, 'n3').count(), { timeout: 10_000 }).toBe(1);
      expect(await nodeOf(page, 'n4').count()).toBe(1);
      expect(await theme.getAttribute('aria-expanded')).toBe('true');
      const themeBox = await nodeOf(page, 'n2').boundingBox();
      const pointBox = await nodeOf(page, 'n3').boundingBox();
      expect(pointBox!.x).toBeGreaterThan(themeBox!.x + themeBox!.width);

      // And pressing it again folds them away.
      await theme.click();
      await expect.poll(() => nodeOf(page, 'n3').count(), { timeout: 10_000 }).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('carries a timecode on a placed node, which goes to the moment without starting sound', async () => {
    const { page } = await openTeaching(mappedId);
    try {
      await page.getByRole('tab', { name: 'Mindmap' }).click();
      await expect.poll(() => nodeOf(page, 'n5').count(), { timeout: 30_000 }).toBe(1);

      // 3.8.4 — the moment the theme names, as a control.
      const chip = nodeOf(page, 'n5').getByRole('button', { name: 'Go to 00:08' });
      expect(await chip.count()).toBe(1);
      // An unplaced node carries none: the root has no chip at all.
      expect(await nodeOf(page, 'n1').getByRole('button', { name: /Go to/ }).count()).toBe(0);

      await chip.click();

      // Seeking, not playing: the element moves and stays paused (3.5.4's rule, kept here).
      await expect
        .poll(() => page.evaluate(() => Math.round(document.querySelector('audio')?.currentTime ?? -1)), { timeout: 30_000 })
        .toBe(8);
      expect(await page.evaluate(() => document.querySelector('audio')?.paused)).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('takes the same canvas full screen and back, keeping what was opened', async () => {
    const { page } = await openTeaching(mappedId);
    try {
      await page.getByRole('tab', { name: 'Mindmap' }).click();
      await expect.poll(() => nodeOf(page, 'n2').count(), { timeout: 30_000 }).toBe(1);
      await nodeOf(page, 'n2').getByRole('button', { name: /Grace/ }).click();
      await expect.poll(() => nodeOf(page, 'n3').count(), { timeout: 10_000 }).toBe(1);

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
      // The opened theme is still open: same element, larger.
      expect(await nodeOf(page, 'n3').count()).toBe(1);

      await page.keyboard.press('Escape');
      await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0);
      expect(await nodeOf(page, 'n3').count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
