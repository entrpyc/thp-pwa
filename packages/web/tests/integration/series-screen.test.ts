import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  MEMBER_LIBRARY_PAGE_PATH,
  MEMBER_SERIES_PAGE_PATH,
  ROLE,
  recordingPagePath,
  seriesPagePath,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  insertSeries,
  setRecordingDescription,
  setRecordingPublication,
  setRecordingSeries,
  setSeriesArtwork,
  upsertPlaybackProgress,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';

/**
 * **The member series screens, in a real browser** (Story 6 Ticket 02).
 *
 * The claims, in the order they cost most to get wrong:
 *
 * 1. **Both screens hold without artwork.** `pages/series-listing.png` and `pages/series-inner.png`
 *    both draw covers this epic does not ship, so what is asserted is that the *layout* survives the
 *    drop — and that nothing is rendered for a deferred destination. Absence from the DOM, not
 *    "not visible": a disabled control is a promise the epic cannot keep.
 * 2. **The rows read forwards and are numbered.** The opposite of the library's order, deliberately.
 * 3. **A member walks in from the landing and from the menu, and back out through a row.**
 * 4. **`home › series › recording` shows whichever way the recording page was opened** — asserted
 *    by opening it directly by URL, which is the case browser history cannot serve.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

const DESKTOP = { width: 1280, height: 900 };

const SERIES_TITLE = `Screen series ${RUN}`;
const HIDDEN_SERIES_TITLE = `Screen unpublished series ${RUN}`;
const FIRST_TITLE = `Screen first ${RUN}`;
const MIDDLE_TITLE = `Screen middle ${RUN}`;
const LAST_TITLE = `Screen last ${RUN}`;
const HIDDEN_TITLE = `Screen hidden in series ${RUN}`;
const LOOSE_TITLE = `Screen no series ${RUN}`;
const COVERED_SERIES_TITLE = `Screen covered series ${RUN}`;
/** The teaching inside it. Named, because the library row for it is asserted against too. */
const COVERED_TITLE = `Screen covered ${RUN}`;

/**
 * The key the covered series is pointed at. Nothing has to be behind it: what this suite asserts is
 * the *frame* — that the row carries an `<img>`, that its `src` is the signed URL the API minted,
 * and that the box crops from the centre rather than stretching. Whether the object decodes is
 * scope plan 1.2's property, proved against the real store in `series-artwork.test.ts`.
 */
const COVER_KEY = `artwork/${RUN}-series-listing.webp`;

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let seriesId: string;
let coveredSeriesId: string;
let firstId: string;
let looseId: string;
/** Two teachings in the *same* covered series — 2.3.3 is that they show one cover, not two. */
let coveredRecordingId: string;
let siblingRecordingId: string;
let seeded = 0;

async function newRecording(
  title: string,
  recordedAt: string,
  inSeries: string | null,
  published: boolean,
): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    { originalMediaKey: `originals/series-screen-${RUN}-${seeded}.mp3`, title, recordedAt },
    handle,
  );
  if (inSeries !== null) await setRecordingSeries(row.id, inSeries, handle);
  if (published) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function signInAs(
  account: TestAccount,
  viewport: { width: number; height: number } = DESKTOP,
): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return page;
}

/**
 * The hero band, located as the parent of the back control it holds.
 *
 * By its contents rather than by a class, because the class is a CSS-module hash and asserting
 * against one would be asserting against the bundler. The back control is in the band on both
 * screens and in both the covered and coverless cases, which is exactly what makes it the handle.
 */
function heroBand(page: Page, backLabel: string): Locator {
  return page.getByLabel(backLabel).locator('..');
}

/**
 * The key out of a signed URL — its path, with the query dropped.
 *
 * Two responses signing the same object produce two different signatures, so comparing whole URLs
 * would compare the HMACs. What 2.3.3 is about is that both pages point at **one object**.
 */
function signedObject(url: string): string {
  return new URL(url).pathname;
}

/** One listing row, by the title it carries. */
function rowFor(page: Page, title: string): Locator {
  return page
    .getByRole('list', { name: 'Series' })
    .getByRole('listitem')
    .filter({ hasText: title })
    .first();
}

/** The menu's entries, in order, with the panel opened. */
async function menuEntries(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: 'Menu' }).click();
  const list = page.getByRole('list', { name: 'Navigation' });
  await expect.poll(() => list.count(), { timeout: 30_000 }).toBe(1);
  return (await list.getByRole('listitem').allTextContents()).map((text) => text.trim());
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });

  member = await createAccount(databaseUrl, ROLE.member, 'series-screen-member');

  seriesId = (
    await insertSeries({ title: SERIES_TITLE, description: 'A verse-by-verse study.' }, handle)
  ).id;
  const hiddenSeriesId = (
    await insertSeries({ title: HIDDEN_SERIES_TITLE, description: null }, handle)
  ).id;
  coveredSeriesId = (
    await insertSeries({ title: COVERED_SERIES_TITLE, description: null }, handle)
  ).id;
  await setSeriesArtwork(coveredSeriesId, COVER_KEY, handle);

  // Out of insertion order on purpose, so "oldest recorded first" cannot pass by accident.
  await newRecording(MIDDLE_TITLE, '2026-02-15', seriesId, true);
  await newRecording(LAST_TITLE, '2026-06-04', seriesId, true);
  firstId = await newRecording(FIRST_TITLE, '2026-01-12', seriesId, true);
  await newRecording(HIDDEN_TITLE, '2026-03-30', seriesId, false);
  await newRecording(`Screen unpublished only ${RUN}`, '2026-03-31', hiddenSeriesId, false);
  coveredRecordingId = await newRecording(COVERED_TITLE, '2026-04-02', coveredSeriesId, true);
  siblingRecordingId = await newRecording(
    `Screen covered sibling ${RUN}`,
    '2026-04-09',
    coveredSeriesId,
    true,
  );
  looseId = await newRecording(LOOSE_TITLE, '2026-07-07', null, true);

  await setRecordingDescription(firstId, 'An introduction to the letter.', handle);
  await upsertPlaybackProgress(
    { userId: member.id, recordingId: firstId, positionMs: 754_000 },
    handle,
  );
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the series listing at /series', () => {
  it('renders the reference`s title and sentence, and the series this run published', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${MEMBER_SERIES_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });

      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: 'Series' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(await page.getByText('Explore in-depth teachings organized in series.').count()).toBe(
        1,
      );

      const rows = page.getByRole('list', { name: 'Series' }).getByRole('listitem');
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(0);

      const ours = (await rows.allTextContents()).filter((text) => text.includes(RUN));
      expect(ours.some((text) => text.includes(SERIES_TITLE))).toBe(true);
      // A series whose only recording is unpublished has nothing to open, so it is not a row.
      expect(ours.some((text) => text.includes(HIDDEN_SERIES_TITLE))).toBe(false);

      // The count and the range, which is what `2h 14m total` became.
      const row = page.getByRole('listitem').filter({ hasText: SERIES_TITLE }).first();
      expect(await row.textContent()).toContain('3 recordings');
      expect(await row.textContent()).toContain('12 Jan 2026 – 4 Jun 2026');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('renders no search box and no download control', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${MEMBER_SERIES_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByRole('list', { name: 'Series' }).count(), { timeout: 30_000 })
        .toBe(1);

      // Absent from the DOM, not merely hidden — the rule the whole member surface draws.
      // A series with no cover still renders no frame at all; scope plan 2.5 is where that
      // becomes a claim in its own right, across every surface at once.
      expect(await rowFor(page, SERIES_TITLE).locator('img').count()).toBe(0);
      expect(await page.getByRole('searchbox').count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Download' }).count()).toBe(0);
      expect(await page.getByRole('list', { name: 'Series' }).locator('[disabled]').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  /**
   * **The cover, on the row** (scope plan 2.1) — `pages/series-listing.png`'s thumbnail slot.
   *
   * The three claims are the frame rather than the picture: that the row carries one image and it
   * is the signed URL the API minted, that the box crops from its centre rather than stretching to
   * whatever shape the admin uploaded, and that it says nothing to a screen reader because the
   * title is rendered beside it. What the bytes decode to is scope plan 1.2's property.
   */
  it('renders the cover as the thumbnail at the left of the row it belongs to', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${MEMBER_SERIES_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const cover = rowFor(page, COVERED_SERIES_TITLE).locator('img');
      await expect.poll(() => cover.count(), { timeout: 30_000 }).toBe(1);

      // The API's own signed URL, not a key and not a path this screen assembled.
      const source = (await cover.getAttribute('src')) ?? '';
      expect(source).toContain(COVER_KEY);
      expect(source.startsWith('http://') || source.startsWith('https://')).toBe(true);
      expect(source).toContain('X-Amz-Signature');

      // At the left: before the title in the row's reading order, as the reference draws it.
      const box = await cover.boundingBox();
      const title = await rowFor(page, COVERED_SERIES_TITLE)
        .getByText(COVERED_SERIES_TITLE)
        .boundingBox();
      expect(box).not.toBeNull();
      expect(title).not.toBeNull();
      expect((box as { x: number }).x).toBeLessThan((title as { x: number }).x);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  /**
   * **The library's rows carry the same cover, in the same slot and at the same size.**
   *
   * A recording has no artwork of its own, so what a library row shows is the study's — the same
   * picture, the same signed object, and one stylesheet rule rather than two. The size assertion is
   * the point of doing this against the series listing rather than in isolation: two listings
   * drawing the same picture at two sizes is exactly the drift a shared rule exists to prevent.
   */
  it('draws that same cover on the library row for a teaching in that series', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${MEMBER_SERIES_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const onListing = rowFor(page, COVERED_SERIES_TITLE).locator('img');
      await expect.poll(() => onListing.count(), { timeout: 30_000 }).toBe(1);
      const listingBox = await onListing.boundingBox();

      await page.goto(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const row = page
        .getByRole('list', { name: 'Recordings' })
        .getByRole('listitem')
        .filter({ hasText: COVERED_TITLE })
        .first();
      const cover = row.locator('img');
      await expect.poll(() => cover.count(), { timeout: 30_000 }).toBe(1);

      // One object, signed twice — the same picture rather than two URLs that both happen to work.
      expect((await cover.getAttribute('src')) ?? '').toContain(COVER_KEY);
      // Decorative here too: the study is named in the strip under the row, so announcing it on the
      // image would read the study twice before the teaching's own title.
      expect(await cover.getAttribute('alt')).toBe('');

      const libraryBox = await cover.boundingBox();
      expect(libraryBox).not.toBeNull();
      expect(listingBox).not.toBeNull();
      expect((libraryBox as { width: number }).width).toBe((listingBox as { width: number }).width);
      expect((libraryBox as { height: number }).height).toBe(
        (listingBox as { height: number }).height,
      );

      // At the left of the row, before the title, as it is on the listing.
      const title = await row.getByText(COVERED_TITLE).first().boundingBox();
      expect((libraryBox as { x: number }).x).toBeLessThan((title as { x: number }).x);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * **The strip naming the study is divided from the row above it, edge to edge, and answers the
   * pointer.**
   *
   * Two claims that are really one: the strip fills the row's width, which is what lets the hairline
   * read as a rule between the teaching and the study rather than as an underline whose length was
   * decided by how long somebody's series title happens to be — and filling the width is also what
   * makes it the size of a thing you press, which is what earns it a hover.
   */
  it('divides the series strip from its row full width, and washes it on hover', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const list = page.getByRole('list', { name: 'Recordings' });
      const row = list
        .getByRole('listitem')
        .filter({ hasText: COVERED_TITLE })
        .first();
      const strip = row.getByRole('link', { name: COVERED_SERIES_TITLE });
      await expect.poll(() => strip.count(), { timeout: 30_000 }).toBe(1);

      // Full width: the strip is as wide as the row it belongs to, which is as wide as the panel.
      const stripBox = await strip.boundingBox();
      const rowBox = await row.boundingBox();
      expect(stripBox).not.toBeNull();
      expect(rowBox).not.toBeNull();
      expect((stripBox as { width: number }).width).toBe((rowBox as { width: number }).width);

      // And the divider is a real border on it rather than a shorter line drawn by the text.
      const border = await strip.evaluate((element) => {
        const style = getComputedStyle(element);
        return { width: style.borderTopWidth, style: style.borderTopStyle };
      });
      expect(border.style).toBe('solid');
      expect(Number.parseFloat(border.width)).toBeGreaterThan(0);

      // The hover wash is the row's own, so a member moving down the list sees one behaviour.
      const before = await strip.evaluate((element) => getComputedStyle(element).backgroundColor);
      await strip.hover();
      await expect
        .poll(() => strip.evaluate((element) => getComputedStyle(element).backgroundColor), {
          timeout: 30_000,
        })
        .not.toBe(before);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('crops the thumbnail to its frame from the centre rather than stretching it', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${MEMBER_SERIES_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const cover = rowFor(page, COVERED_SERIES_TITLE).locator('img');
      await expect.poll(() => cover.count(), { timeout: 30_000 }).toBe(1);

      // `fill` is the default and is exactly the stretch scope prd 3.2.1 rules out; `50% 50%` is
      // what makes the crop a centre crop rather than a corner one.
      expect(await cover.evaluate((node) => getComputedStyle(node).objectFit)).toBe('cover');
      expect(await cover.evaluate((node) => getComputedStyle(node).objectPosition)).toBe('50% 50%');

      // The frame is the row's, fixed, whatever shape the uploaded image is.
      const box = await cover.boundingBox();
      expect(box).not.toBeNull();
      const { width, height } = box as { width: number; height: number };
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(width).toBeGreaterThan(height);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('gives the thumbnail no alternative text, because the title is beside it', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${MEMBER_SERIES_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const cover = rowFor(page, COVERED_SERIES_TITLE).locator('img');
      await expect.poll(() => cover.count(), { timeout: 30_000 }).toBe(1);

      // Empty, and present: `alt=""` is what takes it out of the accessibility tree. A missing
      // attribute would leave a screen reader reading the file name (scope prd 4.3).
      expect(await cover.getAttribute('alt')).toBe('');
      expect(await rowFor(page, COVERED_SERIES_TITLE).getByRole('img').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('one series at /series/[id]', () => {
  it('renders the title, the description, the meta row and the numbered list, forwards', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${seriesPagePath(seriesId)}`, { waitUntil: 'domcontentloaded' });

      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: SERIES_TITLE }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(await page.getByText('A verse-by-verse study.').count()).toBe(1);
      expect(await page.getByText('3 recordings · 12 Jan 2026 – 4 Jun 2026').count()).toBe(1);

      const rows = page.getByRole('list', { name: 'Recordings' }).getByRole('listitem');
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(3);

      const texts = await rows.allTextContents();
      // Oldest recorded first, numbered from 01 — the reverse of the library, and deliberate.
      expect(texts[0]).toContain('01.');
      expect(texts[0]).toContain(FIRST_TITLE);
      expect(texts[1]).toContain('02.');
      expect(texts[1]).toContain(MIDDLE_TITLE);
      expect(texts[2]).toContain('03.');
      expect(texts[2]).toContain(LAST_TITLE);

      // The unpublished teaching in the same series is not a row at all.
      expect(texts.some((text) => text.includes(HIDDEN_TITLE))).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('prints where this member got to on a started row and the date on an unstarted one', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${seriesPagePath(seriesId)}`, { waitUntil: 'domcontentloaded' });
      const rows = page.getByRole('list', { name: 'Recordings' }).getByRole('listitem');
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(3);

      const texts = await rows.allTextContents();
      expect(texts[0]).toContain('Resume at 12:34');
      // No percentage and no bar: a percentage needs a total this epic does not store.
      expect(texts[0]).not.toContain('%');
      expect(await page.getByRole('progressbar').count()).toBe(0);
      // An unstarted row prints the date recorded instead.
      expect(texts[1]).toContain('15 Feb 2026');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('renders no tab strip, no search box and no download control', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${seriesPagePath(seriesId)}`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: SERIES_TITLE }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      // The reference's five-tab strip is dropped whole: a series page has one thing to show.
      expect(await page.getByRole('tablist').count()).toBe(0);
      expect(await page.getByRole('tab').count()).toBe(0);
      for (const absent of ['Scripture', 'Notes', 'Transcript', 'Mindmap', 'Download']) {
        expect(await page.getByRole('button', { name: absent }).count(), absent).toBe(0);
      }
      expect(await page.getByRole('searchbox').count()).toBe(0);
      expect(await page.getByPlaceholder('Search recordings').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('returns to the listing from the back control, however the page was reached', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${seriesPagePath(seriesId)}`, { waitUntil: 'domcontentloaded' });
      const back = page.getByRole('link', { name: 'Back to series' });
      await expect.poll(() => back.count(), { timeout: 30_000 }).toBe(1);
      await back.click();
      await page.waitForURL(`${baseUrl}${MEMBER_SERIES_PAGE_PATH}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

/**
 * **The cover on the two hero bands** (scope plan 2.2, 2.3) — `pages/series-inner.png` and
 * `pages/chapter.png`.
 *
 * Every assertion here waits for something that is on the page in **both** the covered and the
 * coverless case — the title, the back control — and then asserts the artwork synchronously. A
 * poll on the artwork itself would be a poll whose expected outcome is absence half the time, and
 * would be paid for in full at its timeout every time it is right.
 */
describe('the hero band carries the series` cover', () => {
  it('renders the cover as the band at the top of a series page', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${seriesPagePath(coveredSeriesId)}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: COVERED_SERIES_TITLE }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      const art = heroBand(page, 'Back to series').locator('img');
      expect(await art.count()).toBe(1);
      expect(await art.getAttribute('src')).toContain(COVER_KEY);
      // Decorative: the series title is an `h1` on the same screen (scope prd 4.3).
      expect(await art.getAttribute('alt')).toBe('');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('leaves the back control clickable with the artwork behind it', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${seriesPagePath(coveredSeriesId)}`, {
        waitUntil: 'domcontentloaded',
      });
      // The title, not the back control: the control is in the band before the payload lands, so
      // waiting on it would be waiting for a state in which the cover is legitimately not there
      // yet. The heading is what says the series has actually arrived.
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: COVERED_SERIES_TITLE }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      const back = page.getByRole('link', { name: 'Back to series' });
      expect(await back.count()).toBe(1);

      // The artwork is behind it, so this press is the whole assertion: a cover painted over the
      // control would swallow the click and the URL would never change.
      expect(await heroBand(page, 'Back to series').locator('img').count()).toBe(1);
      await back.click();
      await page.waitForURL(`${baseUrl}${MEMBER_SERIES_PAGE_PATH}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('crops the artwork to the band from the centre rather than stretching it', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${seriesPagePath(coveredSeriesId)}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: COVERED_SERIES_TITLE }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      const art = heroBand(page, 'Back to series').locator('img');
      expect(await art.count()).toBe(1);
      expect(await art.evaluate((node) => getComputedStyle(node).objectFit)).toBe('cover');
      expect(await art.evaluate((node) => getComputedStyle(node).objectPosition)).toBe('50% 50%');

      // The band's own proportions, not the image's: wide, and the full width of the band.
      const box = await art.boundingBox();
      const band = await heroBand(page, 'Back to series').boundingBox();
      expect(box).not.toBeNull();
      expect(band).not.toBeNull();
      const art_ = box as { width: number; height: number };
      expect(art_.width).toBeGreaterThan(art_.height);
      expect(art_.width).toBeCloseTo((band as { width: number }).width, 0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('carries the series` cover on a recording page in that series', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(coveredRecordingId)}`, {
        waitUntil: 'domcontentloaded',
      });
      // The back control names the study it returns to, so on a teaching in one it is the series'
      // title rather than the library's label — which is also the assertion that it points there.
      const back = page.getByRole('link', { name: `Back to ${COVERED_SERIES_TITLE}` });
      await expect.poll(() => back.count(), { timeout: 30_000 }).toBe(1);
      await expect
        .poll(() => page.getByRole('heading', { level: 1 }).count(), { timeout: 30_000 })
        .toBeGreaterThan(0);

      const art = heroBand(page, `Back to ${COVERED_SERIES_TITLE}`).locator('img');
      expect(await art.count()).toBe(1);
      expect(await art.getAttribute('src')).toContain(COVER_KEY);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('shows the same cover on two teachings in the same series, because it is the series`', async () => {
    const page = await signInAs(member);
    try {
      const coverOn = async (recordingId: string): Promise<string> => {
        await page.goto(`${baseUrl}${recordingPagePath(recordingId)}`, {
          waitUntil: 'domcontentloaded',
        });
        const back = page.getByRole('link', { name: `Back to ${COVERED_SERIES_TITLE}` });
        await expect.poll(() => back.count(), { timeout: 30_000 }).toBe(1);
        const art = heroBand(page, `Back to ${COVERED_SERIES_TITLE}`).locator('img');
        await expect.poll(() => art.count(), { timeout: 30_000 }).toBe(1);
        return signedObject((await art.getAttribute('src')) ?? '');
      };

      // Same object, not merely two URLs that both work: the signatures differ per response.
      expect(await coverOn(coveredRecordingId)).toBe(await coverOn(siblingRecordingId));
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

/**
 * **No cover, and nothing drawn for one** (scope plan 2.5; scope prd 3.2.6).
 *
 * The claim is *absence from the DOM*, which is the line the whole member surface draws — an empty
 * frame reserved for a picture that does not exist is the thing this rules out, and a rule that
 * merely hides it would still be reserving the box.
 */
describe('a series with no cover shows nothing rather than an empty frame', () => {
  it('drops the thumbnail from its listing row', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${MEMBER_SERIES_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => rowFor(page, SERIES_TITLE).count(), { timeout: 30_000 })
        .toBe(1);

      expect(await rowFor(page, SERIES_TITLE).locator('img').count()).toBe(0);
      // And the row is otherwise whole — this is a dropped thumbnail, not a broken row.
      expect(await rowFor(page, SERIES_TITLE).textContent()).toContain('3 recordings');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('keeps the flat band on its page, holding the back control and no image', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${seriesPagePath(seriesId)}`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: SERIES_TITLE }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      // The band is still there — located by the control it holds — and holds nothing else.
      const band = heroBand(page, 'Back to series');
      expect(await band.count()).toBe(1);
      expect(await band.locator('img').count()).toBe(0);
      const box = await band.boundingBox();
      expect((box as { height: number }).height).toBeGreaterThan(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('keeps the flat band on a teaching that belongs to no series', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(looseId)}`, { waitUntil: 'domcontentloaded' });
      // The heading rather than the back control: this asserts an *absence*, so it has to wait for
      // the state in which a cover would have arrived — otherwise it passes on a page that has not
      // loaded yet and would pass however the band were written.
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: LOOSE_TITLE }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      // No series at all, so no cover to inherit — the ordinary case, not a degraded one.
      const band = heroBand(page, 'Back to recordings');
      expect(await band.locator('img').count()).toBe(0);
      const box = await band.boundingBox();
      expect((box as { height: number }).height).toBeGreaterThan(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('the ways in and the way through', () => {
  it('walks the landing to the listing to a series to a teaching', async () => {
    const page = await signInAs(member);
    try {
      // The landing's way-in row is *View all series* — what `pages/dashboard.png` shows.
      const wayIn = page.getByRole('link', { name: 'View all series' });
      await expect.poll(() => wayIn.count(), { timeout: 30_000 }).toBe(1);
      await wayIn.click();
      await page.waitForURL(`${baseUrl}${MEMBER_SERIES_PAGE_PATH}`, { timeout: 30_000 });

      await page.getByRole('link', { name: new RegExp(SERIES_TITLE) }).click();
      await page.waitForURL(`${baseUrl}${seriesPagePath(seriesId)}`, { timeout: 30_000 });

      await page.getByRole('link', { name: new RegExp(FIRST_TITLE) }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(firstId)}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('offers a member Dashboard, All series, All recordings, Report a bug and Sign out, in that order', async () => {
    const page = await signInAs(member);
    try {
      expect(await menuEntries(page)).toEqual([
        'Dashboard',
        'All series',
        'All recordings',
        'Report a bug',
        'Sign out',
      ]);

      await page
        .getByRole('list', { name: 'Navigation' })
        .getByRole('link', { name: 'All series' })
        .click();
      await page.waitForURL(`${baseUrl}${MEMBER_SERIES_PAGE_PATH}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('reaches a series from a library row`s series link', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const rows = page.getByRole('list', { name: 'Recordings' }).getByRole('listitem');
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(0);

      const row = rows.filter({ hasText: FIRST_TITLE }).first();
      const link = row.getByRole('link', { name: SERIES_TITLE });
      expect(await link.count()).toBe(1);
      await link.click();
      await page.waitForURL(`${baseUrl}${seriesPagePath(seriesId)}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

describe('the breadcrumb', () => {
  it('reads home › series › recording on a teaching opened directly by URL', async () => {
    const page = await signInAs(member);
    try {
      // Opened directly rather than navigated to: the trail is a fact about the recording, not
      // about the navigation that reached it, and this is the case history cannot serve.
      await page.goto(`${baseUrl}${recordingPagePath(firstId)}`, { waitUntil: 'domcontentloaded' });

      const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
      const current = crumbs.locator('[aria-current="page"]');
      await expect.poll(() => current.count(), { timeout: 30_000 }).toBe(1);
      expect(await current.textContent()).toBe(FIRST_TITLE);

      const parent = crumbs.getByRole('link', { name: SERIES_TITLE });
      expect(await parent.count()).toBe(1);
      expect(await parent.getAttribute('href')).toBe(seriesPagePath(seriesId));

      await parent.click();
      await page.waitForURL(`${baseUrl}${seriesPagePath(seriesId)}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /**
   * **The back control returns to the study**, not to the library.
   *
   * Opened directly by URL, which is the case browser history cannot serve and the whole reason
   * this control is a destination rather than a `history.back()`. The label is part of the
   * assertion: a control that said *Back to recordings* and landed on a series page would be a lie
   * told to everybody who cannot see where it points.
   */
  it('returns to the series from the back control on a teaching in one', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(firstId)}`, { waitUntil: 'domcontentloaded' });

      const back = page.getByRole('link', { name: `Back to ${SERIES_TITLE}` });
      await expect.poll(() => back.count(), { timeout: 30_000 }).toBe(1);
      expect(await page.getByRole('link', { name: 'Back to recordings' }).count()).toBe(0);

      await back.click();
      await page.waitForURL(`${baseUrl}${seriesPagePath(seriesId)}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 180_000);

  /** A teaching in no study has no study page to return to, so it keeps the library. */
  it('returns to the library from a teaching in no series', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(looseId)}`, { waitUntil: 'domcontentloaded' });

      const back = page.getByRole('link', { name: 'Back to recordings' });
      await expect.poll(() => back.count(), { timeout: 30_000 }).toBe(1);
      await back.click();
      await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('keeps the two-segment trail for a recording in no series', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(looseId)}`, { waitUntil: 'domcontentloaded' });

      const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
      const current = crumbs.locator('[aria-current="page"]');
      await expect.poll(() => current.count(), { timeout: 30_000 }).toBe(1);
      expect(await current.textContent()).toBe(LOOSE_TITLE);
      // Home and the title, and nothing between them.
      expect(await crumbs.getByRole('listitem').count()).toBe(2);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('names the series on the series page itself', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${seriesPagePath(seriesId)}`, { waitUntil: 'domcontentloaded' });
      const current = page
        .getByRole('navigation', { name: 'Breadcrumb' })
        .locator('[aria-current="page"]');
      await expect.poll(() => current.count(), { timeout: 30_000 }).toBe(1);
      expect(await current.textContent()).toBe(SERIES_TITLE);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('at every width', () => {
  for (const viewport of VIEWPORTS) {
    it(`renders both series screens without horizontal overflow at ${viewport.label}`, async () => {
      const page = await signInAs(member, { width: viewport.width, height: viewport.height });
      try {
        for (const path of [MEMBER_SERIES_PAGE_PATH, seriesPagePath(seriesId)]) {
          await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
          await expect
            .poll(() => page.getByRole('navigation', { name: 'Breadcrumb' }).count(), {
              timeout: 30_000,
            })
            .toBe(1);

          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          );
          expect(overflow, `${path} overflows horizontally at ${viewport.label}`).toBe(false);
        }
      } finally {
        await page.context().close();
      }
    }, 180_000);
  }
});
