import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  MEMBER_LIBRARY_PAGE_PATH,
  ROLE,
  recordingPagePath,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  insertSeries,
  publishSummary,
  setRecordingDescription,
  setRecordingPublication,
  setRecordingSeries,
  setSummaryPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';

/**
 * **The member surface, in a real browser** (Story 4 Ticket 01).
 *
 * Three claims, and the third is the one that is expensive to get wrong:
 *
 * 1. The landing, the library and the recording page exist at `/`, `/recordings` and
 *    `/recordings/{id}`, and the placeholder home screen is gone.
 * 2. The chrome is the references' chrome — a working breadcrumb and a menu with an exact entry set
 *    per role.
 * 3. **Nothing is rendered for a deferred destination.** No search control, no *All series*, no
 *    *All chapters*, no tab strip. A disabled control is a promise the epic cannot keep and a thing
 *    the next epic has to find and un-disable, so what this asserts is *absence from the DOM* —
 *    which is a different and much stronger claim than "not visible".
 *
 * Every assertion runs at phone, tablet and desktop, because there is no point at which not being
 * responsive is acceptable.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Phone, tablet, desktop — the responsive standing constraint of the implementation plan. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

const DESKTOP = { width: 1280, height: 900 };

const PUBLISHED_TITLE = `Screen published ${RUN}`;
/** The series the older teaching is put into, so a labelled row and an unlabelled one both exist. */
const SERIES_TITLE = `Screen library series ${RUN}`;
const OLDER_TITLE = `Screen older ${RUN}`;
const HIDDEN_TITLE = `Screen unpublished ${RUN}`;

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let admin: TestAccount;
let publishedId: string;
let hiddenId: string;
let seeded = 0;

async function newRecording(title: string, recordedAt: string): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    { originalMediaKey: `originals/library-screen-${RUN}-${seeded}.mp3`, title, recordedAt },
    handle,
  );
  return row.id;
}

/** Sign in through the real screen — never a forged cookie — and land on the member landing. */
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

  member = await createAccount(databaseUrl, ROLE.member, 'library-screen-member');
  admin = await createAccount(databaseUrl, ROLE.admin, 'library-screen-admin');

  publishedId = await newRecording(PUBLISHED_TITLE, '2026-07-14');
  const olderId = await newRecording(OLDER_TITLE, '2026-03-01');
  hiddenId = await newRecording(HIDDEN_TITLE, '2026-08-01');

  // One of the two published teachings is in a series and the other is in none, which is what makes
  // "no label on a recording with no series" a comparison rather than an absence.
  const seriesId = (await insertSeries({ title: SERIES_TITLE, description: null }, handle)).id;
  await setRecordingSeries(olderId, seriesId, handle);

  await setRecordingDescription(publishedId, 'What this teaching is about.', handle);
  await publishSummary(publishedId, 'The approved summary a member reads.', handle);
  await setSummaryPublication(publishedId, true, handle);

  await setRecordingPublication(publishedId, new Date(), handle);
  await setRecordingPublication(olderId, new Date(), handle);
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the placeholder home screen is gone', () => {
  it('renders the member landing at / and no "Signed in as" card', async () => {
    const page = await signInAs(member);
    try {
      // The card the placeholder screen was: the display name as an h1, the address under it. It
      // is not merely restyled — it is not there.
      await expect
        .poll(() => page.getByText(`Signed in as ${member.displayName}`).count(), {
          timeout: 30_000,
        })
        .toBe(0);
      expect(await page.getByText(member.email).count()).toBe(0);

      // What replaced it: the landing's one way-in row. Story 4 shipped it pointing at the
      // library because series did not exist; Story 6 gives it the destination
      // `pages/dashboard.png` actually draws, and *All recordings* moved into the menu.
      await expect
        .poll(() => page.getByRole('link', { name: 'View all series' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(await page.getByRole('link', { name: 'View all recordings' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('the library at /recordings', () => {
  it('walks from the landing to the library to a teaching', async () => {
    const page = await signInAs(member);
    try {
      // Through the menu, which is where *All recordings* lives from Story 6.
      await page.getByRole('button', { name: 'Menu' }).click();
      await page
        .getByRole('list', { name: 'Navigation' })
        .getByRole('link', { name: 'All recordings' })
        .click();
      await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: 'Recordings' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      // Scoped to the library's own list: the breadcrumb is a list too, and its items are in the
      // DOM before the recordings have loaded — so an unscoped locator would poll green on the
      // wrong rows and then read nothing.
      const rows = page.getByRole('list', { name: 'Recordings' }).getByRole('listitem');
      await expect
        .poll(() => rows.count(), { timeout: 30_000 })
        .toBeGreaterThan(1);

      // Newest date recorded first, and the unpublished teaching is not a row at all.
      const titles = (await rows.allTextContents()).filter((text) => text.includes(RUN));
      expect(titles.length).toBeGreaterThan(1);
      expect(titles[0]).toContain(PUBLISHED_TITLE);
      expect(titles.some((text) => text.includes(OLDER_TITLE))).toBe(true);
      expect(titles.some((text) => text.includes(HIDDEN_TITLE))).toBe(false);

      await page.getByRole('link', { name: new RegExp(PUBLISHED_TITLE) }).click();
      await page.waitForURL(`${baseUrl}${recordingPagePath(publishedId)}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('labels a row with its series, and leaves a row with none unchanged', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const rows = page.getByRole('list', { name: 'Recordings' }).getByRole('listitem');
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(1);

      // The label is a link **beside** the row's own link rather than inside it — an anchor within
      // an anchor is not valid markup, and the row is a whole-row link.
      const labelled = rows.filter({ hasText: OLDER_TITLE }).first();
      expect(await labelled.getByRole('link', { name: SERIES_TITLE }).count()).toBe(1);
      expect(
        await labelled.getByRole('link', { name: new RegExp(OLDER_TITLE) }).count(),
      ).toBe(1);

      // 3.3.9 — a recording in no series shows no label and is otherwise the same row.
      const unlabelled = rows.filter({ hasText: PUBLISHED_TITLE }).first();
      expect(await unlabelled.getByRole('link').count()).toBe(1);
      expect((await unlabelled.textContent()) ?? '').not.toContain(SERIES_TITLE);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('shows an admin browsing the library exactly what a member sees', async () => {
    const page = await signInAs(admin);
    try {
      await page.goto(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      // Scoped and waited on the library's own rows, so the absence below is a statement about a
      // list that has actually loaded rather than about one that has not arrived yet.
      const rows = page.getByRole('list', { name: 'Recordings' }).getByRole('listitem');
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(1);
      expect((await rows.allTextContents()).some((text) => text.includes(PUBLISHED_TITLE))).toBe(
        true,
      );

      // Unpublished rows stay in the console. The member surface is the member surface, whoever
      // is looking at it.
      expect(await page.getByText(HIDDEN_TITLE).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('the recording page at /recordings/[id]', () => {
  it('renders the title, the date, the summary and the description, and no tab strip', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(publishedId)}`, {
        waitUntil: 'domcontentloaded',
      });

      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: PUBLISHED_TITLE }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(await page.getByText('The approved summary a member reads.').count()).toBe(1);
      expect(await page.getByText('What this teaching is about.').count()).toBe(1);
      expect(await page.getByText('Recorded 14 Jul 2026').count()).toBe(1);

      // Four of the reference's five tabs have no data in this epic. The strip arrived in Story 5
      // holding the one that does — `Transcript` — rather than five that lead nowhere, and the
      // other four are dropped rather than rendered disabled.
      expect(await page.getByRole('tablist').count()).toBe(1);
      expect(await page.getByRole('tab').count()).toBe(1);
      for (const absent of ['Chapter', 'Scripture', 'Notes', 'Mindmap', 'Download']) {
        expect(await page.getByRole('tab', { name: absent }).count(), absent).toBe(0);
        expect(await page.getByRole('button', { name: absent }).count(), absent).toBe(0);
      }
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('returns to the library from the back control, however the page was reached', async () => {
    const page = await signInAs(member);
    try {
      // Opened directly rather than navigated to, which is the case browser history cannot serve.
      await page.goto(`${baseUrl}${recordingPagePath(publishedId)}`, {
        waitUntil: 'domcontentloaded',
      });
      const back = page.getByRole('link', { name: 'Back to recordings' });
      await expect.poll(() => back.count(), { timeout: 30_000 }).toBe(1);
      await back.click();
      await page.waitForURL(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('refuses an unpublished teaching rather than rendering it empty', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(hiddenId)}`, {
        waitUntil: 'domcontentloaded',
      });
      // The API refuses and the screen says so. The client holds no decision — it never had the
      // row to decide about.
      await expect
        .poll(() => page.getByText('There is no such teaching.').count(), { timeout: 30_000 })
        .toBe(1);
      expect(await page.getByText(HIDDEN_TITLE).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('the top navigation', () => {
  it('carries the home icon alone on the landing and the library', async () => {
    const page = await signInAs(member);
    try {
      const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
      await expect.poll(() => crumbs.count(), { timeout: 30_000 }).toBe(1);
      expect(await crumbs.getByRole('link', { name: 'Dashboard' }).count()).toBe(1);
      expect(await page.locator('[aria-current="page"]').count()).toBe(0);

      await page.goto(`${baseUrl}${MEMBER_LIBRARY_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.locator('[aria-current="page"]').count(), { timeout: 30_000 })
        .toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('carries home → the recording title on a recording page', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(publishedId)}`, {
        waitUntil: 'domcontentloaded',
      });
      const current = page.locator('[aria-current="page"]');
      await expect.poll(() => current.count(), { timeout: 30_000 }).toBe(1);
      expect(await current.textContent()).toBe(PUBLISHED_TITLE);
      // This teaching is in no series, so the trail is still the two segments it always was. The
      // series segment the reference draws between them is asserted in series-screen.test.ts.
      expect(
        await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('listitem').count(),
      ).toBe(2);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('offers a member exactly Dashboard, All recordings and Sign out', async () => {
    const page = await signInAs(member);
    try {
      expect(await menuEntries(page)).toEqual([
        'Dashboard',
        'All series',
        'All recordings',
        'Sign out',
      ]);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('offers an admin the same three plus the console', async () => {
    const page = await signInAs(admin);
    try {
      // The entry is rendered from the policy module's answer and grants nothing: `/admin` gates
      // itself server-side and every route behind it refuses independently.
      expect(await menuEntries(page)).toEqual([
        'Dashboard',
        'All series',
        'All recordings',
        'Admin console',
        'Sign out',
      ]);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('renders no control at all for a deferred destination', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${recordingPagePath(publishedId)}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: PUBLISHED_TITLE }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      await page.getByRole('button', { name: 'Menu' }).click();

      // Absent from the DOM, not merely hidden or disabled — which is the whole decision. A greyed
      // control is a promise this epic cannot keep and a thing the next epic has to un-disable.
      // *All series* left this list in Story 6 — it is a live destination now, which is exactly
      // what dropping rather than disabling was for. The rest stay deferred.
      for (const absent of ['All chapters', 'Search', 'My notes']) {
        expect(await page.getByText(absent, { exact: false }).count(), absent).toBe(0);
      }
      expect(await page.getByRole('searchbox').count()).toBe(0);
      // Nothing in the chrome is disabled, which is the half of the decision a count of absent
      // labels cannot make: the menu carries live destinations only. (The transport's scrubber is
      // disabled until the element reports a duration, and that is a transport state rather than a
      // deferred feature — which is why this is scoped to the navigation.)
      const chrome = page.getByRole('navigation', { name: 'Breadcrumb' });
      expect(await chrome.locator('[disabled]').count()).toBe(0);
      expect(await page.getByRole('list', { name: 'Navigation' }).locator('[disabled]').count()).toBe(
        0,
      );
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('signs out from the menu', async () => {
    const page = await signInAs(member);
    try {
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.waitForURL(`${baseUrl}/sign-in`, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('at every width', () => {
  for (const viewport of VIEWPORTS) {
    it(`renders the three screens without horizontal overflow at ${viewport.label}`, async () => {
      const page = await signInAs(member, { width: viewport.width, height: viewport.height });
      try {
        for (const path of [
          DASHBOARD_PAGE_PATH,
          MEMBER_LIBRARY_PAGE_PATH,
          recordingPagePath(publishedId),
        ]) {
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

          const menu = page.getByRole('button', { name: 'Menu' });
          const box = await menu.boundingBox();
          expect(box, `${path} has no menu control at ${viewport.label}`).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
        }
      } finally {
        await page.context().close();
      }
    }, 180_000);
  }
});
