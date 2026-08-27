import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import {
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  MEMBER_LIBRARY_PAGE_PATH,
  ROLE,
  recordingNotesPath,
  recordingPagePath,
  recordingPlaybackPath,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  insertSeries,
  setRecordingPublication,
  setRecordingSeries,
  setSeriesArtwork,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **Playback, driven in a real browser against the real object store** (Story 4 Ticket 02).
 *
 * Nothing here is simulated, and that is the whole design of the suite. A stub would answer every
 * one of these assertions however it was written: whether the element leaves the paused state,
 * whether `currentTime` advances, whether a seek to an unbuffered position produces a **range
 * request to the store rather than to the API**, and whether a dead grant is replaced without the
 * member losing their place. Each is a property of a media element talking to an S3-compatible
 * store, so both have to be real.
 *
 * The audio is a synthesised WAV uploaded through the same presigned `PUT` the admin screen uses —
 * see `tests/support/audio.ts` for why it is generated rather than committed.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const STORE_ORIGIN = settings.MEDIA_ENDPOINT.replace(/\/+$/, '');

/** Two minutes, so a seek to 100 s is genuinely past anything the browser has buffered. */
const TEACHING_SECONDS = 120;

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let recordingId: string;
let secondId: string;

const TITLE = `Player teaching ${RUN}`;
const SECOND_TITLE = `Player second ${RUN}`;

/** A teaching in a covered series, for the transport's tile (scope plan 2.4). */
let coveredId: string;
let coveredSeriesTitle: string;
const COVERED_TITLE = `Player covered ${RUN}`;
const COVER_KEY = `artwork/${RUN}-transport.webp`;

interface Snapshot {
  readonly currentTime: number;
  readonly paused: boolean;
  readonly rate: number;
  readonly duration: number;
  readonly src: string;
}

async function audioState(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const element = document.querySelector('audio');
    return {
      currentTime: element?.currentTime ?? -1,
      paused: element?.paused ?? true,
      rate: element?.playbackRate ?? -1,
      duration: Number.isFinite(element?.duration) ? (element?.duration ?? 0) : 0,
      src: element?.currentSrc ?? '',
    };
  });
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
  // The duration only arrives once the element has read the header off the store, so waiting for it
  // is waiting for a real network round trip to a real bucket.
  await expect
    .poll(async () => (await audioState(page)).duration, { timeout: 60_000 })
    .toBeGreaterThan(TEACHING_SECONDS - 5);
  return { page, requests };
}

/** Requests that carried a `Range` header, which is what a media element makes. */
function ranged(requests: readonly Request[]): Request[] {
  return requests.filter((request) => request.headers()['range'] !== undefined);
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  member = await createAccount(databaseUrl, ROLE.member, 'player-member');

  recordingId = await publishedRecording(TITLE);
  secondId = await publishedRecording(SECOND_TITLE);

  // A third, in a series that has a cover — `recordingId` above is in no series at all, which is
  // what makes it 2.5.4's case without any extra seeding.
  coveredSeriesTitle = `Player series ${RUN}`;
  const series = await insertSeries({ title: coveredSeriesTitle, description: null }, handle);
  await setSeriesArtwork(series.id, COVER_KEY, handle);
  coveredId = await publishedRecording(COVERED_TITLE);
  await setRecordingSeries(coveredId, series.id, handle);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('a member presses play and hears the recording', () => {
  it('leaves the paused state and advances', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      // Opening loads and does not play: a member who opened a teaching on a phone in company has
      // not asked for sound.
      expect((await audioState(page)).paused).toBe(true);

      await page.getByRole('button', { name: 'Play' }).first().click();

      await expect
        .poll(async () => (await audioState(page)).paused, { timeout: 30_000 })
        .toBe(false);
      const started = (await audioState(page)).currentTime;
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(started + 0.5);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('renders the transport the reference draws, and the title in its left slot', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      const bar = page.getByRole('region', { name: 'Player' });
      await expect.poll(() => bar.count(), { timeout: 30_000 }).toBe(1);

      // `exact` because the speed pill's accessible name also contains the word "Playback".
      expect(await bar.getByRole('button', { name: 'Play', exact: true }).count()).toBe(1);
      expect(await bar.getByRole('button', { name: 'Back 10 seconds' }).count()).toBe(1);
      expect(await bar.getByRole('button', { name: 'Forward 10 seconds' }).count()).toBe(1);
      expect(await bar.getByRole('slider', { name: 'Position' }).count()).toBe(1);
      expect(await bar.textContent()).toContain(TITLE);

      // The `···` control. It shipped absent in Story 4 because every item behind it was deferred;
      // Story 5 gave it its first — captions — so it is on the bar from there.
      expect(await bar.getByRole('button', { name: 'More player controls' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('shows no transport at all before a teaching has been opened', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      const fresh = await browser.newContext({ storageState: await page.context().storageState() });
      const landing = await fresh.newPage();
      await landing.goto(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => landing.getByRole('link', { name: 'View all series' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      // The landing before a first play is the reference's layout unchanged.
      expect(await landing.getByRole('region', { name: 'Player' }).count()).toBe(0);
      await fresh.close();
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

describe('the speed control takes effect on the press', () => {
  it('sets 1.5x mid-playback and the element plays at it', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      await page.getByRole('button', { name: 'Play', exact: true }).first().click();
      await expect
        .poll(async () => (await audioState(page)).paused, { timeout: 30_000 })
        .toBe(false);
      expect((await audioState(page)).rate).toBe(1);

      // One pill that cycles: 1x → 1.25x → 1.5x. Read off the element, because the pill saying
      // "1.5x" and the audio playing at 1.5x are two different claims.
      const pill = page.getByRole('button', { name: /Playback speed/ });
      await pill.click();
      await pill.click();

      await expect.poll(async () => (await audioState(page)).rate, { timeout: 30_000 }).toBe(1.5);
      // And it did not interrupt the listen to do it.
      expect((await audioState(page)).paused).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

describe('scrubbing, and where the bytes come from', () => {
  it('seeks to an unbuffered position and plays from there', async () => {
    const { page, requests } = await openTeaching(recordingId);
    try {
      const before = ranged(requests).length;

      // 100 s into a 120 s teaching, with `preload="metadata"` and nothing played yet — so this is
      // genuinely past anything the browser holds.
      await page.getByRole('slider', { name: 'Position' }).fill('100000');
      await page.getByRole('button', { name: 'Play' }).first().click();

      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(100);
      await expect
        .poll(async () => (await audioState(page)).paused, { timeout: 30_000 })
        .toBe(false);

      // Fetching that region meant asking the store for it.
      await expect.poll(() => ranged(requests).length, { timeout: 30_000 }).toBeGreaterThan(before);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('asks the object store for the bytes and never the API', async () => {
    const { page, requests } = await openTeaching(recordingId);
    try {
      await page.getByRole('slider', { name: 'Position' }).fill('60000');
      await page.getByRole('button', { name: 'Play' }).first().click();
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(60);

      // Every ranged request goes to the store. The API is in the authorisation path and never in
      // the audio path — which is what makes scrubbing work without a CDN.
      const rangedUrls = ranged(requests).map((request) => request.url());
      expect(rangedUrls.length).toBeGreaterThan(0);
      for (const url of rangedUrls) {
        expect(url.startsWith(STORE_ORIGIN), `${url} is not the object store`).toBe(true);
      }

      // And nothing on the API origin ever carried media: no range, and no request for the object.
      const toApi = requests.filter((request) => request.url().startsWith(baseUrl));
      expect(toApi.length).toBeGreaterThan(0);
      for (const request of toApi) {
        expect(request.headers()['range'], request.url()).toBeUndefined();
        expect(request.url()).not.toContain('originals/');
      }

      // The element is pointed straight at the store, which is the mechanism behind all of it.
      expect((await audioState(page)).src.startsWith(STORE_ORIGIN)).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('mints the grant through the API before any of it', async () => {
    const { page, requests } = await openTeaching(recordingId);
    try {
      const grants = requests.filter((request) =>
        request.url().startsWith(`${baseUrl}${API_PREFIX}/recordings/${recordingId}/playback`),
      );
      expect(grants).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

describe('a grant that dies mid-listen is replaced without the member noticing', () => {
  it('recovers the position and the play state after the element errors', async () => {
    const { page, requests } = await openTeaching(recordingId);
    const grants = () =>
      requests.filter((request) =>
        request.url().startsWith(`${baseUrl}${API_PREFIX}/recordings/${recordingId}/playback`),
      ).length;
    try {
      await page.getByRole('slider', { name: 'Position' }).fill('30000');
      await page.getByRole('button', { name: 'Play' }).first().click();
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(30);

      const before = await audioState(page);
      const grantsBefore = grants();
      expect(before.paused).toBe(false);
      expect(grantsBefore).toBe(1);

      // Kill the URL under the element the way an expiry would: the source stops resolving and the
      // element raises `error`. Nothing is told to renew — the player notices.
      await page.evaluate(() => {
        const element = document.querySelector('audio');
        if (element === null) return;
        element.src = 'http://127.0.0.1:1/this-grant-is-dead.wav';
        element.load();
      });

      // A second grant was asked for — which is the claim. (The URL itself can come back byte for
      // byte identical: a presigned `GET` is a function of the key, the expiry window and the
      // second it was signed in, so two mints inside one second agree. Counting the requests says
      // what comparing the strings cannot.)
      await expect.poll(grants, { timeout: 60_000 }).toBe(grantsBefore + 1);

      // Back where it was, still playing, and pointed at the store again.
      await expect
        .poll(async () => (await audioState(page)).src.startsWith(STORE_ORIGIN), {
          timeout: 60_000,
        })
        .toBe(true);
      await expect
        .poll(async () => (await audioState(page)).paused, { timeout: 60_000 })
        .toBe(false);
      const after = await audioState(page);
      expect(after.currentTime).toBeGreaterThan(before.currentTime - 2);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

describe('the transport is mounted app-wide', () => {
  it('keeps playing while the member walks back to the library', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      await page.getByRole('button', { name: 'Play' }).first().click();
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(1);

      // A client-side navigation, not a reload: the element lives in the member layout, which is
      // exactly what this is about.
      await page.getByRole('link', { name: 'Back to recordings' }).click();
      await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });

      const bar = page.getByRole('region', { name: 'Player' });
      await expect.poll(() => bar.count(), { timeout: 30_000 }).toBe(1);
      expect(await bar.textContent()).toContain(TITLE);

      const onTheLibrary = await audioState(page);
      expect(onTheLibrary.paused).toBe(false);
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(onTheLibrary.currentTime + 0.5);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('points at the other teaching when a second one is opened', async () => {
    const { page } = await openTeaching(recordingId);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(secondId)}`, {
        waitUntil: 'domcontentloaded',
      });
      const bar = page.getByRole('region', { name: 'Player' });
      await expect
        .poll(async () => (await bar.textContent()) ?? '', { timeout: 30_000 })
        .toContain(SECOND_TITLE);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

/**
 * **The transport's tile** (scope plan 2.4, 2.5.4) — `bottom-navigation/default.png`.
 *
 * The slot at the left of the bar is a thumbnail in the reference, and it carries the cover of the
 * *series* the playing teaching belongs to — a recording has no artwork of its own. The tile
 * stands alone rather than beside a title, so unlike every other cover in this scope it is
 * **labelled** (scope prd 4.3).
 *
 * Each assertion waits for the bar — which is on the page in both the covered and the coverless
 * case — and then reads the tile synchronously, so a run where the tile is correctly absent costs
 * nothing rather than a poll window.
 */
describe('the transport shows the cover of what is playing', () => {
  it('shows the series` cover in the left slot', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      const bar = page.getByRole('region', { name: 'Player' });
      await expect
        .poll(async () => (await bar.textContent()) ?? '', { timeout: 30_000 })
        .toContain(COVERED_TITLE);

      const tile = bar.locator('img');
      expect(await tile.count()).toBe(1);
      expect(await tile.getAttribute('src')).toContain(COVER_KEY);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('labels the tile with the series, because it stands alone', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      const bar = page.getByRole('region', { name: 'Player' });
      await expect
        .poll(async () => (await bar.textContent()) ?? '', { timeout: 30_000 })
        .toContain(COVERED_TITLE);

      // Named, not decorative — the opposite of every other cover in this scope, and the reason is
      // that there is no series title rendered beside it to say the same thing.
      const tile = bar.locator('img');
      expect(await tile.count()).toBe(1);
      expect(await tile.getAttribute('alt')).toBe(coveredSeriesTitle);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('keeps the cover in the slot when the member walks to the library', async () => {
    const { page } = await openTeaching(coveredId);
    try {
      await page.getByRole('button', { name: 'Play' }).first().click();
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(1);

      await page.getByRole('link', { name: 'Back to recordings' }).click();
      await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });

      // The bar is in the member layout and never remounts, so the cover it holds is the one it was
      // opened with — it is not re-fetched by the screen that happens to be under it.
      const bar = page.getByRole('region', { name: 'Player' });
      await expect.poll(() => bar.count(), { timeout: 30_000 }).toBe(1);
      const tile = bar.locator('img');
      expect(await tile.count()).toBe(1);
      expect(await tile.getAttribute('src')).toContain(COVER_KEY);
    } finally {
      await page.context().close();
    }
  }, 240_000);

  it('leaves the title and no image for a teaching that belongs to no series', async () => {
    // `recordingId` is in no series at all (scope prd 3.2.6) — the ordinary case, not a degraded
    // one. The slot falls back to what a member actually needs to know is playing.
    const { page } = await openTeaching(recordingId);
    try {
      const bar = page.getByRole('region', { name: 'Player' });
      await expect
        .poll(async () => (await bar.textContent()) ?? '', { timeout: 30_000 })
        .toContain(TITLE);

      expect(await bar.locator('img').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

/**
 * **The notes store cannot reach playback** (Task 1.6, criterion 1.6.3).
 *
 * `player-context.tsx` gained a second fetch, and it owns the `<audio>` element, the grant and the
 * renewal ticker. Three specific regressions are what active-scope architecture § 5.1 names as the
 * risk of that, and each is driven here rather than reviewed.
 */
describe('the notes the player now holds cannot reach the audio', () => {
  it('plays through a notes failure, and mints no second grant for it', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const asked: string[] = [];
    page.on('request', (request) => asked.push(request.url()));
    try {
      await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email').fill(member.email);
      await page.getByLabel('Password').fill(member.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

      // **Held, then refused** — so the failure lands while the member is already listening. A
      // request that had already failed before the play press would let a `pause()` in the failure
      // path pass unnoticed, which is precisely the regression this is about.
      await page.route(`**${API_PREFIX}${recordingNotesPath(recordingId)}`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        await route.abort();
      });

      await page.goto(`${baseUrl}${recordingPagePath(recordingId)}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect
        .poll(async () => (await audioState(page)).duration, { timeout: 60_000 })
        .toBeGreaterThan(TEACHING_SECONDS - 5);

      await page.getByRole('button', { name: 'Play' }).first().click();
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(1);
      const listening = await audioState(page);

      // Past the moment the notes request gives up.
      await new Promise((resolve) => setTimeout(resolve, 9_000));

      const after = await audioState(page);
      expect(after.paused).toBe(false);
      expect(after.currentTime).toBeGreaterThan(listening.currentTime + 1);
      // The same source, so nothing re-pointed the element on the way through.
      expect(after.src).toBe(listening.src);

      // And one grant across the whole visit: the notes never asked for another.
      const grants = asked.filter(
        (url) => url === `${baseUrl}${API_PREFIX}${recordingPlaybackPath(recordingId)}`,
      );
      expect(grants).toHaveLength(1);
    } finally {
      await context.close();
    }
  }, 240_000);

  it('keeps the early return, so re-opening what is loaded does not re-point the element', async () => {
    const { page, requests } = await openTeaching(recordingId);
    try {
      await page.getByRole('button', { name: 'Play' }).first().click();
      await expect
        .poll(async () => (await audioState(page)).currentTime, { timeout: 30_000 })
        .toBeGreaterThan(1);
      const listening = await audioState(page);

      // Away and back by client-side navigation, which calls `open()` again with the same teaching.
      await page.getByRole('link', { name: 'Back to recordings' }).click();
      await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });
      await page.getByRole('link', { name: new RegExp(TITLE) }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(recordingId)}`, { timeout: 30_000 });

      // The page's own load — the recording and the position — has to finish before the state is
      // read: an `open()` that re-pointed the element would do it a round trip *after* the URL
      // changed, and reading the moment the URL settles would miss it entirely.
      await new Promise((resolve) => setTimeout(resolve, 4_000));

      const back = await audioState(page);
      expect(back.paused).toBe(false);
      // The same source, still running — a re-point would have reset `currentTime` to zero.
      expect(back.src).toBe(listening.src);
      expect(back.currentTime).toBeGreaterThan(listening.currentTime);

      // And exactly one grant across the whole visit.
      expect(
        requests.filter(
          (request) =>
            request.url() === `${baseUrl}${API_PREFIX}${recordingPlaybackPath(recordingId)}`,
        ),
      ).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  }, 240_000);
});
