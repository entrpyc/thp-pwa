import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { DASHBOARD_PAGE_PATH, ROLE } from '@thp/shared';
import { SERVICE_WORKER_PATH } from '@/app/service-worker-update';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';

/**
 * **The worker registers, and the page is still the page.**
 *
 * The worker's whole promise is that it changes nothing a member sees: a signed-out visitor still
 * lands on sign-in, a signed-in member still lands on the dashboard, and nothing is served from a
 * cache. A service worker that broke any of that would do so silently — a worker error is a line
 * in the console, not a failed render — so this drives both states in a real Chromium, waits for
 * the registration to be `ready`, and reads back what actually installed: the versioned script
 * URL, the modules it imported answering as scripts, and an empty cache storage. 127.0.0.1 counts
 * as a secure context, which is what lets the worker register against the test server at all.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

let browser: Browser;
let member: TestAccount;

interface InstalledWorker {
  readonly scriptURL: string;
  readonly controlled: boolean;
  readonly cacheNames: string[];
}

/** What the page's own registration says once it has settled. */
async function installedWorker(page: Page): Promise<InstalledWorker> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return {
      scriptURL: registration.active?.scriptURL ?? '',
      controlled: navigator.serviceWorker.controller !== null,
      cacheNames: await caches.keys(),
    };
  });
}

beforeAll(async () => {
  browser = await chromium.launch();
  member = await createAccount(databaseUrl, ROLE.member, 'service-worker-member');
});

afterAll(async () => {
  await browser?.close();
  await closeTestDatabase();
});

describe('the service worker, in a real browser', () => {
  it('registers under the release on the sign-in screen, which stays the sign-in screen', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });

    const worker = await installedWorker(page);
    const url = new URL(worker.scriptURL);
    expect(url.pathname).toBe(SERVICE_WORKER_PATH);
    expect(url.searchParams.get('v')).toMatch(/\S/);
    expect(worker.cacheNames).toEqual([]);

    // The signed-out page is still the signed-out page: the form is there and no member chrome is.
    await expect.poll(() => page.getByLabel('Email').count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Menu' }).count()).toBe(0);

    // The modules the core imports are served as scripts, not rewritten to a 404 page by the app.
    for (const module of ['/sw/push.js', '/sw/offline.js']) {
      const response = await page.request.get(
        `${baseUrl}${module}?v=${url.searchParams.get('v') ?? ''}`,
      );
      expect(response.status(), module).toBe(200);
      expect(response.headers()['content-type'], module).toMatch(/javascript/);
    }
    await context.close();
  });

  it('controls a signed-in member’s page, which still renders the dashboard', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Email').fill(member.email);
    await page.getByLabel('Password').fill(member.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });

    // `clients.claim` takes the page without a reload, but it is an event, not a synchronous fact.
    await expect
      .poll(async () => (await installedWorker(page)).controlled, { timeout: 15_000 })
      .toBe(true);
    const worker = await installedWorker(page);
    expect(new URL(worker.scriptURL).pathname).toBe(SERVICE_WORKER_PATH);
    expect(worker.cacheNames).toEqual([]);

    // A controlled page is still the server's page: reloading through the worker lands on the
    // dashboard with the member chrome, not on anything a cache remembered.
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(page.url()).toBe(`${baseUrl}${DASHBOARD_PAGE_PATH}`);
    await expect.poll(() => page.getByRole('button', { name: 'Menu' }).count()).toBe(1);
    await context.close();
  });
});
