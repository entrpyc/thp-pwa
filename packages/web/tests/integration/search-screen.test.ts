import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  MEANING_LABELS,
  ROLE,
  SEARCH_PAGE_PATH,
  SEARCH_PATH,
  WORDS_MATCH_LABEL,
  chapterPagePath,
  recordingPagePath,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  listChapters,
  listSegments,
  replaceChapters,
  replaceTranscript,
  setRecordingPublication,
  upsertEmbeddings,
  type DatabaseHandle,
  type NewEmbedding,
} from '@thp/db';
import { fakeVector } from '@thp/embed';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **Search, driven in a real browser** ([3.10.1](docs/project/prd.md), [3.10.6](docs/project/prd.md),
 * [3.10.7](docs/project/prd.md), [3.10.11](docs/project/prd.md)).
 *
 * Real for the reason the chapter suite is: one claim here is about a live media element — that
 * selecting a result lands on the moment and does **not** start sound ([3.2.12](docs/project/prd.md))
 * — and only an element that is actually decoding audio can make it.
 *
 * The teaching is thirty seconds long with a line every ten; the fake embedder means a search for
 * a line's own words is a distance of zero from it, which is all the ranking this screen test needs.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TITLE = `Search screen teaching ${RUN}`;
const LINES = [
  `Opening words ${RUN}.`,
  `The lost sheep is carried home ${RUN}.`,
  `Closing words ${RUN}.`,
];
const CHAPTER_TITLE = `The ninety-nine ${RUN}`;

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let recordingId: string;
let chapterId: string;

async function audioState(page: Page) {
  return page.evaluate(() => {
    const element = document.querySelector('audio');
    return {
      currentTime: element?.currentTime ?? -1,
      paused: element?.paused ?? true,
      duration: Number.isFinite(element?.duration) ? (element?.duration ?? 0) : 0,
    };
  });
}

async function signedInPage(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return page;
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 4 });
  member = await createAccount(databaseUrl, ROLE.member, 'search-screen');

  const { key } = await uploadTestAudio(settings, 30);
  const row = await insertRecording({ originalMediaKey: key, title: TITLE, recordedAt: '2026-08-16' }, handle);
  recordingId = row.id;
  const transcript = await replaceTranscript(
    {
      recordingId,
      language: 'en',
      confidence: 0.95,
      segments: LINES.map((text, index) => ({ startMs: index * 10_000, endMs: (index + 1) * 10_000, text })),
    },
    handle,
  );
  await replaceChapters(
    recordingId,
    [
      { startMs: 0, title: 'Opening', summary: 'How it begins.' },
      { startMs: 20_000, title: CHAPTER_TITLE, summary: 'The shepherd goes looking.' },
    ],
    { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' },
    handle,
  );
  const chapters = await listChapters(recordingId, handle);
  chapterId = chapters[1]?.id ?? '';
  const rows: NewEmbedding[] = [
    ...(await listSegments(transcript.id, handle)).map((segment) => ({
      sourceKind: 'segment' as const,
      sourceId: segment.id,
      recordingId,
      ownerUserId: null,
      text: segment.text,
      vector: fakeVector(segment.text),
      model: 'fake-embed-1',
    })),
    ...chapters.map((chapter) => ({
      sourceKind: 'chapter' as const,
      sourceId: chapter.id,
      recordingId,
      ownerUserId: null,
      text: `${chapter.title}\n\n${chapter.summary}`,
      vector: fakeVector(`${chapter.title}\n\n${chapter.summary}`),
      model: 'fake-embed-1',
    })),
  ];
  await upsertEmbeddings(rows, handle);
  await setRecordingPublication(recordingId, new Date(), handle);
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

describe('the way to the search from the navigation (3.10.1)', () => {
  it('goes to the search page from the magnifier on any screen, and searches on Enter there', async () => {
    const page = await signedInPage();
    // A link, not a button that opens a bar: the search page is where the box and the results are.
    await page.getByRole('link', { name: 'Search' }).click();
    await page.waitForURL((url) => url.pathname === SEARCH_PAGE_PATH, { timeout: 30_000 });
    const box = page.getByRole('searchbox', { name: 'Search for' });
    await expect.poll(() => box.isVisible(), { timeout: 30_000 }).toBe(true);
    await box.fill(LINES[1] ?? '');
    await box.press('Enter');
    await page.waitForURL((url) => url.searchParams.get('q') === LINES[1], { timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe(SEARCH_PAGE_PATH);
    await page.context().close();
  });
});

describe('the results page (3.10.6, 3.10.7)', () => {
  it('prints the match in context with its teaching and moment, and opens the moment without playing', async () => {
    const page = await signedInPage();
    await page.goto(`${baseUrl}${SEARCH_PAGE_PATH}?q=${encodeURIComponent(LINES[1] ?? '')}`, {
      waitUntil: 'domcontentloaded',
    });
    const results = page.getByRole('list', { name: 'Search results' });
    await expect.poll(() => results.isVisible(), { timeout: 30_000 }).toBe(true);
    const first = results.getByRole('listitem').first();
    await expect.poll(() => first.textContent()).toContain(TITLE);
    expect(await first.textContent()).toContain(LINES[1]);
    // The line before and after, in context, and the moment at the right.
    expect(await first.textContent()).toContain(LINES[0]);
    expect(await first.textContent()).toContain('00:10');

    await first.getByRole('link').click();
    await page.waitForURL(`${baseUrl}${recordingPagePath(recordingId)}`, { timeout: 30_000 });
    await expect.poll(async () => (await audioState(page)).duration, { timeout: 60_000 }).toBeGreaterThan(0);
    const state = await audioState(page);
    expect(state.paused).toBe(true);
    expect(state.currentTime).toBeCloseTo(10, 0);
    await page.context().close();
  });

  it('a chapter match opens the chapter’s page', async () => {
    const page = await signedInPage();
    await page.goto(`${baseUrl}${SEARCH_PAGE_PATH}?q=${encodeURIComponent(CHAPTER_TITLE)}`, {
      waitUntil: 'domcontentloaded',
    });
    const results = page.getByRole('list', { name: 'Search results' });
    await expect.poll(() => results.isVisible(), { timeout: 30_000 }).toBe(true);
    const first = results.getByRole('listitem').first();
    expect(await first.textContent()).toContain('Chapter');
    expect(await first.textContent()).toContain(CHAPTER_TITLE);
    await first.getByRole('link').click();
    await page.waitForURL(`${baseUrl}${chapterPagePath(recordingId, chapterId)}`, { timeout: 30_000 });
    await page.context().close();
  });

  it('says how a row matched: a words hit in bold terms, a meaning hit by its bucket label', async () => {
    const page = await signedInPage();
    // The line's own words: both arms place it first, so the row carries both explanations.
    await page.goto(`${baseUrl}${SEARCH_PAGE_PATH}?q=${encodeURIComponent(LINES[1] ?? '')}`, {
      waitUntil: 'domcontentloaded',
    });
    const results = page.getByRole('list', { name: 'Search results' });
    await expect.poll(() => results.isVisible(), { timeout: 30_000 }).toBe(true);
    const first = results.getByRole('listitem').first();
    await expect.poll(() => first.textContent()).toContain(TITLE);

    const labels = first.getByTestId('match-labels');
    expect(await labels.textContent()).toContain(MEANING_LABELS.strong);
    expect(await labels.textContent()).toContain(WORDS_MATCH_LABEL);
    // Never the number.
    expect(await first.textContent()).not.toMatch(/0\.\d{2,}/);

    const bold = first.locator('strong');
    expect(await bold.count()).toBeGreaterThan(0);
    const boldWords = (await bold.allTextContents()).map((word) => word.toLowerCase());
    expect(boldWords).toContain('sheep');
    expect(boldWords).toContain('carried');
    // The context line is not marked: nothing bold outside the matched passage.
    expect(await first.locator(`text=${LINES[0]}`).locator('strong').count()).toBe(0);

    // A member sees no scores disclosure; the numbers are the operator's.
    expect(await first.getByTestId('scores').count()).toBe(0);
    await page.context().close();
  });

  it('the content-type control narrows the search and writes the choice to the address', async () => {
    const page = await signedInPage();
    await page.goto(`${baseUrl}${SEARCH_PAGE_PATH}?q=${encodeURIComponent(LINES[1] ?? '')}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect
      .poll(() => page.getByRole('list', { name: 'Search results' }).isVisible(), { timeout: 30_000 })
      .toBe(true);
    // Untick everything but Notes: the address names the one kind, and this teaching has no notes.
    for (const label of ['Chapters', 'Transcript', 'Summaries', 'Recordings']) {
      await page.getByLabel(label).click();
      await page.waitForURL((url) => url.searchParams.get('q') !== null, { timeout: 30_000 });
    }
    await page.waitForURL((url) => url.searchParams.get('kinds') === 'note', { timeout: 30_000 });
    // Either nothing — this teaching has no notes — or, with other suites' notes in the shared
    // library, rows that are every one of them a Note. Never this teaching's transcript line.
    const empty = page.locator('[data-state="empty"]');
    const results = page.getByRole('list', { name: 'Search results' });
    await expect
      .poll(async () => (await empty.isVisible()) || (await results.isVisible()), { timeout: 30_000 })
      .toBe(true);
    if (await results.isVisible()) {
      const kinds = await results.locator('[class*="hitKind"]').allTextContents();
      expect(kinds.length).toBeGreaterThan(0);
      expect(kinds.every((kind) => kind === 'Note')).toBe(true);
      expect(await results.textContent()).not.toContain(LINES[1]);
    }
    await page.context().close();
  });
});

describe('the controls', () => {
  it('can be set before anything is typed, and the search that follows reads them', async () => {
    const page = await signedInPage();
    let asked = 0;
    await page.route(`**${API_PREFIX}${SEARCH_PATH}?*`, (route) => {
      asked += 1;
      return route.continue();
    });
    await page.goto(`${baseUrl}${SEARCH_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
    const chapters = page.getByLabel('Chapters');
    await expect.poll(() => chapters.isVisible(), { timeout: 30_000 }).toBe(true);
    // Untick one kind and choose a stop with no words in the box: both land in the address.
    await chapters.click();
    await page.waitForURL((url) => url.searchParams.get('kinds') === 'segment,note,summary,recording', {
      timeout: 30_000,
    });
    await page.getByLabel('Meaning only').click();
    await page.waitForURL((url) => url.searchParams.get('mix') === '1', { timeout: 30_000 });
    expect(new URL(page.url()).searchParams.get('q')).toBeNull();
    expect(await chapters.isChecked()).toBe(false);
    expect(await page.getByLabel('Meaning only').isChecked()).toBe(true);
    // Nothing was asked of the route: there were no words to ask with.
    expect(asked).toBe(0);

    // The search that follows carries the controls the member set.
    await page.getByRole('searchbox', { name: 'Search for' }).fill(LINES[1] ?? '');
    await page.getByRole('searchbox', { name: 'Search for' }).press('Enter');
    await page.waitForURL((url) => url.searchParams.get('q') === LINES[1], { timeout: 30_000 });
    const address = new URL(page.url()).searchParams;
    expect(address.get('kinds')).toBe('segment,note,summary,recording');
    expect(address.get('mix')).toBe('1');
    await expect
      .poll(() => page.getByRole('list', { name: 'Search results' }).isVisible(), { timeout: 30_000 })
      .toBe(true);
    expect(asked).toBe(1);
    await page.context().close();
  });

  it('the words/meaning choice is a radio group, and the teaching rows are filtered as "Recordings"', async () => {
    const page = await signedInPage();
    await page.goto(`${baseUrl}${SEARCH_PAGE_PATH}?q=${encodeURIComponent(LINES[1] ?? '')}`, {
      waitUntil: 'domcontentloaded',
    });
    const group = page.getByRole('group', { name: 'Words / meaning' });
    await expect.poll(() => group.isVisible(), { timeout: 30_000 }).toBe(true);
    expect(await group.getByRole('radio').count()).toBe(5);
    expect(await page.locator('input[type="range"]').count()).toBe(0);
    expect(await group.getByRole('radio', { name: 'Balanced' }).isChecked()).toBe(true);
    await group.getByRole('radio', { name: 'Words only' }).click();
    await page.waitForURL((url) => url.searchParams.get('mix') === '0', { timeout: 30_000 });
    expect(await group.getByRole('radio', { name: 'Words only' }).isChecked()).toBe(true);

    const kinds = page.getByRole('group', { name: 'Content type' });
    expect(await kinds.getByRole('checkbox', { name: 'Recordings' }).count()).toBe(1);
    expect(await kinds.getByRole('checkbox', { name: 'Teachings' }).count()).toBe(0);
    await page.context().close();
  });
});

describe('playing a moment from the results', () => {
  it('the timecode plays the teaching from there in the transport and stays on the results', async () => {
    const page = await signedInPage();
    await page.goto(`${baseUrl}${SEARCH_PAGE_PATH}?q=${encodeURIComponent(LINES[1] ?? '')}`, {
      waitUntil: 'domcontentloaded',
    });
    const results = page.getByRole('list', { name: 'Search results' });
    await expect.poll(() => results.isVisible(), { timeout: 30_000 }).toBe(true);
    const first = results.getByRole('listitem').first();
    await expect.poll(() => first.textContent()).toContain(TITLE);
    const before = page.url();

    await first.getByRole('button', { name: 'Play from 00:10' }).click();
    await expect.poll(async () => (await audioState(page)).paused, { timeout: 60_000 }).toBe(false);
    const state = await audioState(page);
    expect(state.currentTime).toBeGreaterThanOrEqual(9.5);
    expect(state.currentTime).toBeLessThan(14);
    // No redirect: the results are where the member still is.
    expect(page.url()).toBe(before);
    expect(await results.isVisible()).toBe(true);
    await page.context().close();
  });
});

describe('the two empty states (3.10.11)', () => {
  it('nothing matching says so about the library', async () => {
    const page = await signedInPage();
    // Words only: the meaning arm answers its nearest rows whatever their distance, so only a
    // words-only search for a word nobody said is a search that finds nothing.
    await page.goto(`${baseUrl}${SEARCH_PAGE_PATH}?q=${encodeURIComponent(`zxqv-${RUN}-nothing`)}&mix=0`, {
      waitUntil: 'domcontentloaded',
    });
    const empty = page.locator('[data-state="empty"]');
    await expect.poll(() => empty.isVisible(), { timeout: 30_000 }).toBe(true);
    expect(await empty.textContent()).toContain('Nothing in the library matches');
    expect(await page.locator('[data-state="unavailable"]').count()).toBe(0);
    await page.context().close();
  });

  it('a search that could not run says search is unavailable, not that nothing matches', async () => {
    const page = await signedInPage();
    // The route failing is the server's business; the browser is shown what the page does with it.
    await page.route(`**${API_PREFIX}${SEARCH_PATH}?*`, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal_error', message: 'down', correlationId: 'x' } }),
      }),
    );
    await page.goto(`${baseUrl}${SEARCH_PAGE_PATH}?q=${encodeURIComponent(LINES[1] ?? '')}`, {
      waitUntil: 'domcontentloaded',
    });
    const down = page.locator('[data-state="unavailable"]');
    await expect.poll(() => down.isVisible(), { timeout: 30_000 }).toBe(true);
    expect(await down.textContent()).toContain('Search is unavailable');
    expect(await page.locator('[data-state="empty"]').count()).toBe(0);
    await page.context().close();
  });
});
