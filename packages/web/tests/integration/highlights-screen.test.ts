import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  HIGHLIGHTS_PAGE_PATH,
  HIGHLIGHT_AT_PARAM,
  HIGHLIGHT_NOTE_PARAM,
  ROLE,
  chapterPagePath,
  recordingPagePath,
} from '@thp/shared';
import {
  createDatabase,
  findSegmentAt,
  insertHighlight,
  insertNote,
  insertRecording,
  insertSeries,
  listHighlightsForMember,
  replaceChapters,
  replaceTranscript,
  setRecordingPublication,
  setRecordingSeries,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **Highlights, driven in a real browser** ([3.15](docs/project/prd.md)). The API's half is
 * `highlights.test.ts`; this file asks what a fetch cannot:
 *
 * - whether each highlight surface ([3.15.4](docs/project/prd.md)) — the transport bar beside the
 *   rate pill, and the marker beside one's own note — shows highlighted state and toggles it,
 *   writing the row the API would (the recording header and a series row carried one too, until
 *   the operator took them off);
 * - whether the chapter page pins the chapter's opening moment;
 * - whether `/highlights` lists the entries newest first with title, series, date and the
 *   note's text, whether Remove takes a row away, whether opening a row lands on the teaching **at
 *   the moment and silent** ([3.15.7](docs/project/prd.md), [3.2.12](docs/project/prd.md)), and
 *   whether the row's play control plays.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEACHING_SECONDS = 60;
const LINE_MS = 10_000;
const GENERATED = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' };

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let neighbour: TestAccount;
/** The playlist test's own account, so the rows it counts are only the ones it planted. */
let curator: TestAccount;

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

/** A published teaching with real audio and a transcript of ten-second lines, so moments snap. */
async function publishedTeaching(title: string): Promise<string> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording(
    { originalMediaKey: key, title, recordedAt: '2026-10-01' },
    handle,
  );
  await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.95,
      segments: Array.from({ length: (TEACHING_SECONDS * 1000) / LINE_MS }, (_unused, index) => ({
        startMs: index * LINE_MS,
        endMs: (index + 1) * LINE_MS,
        text: `Line ${index + 1} of ${title}.`,
      })),
    },
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

/** Open a teaching's page and wait for it — the header is drawn once the payload lands. */
async function openTeaching(page: Page, recordingId: string): Promise<void> {
  await page.goto(`${baseUrl}${recordingPagePath(recordingId)}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('tab', { name: 'Notes' }).count(), { timeout: 60_000 })
    .toBe(1);
}

/**
 * Press a pin control and wait for its label to flip. The locator has to match the control under
 * **both** of its names: one that names only the pre-press label stops matching the moment the
 * press succeeds, and every attribute read then waits out Playwright's own timeout for an element
 * that is no longer there — a test that times out instead of failing.
 */
async function pressAndExpect(control: Locator, expectedLabel: string): Promise<void> {
  await expect.poll(() => control.isEnabled(), { timeout: 30_000 }).toBe(true);
  await control.click();
  await expect
    .poll(() => control.getAttribute('aria-label'), { timeout: 30_000 })
    .toBe(expectedLabel);
}

async function entriesOf(who: TestAccount) {
  return listHighlightsForMember(who.id, handle);
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  member = await createAccount(databaseUrl, ROLE.member, `hl-member-${RUN}`);
  neighbour = await createAccount(databaseUrl, ROLE.member, `hl-neighbour-${RUN}`);
  curator = await createAccount(databaseUrl, ROLE.member, `hl-curator-${RUN}`);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the marker on a note', () => {
  it('offers Add to Highlights beside your own note and beside somebody else’s public one', async () => {
    const where = await publishedTeaching(`Menu ${RUN}`);
    const mine = await insertNote(
      { recordingId: where, authorId: member.id, visibility: 'public', text: 'My note.', timestampMs: 12_000 },
      handle,
    );
    const theirs = await insertNote(
      { recordingId: where, authorId: neighbour.id, visibility: 'public', text: 'Their note.', timestampMs: 14_000 },
      handle,
    );

    const page = await signInAs(member);
    try {
      await openTeaching(page, where);
      await expect
        .poll(() => page.locator(`#note-${mine.id}`).count(), { timeout: 60_000 })
        .toBe(1);

      const theirCard = page.locator(`#note-${theirs.id}`);
      const theirMarker = theirCard.getByRole('button', { name: 'Add to Highlights' });
      await expect.poll(() => theirMarker.isEnabled(), { timeout: 30_000 }).toBe(true);
      await theirMarker.click();
      await expect
        .poll(async () => (await entriesOf(member)).filter((one) => one.noteId === theirs.id).length, {
          timeout: 30_000,
        })
        .toBe(1);

      const ownCard = page.locator(`#note-${mine.id}`);
      const item = ownCard.getByRole('button', { name: 'Add to Highlights' });
      await expect.poll(() => item.isEnabled(), { timeout: 30_000 }).toBe(true);
      await item.click();

      await expect
        .poll(async () => (await entriesOf(member)).filter((one) => one.noteId === mine.id).length, {
          timeout: 30_000,
        })
        .toBe(1);

      // The same control, now filled, offers the way back.
      await expect
        .poll(() => ownCard.getByRole('button', { name: 'Remove from Highlights' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
    } finally {
      await page.context().close();
    }
  });
});

describe('the transport’s marker', () => {
  it('highlights the moment playing, snapped to its line, and reads highlighted while that line plays', async () => {
    const where = await publishedTeaching(`Moment ${RUN}`);
    const page = await signInAs(member);
    try {
      await openTeaching(page, where);
      await expect
        .poll(async () => (await audioState(page)).duration, { timeout: 60_000 })
        .toBeGreaterThan(0);

      const bar = page.getByRole('region', { name: 'Player' });
      const tool = bar.getByRole('button', { name: 'Highlight this moment' });
      await expect.poll(() => tool.isEnabled(), { timeout: 30_000 }).toBe(true);
      await tool.click();

      await expect
        .poll(async () => (await entriesOf(member)).filter((one) => one.recordingId === where).length, {
          timeout: 30_000,
        })
        .toBe(1);
      const [entry] = (await entriesOf(member)).filter((one) => one.recordingId === where);
      expect(entry?.kind).toBe('segment');
      // The page opened at the start, so the moment is the first line.
      expect(entry?.positionMs).toBe(0);
      expect(entry?.segmentId).not.toBeNull();

      const pressed = bar.getByRole('button', { name: 'Remove highlight from this moment' });
      await expect.poll(() => pressed.count(), { timeout: 30_000 }).toBe(1);
      expect(await pressed.getAttribute('aria-pressed')).toBe('true');
    } finally {
      await page.context().close();
    }
  });
});

describe('the chapter page', () => {
  it('pins the chapter’s opening moment', async () => {
    const where = await publishedTeaching(`Chapter ${RUN}`);
    const chapters = await replaceChapters(
      where,
      [
        { startMs: 0, title: 'Opening', summary: 'The start.' },
        { startMs: 20_000, title: 'Middle', summary: 'The middle.' },
      ],
      GENERATED,
      handle,
    );
    const middle = chapters.find((one) => one.title === 'Middle');
    if (middle === undefined) throw new Error('no middle chapter');

    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${chapterPagePath(where, middle.id)}`, {
        waitUntil: 'domcontentloaded',
      });
      // Located by either name, since the press is what changes it (see `pressAndExpect`).
      const control = page.getByRole('button', { name: /^(Highlight|Remove highlight from) this chapter$/u });
      await expect.poll(() => control.count(), { timeout: 60_000 }).toBe(1);
      await pressAndExpect(control, 'Remove highlight from this chapter');

      const [entry] = (await entriesOf(member)).filter((one) => one.recordingId === where);
      expect(entry?.kind).toBe('segment');
      expect(entry?.positionMs).toBe(20_000);
    } finally {
      await page.context().close();
    }
  });

  /**
   * The same control on every row of the Chapters tab, named by the chapter, so a member can pin a
   * chapter from the list without opening its page — and the entry is the chapter's opening moment,
   * exactly what the page's own control pins.
   */
  it('offers the marker on every row of the chapters tab, pinning that chapter’s opening moment', async () => {
    const where = await publishedTeaching(`Chapter rows ${RUN}`);
    await replaceChapters(
      where,
      [
        { startMs: 0, title: 'First', summary: 'The start.' },
        { startMs: 20_000, title: 'Second', summary: 'The middle.' },
      ],
      GENERATED,
      handle,
    );

    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(where)}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.getByRole('tab', { name: 'Chapters' }).count(), { timeout: 60_000 }).toBe(1);
      await page.getByRole('tab', { name: 'Chapters' }).click();

      const list = page.getByRole('region', { name: 'Chapters' });
      await expect.poll(() => list.getByRole('button', { name: /^Highlight /u }).count(), { timeout: 60_000 }).toBe(2);
      // Located by either name, since the press is what changes it (see `pressAndExpect`).
      const second = list.getByRole('button', { name: /^(Highlight|Remove highlight from) Second$/u });
      await pressAndExpect(second, 'Remove highlight from Second');

      const [entry] = (await entriesOf(member)).filter((one) => one.recordingId === where);
      expect(entry?.kind).toBe('segment');
      expect(entry?.positionMs).toBe(20_000);
      // The other row is untouched.
      expect(await list.getByRole('button', { name: 'Highlight First' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  });
});

describe('/highlights', () => {
  it('lists newest first with title, series, date and note text; removes; opens silent at the moment; plays', async () => {
    const study = await insertSeries({ title: `Playlist study ${RUN}`, description: null }, handle);
    const where = await publishedTeaching(`Playlist ${RUN}`);
    await setRecordingSeries(where, study.id, handle);
    const note = await insertNote(
      { recordingId: where, authorId: curator.id, visibility: 'private', text: 'Remember this.', timestampMs: 30_000 },
      handle,
    );
    const line = await findSegmentAt(where, 10_000, handle);

    await insertHighlight({ userId: curator.id, recordingId: where, kind: 'recording' }, handle);
    await insertHighlight(
      { userId: curator.id, recordingId: where, kind: 'segment', positionMs: 10_000, segmentId: line?.id ?? null },
      handle,
    );
    await insertHighlight({ userId: curator.id, recordingId: where, kind: 'note', noteId: note.id }, handle);

    const page = await signInAs(curator);
    try {
      await page.goto(`${baseUrl}${HIGHLIGHTS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.getByRole('heading', { level: 1, name: 'Highlights' }).count(), { timeout: 60_000 }).toBe(1);

      const rows = page.getByRole('list', { name: 'Highlighted entries' }).getByRole('listitem');
      await expect.poll(() => rows.count(), { timeout: 60_000 }).toBe(3);

      // Newest first: the note, then the moment, then the teaching.
      const first = (await rows.nth(0).textContent()) ?? '';
      expect(first).toContain('Remember this.');
      expect(first).toContain(`Playlist study ${RUN}`);
      expect(first).toContain('Highlighted ');
      expect(await rows.nth(1).textContent()).toContain(`Line 2 of Playlist ${RUN}.`);
      expect(await rows.nth(2).textContent()).toContain(`Playlist ${RUN}`);

      // Remove the note's row: the list is what the API answered back.
      await rows.nth(0).getByRole('button', { name: `Remove Playlist ${RUN} from Highlights` }).click();
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(2);
      expect((await entriesOf(curator)).some((one) => one.noteId === note.id)).toBe(false);

      // Opening the moment's row lands on the teaching at ten seconds, and silent.
      const open = rows.nth(0).getByRole('link', { name: `Open Playlist ${RUN} at 00:10` });
      expect(await open.getAttribute('href')).toContain(`${HIGHLIGHT_AT_PARAM}=10000`);
      await open.click();
      await page.waitForURL((url) => url.pathname === recordingPagePath(where), { timeout: 30_000 });
      await expect
        .poll(async () => (await audioState(page)).duration, { timeout: 60_000 })
        .toBeGreaterThan(0);
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThanOrEqual(9.5);
      expect((await audioState(page)).paused).toBe(true);

      // Back on the playlist, the row's play control plays — the one press that is for sound.
      await page.goto(`${baseUrl}${HIGHLIGHTS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => rows.count(), { timeout: 60_000 }).toBe(2);
      await rows.nth(0).getByRole('button', { name: `Play Playlist ${RUN}` }).click();
      await expect
        .poll(async () => (await audioState(page)).paused, { timeout: 60_000 })
        .toBe(false);
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThanOrEqual(9.5);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * A note's row opens the teaching **at the note** ([3.15.7](docs/project/prd.md)): the address
   * names the note as well as its moment, and the Notes tab scrolls that card into the window once
   * the list is on screen. Enough other notes come first that the card would otherwise sit below
   * the fold, so the assertion is on the card being in view, not merely present.
   */
  it('opens a note’s row on the teaching with that note scrolled into view', async () => {
    const where = await publishedTeaching(`Landing ${RUN}`);
    for (let index = 0; index < 12; index += 1) {
      await insertNote(
        {
          recordingId: where,
          authorId: curator.id,
          visibility: 'private',
          text: `Filler ${index} ${RUN}.\n\n\n\n\n\n`,
          timestampMs: 1_000 + index * 1_000,
        },
        handle,
      );
    }
    const wanted = await insertNote(
      { recordingId: where, authorId: curator.id, visibility: 'private', text: 'The one I pinned.', timestampMs: 30_000 },
      handle,
    );
    await insertHighlight({ userId: curator.id, recordingId: where, kind: 'note', noteId: wanted.id }, handle);

    const page = await signInAs(curator);
    try {
      await page.goto(`${baseUrl}${HIGHLIGHTS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      // Found by its own link: the curator's list holds what earlier cases left on it.
      const open = page.getByRole('link', { name: `Open Landing ${RUN} at 00:30` });
      await expect.poll(() => open.count(), { timeout: 60_000 }).toBe(1);
      const href = (await open.getAttribute('href')) ?? '';
      expect(href).toContain(`${HIGHLIGHT_AT_PARAM}=30000`);
      expect(href).toContain(`${HIGHLIGHT_NOTE_PARAM}=${wanted.id}`);
      await open.click();
      await page.waitForURL((url) => url.pathname === recordingPagePath(where), { timeout: 30_000 });

      const card = page.locator(`#note-${wanted.id}`);
      await expect.poll(() => card.count(), { timeout: 60_000 }).toBe(1);
      await expect
        .poll(
          async () =>
            card.evaluate((node) => {
              const box = node.getBoundingClientRect();
              return box.top >= 0 && box.bottom <= window.innerHeight;
            }),
          { timeout: 30_000 },
        )
        .toBe(true);
      // And the page did not simply land at the top: the first filler is above the window.
      const firstTop = await page
        .locator('[id^="note-"]')
        .first()
        .evaluate((node) => node.getBoundingClientRect().top);
      expect(firstTop).toBeLessThan(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});
