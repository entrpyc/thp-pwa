import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  ADMIN_PAGE_PATH,
  ADMIN_SERIES_PAGE_PATH,
  API_PREFIX,
  ROLE,
  recordingSeriesPath,
} from '@thp/shared';
import { createDatabase, insertRecording, type DatabaseHandle } from '@thp/db';
import {
  closeTestDatabase,
  signedInAccount,
  createAccount,
  type TestAccount,
} from '../support/accounts';

/**
 * **The Series console panel, in a real browser** (Story 6 Ticket 01).
 *
 * Three claims:
 *
 * 1. It is a **fifth entry in the console shell**, reachable from it, and a member never reaches it.
 * 2. A series is created and renamed from this screen, and the change is read back from the API
 *    rather than from the state the form happened to keep.
 * 3. **A series with nothing in it is visible**, with a count of zero and no date range — the
 *    console is where an empty series has to be visible in order to be filled.
 *
 * Every claim runs against the same production build the API suite drives.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const PANEL_URL = `${baseUrl}${ADMIN_SERIES_PAGE_PATH}`;
const CONSOLE_URL = `${baseUrl}${ADMIN_PAGE_PATH}`;

/** Phone, tablet, desktop — the responsive standing constraint of the implementation plan. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

const DESKTOP = { width: 1280, height: 900 };

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let browser: Browser;
let handle: DatabaseHandle;
let admin: TestAccount;
let adminCookie: string;
let member: TestAccount;

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 4 });

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'series-panel-admin');
  admin = signedInAdmin.account;
  adminCookie = signedInAdmin.cookie;

  member = await createAccount(databaseUrl, ROLE.member, 'series-panel-member');
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

/** Sign in through the real screen — never a forged cookie — and hand back the page. */
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
  await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
  return page;
}

/** Signed in, on the panel, with the list loaded. */
async function openPanel(
  viewport: { width: number; height: number } = DESKTOP,
): Promise<Page> {
  const page = await signInAs(admin, viewport);
  await page.goto(PANEL_URL, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('region', { name: 'Series', exact: true }).count(), { timeout: 30_000 })
    .toBe(1);
  await expect.poll(() => page.getByText('Loading series…').count(), { timeout: 30_000 }).toBe(0);
  return page;
}

/** Create a series through the form and wait for it to appear in the list below. */
async function createThrough(page: Page, title: string, description = ''): Promise<void> {
  await page.getByLabel('Title', { exact: true }).first().fill(title);
  if (description !== '') {
    await page.getByLabel('Description', { exact: true }).first().fill(description);
  }
  await page.getByRole('button', { name: 'Create series' }).click();
  await expect
    .poll(
      () => page.getByRole('list').getByRole('listitem').filter({ hasText: title }).count(),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
}

/** The id of the series with this title, read through the API the panel calls. */
async function idOf(title: string): Promise<string> {
  const response = await fetch(`${baseUrl}${API_PREFIX}/series`, {
    headers: { accept: 'application/json', cookie: adminCookie },
  });
  const body = (await response.json()) as { series: { id: string; title: string }[] };
  const found = body.series.find((one) => one.title === title);
  if (found === undefined) throw new Error(`no series titled ${title}`);
  return found.id;
}

/** The list row whose text contains `title`. */
function rowFor(page: Page, title: string) {
  return page.getByRole('listitem').filter({ hasText: title }).first();
}

// =================================================================================================

describe('the panel and its gate', () => {
  it('is a fifth entry in the console shell, reachable from it', async () => {
    const page = await signInAs(admin);
    try {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: 'Admin console' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      const link = page.getByRole('navigation', { name: 'Console panels' }).getByRole('link', {
        name: 'Series',
      });
      expect(await link.count()).toBe(1);
      await link.click();
      await page.waitForURL(PANEL_URL, { timeout: 30_000 });

      expect(await page.getByRole('heading', { level: 1, name: 'Admin console' }).count()).toBe(1);
      expect(await link.getAttribute('aria-current')).toBe('page');
      expect(await page.getByRole('region', { name: 'Create a series' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('never shows a member the panel, and never sends them its markup', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(PANEL_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
      expect(await page.getByRole('region', { name: 'Create a series' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('creating and renaming from the screen', () => {
  it('creates a series with a title and a description and lists it', async () => {
    const page = await openPanel();
    const title = `Screen created ${RUN}`;
    try {
      await createThrough(page, title, 'A study of the letter.');

      const row = rowFor(page, title);
      expect(await row.textContent()).toContain('A study of the letter.');
      // Nothing in it yet: the count reads zero and there is no date range at all.
      expect(await row.textContent()).toContain('0 recordings');

      // The form is cleared, so the next series is not a duplicate of this one by accident.
      expect(await page.getByLabel('Title', { exact: true }).first().inputValue()).toBe('');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('renames a series and rewrites its description, and the change survives a reload', async () => {
    const page = await openPanel();
    const before = `Screen rename before ${RUN}`;
    const after = `Screen rename after ${RUN}`;
    try {
      await createThrough(page, before, 'First wording.');

      await rowFor(page, before).getByRole('button', { name: 'Rename' }).click();
      await rowFor(page, before).getByLabel('Title', { exact: true }).fill(after);
      await rowFor(page, before).getByLabel('Description', { exact: true }).fill('Second wording.');
      await rowFor(page, before).getByRole('button', { name: 'Save series' }).click();

      await expect
        .poll(() => page.getByRole('listitem').filter({ hasText: after }).count(), {
          timeout: 30_000,
        })
        .toBeGreaterThan(0);

      // Reloaded, so what is read back is the API's answer rather than the form's own state.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByRole('listitem').filter({ hasText: after }).count(), {
          timeout: 30_000,
        })
        .toBeGreaterThan(0);
      expect(await rowFor(page, after).textContent()).toContain('Second wording.');
      expect(await page.getByText(before, { exact: true }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('says what the API refused and keeps what was typed', async () => {
    const page = await openPanel();
    try {
      // A blank title is refused by the API — the screen holds no decision of its own.
      await page.getByLabel('Description', { exact: true }).first().fill('Typed and kept.');
      await page.getByRole('button', { name: 'Create series' }).click();

      const alert = page.getByRole('region', { name: 'Create a series' }).getByRole('alert');
      await expect.poll(() => alert.count(), { timeout: 30_000 }).toBeGreaterThan(0);
      expect(await page.getByLabel('Description', { exact: true }).first().inputValue()).toBe(
        'Typed and kept.',
      );
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('what the list says about what is in a series', () => {
  it('reads the count and the date range back after a recording is assigned', async () => {
    const page = await openPanel();
    const title = `Screen counted ${RUN}`;
    try {
      await createThrough(page, title);
      // Nothing in it yet, and it is still a row — the console is where an empty series has to be
      // visible in order to be filled.
      expect(await rowFor(page, title).textContent()).toContain('0 recordings');
      expect(await rowFor(page, title).textContent()).not.toContain('2026');

      const seriesId = await idOf(title);
      // Assigned the way the Recordings panel assigns it — the route that screen's picker calls.
      for (const [recordingTitle, recordedAt] of [
        [`Screen counted first ${RUN}`, '2026-03-11'],
        [`Screen counted last ${RUN}`, '2026-09-02'],
      ] as const) {
        const row = await insertRecording(
          {
            originalMediaKey: `originals/series-panel-${RUN}-${recordingTitle}.mp3`,
            title: recordingTitle,
            recordedAt,
          },
          handle,
        );
        const response = await fetch(`${baseUrl}${API_PREFIX}${recordingSeriesPath(row.id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', cookie: adminCookie },
          body: JSON.stringify({ seriesId }),
        });
        expect(response.status).toBe(200);
      }

      // Neither recording is published, and the console counts them anyway — a member's count of
      // the same series would be zero, and that difference is the rule rather than a bug.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect
        .poll(async () => (await rowFor(page, title).textContent()) ?? '', { timeout: 30_000 })
        .toContain('2 recordings');
      // `Sept`, not `Sep` — the `en-GB` short month, which is the one formatter the library, the
      // console and both series screens already share.
      expect(await rowFor(page, title).textContent()).toContain('11 Mar 2026 – 2 Sept 2026');
    } finally {
      await page.context().close();
    }
  }, 240_000);
});

describe('at every width', () => {
  for (const viewport of VIEWPORTS) {
    it(`renders the panel without horizontal overflow at ${viewport.label}`, async () => {
      const page = await openPanel({ width: viewport.width, height: viewport.height });
      try {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        );
        expect(overflow, `the series panel overflows at ${viewport.label}`).toBe(false);

        const create = page.getByRole('button', { name: 'Create series' });
        const box = await create.boundingBox();
        expect(box, `no create control at ${viewport.label}`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
      } finally {
        await page.context().close();
      }
    }, 120_000);
  }
});
