import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Locator, type Page, type Request } from 'playwright';
import {
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  MEMBER_LIBRARY_PAGE_PATH,
  NOW_PLAYING_PAGE_PATH,
  REVIEW_FIELD,
  ROLE,
  formatCitation,
  recordingPagePath,
  recordingPlaybackPath,
  recordingScripturePath,
  type ScriptureCitation,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  insertSeries,
  replaceOpenDrafts,
  replaceScriptureReferences,
  setRecordingPublication,
  setRecordingSeries,
  setSeriesArtwork,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The now-playing view, driven in a real browser** (scope plan 3.1, 3.2, 3.3) —
 * `pages/player.png`.
 *
 * Real for the reason every player suite here is real: the three claims that cost most to get wrong
 * are claims about a *live media element surviving a navigation*, and no component test can make
 * one. "Opening the view leaves a playing teaching playing" is a fact about an `<audio>` element
 * that was decoding bytes from the store before the press and is still the same element after it —
 * so the audio is real, the store is real, and the transition is a real client-side navigation
 * through the real route.
 *
 * Two teachings carry the file:
 *
 * - **`coveredId`** — published, in a series that has a cover, citing three approved references
 *   stored out of canon order, and carrying an **open, unapproved** scripture draft beside them.
 *   That draft is what 3.3.4 is asserted against: a citation nobody approved is a citation nobody
 *   reads.
 * - **`looseId`** — published, in **no series at all** and citing nothing. It is 3.2.4's case and
 *   3.3.3's at once, and neither needed extra seeding to reach.
 *
 * Nothing is behind the artwork key, and nothing needs to be: what this suite asserts is the frame
 * — that the view carries an `<img>`, that its `src` is the signed URL the API minted, that the box
 * is square and crops from its centre. Whether the object decodes is scope plan 1.2's property,
 * proved against the real store in `series-artwork.test.ts`.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Long enough that a play press has somewhere to go while the view is opened and closed. */
const TEACHING_SECONDS = 60;

const COVERED_TITLE = `Now playing covered ${RUN}`;
const LOOSE_TITLE = `Now playing loose ${RUN}`;
const SERIES_TITLE = `Now playing series ${RUN}`;
const COVER_KEY = `artwork/${RUN}-now-playing.webp`;

/**
 * Stored as Romans, Exodus, Genesis — answered as Genesis, Exodus, Romans.
 *
 * The same three the scripture suites use, and for the same reason: canon puts Genesis first and
 * the alphabet puts Exodus first, so a view that re-sorted the API's answer by any obvious key
 * would fail 3.3.2 rather than pass it by coincidence.
 */
const APPROVED = [
  { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4 },
  { book: 'exodus', chapter: 3, verseStart: 1, verseEnd: 2 },
  { book: 'genesis', chapter: 1, verseStart: 1, verseEnd: 2 },
].map((one) => ({ ...one, origin: 'machine' as const, editedByAdmin: false }));

/** Proposed by the draft step and approved by nobody. It must reach no member's screen (3.3.4). */
const DRAFTED: readonly ScriptureCitation[] = [
  { book: 'jonah', chapter: 2, verseStart: 1, verseEnd: 3 },
];

const PROVENANCE = {
  model: 'fake',
  modelVersion: 'fake-1',
  promptVersion: 'draft-1',
  steeringPrompt: null,
  fields: { [REVIEW_FIELD.scripture.name]: { aiSuggested: true, editedByAdmin: false } },
};

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let coveredId: string;
let looseId: string;

interface Snapshot {
  readonly currentTime: number;
  readonly paused: boolean;
  readonly probe: string | null;
}

async function audioState(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const element = document.querySelector('audio');
    return {
      currentTime: element?.currentTime ?? -1,
      paused: element?.paused ?? true,
      probe: element?.dataset['probe'] ?? null,
    };
  });
}

/** How many times this page has asked the API for a grant to play that teaching with. */
function grants(requests: readonly Request[], id: string): number {
  return requests.filter((request) =>
    request.url().startsWith(`${baseUrl}${API_PREFIX}${recordingPlaybackPath(id)}`),
  ).length;
}

async function publishedRecording(title: string): Promise<string> {
  const { key } = await uploadTestAudio(settings, TEACHING_SECONDS);
  const row = await insertRecording(
    { originalMediaKey: key, title, recordedAt: '2026-08-16' },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

/**
 * Sign in through the real screen and open a teaching, waiting until the element has metadata.
 *
 * Waiting for the duration is waiting for a real round trip to the bucket — which is what makes
 * "the same element afterwards" a claim about something that was genuinely working beforehand.
 */
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
    .poll(async () => (await audioState(page)).currentTime, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(0);
  await expect.poll(() => grants(requests, id), { timeout: 60_000 }).toBe(1);
  return { page, requests };
}

const bar = (page: Page): Locator => page.getByRole('region', { name: 'Player' });
const view = (page: Page): Locator => page.getByRole('region', { name: 'Now playing' });

/**
 * The transport's one link — the layer over the slot at its left, which holds the cover and title.
 *
 * By its own accessible name rather than by the teaching's, and that is the point: there is already
 * a link named after the playing teaching on the library and on its series page, going somewhere
 * else entirely. This one says what it does.
 */
function openControl(page: Page): Locator {
  return bar(page).getByRole('link', { name: 'Open the full player' });
}

/** Press the transport's slot and wait for the view to be the page. */
async function openTheView(page: Page): Promise<void> {
  await expect.poll(() => openControl(page).count(), { timeout: 30_000 }).toBe(1);
  await openControl(page).click();
  await page.waitForURL(`${baseUrl}${NOW_PLAYING_PAGE_PATH}`, { timeout: 30_000 });
  await expect.poll(() => view(page).count(), { timeout: 30_000 }).toBe(1);
}

/** The view's scripture citations, in the order they are drawn. */
async function citationsOnScreen(page: Page): Promise<string[]> {
  return view(page).getByRole('listitem').getByRole('heading').allTextContents();
}

/** The same teaching's citations **as the API answers them**, asked for from inside the page. */
async function citationsFromApi(page: Page, id: string): Promise<string[]> {
  const references = await page.evaluate(async (url: string) => {
    const response = await fetch(url, { credentials: 'include' });
    const body = (await response.json()) as {
      references: { book: string; chapter: number; verseStart: number; verseEnd: number }[];
    };
    return body.references;
  }, `${baseUrl}${API_PREFIX}${recordingScripturePath(id)}`);
  return references.map((one) => formatCitation(one as ScriptureCitation));
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  member = await createAccount(databaseUrl, ROLE.member, 'now-playing-member');

  const series = await insertSeries({ title: SERIES_TITLE, description: null }, handle);
  await setSeriesArtwork(series.id, COVER_KEY, handle);

  coveredId = await publishedRecording(COVERED_TITLE);
  await setRecordingSeries(coveredId, series.id, handle);
  await replaceScriptureReferences(coveredId, APPROVED, handle);
  // Open, and left open: an approval is the only thing that puts a citation in front of a member.
  await replaceOpenDrafts(
    coveredId,
    [
      {
        kind: 'scripture',
        fields: { [REVIEW_FIELD.scripture.name]: DRAFTED },
        provenance: PROVENANCE,
      },
    ],
    handle,
  );

  // In no series at all, and citing nothing — 3.2.4 and 3.3.3 in one teaching.
  looseId = await publishedRecording(LOOSE_TITLE);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

/**
 * **The route, opened and closed** (scope plan 3.1).
 *
 * Every assertion here is about the two transitions rather than about what the view holds. The
 * point of scope tdd 1.6 is that a route *inside the member layout* makes "playback is never
 * interrupted" a property of where the route sits — so what has to be driven is the sitting: a real
 * client-side navigation, with a real element playing through it.
 */
describe('the transport opens the now-playing view, and it closes back', () => {
  // 3.1.1 — the docked transport offers the control, and it is the slot that says what is playing.
  it('offers one control on the transport that opens the view', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      await expect.poll(() => openControl(page).count(), { timeout: 30_000 }).toBe(1);
      // It is the only link on the bar, and it covers the slot that says what is playing — so the
      // press is on the teaching without the link having to borrow its name.
      expect(await bar(page).getByRole('link').count()).toBe(1);
      expect(await bar(page).textContent()).toContain(COVERED_TITLE);

      await openTheView(page);
      expect(page.url()).toBe(`${baseUrl}${NOW_PLAYING_PAGE_PATH}`);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * 3.1.2 — **back to where the member was**, which is not a fixed screen.
   *
   * Asserted from two different screens in one run, because a close that always went to the
   * recording page would pass the first half and fail the second — and the transport is on every
   * member screen precisely so that the second half happens.
   */
  it('closes back to the screen it was opened from, whichever that was', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      await openTheView(page);
      await page.getByRole('button', { name: 'Close now playing' }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(coveredId)}`, { timeout: 30_000 });

      // Now from the library, reached by a client-side press rather than a fresh load.
      await page.getByRole('link', { name: 'Back to recordings' }).click();
      await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });

      await openTheView(page);
      await page.getByRole('button', { name: 'Close now playing' }).click();
      await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 240_000);

  // 3.1.3 and 3.1.4 — the audio is untouched by either transition.
  it('leaves a playing teaching playing through the open and through the close', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      await page.getByRole('button', { name: 'Play', exact: true }).first().click();
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(1);

      await openTheView(page);

      // Not merely "still not paused": the position advances, which is the difference between an
      // element that is playing and one that stopped at the moment of the press.
      const onOpen = await audioState(page);
      expect(onOpen.paused).toBe(false);
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(onOpen.currentTime + 0.5);

      await page.getByRole('button', { name: 'Close now playing' }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(coveredId)}`, { timeout: 30_000 });

      const onClose = await audioState(page);
      expect(onClose.paused).toBe(false);
      // And it never went back to the beginning — the position is past where it was on the way in.
      expect(onClose.currentTime).toBeGreaterThan(onOpen.currentTime);
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(onClose.currentTime + 0.5);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /**
   * 3.1.5 — **the same element**, which is the mechanism behind the two criteria above.
   *
   * A mark written onto the element before the press is what tells a surviving element from a
   * freshly mounted one that happens to be playing: React would give a remount a new node, and the
   * mark would be gone. The grant count is the same fact from the API's side — a remounted player
   * would have had to ask for a new signed URL.
   */
  it('keeps the very same audio element, and asks for no second grant', async () => {
    const { page, requests } = await openTeaching(coveredId);
    try {
      await page.evaluate(() => {
        const element = document.querySelector('audio');
        if (element !== null) element.dataset['probe'] = 'the-same-element';
      });
      expect((await audioState(page)).probe).toBe('the-same-element');
      expect(grants(requests, coveredId)).toBe(1);

      await openTheView(page);

      expect((await audioState(page)).probe).toBe('the-same-element');
      expect(grants(requests, coveredId)).toBe(1);

      // And back out again — the return trip remounts the recording page, which calls `open` for a
      // teaching that is already loaded. That call has to be the no-op it says it is.
      await page.getByRole('button', { name: 'Close now playing' }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(coveredId)}`, { timeout: 30_000 });
      expect((await audioState(page)).probe).toBe('the-same-element');
      expect(grants(requests, coveredId)).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  /**
   * 3.1.6 — **no second player**. scope prd 3.3.4 says every control that changes playback stays on
   * the transport, and the way that fails is not by being wrong but by being duplicated: a play
   * button on the view and a play button on the bar, disagreeing the first time one is pressed.
   */
  it('renders no transport control of its own, and leaves the docked one on screen', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      await openTheView(page);
      const panel = view(page);

      expect(await panel.getByRole('button', { name: 'Play', exact: true }).count()).toBe(0);
      expect(await panel.getByRole('button', { name: 'Pause', exact: true }).count()).toBe(0);
      expect(await panel.getByRole('slider').count()).toBe(0);
      expect(await panel.getByRole('button', { name: /Playback speed/ }).count()).toBe(0);
      expect(await panel.getByRole('button', { name: /10 seconds/ }).count()).toBe(0);

      // Not because there is no player on the screen — the docked one is right there, and it is
      // still the only one.
      expect(await bar(page).getByRole('button', { name: 'Play', exact: true }).count()).toBe(1);
      expect(await bar(page).getByRole('slider', { name: 'Position' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// =================================================================================================

/**
 * **The square cover** (scope plan 3.2) — `pages/player.png` draws it large, square and centred.
 *
 * The cover is the *series'*: a recording has none of its own in this scope, and the view reads it
 * off the teaching the transport is already holding rather than fetching anything.
 */
describe('the view shows the playing teaching`s cover as a square', () => {
  // 3.2.1 — it is there, it is the series' cover, and it is square.
  it('renders the series cover as a square', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      await openTheView(page);

      const cover = view(page).locator('img');
      await expect.poll(() => cover.count(), { timeout: 30_000 }).toBe(1);
      expect(await cover.getAttribute('src')).toContain(COVER_KEY);

      const box = await cover.boundingBox();
      expect(box).not.toBeNull();
      const drawn = box as { width: number; height: number };
      expect(drawn.width).toBeGreaterThan(0);
      // Square from the CSS rather than from the image: the box is what `pages/player.png` draws,
      // whatever shape the admin uploaded.
      expect(drawn.height).toBeCloseTo(drawn.width, 0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  // 3.2.2 — cropped from the centre, never stretched to the square.
  it('crops the cover from its centre rather than stretching it', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      await openTheView(page);

      const cover = view(page).locator('img');
      await expect.poll(() => cover.count(), { timeout: 30_000 }).toBe(1);
      expect(await cover.evaluate((node) => getComputedStyle(node).objectFit)).toBe('cover');
      expect(await cover.evaluate((node) => getComputedStyle(node).objectPosition)).toBe('50% 50%');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * 3.2.3 — **labelled**, unlike the covers that sit beside their own titles.
   *
   * Nothing on this view prints the series' name, so a decorative square would leave a screen
   * reader with a page that never says which study is playing (scope prd 4.3).
   */
  it('labels the square with the series, because it stands alone', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      await openTheView(page);

      const cover = view(page).locator('img');
      await expect.poll(() => cover.count(), { timeout: 30_000 }).toBe(1);
      expect(await cover.getAttribute('alt')).toBe(SERIES_TITLE);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * 3.2.4 — a teaching in no series has no cover, and the view draws nothing rather than a
   * placeholder (scope prd 3.3.5).
   *
   * The absence is only meaningful once the view has loaded, so it is read after the scripture
   * list has stated its own answer — otherwise the assertion would pass against a blank page
   * however the code were written.
   */
  it('renders no image at all for a teaching that belongs to no series', async () => {
    const { page } = await openTeaching(looseId);
    try {
      await openTheView(page);
      await expect
        .poll(() => view(page).textContent(), { timeout: 30_000 })
        .toContain('no scripture references');

      expect(await view(page).locator('img').count()).toBe(0);
      // And nothing was reserved for it: the transport's slot is imageless too, which is the same
      // fact one screen further down (scope plan 2.5.4).
      expect(await bar(page).locator('img').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// =================================================================================================

/**
 * **The scripture beneath it** (scope plan 3.3) — `pages/player.png`'s list of references.
 *
 * It is the recording page's own panel, reading the recording page's own route, which is what makes
 * "the same passages under the same rules" true in the code rather than only in the sentence
 * (scope tdd 1.7).
 */
describe('the view lists the playing teaching`s scripture', () => {
  // 3.3.1 — the published references, each with its full verse text.
  it('lists the published references with their verse text', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      await openTheView(page);

      await expect
        .poll(() => citationsOnScreen(page), { timeout: 30_000 })
        .toEqual(['Genesis 1:1–2', 'Exodus 3:1–2', 'Romans 8:1–4']);

      const entries = view(page).getByRole('listitem');
      expect(await entries.nth(0).textContent()).toContain(
        'Stand-in verse text for Genesis 1:1. Stand-in verse text for Genesis 1:2.',
      );
      expect(await entries.nth(1).textContent()).toContain('Stand-in verse text for Exodus 3:2.');
      expect(await entries.nth(2).textContent()).toContain('Stand-in verse text for Romans 8:4.');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * 3.3.2 — **the API's order**, compared against the API's own answer rather than against a list
   * written down here.
   *
   * Canon order is the API's decision, taken from the one canon table; a view that sorted would be
   * a second opinion about the same question. Asking the route from inside the page and comparing
   * is what states that, rather than restating the expected order and proving only that both halves
   * were written by the same hand.
   */
  it('draws the references in the order the API answered with', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      await openTheView(page);
      await expect
        .poll(() => citationsOnScreen(page), { timeout: 30_000 })
        .toHaveLength(APPROVED.length);

      const fromApi = await citationsFromApi(page, coveredId);
      expect(await citationsOnScreen(page)).toEqual(fromApi);
      // And that order is not the order they were stored in, so the comparison had something to
      // catch: they went in as Romans, Exodus, Genesis.
      expect(fromApi[0]).toBe(formatCitation(APPROVED[2] as ScriptureCitation));
    } finally {
      await page.context().close();
    }
  }, 180_000);

  // 3.3.3 — an empty list is stated, not left as blank space (scope prd 3.3.6).
  it('states the empty list for a teaching with no published references', async () => {
    const { page } = await openTeaching(looseId);
    try {
      await openTheView(page);

      await expect
        .poll(() => view(page).textContent(), { timeout: 30_000 })
        .toContain('This teaching has no scripture references.');
      expect(await view(page).getByRole('listitem').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * 3.3.4 — **a draft is not a reference.** `coveredId` carries an open scripture draft citing
   * Jonah 2, and nobody has approved it. It reaches no member's screen, and the three that were
   * approved still do — otherwise "it is absent" would be true of an empty view as well.
   */
  it('never shows a reference that is drafted and not published', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      await openTheView(page);
      await expect
        .poll(() => citationsOnScreen(page), { timeout: 30_000 })
        .toHaveLength(APPROVED.length);

      const drafted = formatCitation(DRAFTED[0] as ScriptureCitation);
      expect(await citationsOnScreen(page)).not.toContain(drafted);
      expect(await view(page).textContent()).not.toContain(drafted);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});
