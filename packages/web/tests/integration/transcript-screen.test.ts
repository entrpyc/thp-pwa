import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import {
  API_PREFIX,
  MEMBER_LIBRARY_PAGE_PATH,
  DASHBOARD_PAGE_PATH,
  ROLE,
  recordingPagePath,
  recordingTranscriptPath,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The follow-along transcript, driven in a real browser against real audio** (Story 5 Ticket 01).
 *
 * Nothing here is simulated, for the reason the player suite states: the highlight moving is a
 * property of a media element reporting `timeupdate`, the auto-scroll is a property of a real
 * scroll container, and a stub would answer every assertion below however it was written.
 *
 * The fixture is a two-minute teaching with **forty three-second lines and one deliberate gap** —
 * 30 s to 33 s belongs to nobody. Long enough that the list genuinely scrolls, and gapped so the
 * "a silence shows no caption" rule is exercised on screen rather than only in the unit test.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEACHING_SECONDS = 120;
const LINE_MS = 3000;
/** The line index nothing covers, which is what makes 30 000–33 000 a silence. */
const MISSING_LINE = 10;

const SEGMENTS = Array.from({ length: 40 }, (_, index) => index)
  .filter((index) => index !== MISSING_LINE)
  .map((index) => ({
    startMs: index * LINE_MS,
    endMs: index * LINE_MS + LINE_MS,
    text: `Line ${index + 1} of the teaching.`,
    speaker: index % 2,
  }));

/** The text of the line covering an offset, as the fixture defines it. */
function lineAt(offsetMs: number): string {
  const found = SEGMENTS.find((one) => offsetMs >= one.startMs && offsetMs < one.endMs);
  if (found === undefined) throw new Error(`the fixture has no line at ${offsetMs}`);
  return found.text;
}

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let recordingId: string;
let noTranscriptId: string;

const TITLE = `Transcript teaching ${RUN}`;
const BARE_TITLE = `Transcript bare ${RUN}`;

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

async function publishedRecording(title: string, withTranscript: boolean): Promise<string> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording(
    { originalMediaKey: key, title, recordedAt: '2026-08-16' },
    handle,
  );
  if (withTranscript) {
    await replaceTranscript(
      { recordingId: row.id, language: 'en', confidence: 0.94, segments: SEGMENTS },
      handle,
    );
  }
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

/** Sign in through the real screen and open a teaching, waiting until the element has metadata. */
async function openTeaching(id: string): Promise<{ page: Page; requests: Request[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
    .poll(async () => (await audioState(page)).duration, { timeout: 60_000 })
    .toBeGreaterThan(TEACHING_SECONDS - 5);
  return { page, requests };
}

/** Open the `Transcript` tab and wait for the lines to arrive. */
async function openTranscript(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Transcript' }).click();
  await expect
    .poll(() => page.getByRole('list', { name: 'Transcript' }).count(), { timeout: 30_000 })
    .toBe(1);
}

/** The text of the highlighted line, or `null` when nothing is highlighted. */
async function highlighted(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const row = document.querySelector('[aria-current="true"]');
    return row === null ? null : (row.textContent ?? '');
  });
}

function transcriptRequests(requests: readonly Request[], id: string): Request[] {
  const path = `${baseUrl}${API_PREFIX}${recordingTranscriptPath(id)}`;
  return requests.filter((request) => request.url() === path);
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  member = await createAccount(databaseUrl, ROLE.member, 'transcript-screen-member');

  recordingId = await publishedRecording(TITLE, true);
  noTranscriptId = await publishedRecording(BARE_TITLE, false);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the recording page carries the tab strip and the transcript under it', () => {
  it('holds the two tabs that have data, and drops the three that do not', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      const strip = page.getByRole('tablist', { name: 'Teaching contents' });
      await expect.poll(() => strip.count(), { timeout: 30_000 }).toBe(1);
      // The strip shipped in Story 5 holding `Transcript` alone; the notes scope gave it `Notes`
      // beside it. The three that still lead nowhere are dropped rather than rendered disabled.
      expect(await strip.getByRole('tab').count()).toBe(2);
      expect(await strip.getByRole('tab', { name: 'Transcript' }).count()).toBe(1);
      expect(await strip.getByRole('tab', { name: 'Notes' }).count()).toBe(1);
      for (const deferred of ['Chapter', 'Scripture', 'Mindmap']) {
        expect(await page.getByRole('tab', { name: deferred }).count(), deferred).toBe(0);
      }
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('renders the segments in playback order', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      await openTranscript(page);
      const texts = await page
        .getByRole('list', { name: 'Transcript' })
        .locator('li')
        .allTextContents();

      expect(texts).toHaveLength(SEGMENTS.length);
      // The query's order, on screen. The gap is a missing line, not a re-ordered one.
      SEGMENTS.forEach((segment, index) => {
        expect(texts[index], `line ${index}`).toContain(segment.text);
      });
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('renders an empty state for a published teaching with no transcript', async () => {
    const { page } = await openTeaching(noTranscriptId);
    try {
      await page.getByRole('tab', { name: 'Transcript' }).click();
      await expect
        .poll(() => page.getByText('This teaching has no transcript yet.').count(), {
          timeout: 30_000,
        })
        .toBe(1);
      // The tab is there and the page is intact — an absent transcript is not a broken screen.
      expect(await page.getByRole('tab', { name: 'Transcript' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

describe('the line being spoken is highlighted', () => {
  it('starts on the first line, moves as playback runs, and follows a seek', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      await openTranscript(page);
      expect(await highlighted(page)).toContain(lineAt(0));

      await page.getByRole('button', { name: 'Play' }).first().click();
      // Real time, real element: the second line begins three seconds in.
      await expect
        .poll(async () => await highlighted(page), { timeout: 30_000 })
        .toContain(lineAt(LINE_MS + 500));

      // A scrub is the other source of position, and the highlight has to follow it too.
      await page.getByRole('slider', { name: 'Position' }).fill('60000');
      await expect
        .poll(async () => await highlighted(page), { timeout: 30_000 })
        .toContain(lineAt(60_000));
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('highlights nothing inside the transcript’s silence', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      await openTranscript(page);
      // Something is highlighted at 29 s, so the `null` below is a silence rather than a transcript
      // that never rendered.
      await page.getByRole('slider', { name: 'Position' }).fill('29000');
      await expect
        .poll(async () => await highlighted(page), { timeout: 30_000 })
        .toContain(lineAt(29_000));

      // 30 000–33 000 belongs to no line. A silence is a real answer, not the previous line held.
      await page.getByRole('slider', { name: 'Position' }).fill('31000');
      await expect.poll(async () => await highlighted(page), { timeout: 30_000 }).toBeNull();

      // And the line after the gap picks up again, so nothing was dropped from the list.
      await page.getByRole('slider', { name: 'Position' }).fill('34000');
      await expect
        .poll(async () => await highlighted(page), { timeout: 30_000 })
        .toContain(lineAt(34_000));
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

describe('selecting a line seeks the audio there', () => {
  it('moves the element and the transport’s elapsed reading, without starting playback', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      await openTranscript(page);
      expect((await audioState(page)).paused).toBe(true);

      // The twenty-first line of the fixture starts at 63 s (index 20, with index 10 missing).
      await page.getByRole('button', { name: lineAt(63_000), exact: false }).first().click();

      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(62);
      const bar = page.getByRole('region', { name: 'Player' });
      await expect
        .poll(async () => (await bar.textContent()) ?? '', { timeout: 30_000 })
        .toContain('01:03');

      // A member reading a paused teaching has not asked for sound.
      expect((await audioState(page)).paused).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

describe('the transcript keeps the current line in view by itself', () => {
  it('follows the highlight, suspends on a member scroll, and resumes when a line is selected', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      await openTranscript(page);
      const list = page.getByRole('list', { name: 'Transcript' });
      const scrollTop = () => list.evaluate((node) => node.scrollTop);

      // Following: a seek deep into the teaching pulls the list down to it on its own.
      await page.getByRole('slider', { name: 'Position' }).fill('105000');
      await expect.poll(scrollTop, { timeout: 30_000 }).toBeGreaterThan(0);
      // And the auto-scroll did not count as a member scroll — the control stays hidden.
      expect(await page.getByRole('button', { name: 'Jump to current' }).count()).toBe(0);

      // A member scroll suspends it, and says so.
      await list.evaluate((node) => {
        node.scrollTop = 0;
      });
      await expect
        .poll(() => page.getByRole('button', { name: 'Jump to current' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      // Suspended means suspended: another seek does not drag the view back.
      await page.getByRole('slider', { name: 'Position' }).fill('108000');
      expect(await scrollTop()).toBe(0);

      // Selecting any line resumes it — the clearest possible signal that they want it keeping up.
      await page.getByRole('button', { name: lineAt(6000), exact: false }).first().click();
      await expect
        .poll(() => page.getByRole('button', { name: 'Jump to current' }).count(), {
          timeout: 30_000,
        })
        .toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('resumes when the Jump to current control is pressed', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      await openTranscript(page);
      const list = page.getByRole('list', { name: 'Transcript' });

      await page.getByRole('slider', { name: 'Position' }).fill('105000');
      await expect
        .poll(() => list.evaluate((node) => node.scrollTop), { timeout: 30_000 })
        .toBeGreaterThan(0);
      await list.evaluate((node) => {
        node.scrollTop = 0;
      });

      const jump = page.getByRole('button', { name: 'Jump to current' });
      await expect.poll(() => jump.count(), { timeout: 30_000 }).toBe(1);
      await jump.click();

      await expect
        .poll(() => list.evaluate((node) => node.scrollTop), { timeout: 30_000 })
        .toBeGreaterThan(0);
      expect(await jump.count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

describe('captions float above the transport on any member screen', () => {
  it('turns on from the ··· menu and keeps captioning after the member navigates away', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      // Off by default: nothing is showing before anybody asks for it.
      expect(await page.getByRole('region', { name: 'Caption' }).count()).toBe(0);

      await page.getByRole('button', { name: 'More player controls' }).click();
      const toolbar = page.getByRole('navigation', { name: 'Player tools' });
      await expect.poll(() => toolbar.count(), { timeout: 30_000 }).toBe(1);
      // The reference draws seven icons; two have data — CC, and the notes scope's speech bubble
      // (active-scope prd 3.1.2). The other five are dropped rather than rendered disabled.
      expect(await toolbar.getByRole('button').count()).toBe(2);
      expect(await toolbar.getByRole('button', { name: 'Write a note' }).count()).toBe(1);
      await toolbar.getByRole('button', { name: 'Captions' }).click();

      await page.getByRole('slider', { name: 'Position' }).fill('45000');
      const pill = page.getByRole('region', { name: 'Caption' });
      await expect
        .poll(async () => (await pill.textContent()) ?? '', { timeout: 30_000 })
        .toContain(lineAt(45_000));

      await page.getByRole('button', { name: 'Play' }).first().click();
      // A client-side navigation away from the recording page: the pill is docked to the transport,
      // which lives in the member layout, so it survives.
      await page.getByRole('link', { name: 'Back to recordings' }).click();
      await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });

      await expect
        .poll(async () => (await pill.textContent()) ?? '', { timeout: 30_000 })
        .toContain('Line ');
      // Still the transcript of the teaching that is playing, on a screen that never fetched it.
      expect(await page.getByRole('list', { name: 'Transcript' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('shows no pill inside a gap, and none once it is dismissed', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      await page.getByRole('button', { name: 'More player controls' }).click();
      await page
        .getByRole('navigation', { name: 'Player tools' })
        .getByRole('button', { name: 'Captions' })
        .click();

      await page.getByRole('slider', { name: 'Position' }).fill('45000');
      const pill = page.getByRole('region', { name: 'Caption' });
      await expect.poll(() => pill.count(), { timeout: 30_000 }).toBe(1);

      // The silence: no pill rather than the previous line held over.
      await page.getByRole('slider', { name: 'Position' }).fill('31000');
      await expect.poll(() => pill.count(), { timeout: 30_000 }).toBe(0);

      await page.getByRole('slider', { name: 'Position' }).fill('45000');
      await expect.poll(() => pill.count(), { timeout: 30_000 }).toBe(1);
      await page.getByRole('button', { name: 'Hide captions' }).click();
      await expect.poll(() => pill.count(), { timeout: 30_000 }).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

describe('the transcript is fetched once per loaded recording, and only when needed', () => {
  it('asks for nothing on open, once when the tab is opened, and not again on the way back', async () => {
    const { page, requests } = await openTeaching(recordingId);
    try {
      // A member who never opens the tab and never turns captions on downloads nothing.
      expect(transcriptRequests(requests, recordingId)).toHaveLength(0);

      await openTranscript(page);
      await expect
        .poll(() => transcriptRequests(requests, recordingId).length, { timeout: 30_000 })
        .toBe(1);

      // Away and back, client-side. The provider owns the transcript, so the page remounting does
      // not re-fetch it.
      await page.getByRole('link', { name: 'Back to recordings' }).click();
      await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });
      await page.getByRole('link', { name: TITLE }).first().click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(recordingId)}`, { timeout: 30_000 });
      await openTranscript(page);

      expect(transcriptRequests(requests, recordingId)).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('clears it when a different teaching is opened, so the pill cannot caption the wrong one', async () => {
    const { page, requests } = await openTeaching(recordingId);
    try {
      await openTranscript(page);
      await expect
        .poll(() => transcriptRequests(requests, recordingId).length, { timeout: 30_000 })
        .toBe(1);

      await page.goto(`${baseUrl}${recordingPagePath(noTranscriptId)}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.getByRole('tab', { name: 'Transcript' }).click();
      // The other teaching's transcript, asked for on its own — and the first one's lines are gone.
      await expect
        .poll(() => transcriptRequests(requests, noTranscriptId).length, { timeout: 30_000 })
        .toBe(1);
      await expect
        .poll(() => page.getByText('This teaching has no transcript yet.').count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(transcriptRequests(requests, recordingId)).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});
