import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  ADMIN_REPORTS_PAGE_PATH,
  DASHBOARD_PAGE_PATH,
  PROFILE_PAGE_PATH,
  ROLE,
  TERMS_PAGE_PATH,
  TERMS_VERSION,
  recordingPagePath,
} from '@thp/shared';
import {
  createDatabase,
  findMemberBlock,
  findUserById,
  insertNote,
  insertRecording,
  listOpenNoteReports,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The moderation controls, driven in a real browser** (Apple guideline 1.2, Google Play's UGC
 * policy). The API's half is `note-reports.test.ts`; this file asks what a fetch cannot:
 *
 * - whether **Report** and **Block** are in the note actions menu on somebody else's public note,
 *   and absent on your own;
 * - whether reporting takes a reason, says thank you, offers Block, and writes the row;
 * - whether blocking names the consequence, needs a confirming press, and makes the member's note
 *   leave the list without a reload;
 * - whether the **Blocked members** card on `/profile/settings` lists them and Unblock brings the
 *   note back;
 * - whether a member with no acceptance meets the **terms prompt** on Save, with their text still
 *   in the box, and whether accepting saves the note in the same breath;
 * - whether an admin's **Reports** panel shows the report with the note, the reporter and a link to
 *   the recording, and Dismiss clears it.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let browser: Browser;
let handle: DatabaseHandle;
let member: TestAccount;
let neighbour: TestAccount;
let newcomer: TestAccount;
let admin: TestAccount;

async function publishedRecording(title: string): Promise<string> {
  const { key } = await uploadTestAudio(settings, 20);
  const row = await insertRecording(
    { originalMediaKey: key, title, recordedAt: '2026-10-01' },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function signInAs(who: TestAccount): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return page;
}

async function openTeaching(who: TestAccount, recordingId: string): Promise<Page> {
  const page = await signInAs(who);
  await page.goto(`${baseUrl}${recordingPagePath(recordingId)}`, { waitUntil: 'domcontentloaded' });
  const tab = page.getByRole('tab', { name: 'Notes' });
  await expect.poll(() => tab.count(), { timeout: 60_000 }).toBe(1);
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect
    .poll(() => page.getByRole('form', { name: 'Write a note' }).count(), { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(() => page.getByText('Loading the notes…', { exact: true }).count(), { timeout: 30_000 })
    .toBe(0);
  return page;
}

function card(page: Page, noteId: string) {
  return page.locator(`#note-${noteId}`);
}

async function plant(recordingId: string, who: TestAccount, text: string, timestampMs: number): Promise<string> {
  const row = await insertNote(
    { recordingId, authorId: who.id, visibility: 'public', text, timestampMs },
    handle,
  );
  return row.id;
}

beforeAll(async () => {
  browser = await chromium.launch();
  handle = createDatabase({ url: databaseUrl, max: 6 });
  member = await createAccount(databaseUrl, ROLE.member, `ugc-member-${RUN}`);
  neighbour = await createAccount(databaseUrl, ROLE.member, `ugc-neighbour-${RUN}`);
  newcomer = await createAccount(databaseUrl, ROLE.member, `ugc-newcomer-${RUN}`, undefined, {
    termsAccepted: false,
  });
  admin = await createAccount(databaseUrl, ROLE.admin, `ugc-admin-${RUN}`);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('Report and Block in the note actions menu', () => {
  it('offers both on somebody else’s public note and neither on your own', async () => {
    const where = await publishedRecording(`UGC menu ${RUN}`);
    const theirs = await plant(where, neighbour, 'Somebody else wrote this.', 10_000);
    const mine = await plant(where, member, 'I wrote this.', 20_000);

    const page = await openTeaching(member, where);
    try {
      await card(page, theirs).getByRole('button', { name: 'Note actions' }).click();
      const menu = card(page, theirs).getByRole('group', { name: 'Note actions' });
      expect(await menu.getByRole('button', { name: 'Report' }).count()).toBe(1);
      expect(await menu.getByRole('button', { name: 'Block' }).count()).toBe(1);
      // A member moderates nothing: the admin entries are not drawn beside them.
      expect(await menu.getByRole('button', { name: 'Delete' }).count()).toBe(0);

      await card(page, mine).getByRole('button', { name: 'Note actions' }).click();
      const own = card(page, mine).getByRole('group', { name: 'Note actions' });
      expect(await own.getByRole('button', { name: 'Report' }).count()).toBe(0);
      expect(await own.getByRole('button', { name: 'Block' }).count()).toBe(0);
      expect(await own.getByRole('button', { name: 'Edit' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('reports with a reason, says thank you, offers Block, and writes the row', async () => {
    const where = await publishedRecording(`UGC report ${RUN}`);
    const theirs = await plant(where, neighbour, `Reportable ${RUN}`, 10_000);

    const page = await openTeaching(member, where);
    try {
      await card(page, theirs).getByRole('button', { name: 'Note actions' }).click();
      await card(page, theirs).getByRole('button', { name: 'Report' }).click();

      const form = card(page, theirs).getByRole('form', { name: 'Report this note' });
      await expect.poll(() => form.count()).toBe(1);
      // Nothing is sent until a reason is chosen.
      expect(await form.getByRole('button', { name: 'Send report' }).isDisabled()).toBe(true);
      await form.getByRole('radio', { name: 'Spam or advertising' }).check();
      await form.getByLabel(/Anything an admin should know/).fill('Looks like an advert.');
      await form.getByRole('button', { name: 'Send report' }).click();

      const thanks = card(page, theirs).getByRole('group', { name: 'Report sent' });
      await expect.poll(() => thanks.count(), { timeout: 30_000 }).toBe(1);
      expect(await thanks.innerText()).toContain('An admin will review this note');
      expect(await thanks.getByRole('button', { name: `Block ${neighbour.displayName}` }).count()).toBe(1);

      // The note is still on screen: a report hides nothing by itself.
      await thanks.getByRole('button', { name: 'Done' }).click();
      expect(await card(page, theirs).innerText()).toContain(`Reportable ${RUN}`);

      const open = (await listOpenNoteReports(handle)).filter((one) => one.noteId === theirs);
      expect(open).toHaveLength(1);
      expect(open[0]?.reason).toBe('spam');
      expect(open[0]?.detail).toBe('Looks like an advert.');
      expect(open[0]?.reporterId).toBe(member.id);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('blocks after a confirmation that names the consequence, and the note leaves the list at once', async () => {
    const where = await publishedRecording(`UGC block ${RUN}`);
    const theirs = await plant(where, neighbour, `Blockable ${RUN}`, 10_000);
    const mine = await plant(where, member, `Mine stays ${RUN}`, 20_000);

    const page = await openTeaching(member, where);
    try {
      await card(page, theirs).getByRole('button', { name: 'Note actions' }).click();
      await card(page, theirs).getByRole('button', { name: 'Block' }).click();

      const confirm = card(page, theirs).getByRole('group', { name: 'Confirm block' });
      await expect.poll(() => confirm.count()).toBe(1);
      const text = await confirm.innerText();
      expect(text).toContain(`Block ${neighbour.displayName}?`);
      expect(text).toContain("no longer see each other's notes");
      expect(text).toContain('unblock from Profile');

      // Cancel changes nothing.
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      expect(await findMemberBlock(member.id, neighbour.id, handle)).toBeNull();
      expect(await card(page, theirs).count()).toBe(1);

      await card(page, theirs).getByRole('button', { name: 'Note actions' }).click();
      await card(page, theirs).getByRole('button', { name: 'Block' }).click();
      await card(page, theirs)
        .getByRole('group', { name: 'Confirm block' })
        .getByRole('button', { name: 'Block', exact: true })
        .click();

      // The block is written, and the list refreshed without a reload: their note is gone, mine stays.
      await expect.poll(() => card(page, theirs).count(), { timeout: 30_000 }).toBe(0);
      expect(await card(page, mine).count()).toBe(1);
      expect(await findMemberBlock(member.id, neighbour.id, handle)).not.toBeNull();
      expect(new URL(page.url()).pathname).toBe(recordingPagePath(where));
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// =================================================================================================

describe('the Blocked members card on the settings page', () => {
  it('lists who is blocked and Unblock brings their notes back', async () => {
    // The block the previous test placed is still standing; if it ran alone, place one.
    if ((await findMemberBlock(member.id, neighbour.id, handle)) === null) {
      const { insertMemberBlock } = await import('@thp/db');
      await insertMemberBlock(member.id, neighbour.id, handle);
    }
    const where = await publishedRecording(`UGC unblock ${RUN}`);
    const theirs = await plant(where, neighbour, `Hidden until unblocked ${RUN}`, 10_000);

    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${PROFILE_PAGE_PATH}/settings`, { waitUntil: 'domcontentloaded' });
      const section = page.getByRole('region', { name: 'Blocked members' });
      await expect.poll(() => section.count(), { timeout: 30_000 }).toBe(1);
      expect(await section.innerText()).toContain("do not see each other's notes");

      const list = section.getByRole('list', { name: 'Blocked members' });
      await expect.poll(() => list.getByRole('listitem').count(), { timeout: 30_000 }).toBe(1);
      expect(await list.innerText()).toContain(neighbour.displayName);
      expect(await list.innerText()).toContain('Blocked since');

      await section.getByRole('button', { name: `Unblock ${neighbour.displayName}` }).click();
      await expect
        .poll(() => section.getByRole('status').last().textContent(), { timeout: 30_000 })
        .toContain('is unblocked');
      expect(await list.count()).toBe(0);
      expect(await findMemberBlock(member.id, neighbour.id, handle)).toBeNull();

      // Nothing was deleted while the block stood: the note is back in the next read.
      await page.goto(`${baseUrl}${recordingPagePath(where)}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => card(page, theirs).count(), { timeout: 60_000 }).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// =================================================================================================

describe('the terms prompt', () => {
  it('meets a member with no acceptance on Save, keeps the text, and saves once the terms are accepted', async () => {
    const where = await publishedRecording(`UGC terms ${RUN}`);
    expect((await findUserById(newcomer.id, handle))?.termsAcceptedVersion).toBeNull();

    const page = await openTeaching(newcomer, where);
    try {
      const composer = page.getByRole('form', { name: 'Write a note' });
      await composer.getByLabel('Your note').fill(`First words ${RUN}`);
      await composer.getByRole('button', { name: 'Public' }).click();
      await composer.getByRole('button', { name: 'Save note' }).click();

      const prompt = composer.getByRole('group', { name: 'Accept the terms of use' });
      await expect.poll(() => prompt.count(), { timeout: 30_000 }).toBe(1);
      expect(await prompt.innerText()).toContain('read and accept the terms of use');
      // The page's own rules, and the link to the whole page.
      expect(await prompt.getByRole('list', { name: 'Posting rules' }).getByRole('listitem').count()).toBeGreaterThan(3);
      expect(await prompt.getByRole('link', { name: 'terms of use' }).getAttribute('href')).toBe(TERMS_PAGE_PATH);
      // The text is still in the box: nothing was lost to the refusal.
      expect(await composer.getByLabel('Your note').inputValue()).toBe(`First words ${RUN}`);
      // Nothing was written yet.
      expect(await page.getByRole('list', { name: 'Notes' }).getByRole('listitem').count()).toBe(0);

      // "Not now" closes the prompt and keeps the text.
      await prompt.getByRole('button', { name: 'Not now' }).click();
      await expect.poll(() => prompt.count()).toBe(0);
      expect(await composer.getByLabel('Your note').inputValue()).toBe(`First words ${RUN}`);

      await composer.getByRole('button', { name: 'Save note' }).click();
      await expect.poll(() => prompt.count(), { timeout: 30_000 }).toBe(1);
      await prompt.getByRole('button', { name: 'I accept the terms' }).click();

      // Accepting recorded the version and saved the note in the same breath.
      await expect
        .poll(() => page.getByRole('list', { name: 'Notes' }).innerText().catch(() => ''), { timeout: 30_000 })
        .toContain(`First words ${RUN}`);
      expect(await composer.getByLabel('Your note').inputValue()).toBe('');
      const row = await findUserById(newcomer.id, handle);
      expect(row?.termsAcceptedVersion).toBe(TERMS_VERSION);
      expect(row?.termsAcceptedAt).toBeInstanceOf(Date);

      // And the next note meets no prompt.
      await composer.getByLabel('Your note').fill(`Second words ${RUN}`);
      await composer.getByRole('button', { name: 'Save note' }).click();
      await expect
        .poll(() => page.getByRole('list', { name: 'Notes' }).innerText().catch(() => ''), { timeout: 30_000 })
        .toContain(`Second words ${RUN}`);
      expect(await prompt.count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

// =================================================================================================

describe('the admin Reports panel', () => {
  it('lists a report with the note, who reported it and a link to the recording, and Dismiss clears it', async () => {
    const where = await publishedRecording(`UGC admin ${RUN}`);
    const theirs = await plant(where, neighbour, `Flagged for the console ${RUN}`, 10_000);
    const { insertNoteReport } = await import('@thp/db');
    await insertNoteReport(
      { noteId: theirs, reporterId: member.id, reason: 'harassment', detail: 'For the console.' },
      handle,
    );

    const page = await signInAs(admin);
    try {
      await page.goto(`${baseUrl}${ADMIN_REPORTS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      // The panel is in the console's strip and marked current.
      await expect
        .poll(() => page.getByRole('link', { name: 'Reports' }).getAttribute('aria-current'), { timeout: 30_000 })
        .toBe('page');

      const list = page.getByRole('list', { name: 'Open reports' });
      await expect.poll(() => list.count(), { timeout: 30_000 }).toBe(1);
      const row = list.getByRole('listitem').filter({ hasText: `Flagged for the console ${RUN}` });
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
      const text = await row.innerText();
      expect(text).toContain('Harassment or threats');
      expect(text).toContain(`UGC admin ${RUN}`);
      expect(text).toContain(`Reported by ${member.displayName}`);
      expect(text).toContain(`note by ${neighbour.displayName}`);
      expect(text).toContain('For the console.');
      expect(await row.getByRole('link', { name: 'Open the recording' }).getAttribute('href')).toBe(
        recordingPagePath(where),
      );
      expect(await row.getByRole('button', { name: `Remove the note by ${neighbour.displayName}` }).count()).toBe(1);

      await row.getByRole('button', { name: `Dismiss the report by ${member.displayName}` }).click();
      await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(0);
      await expect
        .poll(() => page.getByRole('status').first().textContent(), { timeout: 30_000 })
        .toContain('dismissed');
      expect((await listOpenNoteReports(handle)).some((one) => one.noteId === theirs)).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});
