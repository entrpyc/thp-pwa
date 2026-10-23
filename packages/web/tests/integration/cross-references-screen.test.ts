import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { DASHBOARD_PAGE_PATH, ROLE, recordingPagePath } from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  insertSeries,
  listSegments,
  replaceChapters,
  replaceCrossReferencesForRun,
  replaceTranscript,
  setRecordingPublication,
  setRecordingSeries,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The related-teachings strip on the recording page, driven in a real browser against real
 * audio** ([3.9.2](docs/project/prd.md), [3.9.5](docs/project/prd.md), [3.2.12](docs/project/prd.md)).
 *
 * Real for the reason every player suite is: "nothing is drawn until the part playing has a
 * link", "the strip follows the position", and "pressing a link lands on the other teaching at
 * the moment, paused" are claims about a rendered page over a live media element, and a component
 * test would answer them however the component was written.
 *
 * **Two teachings of two minutes, forty-second chapters**, exactly as the transport suites seed
 * them, and one link planted between them directly through `@thp/db`: the worker's step is under
 * test in its own suite, and what this file is about is what a member sees of a link once it
 * exists.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const TEACHING_SECONDS = 120;
const LINE_MS = 10_000;
const CHAPTER_MS = 40_000;

const LISTENING_TITLE = `Related listening ${RUN}`;
const OTHER_TITLE = `Related other ${RUN}`;
const SERIES_TITLE = `Related study ${RUN}`;

const GENERATED = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' };

const THREE = [
  { startMs: 0, title: 'The vine', summary: 'What abiding means.' },
  { startMs: CHAPTER_MS, title: 'The branches', summary: 'The cost of pruning.' },
  { startMs: 2 * CHAPTER_MS, title: 'The gardener', summary: 'Who tends the field.' },
];

/** The line of the listening teaching that triggers the link: 50 s, inside the second chapter. */
const SOURCE_LINE = 5;
/** The moment in the other teaching the link opens: 30 s. */
const TARGET_LINE = 3;

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let listeningId: string;
let otherId: string;

interface Snapshot {
  readonly currentTime: number;
  readonly paused: boolean;
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

/** A published teaching with real audio, a transcript of twelve lines, and the chapters given. */
async function publishedTeaching(
  title: string,
  inSeries: string | null,
): Promise<{ id: string; segmentIds: string[] }> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording({ originalMediaKey: key, title, recordedAt: '2026-08-16' }, handle);
  const transcript = await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.95,
      segments: Array.from({ length: (TEACHING_SECONDS * 1000) / LINE_MS }, (_unused, index) => ({
        startMs: index * LINE_MS,
        endMs: (index + 1) * LINE_MS,
        text: `Line ${index + 1} of ${title}, long enough to be a sentence of its own.`,
      })),
    },
    handle,
  );
  await replaceChapters(row.id, THREE, GENERATED, handle);
  if (inSeries !== null) await setRecordingSeries(row.id, inSeries, handle);
  await setRecordingPublication(row.id, new Date(), handle);
  return { id: row.id, segmentIds: (await listSegments(transcript.id, handle)).map((one) => one.id) };
}

/** Sign in and open a teaching, waiting until the element has metadata, and rewind it. */
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

const strip = (page: Page): Locator => page.getByRole('region', { name: 'Related teachings' });

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  member = await createAccount(databaseUrl, ROLE.member, `related-member-${RUN}`);

  const study = await insertSeries({ title: SERIES_TITLE, description: null }, handle);
  const [listening, other] = await Promise.all([
    publishedTeaching(LISTENING_TITLE, null),
    publishedTeaching(OTHER_TITLE, study.id),
  ]);
  listeningId = listening.id;
  otherId = other.id;

  await replaceCrossReferencesForRun(
    listeningId,
    [
      {
        sourceRecordingId: listeningId,
        sourceSegmentId: listening.segmentIds[SOURCE_LINE] as string,
        targetRecordingId: otherId,
        targetSegmentId: other.segmentIds[TARGET_LINE] as string,
        score: 0.9,
        basis: 'semantic',
      },
    ],
    handle,
  );
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
}, 60_000);

describe('the related-teachings strip', () => {
  it('draws nothing until the chapter playing has a link, then names the other teaching, its series and the moment, and goes quiet again', async () => {
    const page = await openTeaching(listeningId);
    try {
      // The chapters are known — the tab is drawn off them — and the first chapter has no link.
      await expect.poll(() => page.getByRole('tab', { name: 'Chapters' }).count(), { timeout: 30_000 }).toBe(1);
      expect(await strip(page).count()).toBe(0);

      // Into the second chapter, where the planted sentence is.
      await seekTo(page, CHAPTER_MS + 5_000);
      await expect.poll(() => strip(page).count(), { timeout: 30_000 }).toBe(1);

      const link = strip(page).getByRole('link');
      await expect.poll(() => link.count()).toBe(1);
      const text = (await link.textContent()) ?? '';
      expect(text).toContain(OTHER_TITLE);
      expect(text).toContain(SERIES_TITLE);
      expect(text).toContain('at 00:30');
      expect(text).toContain(`Line ${TARGET_LINE + 1} of ${OTHER_TITLE}`);
      expect(await link.getAttribute('href')).toBe(recordingPagePath(otherId));

      // Out again, into the third chapter: nothing there, nothing drawn.
      await seekTo(page, 2 * CHAPTER_MS + 5_000);
      await expect.poll(() => strip(page).count(), { timeout: 30_000 }).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('opens the other teaching at the moment, paused (3.9.5, 3.2.12)', async () => {
    const page = await openTeaching(listeningId);
    try {
      await seekTo(page, CHAPTER_MS + 5_000);
      await expect.poll(() => strip(page).count(), { timeout: 30_000 }).toBe(1);

      await strip(page).getByRole('link').click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(otherId)}`, { timeout: 30_000 });

      // The transport holds the other teaching, at the link's moment, and nothing is playing: a
      // member who pressed a related moment has not asked for sound.
      await expect
        .poll(async () => (await audioState(page)).duration, { timeout: 60_000 })
        .toBeGreaterThan(0);
      await expect
        .poll(async () => Math.round((await audioState(page)).currentTime), { timeout: 30_000 })
        .toBe(TARGET_LINE * (LINE_MS / 1000));
      expect((await audioState(page)).paused).toBe(true);
      await expect.poll(() => page.getByRole('heading', { level: 1 }).textContent()).toBe(OTHER_TITLE);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
