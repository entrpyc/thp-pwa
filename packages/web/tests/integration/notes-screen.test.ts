import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  MAX_NOTE_LENGTH,
  MEMBER_LIBRARY_PAGE_PATH,
  REACTIONS,
  ROLE,
  recordingNotesPath,
  recordingPagePath,
  recordingPlaybackPath,
} from '@thp/shared';
import {
  createDatabase,
  insertNote,
  insertRecording,
  pinNote,
  setNoteReaction,
  setRecordingPublication,
  softDeleteNote,
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
/** The one account that may moderate — Group 6's overflow is drawn for this role and no other. */
let admin: TestAccount;

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
  admin = await createAccount(databaseUrl, ROLE.admin, `notes-admin-${RUN}`);

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
  it('is pinned above the list, follows the teaching, and holds from the first character', async () => {
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
      const onOpening = await form.locator('p').first().innerText();
      // Where the teaching actually was, not a default. A composer that fell back to `00:00` would
      // satisfy a shape check while saying nothing, so the seconds are read and compared.
      expect(onOpening).toMatch(/^At 00:\d{2}$/);
      expect(secondsIn(onOpening)).toBeGreaterThanOrEqual(5);

      // Pinned above everything below it (5.1.2).
      expect(await followsTheComposer(page, '[aria-label="Which notes to show"]')).toBe(true);
      expect(await followsTheComposer(page, '[aria-label="Notes"]')).toBe(true);

      expect(await form.getByPlaceholder('What landed at this moment?').count()).toBe(1);
      // Nothing editable but the note itself — the position is a label, not a field.
      expect(await form.getByRole('textbox').count()).toBe(1);

      /*
       * **Armed, not frozen.** Nothing has been typed, so the moment follows the teaching — a
       * member who opened this tab ten minutes ago has not decided anything yet, and a composer
       * still offering the moment they opened it at would anchor their note ten minutes early.
       */
      await expect
        .poll(() => form.locator('p').first().innerText(), { timeout: 30_000 })
        .not.toBe(onOpening);

      // The first character is the decision.
      await page.getByLabel('Your note').fill('T');
      const held = await form.locator('p').first().innerText();
      expect(secondsIn(held)).toBeGreaterThanOrEqual(secondsIn(onOpening));

      // And from there it holds, while the teaching runs on underneath it (3.1.1's whole point).
      const typingFrom = (await audioState(page)).currentTime;
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(typingFrom + 3);
      await page.getByLabel('Your note').fill('The moment this actually lands.');
      expect(await form.locator('p').first().innerText()).toBe(held);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('starts the next note from where the teaching has reached, not from the last one', async () => {
    // The gap the old wording left: with the moment fixed when the tab opened, every note written
    // in one sitting landed on the same second — and collapsed into one marker on the transport.
    const sittingId = await publishedRecording(`Notes sitting ${RUN}`);
    const page = await openTeaching(sittingId);
    try {
      await waitForAudio(page);
      await page.getByRole('button', { name: 'Play' }).first().click();
      await openNotes(page);

      await page.getByLabel('Your note').fill('The first thing that landed.');
      const first = await page
        .getByRole('form', { name: 'Write a note' })
        .locator('p')
        .first()
        .innerText();
      await page.getByRole('button', { name: 'Save note' }).click();
      await expect
        .poll(() => page.locator('ol[aria-label="Notes"] > li').count(), { timeout: 30_000 })
        .toBe(1);

      // Let the teaching run on, then write the second note.
      const savedAt = (await audioState(page)).currentTime;
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(savedAt + 4);
      await page.getByLabel('Your note').fill('And the second, later on.');
      await page.getByRole('button', { name: 'Save note' }).click();
      await expect
        .poll(() => page.locator('ol[aria-label="Notes"] > li').count(), { timeout: 30_000 })
        .toBe(2);

      // Two notes, two moments — asserted as *different seconds*, which is the whole finding.
      const moments = await page
        .locator('ol[aria-label="Notes"] > li')
        .evaluateAll((rows) =>
          rows.map((row) => row.querySelector('button')?.textContent?.trim() ?? ''),
        );
      expect(moments).toHaveLength(2);
      expect(moments[0]).not.toBe(moments[1]);
      expect(secondsIn(`At ${moments[0] ?? ''}`)).toBeGreaterThanOrEqual(secondsIn(first));
      expect(secondsIn(`At ${moments[1] ?? ''}`)).toBeGreaterThan(
        secondsIn(`At ${moments[0] ?? ''}`),
      );
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

// =================================================================================================
// Groups 2–6 — the notes surface: threads, reactions, author controls, tombstones and pins
// =================================================================================================

/**
 * **Everything the member reads and presses on a note**, driven in the same real browser as above.
 *
 * Two shapes recur, and both are deliberate. **Every control that must be absent is asserted
 * absent on a card where a sibling control *is* present**, so "the picker did not render" cannot
 * pass because nothing rendered at all. And **every refusal is driven by removing the note out of
 * band** — a second hand at the database, which is exactly what "removed underneath the member"
 * is — rather than by stubbing the API into failing.
 */

/** Sign in as somebody in particular and open a teaching. `openTeaching` is this as the member. */
async function openAs(who: TestAccount, id: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

  await page.goto(`${baseUrl}${recordingPagePath(id)}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('tab', { name: 'Notes' }).count(), { timeout: 60_000 })
    .toBe(1);
  return page;
}

/** The card for one note, whether it sits in the list, the pinned group or a thread. */
function card(page: Page, noteId: string) {
  return page.locator(`#note-${noteId}`);
}

/**
 * One of a note's **own** controls, found by its label.
 *
 * A card contains the thread hanging under it, so a card-scoped query also finds every reply's
 * overflow and picker — and "this tombstone offers no picker" would pass or fail on whether its
 * replies do. This excludes anything inside the thread, which is what makes the absence about the
 * card being asked about.
 */
function ownControl(page: Page, noteId: string, label: string) {
  return page.locator(
    `#note-${noteId} button[aria-label="${label}"]:not(ol[aria-label="Replies"] button)`,
  );
}

/** Plant a reply straight into the table, so a thread fixture does not depend on the composer. */
async function plantReply(
  recordingId: string,
  who: TestAccount,
  parentId: string,
  text: string,
): Promise<string> {
  const row = await insertNote(
    { recordingId, authorId: who.id, visibility: 'public', text, parentId },
    handle,
  );
  return row.id;
}

/** Plant a note and answer its id — `plant` above answers nothing, and these fixtures need one. */
async function plantId(
  recordingId: string,
  who: TestAccount,
  text: string,
  visibility: 'private' | 'public',
  timestampMs: number,
): Promise<string> {
  const row = await insertNote(
    { recordingId, authorId: who.id, visibility, text, timestampMs },
    handle,
  );
  return row.id;
}

// -------------------------------------------------------------------------------------------
// Task 2.2 — reaching a noted moment, from the list's side

describe('a note is reachable from its moment and its moment from the note', () => {
  it('seeks from a card’s timestamp without starting playback', async () => {
    const where = await publishedRecording(`Screen seek ${RUN}`);
    await plant(where, member, 'Ninety seconds in.', 'public', 90_000);

    const page = await openTeaching(where, { withAudio: true });
    try {
      await waitForAudio(page);
      await openNotes(page);
      expect((await audioState(page)).paused).toBe(true);

      await page.getByRole('button', { name: 'The note at 01:30' }).click();

      await expect
        .poll(() => audioState(page).then((one) => Math.round(one.currentTime)), {
          timeout: 15_000,
        })
        .toBe(90);
      // The same rule selecting a transcript line follows: finding your place is not asking for
      // sound.
      expect((await audioState(page)).paused).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('opens the Notes tab at the note a marker names, and marks it', async () => {
    const where = await publishedRecording(`Screen reveal ${RUN}`);
    await plant(where, member, 'The first moment.', 'public', 20_000);
    const target = await plantId(where, member, 'The moment being reached.', 'public', 90_000);

    const page = await openTeaching(where, { withAudio: true });
    try {
      await waitForAudio(page);
      // The tab starts shut — pressing a marker is what opens it.
      expect(
        await page.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected'),
      ).toBe('false');

      await page
        .getByRole('button', { name: 'Note at 01:30' })
        .click({ position: { x: 1, y: 2 } });

      await expect
        .poll(() => page.getByRole('form', { name: 'Write a note' }).count(), { timeout: 30_000 })
        .toBe(1);
      expect(await page.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      // Briefly marked, so it is findable in a long list — the notes green, and on that card only.
      await expect
        .poll(
          () =>
            card(page, target).evaluate((one) => getComputedStyle(one).borderTopColor),
          { timeout: 10_000 },
        )
        .toBe(hexToRgb('#22C55E'));
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('opens a collapsed marker at its earliest note, with the rest as the next rows', async () => {
    const where = await publishedRecording(`Screen collapsed ${RUN}`);
    // Two inside one 1.2s window on a two-minute teaching, and one far away.
    const first = await plantId(where, member, 'Earliest of the pair.', 'public', 60_000);
    await plant(where, member, 'The other of the pair.', 'public', 60_400);
    await plant(where, member, 'Somewhere else entirely.', 'public', 10_000);

    const page = await openTeaching(where, { withAudio: true });
    try {
      await waitForAudio(page);
      await page
        .getByRole('button', { name: '2 notes from 01:00' })
        .click({ position: { x: 1, y: 2 } });

      await expect
        .poll(() => page.getByRole('form', { name: 'Write a note' }).count(), { timeout: 30_000 })
        .toBe(1);
      // Seeks to the *earliest* of the pair, and marks that one.
      await expect
        .poll(() => audioState(page).then((one) => Math.round(one.currentTime)), {
          timeout: 15_000,
        })
        .toBe(60);
      await expect
        .poll(() => card(page, first).evaluate((one) => getComputedStyle(one).borderTopColor), {
          timeout: 10_000,
        })
        .toBe(hexToRgb('#22C55E'));

      // And the rest of the collapsed group are the next rows — the list's own order, unchanged.
      const rows = await listed(page);
      const at = rows.findIndex((one) => one.includes('Earliest of the pair.'));
      expect(rows[at + 1]).toContain('The other of the pair.');
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// -------------------------------------------------------------------------------------------
// Task 3.2 — threads in the list

describe('the group reads and writes a conversation under a note', () => {
  it('offers Reply on a public note, opening a field with the placeholder and a count', async () => {
    const where = await publishedRecording(`Screen reply ${RUN}`);
    const parent = await plantId(where, member, 'Worth answering.', 'public', 10_000);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      const one = card(page, parent);
      await one.getByRole('button', { name: 'Reply' }).click();

      const field = one.getByRole('textbox', { name: 'Write a reply' });
      expect(await field.getAttribute('placeholder')).toBe('Write a reply');

      // The count appears on the same rule as the composer's (5.1.4) — not before 900, and in the
      // error treatment past the ceiling.
      await field.fill('x'.repeat(COUNT_APPEARS_FROM - 1));
      expect(await one.innerText()).not.toContain(`/ ${MAX_NOTE_LENGTH.toLocaleString('en-GB')}`);
      await field.fill('x'.repeat(COUNT_APPEARS_FROM));
      expect(await one.innerText()).toContain(`/ ${MAX_NOTE_LENGTH.toLocaleString('en-GB')}`);
      await field.fill('x'.repeat(MAX_NOTE_LENGTH + 1));
      expect(await one.innerText()).toContain(
        `${MAX_NOTE_LENGTH.toLocaleString('en-GB')} characters maximum.`,
      );
      expect(await one.getByRole('button', { name: 'Reply', exact: true }).isDisabled()).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('carries no visibility control on the reply field, and writes a public reply', async () => {
    const where = await publishedRecording(`Screen reply public ${RUN}`);
    const parent = await plantId(where, member, 'The note.', 'public', 10_000);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      const one = card(page, parent);
      await one.getByRole('button', { name: 'Reply' }).click();

      // The composer above has one; the reply field has none, because there is nothing to choose.
      expect(await one.getByRole('group', { name: 'Who can see this note' }).count()).toBe(0);
      expect(await page.getByRole('group', { name: 'Who can see this note' }).count()).toBe(1);

      await one.getByRole('textbox', { name: 'Write a reply' }).fill('Said out loud.');
      await one.getByRole('button', { name: 'Reply', exact: true }).click();

      await expect
        .poll(() => one.getByRole('list', { name: 'Replies' }).count(), { timeout: 30_000 })
        .toBe(1);
      const reply = one.getByRole('list', { name: 'Replies' }).getByRole('listitem').first();
      expect(await reply.innerText()).toContain('Said out loud.');
      // No **Private** pill, on a card that would carry one if it were private.
      expect(await reply.getByText('Private', { exact: true }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('indents replies inside the parent’s card, with a hairline and no timestamp link', async () => {
    const where = await publishedRecording(`Screen thread ${RUN}`);
    const parent = await plantId(where, member, 'The note.', 'public', 10_000);
    await plantReply(where, neighbour, parent, 'The first answer.');
    await plantReply(where, neighbour, parent, 'The second answer.');

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      const one = card(page, parent);
      const replies = one.getByRole('list', { name: 'Replies' }).getByRole('listitem');
      expect(await replies.count()).toBe(2);

      // Inside the parent's card, not beside it — a thread is part of the note it hangs under.
      expect(await page.getByRole('list', { name: 'Notes' }).getByRole('listitem').count()).toBe(3);

      const shape = await replies.first().evaluate((row) => {
        const style = getComputedStyle(row);
        const thread = row.parentElement as HTMLElement;
        return {
          separator: style.borderTopWidth,
          separatorColour: style.borderTopColor,
          indent: Number.parseFloat(getComputedStyle(thread).paddingLeft),
          border: getComputedStyle(document.documentElement)
            .getPropertyValue('--color-border')
            .trim(),
        };
      });
      // A hairline rather than a gap (5.3.1), and one step of indent.
      expect(Number.parseFloat(shape.separator)).toBeGreaterThan(0);
      expect(shape.indent).toBeGreaterThan(0);

      const text = await replies.first().innerText();
      expect(text).toContain(neighbour.displayName);
      expect(text).toMatch(/\d{1,2} \w{3} \d{4}/);
      // A reply has no moment of its own, so it has no link to one — while the parent does.
      expect(await replies.first().getByRole('button', { name: /The note at/ }).count()).toBe(0);
      expect(await one.getByRole('button', { name: 'The note at 00:10' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('shows no thread area at all on a note nobody has answered', async () => {
    const where = await publishedRecording(`Screen no thread ${RUN}`);
    const quiet = await plantId(where, member, 'Nobody answered this.', 'public', 10_000);
    const busy = await plantId(where, member, 'Somebody answered this.', 'public', 20_000);
    await plantReply(where, neighbour, busy, 'An answer.');

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      // Not an empty list — no list (3.3.7). Asserted beside a card that does have one, so the
      // absence cannot pass because nothing rendered.
      expect(await card(page, quiet).getByRole('list', { name: 'Replies' }).count()).toBe(0);
      expect(await card(page, busy).getByRole('list', { name: 'Replies' }).count()).toBe(1);
      expect(await card(page, quiet).getByRole('button', { name: 'Reply' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('offers no reply affordance on a private note or on a reply', async () => {
    const where = await publishedRecording(`Screen no reply ${RUN}`);
    const secret = await plantId(where, member, 'Only mine.', 'private', 10_000);
    const open = await plantId(where, member, 'The group’s.', 'public', 20_000);
    const reply = await plantReply(where, neighbour, open, 'An answer.');

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      // Neither a private note nor a reply carries one; the public parent beside them does.
      expect(await card(page, secret).getByRole('button', { name: 'Reply' }).count()).toBe(0);
      expect(await card(page, reply).getByRole('button', { name: 'Reply' }).count()).toBe(0);
      expect(await card(page, open).getByRole('button', { name: 'Reply' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// -------------------------------------------------------------------------------------------
// Task 4.4 — the reaction row and the picker

describe('the group’s response to a moment reads on the card', () => {
  it('shows a pill per chosen emoji, labelled by name and count, the member’s own outlined', async () => {
    const where = await publishedRecording(`Screen reactions ${RUN}`);
    const note = await plantId(where, member, 'Responded to.', 'public', 10_000);
    await setNoteReaction(note, member.id, '🙏', handle);
    await setNoteReaction(note, neighbour.id, '🙏', handle);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      const one = card(page, note);

      // A bare emoji is unreadable to a screen reader, so the name and the number are the label.
      const mine = one.getByRole('button', { name: 'praying, 2' });
      expect(await mine.count()).toBe(1);
      // Only emoji somebody chose — the other five are absent, not shown at zero.
      expect(await one.getByRole('button', { name: /, \d+$/ }).count()).toBe(1);

      const outlines = await one.evaluate((row) => {
        const pills = [...row.querySelectorAll('button')].filter((b) =>
          /, \d+$/.test(b.getAttribute('aria-label') ?? ''),
        );
        return {
          mine: getComputedStyle(pills[0] as HTMLElement).borderTopColor,
          strong: getComputedStyle(document.documentElement)
            .getPropertyValue('--color-primary-strong')
            .trim(),
        };
      });
      expect(outlines.mine).toBe(hexToRgb(outlines.strong));
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('shows no row at all on a note nobody has reacted to, only the control', async () => {
    const where = await publishedRecording(`Screen no reactions ${RUN}`);
    const quiet = await plantId(where, member, 'Nobody responded.', 'public', 10_000);
    const busy = await plantId(where, member, 'Somebody did.', 'public', 20_000);
    await setNoteReaction(busy, neighbour.id, '🔥', handle);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      expect(await card(page, quiet).getByRole('button', { name: /, \d+$/ }).count()).toBe(0);
      expect(await card(page, busy).getByRole('button', { name: /, \d+$/ }).count()).toBe(1);
      // The control that opens the picker is there either way.
      expect(await card(page, quiet).getByRole('button', { name: 'React to this note' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('opens a picker of all six by name, marks the current choice, and closes on select', async () => {
    const where = await publishedRecording(`Screen picker ${RUN}`);
    const note = await plantId(where, member, 'About to be responded to.', 'public', 10_000);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      const one = card(page, note);
      await one.getByRole('button', { name: 'React to this note' }).click();

      const picker = one.getByRole('group', { name: 'Choose a reaction' });
      expect(await picker.getByRole('button').count()).toBe(REACTIONS.length);
      for (const reaction of REACTIONS) {
        expect(await picker.getByRole('button', { name: reaction.name }).count(), reaction.name).toBe(1);
      }
      // Nothing chosen yet, so nothing is marked.
      expect(await picker.getByRole('button', { name: 'insight' }).getAttribute('aria-pressed')).toBe(
        'false',
      );

      await picker.getByRole('button', { name: 'insight' }).click();
      // Selecting closes it (5.4.2).
      await expect.poll(() => one.getByRole('group', { name: 'Choose a reaction' }).count()).toBe(0);
      await expect
        .poll(() => one.getByRole('button', { name: 'insight, 1' }).count(), { timeout: 30_000 })
        .toBe(1);

      // Re-opened, the member's current choice is marked — which is what makes the toggle-off
      // below discoverable rather than a guess.
      await one.getByRole('button', { name: 'React to this note' }).click();
      expect(
        await one
          .getByRole('group', { name: 'Choose a reaction' })
          .getByRole('button', { name: 'insight' })
          .getAttribute('aria-pressed'),
      ).toBe('true');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('clears the reaction when the member picks the one they already chose', async () => {
    const where = await publishedRecording(`Screen toggle off ${RUN}`);
    const note = await plantId(where, member, 'Chosen, then unchosen.', 'public', 10_000);
    await setNoteReaction(note, member.id, '👏', handle);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      const one = card(page, note);
      await expect.poll(() => one.getByRole('button', { name: 'encouraged, 1' }).count()).toBe(1);

      await one.getByRole('button', { name: 'React to this note' }).click();
      await one
        .getByRole('group', { name: 'Choose a reaction' })
        .getByRole('button', { name: 'encouraged' })
        .click();

      // Gone entirely rather than left at zero — a reaction given can be taken back (3.4.4).
      await expect
        .poll(() => one.getByRole('button', { name: /, \d+$/ }).count(), { timeout: 30_000 })
        .toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('shows a private note neither a reaction row nor a picker control', async () => {
    const where = await publishedRecording(`Screen private reactions ${RUN}`);
    const secret = await plantId(where, member, 'Only mine.', 'private', 10_000);
    const open = await plantId(where, member, 'The group’s.', 'public', 20_000);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      expect(await card(page, secret).getByRole('button', { name: 'React to this note' }).count()).toBe(0);
      // Beside a card that does carry one, so the absence is about the visibility.
      expect(await card(page, open).getByRole('button', { name: 'React to this note' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// -------------------------------------------------------------------------------------------
// Tasks 5.1.4 and 5.3 — author controls, the edit form, the confirmation and the tombstone

describe('a member acts on what they wrote', () => {
  it('offers Edit and Delete on their own note and neither on anybody else’s', async () => {
    const where = await publishedRecording(`Screen own ${RUN}`);
    const mine = await plantId(where, member, 'Mine to change.', 'public', 10_000);
    const theirs = await plantId(where, neighbour, 'Not mine to touch.', 'public', 20_000);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      await card(page, mine).getByRole('button', { name: 'Note actions' }).click();
      const menu = card(page, mine).getByRole('group', { name: 'Note actions' });
      expect(await menu.getByRole('button', { name: 'Edit' }).count()).toBe(1);
      expect(await menu.getByRole('button', { name: 'Delete' }).count()).toBe(1);

      // A member is not an admin, so somebody else's note carries no overflow at all.
      expect(await card(page, theirs).getByRole('button', { name: 'Note actions' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('turns the card into the composer, keeps the moment and the visibility, and saves', async () => {
    const where = await publishedRecording(`Screen edit ${RUN}`);
    const note = await plantId(where, member, 'The first wording.', 'private', 30_000);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      const one = card(page, note);
      await one.getByRole('button', { name: 'Note actions' }).click();
      await one.getByRole('button', { name: 'Edit' }).click();

      const form = one.getByRole('form', { name: 'Edit this note' });
      // The existing text is loaded, not an empty field.
      expect(await form.getByLabel('Your note').inputValue()).toBe('The first wording.');
      // The moment and the visibility are shown and are not controls (3.5.3).
      expect(await one.getByRole('button', { name: 'The note at 00:30' }).count()).toBe(1);
      expect(await one.getByText('Private', { exact: true }).count()).toBe(1);
      expect(await form.getByRole('group', { name: 'Who can see this note' }).count()).toBe(0);

      // Cancel leaves the note as it was.
      await form.getByRole('button', { name: 'Cancel' }).click();
      expect(await one.innerText()).toContain('The first wording.');

      await one.getByRole('button', { name: 'Note actions' }).click();
      await one.getByRole('button', { name: 'Edit' }).click();
      await one.getByRole('form', { name: 'Edit this note' }).getByLabel('Your note').fill('The better wording.');
      await one.getByRole('button', { name: 'Save', exact: true }).click();

      await expect
        .poll(() => card(page, note).innerText(), { timeout: 30_000 })
        .toContain('The better wording.');
      // Nothing marks the card as edited, and the previous text is nowhere on the screen.
      expect(await card(page, note).innerText()).not.toContain('edited');
      expect(await page.textContent('body')).not.toContain('The first wording.');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('confirms a delete first, says when replies will stay, and Cancel leaves it be', async () => {
    const where = await publishedRecording(`Screen confirm ${RUN}`);
    const bare = await plantId(where, member, 'Nothing hangs off this.', 'public', 10_000);
    const threaded = await plantId(where, member, 'This one has a reply.', 'public', 20_000);
    await plantReply(where, neighbour, threaded, 'An answer that survives.');

    const page = await openTeaching(where);
    try {
      await openNotes(page);

      await card(page, bare).getByRole('button', { name: 'Note actions' }).click();
      await card(page, bare).getByRole('button', { name: 'Delete' }).click();
      const confirm = card(page, bare).getByRole('group', { name: 'Confirm deletion' });
      expect(await confirm.innerText()).toContain("Delete this note? This can't be undone.");

      // Cancel leaves the note exactly where it was.
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      expect(await card(page, bare).count()).toBe(1);
      expect(await card(page, bare).innerText()).toContain('Nothing hangs off this.');

      // A note with replies says what will happen to them.
      await card(page, threaded).getByRole('button', { name: 'Note actions' }).click();
      await card(page, threaded).getByRole('button', { name: 'Delete' }).click();
      expect(
        await card(page, threaded).getByRole('group', { name: 'Confirm deletion' }).innerText(),
      ).toContain("Delete this note? The replies to it will stay. This can't be undone.");
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('replaces a removed note with one dim line, keeping its moment and its replies', async () => {
    const where = await publishedRecording(`Screen tombstone ${RUN}`);
    const note = await plantId(where, member, 'About to be removed.', 'public', 40_000);
    await plantReply(where, neighbour, note, 'The conversation that outlives it.');
    await setNoteReaction(note, neighbour.id, '🙏', handle);
    // Removed by an **admin**, so what the author reads is what everybody reads (3.5.8).
    await softDeleteNote(note, admin.id, handle);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      const one = card(page, note);

      const text = await one.innerText();
      expect(text).toContain('This note was removed.');
      expect(text).not.toContain('About to be removed.');
      // Nothing about who removed it, and no author line — its own author reads this too.
      expect(text).not.toContain(admin.displayName);
      expect(text).not.toContain(member.displayName);

      // Kept: the moment, and the thread that hangs from it.
      expect(await one.getByRole('button', { name: 'The note at 00:40' }).count()).toBe(1);
      expect(await one.getByRole('list', { name: 'Replies' }).getByRole('listitem').count()).toBe(1);

      // Gone: the reaction row, the reply control and the overflow.
      expect(await one.getByRole('button', { name: /, \d+$/ }).count()).toBe(0);
      expect(await ownControl(page, note, 'React to this note').count()).toBe(0);
      expect(await one.getByRole('button', { name: 'Reply' }).count()).toBe(0);
      expect(await ownControl(page, note, 'Note actions').count()).toBe(0);

      // Dim and italic, which is what makes it read as an absence rather than as a note.
      const style = await one.locator('p').first().evaluate((line) => ({
        style: getComputedStyle(line).fontStyle,
        colour: getComputedStyle(line).color,
        dim: getComputedStyle(document.documentElement).getPropertyValue('--color-text-dim').trim(),
      }));
      expect(style.style).toBe('italic');
      expect(style.colour).toBe(hexToRgb(style.dim));
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// -------------------------------------------------------------------------------------------
// Task 5.4 — acting on a note removed underneath you

describe('a note removed while the member’s screen was open', () => {
  it('keeps a refused reply’s text in the field and shows the tombstone', async () => {
    const where = await publishedRecording(`Screen refused reply ${RUN}`);
    const note = await plantId(where, member, 'About to go.', 'public', 10_000);
    await plantReply(where, neighbour, note, 'Holding the tombstone up.');

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      const one = card(page, note);
      await one.getByRole('button', { name: 'Reply' }).click();
      await one.getByRole('textbox', { name: 'Write a reply' }).fill('A paragraph worth keeping.');

      // A second hand removes it while the member is typing — which is exactly the situation.
      await softDeleteNote(note, member.id, handle);
      await one.getByRole('button', { name: 'Reply', exact: true }).click();

      await expect
        .poll(() => card(page, note).innerText(), { timeout: 30_000 })
        .toContain('This note was removed while you were writing.');
      // The text is still there to be copied out before the list catches up.
      expect(await card(page, note).getByRole('textbox', { name: 'Write a reply' }).inputValue()).toBe(
        'A paragraph worth keeping.',
      );
      // And the list refreshed to the tombstone rather than to a note that is not there.
      expect(await card(page, note).innerText()).toContain('This note was removed.');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('says so on a refused reaction, and shows no reactions on the tombstone', async () => {
    const where = await publishedRecording(`Screen refused reaction ${RUN}`);
    const note = await plantId(where, member, 'About to go.', 'public', 10_000);
    await plantReply(where, neighbour, note, 'Holding the tombstone up.');
    await setNoteReaction(note, neighbour.id, '🔥', handle);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      const one = card(page, note);
      await expect.poll(() => one.getByRole('button', { name: 'convicting, 1' }).count()).toBe(1);

      await softDeleteNote(note, member.id, handle);
      await ownControl(page, note, 'React to this note').click();
      await one
        .getByRole('group', { name: 'Choose a reaction' })
        .getByRole('button', { name: 'praying' })
        .click();

      // **Read off the refusal itself, not off the card.** 5.4.3's sentence and the tombstone's
      // (5.3.3) are word for word the same, so a check against the card's text would be satisfied
      // by the tombstone alone and would say nothing at all about what the refused reaction was
      // told — which is exactly the shape that certifies a criterion nothing is enforcing.
      await expect
        .poll(() => card(page, note).getByRole('status').innerText(), { timeout: 30_000 })
        .toBe('This note was removed.');
      // And the list caught up behind it: the tombstone is what stands there now.
      expect(await card(page, note).innerText()).toContain('This note was removed.');
      // A row of responses to words nobody can read any more is a reaction to nothing (3.4.10).
      expect(await card(page, note).getByRole('button', { name: /, \d+$/ }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('says something different again on a refused edit and a refused delete', async () => {
    const where = await publishedRecording(`Screen refused edit ${RUN}`);
    const forEdit = await plantId(where, member, 'Edited too late.', 'public', 10_000);
    const forDelete = await plantId(where, member, 'Deleted too late.', 'public', 20_000);
    await plantReply(where, neighbour, forEdit, 'Holding it up.');
    await plantReply(where, neighbour, forDelete, 'Holding it up.');

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      await card(page, forEdit).getByRole('button', { name: 'Note actions' }).click();
      await card(page, forEdit).getByRole('button', { name: 'Edit' }).click();
      await card(page, forEdit)
        .getByRole('form', { name: 'Edit this note' })
        .getByLabel('Your note')
        .fill('Never landing.');

      await softDeleteNote(forEdit, member.id, handle);
      await card(page, forEdit).getByRole('button', { name: 'Save', exact: true }).click();

      await expect
        .poll(() => card(page, forEdit).innerText(), { timeout: 30_000 })
        .toContain('This note has already been removed.');

      // The delete half, refused the same way and with the same sentence.
      await card(page, forDelete).getByRole('button', { name: 'Note actions' }).click();
      await card(page, forDelete).getByRole('button', { name: 'Delete' }).click();
      await softDeleteNote(forDelete, member.id, handle);
      await card(page, forDelete)
        .getByRole('group', { name: 'Confirm deletion' })
        .getByRole('button', { name: 'Delete', exact: true })
        .click();

      await expect
        .poll(() => card(page, forDelete).innerText(), { timeout: 30_000 })
        .toContain('This note has already been removed.');
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// -------------------------------------------------------------------------------------------
// Task 6.4 — pinned notes and the admin overflow

describe('the group reads the raised notes first', () => {
  it('renders pinned notes above the list, under a heading, in the list’s own order', async () => {
    const where = await publishedRecording(`Screen pinned ${RUN}`);
    const early = await plantId(where, member, 'Raised, and earlier.', 'public', 20_000);
    const middle = await plantId(where, member, 'Not raised.', 'public', 40_000);
    const late = await plantId(where, member, 'Raised, and later.', 'public', 60_000);
    // Pinned in the reverse of the order they must read in, so the order is the query's and not
    // the order somebody happened to press.
    await pinNote({ noteId: late, recordingId: where, pinnedBy: admin.id }, handle);
    await pinNote({ noteId: early, recordingId: where, pinnedBy: admin.id }, handle);

    const page = await openTeaching(where);
    try {
      await openNotes(page);
      const pinned = page.getByRole('list', { name: 'Pinned' }).getByRole('listitem');
      expect(await pinned.count()).toBe(2);
      // Timestamp ascending — the same total order the list itself uses (3.6.5).
      expect(await pinned.nth(0).innerText()).toContain('Raised, and earlier.');
      expect(await pinned.nth(1).innerText()).toContain('Raised, and later.');
      // A **heading** over the group, so the raised notes visibly end and the teaching's own order
      // begins. Asked for as a heading rather than as the text "Pinned", because each card carries
      // a pill saying exactly that — and a check that matched either would pass with no heading.
      expect(await page.getByRole('heading', { name: 'Pinned', exact: true }).count()).toBe(1);
      expect(await pinned.nth(0).getByText('Pinned', { exact: true }).count()).toBe(1);

      const raised = await pinned.first().evaluate((row) => {
        const style = getComputedStyle(row);
        return {
          background: style.backgroundColor,
          border: style.borderTopColor,
          surface: getComputedStyle(document.documentElement)
            .getPropertyValue('--color-surface-raised')
            .trim(),
        };
      });
      expect(raised.background).toBe(hexToRgb(raised.surface));

      // The whole group reads them, not only an admin: this page is a member's.
      expect(await page.getByRole('list', { name: 'Notes' }).getByRole('listitem').count()).toBe(1);
      expect(
        await page.getByRole('list', { name: 'Notes' }).getByRole('listitem').first().innerText(),
      ).toContain('Not raised.');
      // And each is a full card, working in place (6.4.3).
      expect(await pinned.first().getByRole('button', { name: 'The note at 00:20' }).count()).toBe(1);
      expect(await pinned.first().getByRole('button', { name: 'Reply' }).count()).toBe(1);
      expect(await pinned.first().getByRole('button', { name: 'React to this note' }).count()).toBe(1);
      expect(await card(page, middle).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('does not repeat a pinned note at its own position, and leaves its marker there', async () => {
    const where = await publishedRecording(`Screen pinned once ${RUN}`);
    const note = await plantId(where, member, 'Read once, at the top.', 'public', 90_000);
    await pinNote({ noteId: note, recordingId: where, pinnedBy: admin.id }, handle);

    const page = await openTeaching(where, { withAudio: true });
    try {
      await waitForAudio(page);
      await openNotes(page);

      // One card in the document, in the pinned group — every note is read once (6.4.2).
      expect(await page.locator(`#note-${note}`).count()).toBe(1);
      expect(await page.getByRole('list', { name: 'Pinned' }).getByRole('listitem').count()).toBe(1);
      expect(await page.getByRole('list', { name: 'Notes' }).count()).toBe(0);

      // Its tick is at its own moment, unmoved by being raised. Asked of the transport rather than
      // of the page, because the card's own timestamp link reads almost the same.
      expect(
        await page
          .getByRole('region', { name: 'Player' })
          .getByRole('button', { name: 'Note at 01:30' })
          .count(),
      ).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('offers an admin Delete and Pin on any public note, and neither on a reply or a private one', async () => {
    const where = await publishedRecording(`Screen admin overflow ${RUN}`);
    const open = await plantId(where, member, 'A member’s public note.', 'public', 10_000);
    const secret = await plantId(where, admin, 'The admin’s own private note.', 'private', 20_000);
    const reply = await plantReply(where, member, open, 'A reply.');

    const page = await openAs(admin, where);
    try {
      await openNotes(page);

      await ownControl(page, open, 'Note actions').click();
      const menu = card(page, open).getByRole('group', { name: 'Note actions' });
      expect(await menu.getByRole('button', { name: 'Delete' }).count()).toBe(1);
      expect(await menu.getByRole('button', { name: 'Pin' }).count()).toBe(1);
      // Moderation is deletion, never rewriting: no Edit on a note the admin did not write.
      expect(await menu.getByRole('button', { name: 'Edit' }).count()).toBe(0);

      // A reply has no moment to raise, and a private note is nobody else's to read (3.6.8).
      await card(page, reply).getByRole('button', { name: 'Note actions' }).click();
      expect(
        await card(page, reply).getByRole('group', { name: 'Note actions' }).getByRole('button', { name: 'Pin' }).count(),
      ).toBe(0);
      await card(page, secret).getByRole('button', { name: 'Note actions' }).click();
      expect(
        await card(page, secret).getByRole('group', { name: 'Note actions' }).getByRole('button', { name: 'Pin' }).count(),
      ).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('names the moderation in the confirmation, and moves a note in and out without one', async () => {
    const where = await publishedRecording(`Screen moderate ${RUN}`);
    const note = await plantId(where, member, 'A member’s note.', 'public', 10_000);

    const page = await openAs(admin, where);
    try {
      await openNotes(page);

      // Pinning acts on the press — neither pin action is destructive and both undo in one (5.6.3).
      await card(page, note).getByRole('button', { name: 'Note actions' }).click();
      await card(page, note).getByRole('button', { name: 'Pin' }).click();
      await expect
        .poll(() => page.getByRole('list', { name: 'Pinned' }).getByRole('listitem').count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(await page.getByRole('group', { name: 'Confirm deletion' }).count()).toBe(0);

      // And back to its chronological position, again without a prompt.
      await card(page, note).getByRole('button', { name: 'Note actions' }).click();
      await card(page, note).getByRole('button', { name: 'Unpin' }).click();
      await expect
        .poll(() => page.getByRole('list', { name: 'Pinned' }).count(), { timeout: 30_000 })
        .toBe(0);
      await expect
        .poll(() => page.getByRole('list', { name: 'Notes' }).getByRole('listitem').count())
        .toBe(1);

      // Deleting somebody else's note says what it is, and that it goes on the record.
      await card(page, note).getByRole('button', { name: 'Note actions' }).click();
      await card(page, note).getByRole('button', { name: 'Delete' }).click();
      expect(
        await card(page, note).getByRole('group', { name: 'Confirm deletion' }).innerText(),
      ).toContain("Delete this member's note? This can't be undone, and the removal is logged.");
    } finally {
      await page.context().close();
    }
  }, 180_000);
});
