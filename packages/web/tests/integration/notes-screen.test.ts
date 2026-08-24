import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  MAX_NOTE_LENGTH,
  MEMBER_LIBRARY_PAGE_PATH,
  ROLE,
  recordingNotesPath,
  recordingPagePath,
  recordingPlaybackPath,
} from '@thp/shared';
import {
  createDatabase,
  insertNote,
  insertRecording,
  setRecordingPublication,
  upsertPlaybackProgress,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The Notes tab, driven in a real browser against real audio** (Tasks 1.6, 1.7 and 1.8).
 *
 * Real for the reason the player and transcript suites are: the anchor freezing is a property of a
 * media element whose `currentTime` is genuinely advancing, the composer's refusals are properties
 * of a real API answering a real request, and a stub would satisfy every assertion below however it
 * was written.
 *
 * The fixture is a two-minute teaching, long enough for playback to move a measurable distance
 * under a composer that is supposed not to move with it.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEACHING_SECONDS = 120;

/** An hour, two minutes and five seconds — the only position that exercises the `h:mm:ss` form. */
const PAST_AN_HOUR_MS = 3_725_000;

/** The composer's own threshold, restated here so the test does not read it from the component. */
const COUNT_APPEARS_FROM = 900;

/** `#22C55E` as a browser reports a computed colour. */
function hexToRgb(hex: string): string {
  const value = hex.replace('#', '');
  const parts = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16));
  return `rgb(${parts.join(', ')})`;
}

/**
 * Whether `selector` sits **after** the composer in the document.
 *
 * The composer is pinned to the top of the surface (5.1.2) and the filter is directly under it
 * (5.2.5), which is an ordering claim rather than a "both exist" one — so it is asked of the
 * document rather than inferred from two `count()`s.
 */
async function followsTheComposer(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((wanted) => {
    const composer = document.querySelector('form[aria-label="Write a note"]');
    const other = document.querySelector(wanted);
    if (composer === null || other === null) return false;
    return (composer.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }, selector);
}

/** The seconds out of an `At mm:ss` label, so an anchor can be compared rather than pattern-matched. */
function secondsIn(label: string): number {
  const [minutes, seconds] = label.replace('At ', '').split(':');
  return Number(minutes) * 60 + Number(seconds);
}

/** The monogram the card is expected to draw — the initials of the first and last words. */
function monogramOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';
  const last = words[words.length - 1] ?? '';
  return (first === last ? first.slice(0, 1) : first.slice(0, 1) + last.slice(0, 1)).toUpperCase();
}

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let neighbour: TestAccount;

/** The teaching most tests write on. Starts with no notes and gains them as tests run. */
let scratchId: string;
/** Carries a fixed set of notes nothing else writes to, so the list assertions are stable. */
let readingId: string;
/** Never written on by anybody. */
let bareId: string;
/** Carries only the neighbour's public note, so **Mine** has an empty state to show. */
let othersOnlyId: string;
/** Has a stored resume position past an hour, and nothing else. */
let resumedId: string;

const READING_TITLE = `Notes reading ${RUN}`;

async function publishedRecording(title: string): Promise<string> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording(
    { originalMediaKey: key, title, recordedAt: '2026-08-16' },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

/** Sign in through the real screen and open a teaching. */
async function openTeaching(id: string, options: { withAudio?: boolean } = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

  if (options.withAudio === false) {
    // No grant means the element never gets a source, never reads metadata and therefore never
    // clamps a restored position to a duration it has not learnt. That is a real state — a teaching
    // whose audio has not arrived — and it is the only way to hold a position past an hour on a
    // two-minute fixture.
    await page.route(`**${API_PREFIX}${recordingPlaybackPath(id)}`, (route) => route.abort());
  }

  await page.goto(`${baseUrl}${recordingPagePath(id)}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('tab', { name: 'Notes' }).count(), { timeout: 60_000 })
    .toBe(1);
  return page;
}

/** Wait until the element has read its duration off the store — a real network round trip. */
async function waitForAudio(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const element = document.querySelector('audio');
          return Number.isFinite(element?.duration) ? (element?.duration ?? 0) : 0;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(TEACHING_SECONDS - 5);
}

async function audioState(page: Page): Promise<{ currentTime: number; paused: boolean }> {
  return page.evaluate(() => {
    const element = document.querySelector('audio');
    return { currentTime: element?.currentTime ?? -1, paused: element?.paused ?? true };
  });
}

async function openNotes(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Notes' }).click();
  await expect
    .poll(() => page.getByRole('form', { name: 'Write a note' }).count(), { timeout: 30_000 })
    .toBe(1);
}

/** The visible note cards' text, in the order they are rendered. */
async function listed(page: Page): Promise<string[]> {
  return page.getByRole('list', { name: 'Notes' }).getByRole('listitem').allInnerTexts();
}

/** Plant a note straight into the table, so a list fixture does not depend on the composer. */
async function plant(
  recordingId: string,
  who: TestAccount,
  text: string,
  visibility: 'private' | 'public',
  timestampMs: number,
): Promise<void> {
  await insertNote(
    { recordingId, authorId: who.id, visibility, text, timestampMs },
    handle,
  );
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  member = await createAccount(databaseUrl, ROLE.member, `notes-member-${RUN}`);
  neighbour = await createAccount(databaseUrl, ROLE.member, `notes-neighbour-${RUN}`);

  [scratchId, readingId, bareId, othersOnlyId, resumedId] = await Promise.all([
    publishedRecording(`Notes scratch ${RUN}`),
    publishedRecording(READING_TITLE),
    publishedRecording(`Notes bare ${RUN}`),
    publishedRecording(`Notes others ${RUN}`),
    publishedRecording(`Notes resumed ${RUN}`),
  ]);

  // The reading fixture: interleaved kinds, out of position order in the table, and one note the
  // reading member must never see.
  await plant(readingId, neighbour, 'The group reads this one.', 'public', 30_000);
  await plant(readingId, member, 'Mine, and only mine.', 'private', 10_000);
  await plant(readingId, member, 'Mine, and the group’s.', 'public', 20_000);
  await plant(readingId, neighbour, 'Nobody else reads this.', 'private', 5_000);

  await plant(othersOnlyId, neighbour, 'Written by somebody else.', 'public', 1_000);

  await upsertPlaybackProgress(
    { userId: member.id, recordingId: resumedId, positionMs: PAST_AN_HOUR_MS },
    handle,
  );
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================
// Task 1.6 — the tab, the store and the list
// =================================================================================================

describe('the recording page carries a Notes tab', () => {
  it('adds it beside Transcript, in the notes green, and opening one closes the other', async () => {
    const page = await openTeaching(readingId);
    try {
      const strip = page.getByRole('tablist', { name: 'Teaching contents' });
      // Two tabs, in the reference's order — Notes before Transcript.
      expect(await strip.getByRole('tab').count()).toBe(2);
      expect(
        (await strip.getByRole('tab').allInnerTexts()).map((text) => text.replace(/[^A-Za-z]/g, '')),
      ).toEqual(['Notes', 'Transcript']);

      await page.getByRole('tab', { name: 'Transcript' }).click();
      expect(
        await page.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected'),
      ).toBe('true');

      // Single-select, the way the reference's strip reads.
      await openNotes(page);
      expect(await page.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(
        await page.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected'),
      ).toBe('false');
      expect(await page.getByRole('list', { name: 'Transcript' }).count()).toBe(0);

      // The green is the tab's, and it is the token rather than a colour typed here.
      const colours = await page
        .getByRole('tab', { name: 'Notes' })
        .evaluate((tab) => {
          const style = getComputedStyle(tab);
          const icon = tab.querySelector('span');
          return {
            border: style.borderTopColor,
            icon: icon === null ? '' : getComputedStyle(icon).color,
            notes: getComputedStyle(document.documentElement)
              .getPropertyValue('--color-notes')
              .trim(),
          };
        });
      const green = hexToRgb(colours.notes);
      expect(colours.icon).toBe(green);
      expect(colours.border).toBe(green);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('fetches the notes when the teaching is opened, before the tab is ever pressed', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
    const page = await context.newPage();
    const asked: string[] = [];
    page.on('request', (request) => asked.push(request.url()));
    try {
      await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email').fill(member.email);
      await page.getByLabel('Password').fill(member.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

      await page.goto(`${baseUrl}${recordingPagePath(readingId)}`, {
        waitUntil: 'domcontentloaded',
      });
      const wanted = `${baseUrl}${API_PREFIX}${recordingNotesPath(readingId)}`;
      await expect
        .poll(() => asked.filter((url) => url === wanted).length, { timeout: 30_000 })
        .toBe(1);

      // The markers (3.2.4) are on the transport without the tab, which is the whole reason this
      // request does not wait for it.
      expect(await page.getByRole('form', { name: 'Write a note' }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 180_000);

  it('clears the previous teaching’s notes, and discards its late answer', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email').fill(member.email);
      await page.getByLabel('Password').fill(member.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

      // **Registered before the teaching is ever opened**, so the request that hangs is the one the
      // provider issues on `open()`. Holding a request that is never made would drive nothing, and
      // the guard under test — `loadedRef.current?.id !== recording.id` — is only reachable by an
      // answer that arrives after the member has moved on.
      await page.route(`**${API_PREFIX}${recordingNotesPath(readingId)}`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        await route.continue();
      });

      await page.goto(`${baseUrl}${recordingPagePath(readingId)}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect
        .poll(() => page.getByRole('tab', { name: 'Notes' }).count(), { timeout: 60_000 })
        .toBe(1);

      // Client-side navigation, so the provider stays mounted and the late answer has somewhere to
      // land. A full page load would tear it down and prove nothing.
      await page.getByRole('link', { name: 'Back to recordings' }).click();
      await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });
      await page.getByRole('link', { name: new RegExp(`Notes bare ${RUN}`) }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(bareId)}`, { timeout: 30_000 });
      await openNotes(page);

      // Cleared: the previous teaching's notes are gone the moment a different one is opened.
      await expect
        .poll(() => page.textContent('body'), { timeout: 30_000 })
        .toContain('No notes on this teaching yet. Write the first one.');

      // Long enough for the held answer to have arrived and been discarded.
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      expect(await page.getByRole('list', { name: 'Notes' }).count()).toBe(0);
      expect(await page.textContent('body')).not.toContain('The group reads this one.');
      expect(await page.textContent('body')).toContain(
        'No notes on this teaching yet. Write the first one.',
      );
    } finally {
      await context.close();
    }
  }, 240_000);

  it('lists the payload’s cards with a timestamp, a monogram, a name, a time and the text', async () => {
    const page = await openTeaching(readingId);
    try {
      await openNotes(page);
      const rows = await listed(page);

      // The payload's order — position ascending — and the two kinds interleaved rather than
      // separated. The neighbour's private note is not among them.
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain('Mine, and only mine.');
      expect(rows[1]).toContain('Mine, and the group’s.');
      expect(rows[2]).toContain('The group reads this one.');
      expect(rows.join('\n')).not.toContain('Nobody else reads this.');

      const first = page.getByRole('list', { name: 'Notes' }).getByRole('listitem').first();
      expect(await first.getByRole('button', { name: 'The note at 00:10' }).count()).toBe(1);
      expect(await first.innerText()).toContain(member.displayName);
      // "Test notes-member-…" → the monogram of the first and last words.
      expect(await first.innerText()).toContain(monogramOf(member.displayName));
      expect(await first.innerText()).toMatch(/\d{1,2} \w{3} \d{4}/);

      // The **Private** pill is on the member's own private note and on neither of the others.
      expect(await first.getByText('Private', { exact: true }).count()).toBe(1);
      const others = page.getByRole('list', { name: 'Notes' }).getByRole('listitem');
      expect(await others.nth(1).getByText('Private', { exact: true }).count()).toBe(0);
      expect(await others.nth(2).getByText('Private', { exact: true }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('renders markdown, HTML and a URL as the characters they are, and keeps line breaks', async () => {
    const literalId = await publishedRecording(`Notes literal ${RUN}`);
    const raw = '**bold** <b>tag</b> <script>x</script>\nhttps://example.test/a\nthird line';
    await plant(literalId, member, raw, 'private', 1_000);

    const page = await openTeaching(literalId);
    try {
      await openNotes(page);
      const card = page.getByRole('list', { name: 'Notes' }).getByRole('listitem').first();

      // The markup is text: no element was created from it, and the asterisks survived.
      expect(await card.locator('b').count()).toBe(0);
      expect(await card.locator('script').count()).toBe(0);
      expect(await card.locator('a').count()).toBe(0);
      const shown = await card.innerText();
      expect(shown).toContain('**bold**');
      expect(shown).toContain('<b>tag</b>');
      expect(shown).toContain('https://example.test/a');

      // Three lines rendered as three lines — `innerText` collapses nothing the CSS preserves.
      const body = await card.locator('p').last().innerText();
      expect(body.split('\n').filter((line) => line.trim() !== '')).toHaveLength(3);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('shows the empty state for a teaching nobody has written on', async () => {
    const page = await openTeaching(bareId);
    try {
      await openNotes(page);
      await expect
        .poll(() => page.textContent('body'), { timeout: 30_000 })
        .toContain('No notes on this teaching yet. Write the first one.');
      expect(await page.getByRole('list', { name: 'Notes' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('degrades a failed load to a retry, with the recording above still playing', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email').fill(member.email);
      await page.getByLabel('Password').fill(member.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

      let refuse = true;
      await page.route(`**${API_PREFIX}${recordingNotesPath(readingId)}`, async (route) => {
        if (refuse) await route.abort();
        else await route.continue();
      });

      await page.goto(`${baseUrl}${recordingPagePath(readingId)}`, {
        waitUntil: 'domcontentloaded',
      });
      await waitForAudio(page);
      await page.getByRole('tab', { name: 'Notes' }).click();

      await expect
        .poll(() => page.textContent('body'), { timeout: 30_000 })
        .toContain("Couldn't load notes.");
      expect(await page.getByRole('button', { name: 'Try again' }).count()).toBe(1);

      // The player is untouched by a notes failure — the Availability NFR, driven rather than
      // claimed: the teaching above still plays.
      await page.getByRole('button', { name: 'Play' }).first().click();
      await expect.poll(async () => (await audioState(page)).paused, { timeout: 30_000 }).toBe(false);

      refuse = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect.poll(() => listed(page), { timeout: 30_000 }).toHaveLength(3);
    } finally {
      await context.close();
    }
  }, 240_000);
});

// =================================================================================================
// Task 1.7 — the All / Public / Mine filter
// =================================================================================================

describe('the All / Public / Mine filter', () => {
  it('sits under the composer, opens on All, and narrows the list', async () => {
    const page = await openTeaching(readingId);
    try {
      await openNotes(page);
      const filters = page.getByRole('tablist', { name: 'Which notes to show' });
      expect(await filters.getByRole('tab').allInnerTexts()).toEqual(['All', 'Public', 'Mine']);
      expect(await filters.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe(
        'true',
      );

      // Under the composer, not above it (5.2.5).
      // Directly under the composer, not above it (5.2.5).
      expect(await followsTheComposer(page, '[aria-label="Which notes to show"]')).toBe(true);

      await filters.getByRole('tab', { name: 'Public' }).click();
      await expect.poll(() => listed(page), { timeout: 30_000 }).toHaveLength(2);
      expect((await listed(page)).join('\n')).not.toContain('Mine, and only mine.');

      // **Mine** is the reader's own notes of *both* visibilities.
      await filters.getByRole('tab', { name: 'Mine' }).click();
      await expect.poll(() => listed(page), { timeout: 30_000 }).toHaveLength(2);
      const mine = (await listed(page)).join('\n');
      expect(mine).toContain('Mine, and only mine.');
      expect(mine).toContain('Mine, and the group’s.');
      expect(mine).not.toContain('The group reads this one.');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('gives each state its own empty state', async () => {
    const page = await openTeaching(othersOnlyId);
    try {
      await openNotes(page);
      const filters = page.getByRole('tablist', { name: 'Which notes to show' });

      // A teaching carrying public notes but none of the member's own is **not** an empty state
      // under All.
      await expect.poll(() => listed(page), { timeout: 30_000 }).toHaveLength(1);

      await filters.getByRole('tab', { name: 'Mine' }).click();
      await expect
        .poll(() => page.textContent('body'), { timeout: 30_000 })
        .toContain("You haven't written a note on this teaching yet.");
    } finally {
      await page.context().close();
    }

    const bare = await openTeaching(bareId);
    try {
      await openNotes(bare);
      const filters = bare.getByRole('tablist', { name: 'Which notes to show' });

      await expect
        .poll(() => bare.textContent('body'), { timeout: 30_000 })
        .toContain('No notes on this teaching yet. Write the first one.');

      await filters.getByRole('tab', { name: 'Public' }).click();
      await expect
        .poll(() => bare.textContent('body'), { timeout: 30_000 })
        .toContain('Nobody has shared a note on this teaching yet.');

      await filters.getByRole('tab', { name: 'Mine' }).click();
      await expect
        .poll(() => bare.textContent('body'), { timeout: 30_000 })
        .toContain("You haven't written a note on this teaching yet.");
    } finally {
      await bare.context().close();
    }
  }, 240_000);

  it('changes what is listed and nothing about what the player holds', async () => {
    const page = await openTeaching(readingId);
    try {
      await openNotes(page);
      const filters = page.getByRole('tablist', { name: 'Which notes to show' });

      // The set the player holds is not readable from the page, so the property is asserted the way
      // a member would see it: switching away and back returns the identical full list, which a
      // filter that had narrowed the *source* could not do.
      const all = await listed(page);
      await filters.getByRole('tab', { name: 'Mine' }).click();
      await expect.poll(() => listed(page), { timeout: 30_000 }).toHaveLength(2);
      await filters.getByRole('tab', { name: 'Public' }).click();
      await expect.poll(() => listed(page), { timeout: 30_000 }).toHaveLength(2);
      await filters.getByRole('tab', { name: 'All' }).click();
      await expect.poll(() => listed(page), { timeout: 30_000 }).toEqual(all);

      // And no request was made for any of it: the filter never asks the API for a narrower set.
      const asked: string[] = [];
      page.on('request', (request) => asked.push(request.url()));
      await filters.getByRole('tab', { name: 'Mine' }).click();
      await filters.getByRole('tab', { name: 'Public' }).click();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(
        asked.filter((url) => url.includes(recordingNotesPath(readingId))),
      ).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// =================================================================================================
// Task 1.8 — the composer
// =================================================================================================

describe('the composer', () => {
  it('is pinned above the list at a frozen position the author cannot change', async () => {
    // The reading fixture, so there is a list for the composer to be pinned above.
    const page = await openTeaching(readingId);
    try {
      await waitForAudio(page);
      await page.getByRole('button', { name: 'Play' }).first().click();
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(8);

      await openNotes(page);
      const form = page.getByRole('form', { name: 'Write a note' });
      const anchor = await form.locator('p').first().innerText();
      // Where the teaching actually was, not a default. A composer that fell back to `00:00` would
      // satisfy a shape check while saying nothing, so the seconds are read and compared.
      expect(anchor).toMatch(/^At 00:\d{2}$/);
      expect(secondsIn(anchor)).toBeGreaterThanOrEqual(5);

      // Pinned above everything below it (5.1.2).
      expect(await followsTheComposer(page, '[aria-label="Which notes to show"]')).toBe(true);
      expect(await followsTheComposer(page, '[aria-label="Notes"]')).toBe(true);

      expect(await form.getByPlaceholder('What landed at this moment?').count()).toBe(1);
      // Nothing editable but the note itself — the position is a label, not a field.
      expect(await form.getByRole('textbox').count()).toBe(1);

      const before = (await audioState(page)).currentTime;
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(before + 3);

      // Frozen: the teaching has moved on by seconds and the anchor has not.
      expect(await form.locator('p').first().innerText()).toBe(anchor);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('neither pauses nor moves playback when it opens', async () => {
    const page = await openTeaching(scratchId);
    try {
      await waitForAudio(page);
      await page.getByRole('button', { name: 'Play' }).first().click();
      await expect.poll(async () => (await audioState(page)).paused, { timeout: 30_000 }).toBe(false);

      const before = await audioState(page);
      await openNotes(page);
      const after = await audioState(page);

      expect(after.paused).toBe(false);
      // Forward, and only forward — an open that seeked would show a position behind this one.
      expect(after.currentTime).toBeGreaterThanOrEqual(before.currentTime);
      expect(after.currentTime).toBeLessThan(before.currentTime + 5);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('anchors to the restored resume position when nothing has played', async () => {
    const page = await openTeaching(resumedId, { withAudio: false });
    try {
      await openNotes(page);
      const form = page.getByRole('form', { name: 'Write a note' });
      // 3 725 000 ms is an hour, two minutes and five seconds — the `h:mm:ss` form.
      expect(await form.locator('p').first().innerText()).toBe('At 1:02:05');
    } finally {
      await page.context().close();
    }

    const fresh = await openTeaching(bareId, { withAudio: false });
    try {
      await openNotes(fresh);
      expect(await fresh.getByRole('form', { name: 'Write a note' }).locator('p').first().innerText())
        .toBe('At 00:00');
    } finally {
      await fresh.context().close();
    }
  }, 240_000);

  it('opens on Private, explains the choice, and saves a private note untouched', async () => {
    const privateId = await publishedRecording(`Notes private ${RUN}`);
    const page = await openTeaching(privateId);
    try {
      await openNotes(page);
      const form = page.getByRole('form', { name: 'Write a note' });

      expect(await form.getByRole('button', { name: 'Private' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(await form.getByRole('button', { name: 'Public' }).getAttribute('aria-pressed')).toBe(
        'false',
      );
      expect(await form.innerText()).toContain('Only you will see this.');

      await form.getByRole('button', { name: 'Public' }).click();
      expect(await form.innerText()).toContain(
        'Everyone in the group will see this at this moment.',
      );
      await form.getByRole('button', { name: 'Private' }).click();
      expect(await form.innerText()).toContain('Only you will see this.');

      // Submitted without touching the control at all.
      await form.getByRole('textbox').fill('Untouched control, so nothing is published.');
      await form.getByRole('button', { name: 'Save note' }).click();
      await expect.poll(() => listed(page), { timeout: 30_000 }).toHaveLength(1);

      const card = page.getByRole('list', { name: 'Notes' }).getByRole('listitem').first();
      expect(await card.getByText('Private', { exact: true }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('counts from 900, refuses past the ceiling, and refuses an empty composer', async () => {
    const page = await openTeaching(scratchId);
    try {
      await openNotes(page);
      const form = page.getByRole('form', { name: 'Write a note' });
      const field = form.getByRole('textbox');
      const submit = form.getByRole('button', { name: 'Save note' });

      // Empty: disabled, and no message. An empty composer is not an error.
      expect(await submit.isDisabled()).toBe(true);
      expect(await form.innerText()).not.toContain('characters maximum');

      await field.fill('   ');
      expect(await submit.isDisabled()).toBe(true);

      await field.fill('x'.repeat(COUNT_APPEARS_FROM - 1));
      expect(await form.innerText()).not.toContain('/ 1,000');
      expect(await submit.isDisabled()).toBe(false);

      await field.fill('x'.repeat(COUNT_APPEARS_FROM));
      expect(await form.innerText()).toContain('900 / 1,000');

      await field.fill('x'.repeat(MAX_NOTE_LENGTH));
      expect(await form.innerText()).toContain('1,000 / 1,000');
      expect(await submit.isDisabled()).toBe(false);

      await field.fill('x'.repeat(MAX_NOTE_LENGTH + 1));
      expect(await form.innerText()).toContain('1,000 characters maximum.');
      expect(await submit.isDisabled()).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('saves, and keeps the text when the save fails', async () => {
    const savingId = await publishedRecording(`Notes saving ${RUN}`);
    const page = await openTeaching(savingId);
    try {
      await openNotes(page);
      const form = page.getByRole('form', { name: 'Write a note' });
      const field = form.getByRole('textbox');
      const submit = form.getByRole('button', { name: 'Save note' });

      await field.fill('This one saves.');
      await submit.click();
      await expect.poll(() => listed(page), { timeout: 30_000 }).toHaveLength(1);
      expect((await listed(page))[0]).toContain('This one saves.');
      // Cleared on success, so the next note starts empty.
      expect(await field.inputValue()).toBe('');

      // A save that cannot reach the server.
      await page.route(
        `**${API_PREFIX}${recordingNotesPath(savingId)}`,
        async (route) => {
          if (route.request().method() === 'POST') await route.abort();
          else await route.continue();
        },
      );
      await field.fill('This one does not, and must not be lost.');
      await page.getByRole('button', { name: 'Save note' }).click();

      await expect
        .poll(() => form.innerText(), { timeout: 30_000 })
        .toContain("Couldn't save your note. Your text is still here — try again.");
      expect(await field.inputValue()).toBe('This one does not, and must not be lost.');
      // Still exactly one note: the refusal wrote nothing.
      expect(await listed(page)).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('cannot be pressed twice while it is saving', async () => {
    const twiceId = await publishedRecording(`Notes twice ${RUN}`);
    const page = await openTeaching(twiceId);
    try {
      await openNotes(page);
      const form = page.getByRole('form', { name: 'Write a note' });

      // Held open long enough for a second press to be possible if the control allowed one.
      await page.route(`**${API_PREFIX}${recordingNotesPath(twiceId)}`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        await route.continue();
      });

      await form.getByRole('textbox').fill('Pressed once, saved once.');
      await form.getByRole('button', { name: 'Save note' }).click();

      const busy = form.getByRole('button', { name: 'Saving…' });
      await expect.poll(() => busy.count(), { timeout: 10_000 }).toBe(1);
      expect(await busy.isDisabled()).toBe(true);

      await expect.poll(() => listed(page), { timeout: 60_000 }).toHaveLength(1);
      // One press, one note — a second write would have made two.
      expect(await listed(page)).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('says the teaching went away when it is unpublished underneath, and keeps the text', async () => {
    const goneId = await publishedRecording(`Notes gone ${RUN}`);
    const page = await openTeaching(goneId);
    try {
      await openNotes(page);
      const form = page.getByRole('form', { name: 'Write a note' });
      const field = form.getByRole('textbox');
      await field.fill('Written just as the teaching came down.');

      // Really unpublished, in the database, between the composer opening and the press.
      await setRecordingPublication(goneId, null, handle);

      await form.getByRole('button', { name: 'Save note' }).click();
      await expect
        .poll(() => form.innerText(), { timeout: 30_000 })
        .toContain("This teaching isn't available any more, so the note can't be saved.");
      expect(await field.inputValue()).toBe('Written just as the teaching came down.');
    } finally {
      await page.context().close();
    }
  }, 180_000);
});
