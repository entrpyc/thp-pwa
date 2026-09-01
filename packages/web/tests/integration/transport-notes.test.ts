import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  MEMBER_LIBRARY_PAGE_PATH,
  ROLE,
  recordingNotesPath,
  recordingPagePath,
  type NotesPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertNote,
  insertRecording,
  setRecordingPublication,
  softDeleteNote,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The notes on the transport** (Group 2), driven in a real browser against real audio.
 *
 * Real for the reason the player suite is, and for one more that is specific to this group: every
 * position on this bar is a fraction of a duration **nothing in this product stores**. The media
 * element is the only source of one, so a marker's left offset and 3.2.6's 1% collapse window are
 * both computed from a number that only exists once a real file has been read over a real network.
 * A stub would satisfy every assertion below however it was written.
 *
 * The fixture is a two-minute teaching, which makes the collapse window 1.2 seconds — small enough
 * to place notes either side of deliberately, and large enough that the difference is not a
 * rounding error.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEACHING_SECONDS = 120;
/** 1% of the fixture's duration (3.2.6), restated here rather than read from the component. */
const COLLAPSE_WINDOW_MS = (TEACHING_SECONDS * 1000) / 100;

/** `#22C55E` as a browser reports a computed colour. */
function hexToRgb(hex: string): string {
  const value = hex.replace('#', '');
  const parts = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16));
  return `rgb(${parts.join(', ')})`;
}

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let neighbour: TestAccount;

/** Carries three notes: two inside one collapse window, one well clear of them. */
let markedId: string;
/** Nobody has annotated it, so the track must be the plain one of 5.7.3. */
let bareId: string;
/** A second teaching, so "the set is replaced" is a change rather than a re-render. */
let otherId: string;
/** Carries the two notes Task 5.3.5 deletes — one bare, one with a reply. */
let deletingId: string;
/** Carries one note and one reply, so a reply proving marker-less is a real reply. */
let threadedId: string;

const FIRST_MS = 20_000;
/** Inside the window from `FIRST_MS`, so the two read as one tick. */
const SECOND_MS = FIRST_MS + COLLAPSE_WINDOW_MS / 2;
/** Well clear of it, so the third is its own. */
const THIRD_MS = 80_000;

let bareNoteId: string;
let threadedNoteId: string;

async function publishedRecording(title: string): Promise<string> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording(
    { originalMediaKey: key, title, recordedAt: '2026-08-16' },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

/** Plant a note straight into the table, so a marker fixture does not depend on the composer. */
async function plant(
  recordingId: string,
  who: TestAccount,
  text: string,
  timestampMs: number,
  visibility: 'private' | 'public' = 'public',
): Promise<string> {
  const row = await insertNote(
    { recordingId, authorId: who.id, visibility, text, timestampMs },
    handle,
  );
  return row.id;
}

/** Sign in through the real screen and open a teaching, waiting for the audio to be readable. */
async function openTeaching(id: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

  await page.goto(`${baseUrl}${recordingPagePath(id)}`, { waitUntil: 'domcontentloaded' });
  await waitForAudio(page);
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

/**
 * The transport bar itself.
 *
 * Everything below that looks for a tick looks for it **here**. The notes panel opens with the
 * recording page now and draws marks of its own; unscoped, the two would be counted together and
 * every count in this file would be the sum of two features rather than a fact about either.
 */
function bar(page: Page) {
  return page.getByRole('region', { name: 'Player' });
}

/**
 * Every tick on the track, in the order they sit on it.
 *
 * The `span` matters: the layer that holds them is a `div` whose class also contains "marker", so
 * an element-less selector would count the layer as a tick and every count here would be one too
 * many.
 */
function ticks(page: Page) {
  return bar(page).locator('span[class*="marker"]');
}

/**
 * Which second of the teaching each tick stands on.
 *
 * A tick carries no text and no label — it is a mark on the track rather than a control — so the
 * moment it names is read off the offset it is drawn at, which is also the only thing about it a
 * member can see. Rounded to the second, because the offset is a percentage of a duration the
 * browser reports as a float.
 */
async function tickSeconds(page: Page): Promise<number[]> {
  const percents = await ticks(page).evaluateAll((all) =>
    all.map((one) => Number.parseFloat((one as HTMLElement).style.left)),
  );
  return percents.map((percent) => Math.round((percent / 100) * TEACHING_SECONDS));
}

/**
 * Walk from the recording page back to the library **through the page's own control**.
 *
 * A fresh `goto` would be a full document load, which remounts the whole member surface and takes
 * the player with it — so it would say nothing about whether the transport travels. The back
 * control is a client-side link, and the layout that owns the player survives it, which is exactly
 * the move 3.2.7 is about.
 */
async function leaveForTheLibrary(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Back to recordings' }).click();
  await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });
}

async function audioState(page: Page): Promise<{ currentTime: number; paused: boolean }> {
  return page.evaluate(() => {
    const element = document.querySelector('audio');
    return { currentTime: element?.currentTime ?? -1, paused: element?.paused ?? true };
  });
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  member = await createAccount(databaseUrl, ROLE.member, `transport-member-${RUN}`);
  neighbour = await createAccount(databaseUrl, ROLE.member, `transport-neighbour-${RUN}`);

  [markedId, bareId, otherId, deletingId, threadedId] = await Promise.all([
    publishedRecording(`Transport marked ${RUN}`),
    publishedRecording(`Transport bare ${RUN}`),
    publishedRecording(`Transport other ${RUN}`),
    publishedRecording(`Transport deleting ${RUN}`),
    publishedRecording(`Transport threaded ${RUN}`),
  ]);

  await plant(markedId, neighbour, 'The first of two close together.', FIRST_MS);
  await plant(markedId, neighbour, 'The second of two close together.', SECOND_MS);
  await plant(markedId, member, 'On its own, further along.', THIRD_MS);
  // The neighbour's private note must produce no marker for this member, exactly as it produces no
  // row — the marker set is the payload, and the payload never carried it.
  await plant(markedId, neighbour, 'Nobody else reads this.', 50_000, 'private');

  await plant(otherId, member, 'A note on a different teaching.', 30_000);

  bareNoteId = await plant(deletingId, member, 'Nothing hangs off this.', 15_000);
  threadedNoteId = await plant(deletingId, member, 'This one has a reply.', 60_000);
  await insertNote(
    {
      recordingId: deletingId,
      authorId: neighbour.id,
      visibility: 'public',
      text: 'The conversation that outlives it.',
      parentId: threadedNoteId,
    },
    handle,
  );

  const parent = await plant(threadedId, member, 'The only moment on this teaching.', 40_000);
  await insertNote(
    {
      recordingId: threadedId,
      authorId: neighbour.id,
      visibility: 'public',
      text: 'A reply, which is no moment of its own.',
      parentId: parent,
    },
    handle,
  );
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================
// Task 2.1 — the marker layer on the scrubber
// =================================================================================================

describe('the transport shows where the teaching has been annotated', () => {
  it('draws a round dot per visible note in the notes green, on the line itself', async () => {
    const page = await openTeaching(markedId);
    try {
      // Three visible notes, two of them inside one collapse window — so two dots (3.2.6).
      await expect.poll(() => ticks(page).count()).toBe(2);

      const drawn = await ticks(page)
        .first()
        .evaluate((tick) => {
          // The dot is the tick's `::before`; the tick itself is the transparent box around it, so
          // the green and the roundness are read off the mark rather than off the box.
          const dot = getComputedStyle(tick, '::before');
          const layer = tick.parentElement as HTMLElement;
          const slider = layer.parentElement?.querySelector('input[type="range"]') as HTMLElement;
          return {
            background: dot.backgroundColor,
            width: Number.parseFloat(dot.width),
            height: Number.parseFloat(dot.height),
            radius: Number.parseFloat(dot.borderTopLeftRadius),
            notes: getComputedStyle(document.documentElement)
              .getPropertyValue('--color-notes')
              .trim(),
            // A dot sits *on* the line, and the line is the input's own track — so the layer has
            // to be over the input, not under it, or every dot is hidden behind the track.
            layerZ: Number(getComputedStyle(layer).zIndex),
            sliderZ: Number(getComputedStyle(slider).zIndex),
            layerTakesPointer: getComputedStyle(layer).pointerEvents,
          };
        });

      expect(drawn.background).toBe(hexToRgb(drawn.notes));
      // Round, not a rule: square, and at least half its own width in corner radius.
      expect(drawn.width).toBe(drawn.height);
      expect(drawn.radius).toBeGreaterThanOrEqual(drawn.width / 2);
      expect(drawn.layerZ).toBeGreaterThan(drawn.sliderZ);
      expect(drawn.layerTakesPointer).toBe('none');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('places each tick at its own note’s position along the track', async () => {
    const page = await openTeaching(markedId);
    try {
      await expect.poll(() => ticks(page).count()).toBe(2);

      // Read straight off the ticks, as percentages of the real duration: 20s and 80s of 120s. A
      // layer that placed every tick at zero, or spaced them evenly, would render the same number
      // of ticks and fail here.
      const percents = await ticks(page).evaluateAll((all) =>
        all.map((one) => Number.parseFloat((one as HTMLElement).style.left)),
      );
      expect(percents[0]).toBeCloseTo((FIRST_MS / (TEACHING_SECONDS * 1000)) * 100, 0);
      expect(percents[1]).toBeCloseTo((THIRD_MS / (TEACHING_SECONDS * 1000)) * 100, 0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('leaves the scrubber a slider that still scrubs by pointer and by keyboard', async () => {
    const page = await openTeaching(markedId);
    try {
      await expect.poll(() => ticks(page).count()).toBe(2);
      const slider = page.getByRole('slider', { name: 'Position' });
      // Still announced as a slider, and still a real range input — not a div wearing a role.
      expect(await slider.count()).toBe(1);
      expect(await slider.evaluate((one) => one.tagName.toLowerCase())).toBe('input');

      // By pointer, in the middle of the track — the band the markers must not have taken.
      const box = await slider.boundingBox();
      if (box === null) throw new Error('the scrubber has no box');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect
        .poll(() => audioState(page).then((one) => one.currentTime), { timeout: 15_000 })
        .toBeGreaterThan(TEACHING_SECONDS / 4);

      // And by keyboard, which is the half a pointer test can never speak for.
      const before = (await audioState(page)).currentTime;
      await slider.focus();
      await page.keyboard.press('ArrowRight');
      await expect
        .poll(() => audioState(page).then((one) => one.currentTime), { timeout: 15_000 })
        .toBeGreaterThan(before);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('keeps the ticks on the docked bar away from the recording page, and swaps the set', async () => {
    const page = await openTeaching(markedId);
    try {
      await expect.poll(() => ticks(page).count()).toBe(2);

      // The transport travels with the member (3.2.7), so the ticks do. Walked to through the
      // page's own control rather than by a fresh load, because a reload would remount the player
      // and this is about the bar *surviving* the move.
      await leaveForTheLibrary(page);
      await expect.poll(() => ticks(page).count()).toBe(2);
      expect(await page.getByRole('tab', { name: 'Notes' }).count()).toBe(0);

      /*
       * **The second teaching's answer is held back**, and that is the whole point of the rest of
       * this test. Opening a different teaching *replaces* the marker set; with the answer in
       * flight there is nothing to replace it with yet, so the track must be bare. Without the
       * hold, a set that was never cleared and a set that was cleared and refilled look identical
       * the moment the answer lands — which is to say the claim would not be tested at all.
       */
      await page.route(`**${API_PREFIX}${recordingNotesPath(otherId)}`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        await route.continue();
      });

      // Client-side, so the player stays mounted and the swap is a swap rather than a reload.
      await page.getByRole('link', { name: new RegExp(`Transport other ${RUN}`) }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(otherId)}`, { timeout: 30_000 });

      // The previous teaching's ticks are gone before the new teaching's have arrived.
      await expect.poll(() => ticks(page).count()).toBe(0);

      await waitForAudio(page);
      await expect.poll(() => ticks(page).count(), { timeout: 30_000 }).toBe(1);
      // The other teaching's own note, at its own moment — the set was replaced, not added to.
      expect(await tickSeconds(page)).toEqual([30]);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('collapses notes closer than 1% of the duration into one tick', async () => {
    const page = await openTeaching(markedId);
    try {
      await expect.poll(() => ticks(page).count()).toBe(2);

      // The two inside the window read as one tick at the *earlier* of them; the third is its own.
      // Three notes and two ticks is the assertion — a layer that did not collapse would show
      // three, and one that collapsed everything would show one.
      expect(await tickSeconds(page)).toEqual([FIRST_MS / 1000, THIRD_MS / 1000]);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('renders a plain track for a teaching nobody has annotated', async () => {
    const page = await openTeaching(bareId);
    try {
      expect(await page.getByRole('slider', { name: 'Position' }).count()).toBe(1);
      expect(await ticks(page).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('renders no ticks at all when the notes failed to load, rather than stale ones', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email').fill(member.email);
      await page.getByLabel('Password').fill(member.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

      await page.route(`**${API_PREFIX}${recordingNotesPath(markedId)}`, (route) => route.abort());
      await page.goto(`${baseUrl}${recordingPagePath(markedId)}`, {
        waitUntil: 'domcontentloaded',
      });
      await waitForAudio(page);

      // A failure leaves the track marker-less and the teaching playable — the Availability NFR.
      expect(await ticks(page).count()).toBe(0);
      expect(await page.getByRole('slider', { name: 'Position' }).count()).toBe(1);
      await page
        .getByRole('region', { name: 'Player' })
        .getByRole('button', { name: 'Play', exact: true })
        .click();
      await expect.poll(() => audioState(page).then((one) => one.paused)).toBe(false);
    } finally {
      await context.close();
    }
  }, 180_000);
});

// =================================================================================================
// Task 2.3 — the composer from the transport menu
// =================================================================================================

describe('a member writes a note from the transport, on any screen', () => {
  it('offers a speech-bubble beside the captions item, opening the composer as a sheet', async () => {
    const page = await openTeaching(bareId);
    try {
      /*
       * Shut the Notes tab first. It opens with the recording page now, and its panel holds a
       * composer of its own — so the count below would be two forms and would say nothing about
       * where this one came from. What is being shown here is that the transport opens a composer
       * **over the current screen rather than inside a tab**, and that needs the tab shut.
       */
      await page.getByRole('tab', { name: 'Notes' }).click();
      await expect
        .poll(() => page.getByRole('form', { name: 'Write a note' }).count())
        .toBe(0);

      const toolbar = page.getByRole('navigation', { name: 'Player tools' });
      expect(await toolbar.count()).toBe(0);

      await page.getByRole('button', { name: 'More player controls' }).click();
      // Two items now, where the strip shipped holding one.
      expect(await toolbar.getByRole('button').count()).toBe(2);

      await page.getByRole('button', { name: 'Write a note' }).click();
      await expect.poll(() => page.getByRole('form', { name: 'Write a note' }).count()).toBe(1);
      // Over the current screen rather than inside a tab — the Notes tab is still shut.
      expect(
        await page.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected'),
      ).toBe('false');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('names the teaching above the frozen timestamp', async () => {
    const page = await openTeaching(bareId);
    try {
      // Shut the tab that opens with the page, so the one composer on screen is the sheet's.
      await page.getByRole('tab', { name: 'Notes' }).click();
      await expect
        .poll(() => page.getByRole('form', { name: 'Write a note' }).count())
        .toBe(0);

      await page.getByRole('button', { name: 'More player controls' }).click();
      await page.getByRole('button', { name: 'Write a note' }).click();
      await expect.poll(() => page.getByRole('form', { name: 'Write a note' }).count()).toBe(1);

      const sheet = page.getByRole('region', { name: 'Note composer' });
      const text = (await sheet.innerText()).split('\n').map((one) => one.trim());
      const title = text.indexOf(`Transport bare ${RUN}`);
      const at = text.findIndex((one) => one.startsWith('At '));

      // Which teaching is being annotated, and then which moment — in that order, because over
      // another screen the title is the only thing that says which teaching this is (5.1.5).
      expect(title).toBeGreaterThanOrEqual(0);
      expect(at).toBeGreaterThan(title);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('anchors to the loaded teaching from another screen, and writes an ordinary note', async () => {
    const page = await openTeaching(bareId);
    try {
      // Move the player to a position **this test chose**, so what the note is anchored to can be
      // compared against something the component did not supply. Reading the expected moment back
      // off the sheet would pass just as well if the sheet ignored the player entirely.
      await page.getByRole('slider', { name: 'Position' }).fill('45000');
      await expect
        .poll(() => audioState(page).then((one) => Math.round(one.currentTime)), {
          timeout: 15_000,
        })
        .toBe(45);

      // Walk away from the recording page entirely. The transport, and the teaching it holds,
      // travel with the member.
      await leaveForTheLibrary(page);
      await page.getByRole('button', { name: 'More player controls' }).click();
      await page.getByRole('button', { name: 'Write a note' }).click();
      await expect.poll(() => page.getByRole('form', { name: 'Write a note' }).count()).toBe(1);

      // The sheet says the moment the player was holding, on a screen that has no player controls
      // of its own beyond the docked bar.
      const anchor = await page.getByRole('region', { name: 'Note composer' }).innerText();
      expect(anchor).toContain('At 00:45');

      await page.getByLabel('Your note').fill('Written from the library.');
      await page.getByRole('button', { name: 'Public' }).click();
      await page.getByRole('button', { name: 'Save note' }).click();
      await expect.poll(() => page.getByRole('form', { name: 'Write a note' }).count()).toBe(0);

      // Read back from the API rather than from the screen the note was written on: what is being
      // pinned is that the row is indistinguishable from one written under the tab.
      const payload = (await page.evaluate(async (path) => {
        const response = await fetch(path, { credentials: 'include' });
        return response.json() as Promise<NotesPayload>;
      }, `${baseUrl}${API_PREFIX}${recordingNotesPath(bareId)}`)) as NotesPayload;

      const written = payload.notes.find((one) => one.text === 'Written from the library.');
      expect(written).toBeDefined();
      expect(written?.visibility).toBe('public');
      expect(written?.timestampMs).toBe(45_000);
      expect(written?.replies).toEqual([]);
      expect(written?.pinned).toBe(false);

      // And it is on the teaching the transport was holding, not on the library's first entry.
      const elsewhere = (await page.evaluate(async (path) => {
        const response = await fetch(path, { credentials: 'include' });
        return response.json() as Promise<NotesPayload>;
      }, `${baseUrl}${API_PREFIX}${recordingNotesPath(otherId)}`)) as NotesPayload;
      expect(elsewhere.notes.map((one) => one.text)).not.toContain('Written from the library.');
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// =================================================================================================
// Tasks 3.2.6 and 5.3.5 — what does and does not put a tick on the track
// =================================================================================================

describe('what the marker set follows', () => {
  it('gives a reply no marker of its own', async () => {
    const page = await openTeaching(threadedId);
    try {
      // One note and one reply on this teaching, and one tick: a reply belongs to its parent's
      // moment and has none of its own (3.3.2).
      await expect.poll(() => ticks(page).count()).toBe(1);
      expect(await tickSeconds(page)).toEqual([40]);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('drops a deleted note’s marker, and keeps one whose replies survive it', async () => {
    const before = await openTeaching(deletingId);
    try {
      expect(await tickSeconds(before)).toEqual([15, 60]);
    } finally {
      await before.context().close();
    }

    // Both deleted the same way; only the second is holding a thread open.
    await softDeleteNote(bareNoteId, member.id, handle);
    await softDeleteNote(threadedNoteId, member.id, handle);

    const after = await openTeaching(deletingId);
    try {
      // The tombstone keeps its moment so the surviving replies stay reachable from it (3.5.4);
      // the note with nothing under it takes its tick with it.
      await expect.poll(() => tickSeconds(after)).toEqual([60]);
    } finally {
      await after.context().close();
    }
  }, 180_000);
});
