import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import {
  ADMIN_PAGE_PATH,
  API_PREFIX,
  INVITATIONS_PATH,
  ROLE,
  ROLE_LABEL,
  USERS_PATH,
  isApiErrorBody,
  type AccountListPayload,
  type InvitationListPayload,
  type InvitationSummary,
} from '@thp/shared';
import {
  closeTestDatabase,
  createAccount,
  signIn,
  signedInAccount,
  type TestAccount,
} from '../support/accounts';

/**
 * The admin console, driven in a real browser against the same production build the API suite uses.
 *
 * **This step ships no API.** Steps 3 and 4 shipped all nine routes the console drives, and every
 * one of them is refused server-side by the policy module. So the assertions here divide cleanly in
 * two: what an operator can see and do, and — once, deliberately — a direct request proving that
 * the refusal is the API's and not this screen's.
 *
 * Everything is scoped to accounts and invitations this file seeds. The suite shares one database
 * across its files, so "the list contains what we put in it, in the order the API sent" is the
 * honest form of "every account is listed"; asserting a total would be asserting what the rest of
 * the run happened to do that second.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const CONSOLE_URL = `${baseUrl}${ADMIN_PAGE_PATH}`;
const USERS_URL = `${baseUrl}${API_PREFIX}${USERS_PATH}`;
const INVITATIONS_URL = `${baseUrl}${API_PREFIX}${INVITATIONS_PATH}`;

/** Phone, tablet, desktop — the responsive standing constraint of the implementation plan. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

const DESKTOP = { width: 1280, height: 900 };

let browser: Browser;
let sql: postgres.Sql;

let admin: TestAccount;
let adminCookie: string;
let member: TestAccount;
let memberCookie: string;
/** A long display name and a long address, for the overflow checks. */
let longAccount: TestAccount;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly body: T;
}

async function call<T>(url: string, init: RequestInit & { cookie?: string } = {}): Promise<Answer<T>> {
  const { cookie, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...rest.headers,
    },
  });
  const body: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    code: isApiErrorBody(body) ? body.error.code : null,
    message: isApiErrorBody(body) ? body.error.message : null,
    body: body as T,
  };
}

async function listAccounts(): Promise<AccountListPayload> {
  const answer = await call<AccountListPayload>(USERS_URL, { cookie: adminCookie });
  expect(answer.status).toBe(200);
  return answer.body;
}

async function listInvitations(): Promise<readonly InvitationSummary[]> {
  const answer = await call<InvitationListPayload>(INVITATIONS_URL, { cookie: adminCookie });
  expect(answer.status).toBe(200);
  return answer.body.invitations;
}

async function issueInvitation(email: string): Promise<InvitationSummary> {
  const answer = await call<InvitationSummary>(INVITATIONS_URL, {
    method: 'POST',
    cookie: adminCookie,
    body: JSON.stringify({ email, role: ROLE.member }),
  });
  expect(answer.status).toBe(201);
  return answer.body;
}

/** An address nothing has used, unique to the call. */
function freshEmail(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}@example.test`;
}

beforeAll(async () => {
  browser = await chromium.launch();
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'console-admin');
  admin = signedInAdmin.account;
  adminCookie = signedInAdmin.cookie;

  const signedInMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'console-member');
  member = signedInMember.account;
  memberCookie = signedInMember.cookie;

  longAccount = await createAccount(
    databaseUrl,
    ROLE.member,
    'extraordinarily-long-name-for-somebody-who-attends-on-sundays',
  );
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await sql?.end({ timeout: 5 });
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

/** Signed in, on the console, with both lists loaded. */
async function openConsole(
  account: TestAccount,
  viewport: { width: number; height: number } = DESKTOP,
): Promise<Page> {
  const page = await signInAs(account, viewport);
  await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('heading', { level: 1, name: 'Admin console' }).count(), {
      timeout: 30_000,
    })
    .toBe(1);
  await expect
    .poll(() => rowFor(page, account.email).count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  return page;
}

/** The one row carrying this address. Rows are list items; nothing else on the screen is. */
function rowFor(page: Page, email: string): Locator {
  return page.getByRole('listitem').filter({ hasText: email });
}

function membersRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Members' });
}

function invitationsRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Invitations' });
}

/**
 * A state chip, matched precisely.
 *
 * `getByText` is case-insensitive and matches substrings, so a bare "Deactivated" also finds the
 * API's own `That account is already deactivated.` — which is exactly the sentence these
 * assertions have to be able to tell the chip apart from.
 */
function chip(row: Locator, text: string): Locator {
  return row.getByText(text, { exact: true });
}

/** The chip carries the date after the word, so it is matched by shape rather than by equality. */
function deactivatedChip(row: Locator): Locator {
  return row.getByText(/^Deactivated /);
}

/** The refusal or confirmation printed where the press happened. */
async function noteOn(row: Locator, kind: 'alert' | 'status'): Promise<string> {
  return ((await row.getByRole(kind).first().textContent().catch(() => '')) ?? '').trim();
}

async function waitForNote(row: Locator, kind: 'alert' | 'status'): Promise<string> {
  await expect.poll(async () => (await noteOn(row, kind)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  return noteOn(row, kind);
}

/** A mark that survives only if the document is never replaced. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });
}

async function stillSameDocument(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true,
  );
}

// =================================================================================================

describe('the console shell and its gate', () => {
  it('renders the console for an admin — header, panel navigation and the panel', async () => {
    const page = await openConsole(admin);
    try {
      expect(await page.getByRole('heading', { level: 1, name: 'Admin console' }).count()).toBe(1);
      expect(await page.getByRole('navigation', { name: 'Console panels' }).count()).toBe(1);
      expect(
        await page.getByRole('link', { name: 'User management' }).getAttribute('aria-current'),
      ).toBe('page');
      expect(await membersRegion(page).count()).toBe(1);
      expect(await invitationsRegion(page).count()).toBe(1);
      expect(await page.getByRole('region', { name: 'Invite somebody' }).count()).toBe(1);

      // The header carries who is signed in, and the way out.
      expect(await page.getByText(admin.displayName).count()).toBeGreaterThan(0);
      expect(await page.getByRole('button', { name: 'Sign out' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('never shows a member the console, and never sends them its markup', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
      expect(await page.getByRole('heading', { level: 1, name: 'Admin console' }).count()).toBe(0);
      expect(await membersRegion(page).count()).toBe(0);
    } finally {
      await page.context().close();
    }

    // Not merely navigated away from: the console's markup is never produced at all.
    const response = await fetch(CONSOLE_URL, {
      headers: { cookie: memberCookie },
      redirect: 'manual',
    });
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(await response.text()).not.toContain('Admin console');
  }, 90_000);

  it('sends an anonymous request to sign-in', async () => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    try {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(`${baseUrl}/sign-in`, { timeout: 30_000 });
      expect(await page.getByLabel('Email').count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('is a render decision — the API is what refuses a member the data', async () => {
    // The console hides; this is what actually says no, and it says no to a direct request that
    // never went near the screen.
    const answer = await call(USERS_URL, { cookie: memberCookie });
    expect(answer.status).toBe(403);
    expect(answer.code).toBe('forbidden');

    const invitations = await call(INVITATIONS_URL, { cookie: memberCookie });
    expect(invitations.status).toBe(403);
    expect(invitations.code).toBe('forbidden');
  }, 60_000);

  it('is reachable without typing a URL, and only for an admin', async () => {
    // The way in moved with Story 4 Ticket 01: the placeholder landing that used to carry this link
    // is gone, and the entry now lives in the member navigation menu. It still grants nothing —
    // `/admin` gates itself server-side and every route behind it refuses independently, which is
    // what the rest of this suite drives directly.
    const adminPage = await signInAs(admin);
    try {
      await adminPage.getByRole('button', { name: 'Menu' }).click();
      const link = adminPage.getByRole('link', { name: 'Admin console' });
      await expect.poll(() => link.count(), { timeout: 30_000 }).toBe(1);
      await link.click();
      await adminPage.waitForURL(CONSOLE_URL, { timeout: 30_000 });
      expect(await adminPage.getByRole('heading', { level: 1, name: 'Admin console' }).count()).toBe(1);
    } finally {
      await adminPage.context().close();
    }

    const memberPage = await signInAs(member);
    try {
      await memberPage.getByRole('button', { name: 'Menu' }).click();
      await expect
        .poll(() => memberPage.getByRole('list', { name: 'Navigation' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(await memberPage.getByRole('link', { name: 'Admin console' }).count()).toBe(0);
    } finally {
      await memberPage.context().close();
    }
  }, 120_000);

  it.each(VIEWPORTS)('fits a $label viewport with no horizontal scroll', async (viewport) => {
    const page = await openConsole(admin, { width: viewport.width, height: viewport.height });
    try {
      // A long display name and a long address are on screen, which is what makes this worth
      // asserting rather than a check that a short list fits.
      await expect
        .poll(() => rowFor(page, longAccount.email).count(), { timeout: 30_000 })
        .toBe(1);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

      const submit = await page.getByRole('button', { name: 'Send invitation' }).boundingBox();
      expect(submit, 'the invite button must be on screen').not.toBeNull();
      expect((submit?.x ?? -1) + (submit?.width ?? 0)).toBeLessThanOrEqual(viewport.width);

      // No control smaller than a thumb — the panel is operated standing up, on a phone.
      const deactivate = await rowFor(page, longAccount.email)
        .getByRole('button', { name: 'Deactivate', exact: true })
        .boundingBox();
      expect(deactivate?.height ?? 0).toBeGreaterThanOrEqual(40);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

// =================================================================================================

describe('the member list', () => {
  it('lists every account with its name, address, role and active state', async () => {
    const deactivated = await createAccount(databaseUrl, ROLE.member, 'listed-inactive');
    expect(
      (await call(`${USERS_URL}/${deactivated.id}/deactivate`, {
        method: 'POST',
        cookie: adminCookie,
      })).status,
    ).toBe(200);

    const page = await openConsole(admin);
    try {
      const members = membersRegion(page);

      // An admin, a member and a deactivated member — name, address and role all on the row.
      for (const [account, label] of [
        [admin, ROLE_LABEL[ROLE.admin]],
        [member, ROLE_LABEL[ROLE.member]],
        [deactivated, ROLE_LABEL[ROLE.member]],
      ] as const) {
        const row = members.getByRole('listitem').filter({ hasText: account.email });
        await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
        expect(await row.getByText(account.displayName).count()).toBeGreaterThan(0);
        expect(
          await row
            .getByRole('group', { name: `Role for ${account.displayName}` })
            .getByRole('button', { name: label, exact: true })
            .getAttribute('aria-pressed'),
        ).toBe('true');
      }

      // The deactivated row carries a state marker the active rows do not, and says when.
      const inactiveRow = members.getByRole('listitem').filter({ hasText: deactivated.email });
      expect(await deactivatedChip(inactiveRow).count()).toBe(1);
      const when = await inactiveRow.locator('time').first().getAttribute('datetime');
      expect(Number.isNaN(Date.parse(when ?? ''))).toBe(false);

      const activeRow = members.getByRole('listitem').filter({ hasText: member.email });
      expect(await deactivatedChip(activeRow).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 150_000);

  it('renders in the API’s order rather than re-sorting in the client', async () => {
    const page = await openConsole(admin);
    try {
      const payload = await listAccounts();
      const rendered = await membersRegion(page).getByRole('listitem').allTextContents();
      const expected = payload.accounts.map((account) => account.email);

      // Row for row, in sequence. `allTextContents` runs a row's text together with no separator,
      // so the address cannot be cut back out of it — but addresses are unique, so "row N carries
      // account N's address" pins the order just as exactly. `listUsers` orders by creation, and a
      // client re-sort would show as a different sequence.
      expect(rendered).toHaveLength(expected.length);
      expected.forEach((email, index) => {
        expect(rendered[index]).toContain(email);
      });
      expect(expected.length).toBeGreaterThan(2);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('refreshes the row after a mutation, without a manual reload', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'refreshes');
    const page = await openConsole(admin);
    try {
      await expect.poll(() => rowFor(page, target.email).count(), { timeout: 30_000 }).toBe(1);
      await markDocument(page);

      const row = rowFor(page, target.email);
      await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
      await row.getByRole('button', { name: 'Yes, end access' }).click();

      await expect
        .poll(() => deactivatedChip(rowFor(page, target.email)).count(), { timeout: 30_000 })
        .toBe(1);
      expect(await stillSameDocument(page)).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 150_000);
});

// =================================================================================================

describe('assigning a role', () => {
  it('promotes an account and the change survives a re-fetch', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'promoted');
    const page = await openConsole(admin);
    try {
      const row = rowFor(page, target.email);
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);

      const picker = row.getByRole('group', { name: `Role for ${target.displayName}` });
      await picker.getByRole('button', { name: ROLE_LABEL[ROLE.admin], exact: true }).click();

      await expect
        .poll(
          async () =>
            picker
              .getByRole('button', { name: ROLE_LABEL[ROLE.admin], exact: true })
              .getAttribute('aria-pressed'),
          { timeout: 30_000 },
        )
        .toBe('true');

      const payload = await listAccounts();
      const found = payload.accounts.find((account) => account.id === target.id);
      expect(found?.role).toBe(ROLE.admin);
    } finally {
      await page.context().close();
    }
  }, 150_000);

  it('treats re-assigning the role an account already holds as success, not failure', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'idempotent-role');
    const page = await openConsole(admin);
    try {
      const row = rowFor(page, target.email);
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);

      // The role it already has. The API answers with the current state on purpose.
      await row
        .getByRole('group', { name: `Role for ${target.displayName}` })
        .getByRole('button', { name: ROLE_LABEL[ROLE.member], exact: true })
        .click();

      const reported = await waitForNote(row, 'status');
      expect(reported).toContain(ROLE_LABEL[ROLE.member]);
      // And it is reported as what happened, not as a refusal.
      expect(await row.getByRole('alert').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 150_000);

  it('refuses to demote the last active admin and prints the API’s own reason', async () => {
    const only = await createAccount(databaseUrl, ROLE.admin, 'console-only-admin');
    await withOnlyTheseAdmins([only.id], async () => {
      // The same refusal, taken straight from the API, so the screen is compared against the real
      // words rather than against a copy of them written here.
      const direct = await call(`${USERS_URL}/${only.id}`, {
        method: 'PATCH',
        cookie: (await signInFor(only)).cookie,
        body: JSON.stringify({ role: ROLE.member }),
      });
      expect(direct.status).toBe(409);
      expect(direct.code).toBe('last_admin');

      const page = await openConsole(only);
      try {
        const row = rowFor(page, only.email);
        await row
          .getByRole('group', { name: `Role for ${only.displayName}` })
          .getByRole('button', { name: ROLE_LABEL[ROLE.member], exact: true })
          .click();

        expect(await waitForNote(row, 'alert')).toBe(direct.message);
        // Still an admin, and the row says so.
        expect(
          await row
            .getByRole('group', { name: `Role for ${only.displayName}` })
            .getByRole('button', { name: ROLE_LABEL[ROLE.admin], exact: true })
            .getAttribute('aria-pressed'),
        ).toBe('true');
      } finally {
        await page.context().close();
      }
    });
  }, 180_000);
});

// =================================================================================================

describe('deactivating and reactivating', () => {
  it('takes a confirming press, and the confirmation names the account', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'confirmed');
    const page = await openConsole(admin);
    try {
      let deactivateCalls = 0;
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().endsWith(`/${target.id}/deactivate`)) {
          deactivateCalls += 1;
        }
      });

      const row = rowFor(page, target.email);
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
      await row.getByRole('button', { name: 'Deactivate', exact: true }).click();

      // The confirmation says whose access is ending.
      await expect
        .poll(() => row.getByText(`End access for ${target.displayName}`).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(await row.getByText(target.email).count()).toBeGreaterThan(0);

      // The first press changed nothing at all.
      expect(deactivateCalls).toBe(0);
      expect(await isActive(target.id)).toBe(true);

      await row.getByRole('button', { name: 'Yes, end access' }).click();
      await expect
        .poll(() => deactivatedChip(rowFor(page, target.email)).count(), { timeout: 30_000 })
        .toBe(1);
      expect(deactivateCalls).toBe(1);
      expect(await isActive(target.id)).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('restores an account, and the re-fetched listing says active', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'restored');
    expect(
      (await call(`${USERS_URL}/${target.id}/deactivate`, { method: 'POST', cookie: adminCookie }))
        .status,
    ).toBe(200);

    const page = await openConsole(admin);
    try {
      const row = rowFor(page, target.email);
      await expect.poll(() => deactivatedChip(row).count(), { timeout: 30_000 }).toBe(1);

      await row.getByRole('button', { name: 'Restore' }).click();
      await expect
        .poll(() => deactivatedChip(rowFor(page, target.email)).count(), { timeout: 30_000 })
        .toBe(0);

      const payload = await listAccounts();
      expect(payload.accounts.find((account) => account.id === target.id)?.active).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('refuses to deactivate the last active admin and prints the API’s own reason', async () => {
    const only = await createAccount(databaseUrl, ROLE.admin, 'console-only-admin-off');
    await withOnlyTheseAdmins([only.id], async () => {
      const direct = await call(`${USERS_URL}/${only.id}/deactivate`, {
        method: 'POST',
        cookie: (await signInFor(only)).cookie,
      });
      expect(direct.status).toBe(409);
      expect(direct.code).toBe('last_admin');

      const page = await openConsole(only);
      try {
        const row = rowFor(page, only.email);
        await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
        await row.getByRole('button', { name: 'Yes, end access' }).click();

        expect(await waitForNote(row, 'alert')).toBe(direct.message);
        expect(await isActive(only.id)).toBe(true);
      } finally {
        await page.context().close();
      }
    });
  }, 180_000);

  it('reports a state conflict as a conflict, not as a success it did not achieve', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'conflicted');
    const page = await openConsole(admin);
    try {
      const row = rowFor(page, target.email);
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);

      // The row on screen goes stale underneath: somebody else ends this account's access.
      expect(
        (await call(`${USERS_URL}/${target.id}/deactivate`, { method: 'POST', cookie: adminCookie }))
          .status,
      ).toBe(200);
      const conflict = await call(`${USERS_URL}/${target.id}/deactivate`, {
        method: 'POST',
        cookie: adminCookie,
      });
      expect(conflict.status).toBe(409);
      expect(conflict.code).toBe('account_state_conflict');

      await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
      await row.getByRole('button', { name: 'Yes, end access' }).click();

      expect(await waitForNote(rowFor(page, target.email), 'alert')).toBe(conflict.message);
      // And having said so, the row settles into what the database actually holds.
      await expect
        .poll(() => deactivatedChip(rowFor(page, target.email)).count(), { timeout: 30_000 })
        .toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// =================================================================================================

describe('invitations', () => {
  it('issues one from the console, and it appears in the list and over the API', async () => {
    const email = freshEmail('console-invited');
    const page = await openConsole(admin);
    try {
      await page.getByLabel('Email').fill(email);
      await page
        .getByRole('group', { name: 'Role for the invitation' })
        .getByRole('button', { name: ROLE_LABEL[ROLE.admin], exact: true })
        .click();
      await page.getByRole('button', { name: 'Send invitation' }).click();

      const row = invitationsRegion(page).getByRole('listitem').filter({ hasText: email });
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
      expect(await chip(row, 'Pending').count()).toBe(1);
      expect(await row.getByText(ROLE_LABEL[ROLE.admin]).count()).toBeGreaterThan(0);

      const issued = (await listInvitations()).find((entry) => entry.email === email);
      expect(issued?.status).toBe('pending');
      expect(issued?.role).toBe(ROLE.admin);
    } finally {
      await page.context().close();
    }
  }, 150_000);

  it.each([
    {
      label: 'email_taken',
      code: 'email_taken',
      body: () => ({ email: member.email, role: ROLE.member }),
    },
    {
      label: 'invalid_input',
      code: 'invalid_input',
      body: () => ({ email: 'not-an-address', role: ROLE.member }),
    },
  ])('shows the API’s own $label refusal against the form', async ({ code, body }) => {
    const payload = body();
    const direct = await call(INVITATIONS_URL, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify(payload),
    });
    expect(direct.code).toBe(code);

    const page = await openConsole(admin);
    try {
      await markDocument(page);
      await page.getByLabel('Email').fill(payload.email);
      await page.getByRole('button', { name: 'Send invitation' }).click();

      const error = page.locator('form').getByRole('alert');
      await expect
        .poll(async () => ((await error.textContent().catch(() => '')) ?? '').trim(), {
          timeout: 30_000,
        })
        .toBe(direct.message);

      // Being refused costs nothing: what was typed is still there and the page never reloaded.
      expect(await page.getByLabel('Email').inputValue()).toBe(payload.email);
      expect(new URL(page.url()).pathname).toBe(ADMIN_PAGE_PATH);
      expect(await stillSameDocument(page)).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 150_000);

  it('shows the API’s own invitation_exists refusal against the form', async () => {
    const email = freshEmail('console-duplicate');
    await issueInvitation(email);

    const direct = await call(INVITATIONS_URL, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email, role: ROLE.member }),
    });
    expect(direct.code).toBe('invitation_exists');

    const page = await openConsole(admin);
    try {
      await page.getByLabel('Email').fill(email);
      await page.getByRole('button', { name: 'Send invitation' }).click();

      const error = page.locator('form').getByRole('alert');
      await expect
        .poll(async () => ((await error.textContent().catch(() => '')) ?? '').trim(), {
          timeout: 30_000,
        })
        .toBe(direct.message);
    } finally {
      await page.context().close();
    }
  }, 150_000);

  it('distinguishes a pending invitation from an expired one, and shows the API’s expiry', async () => {
    const pendingEmail = freshEmail('console-open');
    const expiredEmail = freshEmail('console-stale');
    const pending = await issueInvitation(pendingEmail);
    const expired = await issueInvitation(expiredEmail);
    await sql`update invitation set expires_at = now() - interval '1 day' where id = ${expired.id}`;

    const page = await openConsole(admin);
    try {
      const region = invitationsRegion(page);
      const pendingRow = region.getByRole('listitem').filter({ hasText: pendingEmail });
      const expiredRow = region.getByRole('listitem').filter({ hasText: expiredEmail });

      await expect.poll(() => pendingRow.count(), { timeout: 30_000 }).toBe(1);
      expect(await chip(pendingRow, 'Pending').count()).toBe(1);
      expect(await chip(expiredRow, 'Expired').count()).toBe(1);
      expect(await chip(expiredRow, 'Pending').count()).toBe(0);

      // The status and the expiry are the API's, not a second clock in the client.
      expect(await pendingRow.locator('time').first().getAttribute('datetime')).toBe(
        pending.expiresAt,
      );
      const listed = await listInvitations();
      expect(listed.find((entry) => entry.id === expired.id)?.status).toBe('expired');
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('revokes an invitation out of the actionable set without hiding what happened', async () => {
    const email = freshEmail('console-closing');
    await issueInvitation(email);

    const page = await openConsole(admin);
    try {
      const row = invitationsRegion(page).getByRole('listitem').filter({ hasText: email });
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
      await row.getByRole('button', { name: 'Revoke' }).click();

      await expect.poll(() => chip(row, 'Revoked').count(), { timeout: 30_000 }).toBe(1);
      // Still listed — the record of what happened stays — but nothing is offered on it any more.
      expect(await row.count()).toBe(1);
      expect(await row.getByRole('button', { name: 'Revoke' }).count()).toBe(0);
      expect(await row.getByRole('button', { name: 'Resend' }).count()).toBe(0);

      expect((await listInvitations()).find((entry) => entry.email === email)?.status).toBe(
        'revoked',
      );
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('replaces a resent invitation with a fresh one on a fresh window', async () => {
    const email = freshEmail('console-refreshed');
    const original = await issueInvitation(email);

    const page = await openConsole(admin);
    try {
      const region = invitationsRegion(page);
      const rows = region.getByRole('listitem').filter({ hasText: email });
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(1);
      await rows.getByRole('button', { name: 'Resend' }).click();

      // The API answers `201` with a new id and a later expiry.
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(2);
      const listed = await listInvitations();
      const replacement = listed.find(
        (entry) => entry.email === email && entry.status === 'pending',
      );
      expect(replacement).toBeDefined();
      expect(replacement?.id).not.toBe(original.id);
      expect(Date.parse(replacement?.expiresAt ?? '')).toBeGreaterThan(
        Date.parse(original.expiresAt),
      );

      // Exactly one row for this address is still open, and it carries the *new* expiry.
      const pendingRow = rows.filter({ hasText: 'Pending' });
      expect(await pendingRow.count()).toBe(1);
      expect(await pendingRow.locator('time').first().getAttribute('datetime')).toBe(
        replacement?.expiresAt,
      );

      // The old one is not left behind looking live.
      expect(await rows.filter({ hasText: 'Revoked' }).count()).toBe(1);
      expect(await pendingRow.getByRole('button', { name: 'Resend' }).count()).toBe(1);
      expect(
        await rows.filter({ hasText: 'Revoked' }).getByRole('button', { name: 'Resend' }).count(),
      ).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// =================================================================================================

describe('failure and empty states', () => {
  it('says it could not load rather than showing an empty list', async () => {
    const page = await signInAs(admin);
    try {
      await page.route(
        (url) => url.pathname === `${API_PREFIX}${USERS_PATH}`,
        (route) => route.abort(),
      );
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });

      const members = membersRegion(page);
      await expect
        .poll(async () => (await members.getByRole('alert').count()) > 0, { timeout: 30_000 })
        .toBe(true);
      const stated = ((await members.getByRole('alert').first().textContent()) ?? '').trim();
      expect(stated.length).toBeGreaterThan(0);

      // "nothing to show" and "could not load" are never the same screen.
      expect(await members.getByText('No accounts yet.').count()).toBe(0);
      expect(await members.getByRole('listitem').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('reads as empty rather than as broken when there is nothing outstanding', async () => {
    const page = await signInAs(admin);
    try {
      await page.route(
        (url) => url.pathname === `${API_PREFIX}${INVITATIONS_PATH}`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ invitations: [] }),
          }),
      );
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });

      const invitations = invitationsRegion(page);
      await expect
        .poll(() => invitations.getByText('No invitations outstanding').count(), { timeout: 30_000 })
        .toBe(1);
      expect(await invitations.getByRole('alert').count()).toBe(0);
      expect(await invitations.getByRole('listitem').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

// =================================================================================================
// Fixtures the last-admin block needs, kept at the bottom because nothing else uses them.

/** Sign in over HTTP, for a direct request made alongside a browser one. */
async function signInFor(account: TestAccount): Promise<{ cookie: string }> {
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) {
    throw new Error(`sign-in for ${account.email} returned ${result.status} and no cookie`);
  }
  return { cookie: result.cookie };
}

async function isActive(id: string): Promise<boolean> {
  const rows = await sql<{ deactivated_at: Date | null }[]>`
    select deactivated_at from "user" where id = ${id}
  `;
  return rows[0]?.deactivated_at === null;
}

/**
 * Take the database down to exactly the admins a test wants, and put it back afterwards.
 *
 * The last-admin invariant is about *how many active admins exist*, so a test that leaned on the
 * fixture admin would be asserting against whatever else the run had done that second.
 */
async function withOnlyTheseAdmins<T>(keep: readonly string[], body: () => Promise<T>): Promise<T> {
  const rows = await sql<{ id: string }[]>`
    select id from "user" where role = 'admin' and deactivated_at is null
  `;
  const ids = rows.map((row) => row.id).filter((id) => !keep.includes(id));

  for (const id of ids) {
    await sql`update "user" set deactivated_at = now() where id = ${id}`;
  }
  try {
    return await body();
  } finally {
    for (const id of ids) {
      await sql`update "user" set deactivated_at = null where id = ${id}`;
    }
  }
}
