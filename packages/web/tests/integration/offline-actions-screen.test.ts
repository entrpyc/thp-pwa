import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  ANNOUNCEMENTS_PATH,
  API_PREFIX,
  DASHBOARD_PAGE_PATH,
  NOTIFICATIONS_PAGE_PATH,
  NOTIFICATIONS_PATH,
  ROLE,
  SOS_NEW_PAGE_PATH,
  SOS_PAGE_PATH,
  FLOW_SESSIONS_PATH,
  FLOW_TRACKER_START_PAGE_PATH,
  HIGHLIGHTS_PAGE_PATH,
  HIGHLIGHTS_PATH,
  MY_NOTES_PAGE_PATH,
  NOTE_FOLDERS_PATH,
  SOS_PATH,
  flowSessionPagePath,
  recordingNotesPath,
  recordingPagePath,
  sosPagePath,
  sosPath,
  type CreateNotePayload,
  type FlowSessionsPayload,
  type HighlightListPayload,
  type NoteFoldersPayload,
  type NotesPayload,
  type NotificationListPayload,
  type SosListPayload,
  type SosSignalPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertGeneratedQuestions,
  insertRecording,
  replaceChapters,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, signIn, signedInAccount, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **Acting with no connection, driven in a real browser** ([3.18.18](docs/project/prd.md)).
 *
 * The pure half is `tests/unit/offline-actions.test.ts` and `offline-replay.test.ts`. What only a
 * browser can answer is whether the pieces meet: that the screens a member acts on are there with
 * the network cut, that a press on them shows its result at once, that a prayer request raised
 * offline opens on a page the server has never rendered — and that when the connection returns,
 * the server ends up holding exactly what was done.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEMPLATE_ID = '00000000-0000-4000-8000-00000000000f';

let browser: Browser;
let member: TestAccount;
let memberCookie: string;
let othersSignalId: string;
let handle: DatabaseHandle;
let teachingId: string;
let teachingTitle: string;
let othersNoteId: string;

async function api<T>(path: string, cookie: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: { accept: 'application/json', 'content-type': 'application/json', cookie },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${response.status}`);
  return (await response.json()) as T;
}

beforeAll(async () => {
  browser = await chromium.launch();
  member = await createAccount(databaseUrl, ROLE.member, `offline-acts-${RUN}`);
  const signed = await signIn(baseUrl, member.email, member.password);
  if (signed.cookie === null) throw new Error('the member could not be signed in');
  memberCookie = signed.cookie;

  // Something to read and act on: a notice in the member's bell, and somebody else's request.
  const admin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, `offline-acts-admin-${RUN}`);
  await api(ANNOUNCEMENTS_PATH, admin.cookie, {
    method: 'POST',
    body: { kind: 'announcement', title: `Offline notice ${RUN}`, body: 'Read me without a connection.' },
  });
  const other = await signedInAccount(baseUrl, databaseUrl, ROLE.member, `offline-acts-other-${RUN}`);
  const raised = await api<SosSignalPayload>(SOS_PATH, other.cookie, {
    method: 'POST',
    body: { urgency: 'yellow', description: `Please pray for the journey ${RUN}`, anonymous: false },
  });
  othersSignalId = raised.signal.id;

  // A teaching that can be downloaded, with two chapters, a question on each, and somebody
  // else's note to reply to. Dated far ahead so it leads the Flow Tracker's list.
  handle = createDatabase({ url: databaseUrl, max: 4 });
  teachingTitle = `Offline teaching ${RUN}`;
  const upload = await uploadTestAudio(settings, 2);
  teachingId = (await insertRecording({ originalMediaKey: upload.key, title: teachingTitle, recordedAt: '2088-04-04' }, handle)).id;
  const chapters = await replaceChapters(
    teachingId,
    [
      { startMs: 0, title: `Opening ${RUN}`, summary: 'How it begins.' },
      { startMs: 1_000, title: `Closing ${RUN}`, summary: 'How it ends.' },
    ],
    { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' },
    handle,
  );
  await insertGeneratedQuestions(
    chapters.map((one) => ({
      scope: 'chapter' as const,
      chapterId: one.id,
      text: `How has ${one.title} shown up this week?`,
      generatedBy: { model: 'fake', modelVersion: 'fake-1', promptVersion: 'reflections-1' },
    })),
    handle,
  );
  await setRecordingPublication(teachingId, new Date(), handle);
  const written = await api<CreateNotePayload>(recordingNotesPath(teachingId), other.cookie, {
    method: 'POST',
    body: { text: `A thought worth answering ${RUN}`, visibility: 'public', timestampMs: 500 },
  });
  othersNoteId = written.note.id;
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await browser?.close();
  await closeTestDatabase();
});

async function signedIn(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return { context, page };
}

/** The paths the worker holds a page for. */
function keptPages(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const cache = await caches.open('thp-pages-v2');
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  });
}

describe('with the network cut', () => {
  it('reads a notice, prays for a request and raises one — and the server holds all three afterwards', async () => {
    const { context, page } = await signedIn();
    try {
      // Before the signal goes: the worker in control, the screens read ahead, their pages kept —
      // including the one copy of the prayer-request page that stands in for any request.
      await page.goto(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 30_000 }).toBe(true);
      await expect
        .poll(async () => {
          const kept = await keptPages(page);
          return [NOTIFICATIONS_PAGE_PATH, SOS_PAGE_PATH, SOS_NEW_PAGE_PATH, sosPagePath(TEMPLATE_ID)].every((path) => kept.includes(path));
        }, { timeout: 60_000 })
        .toBe(true);

      await context.setOffline(true);

      // 1. The notification centre opens from the device, and the notice can be marked read.
      await page.goto(`${baseUrl}${NOTIFICATIONS_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const notices = page.getByRole('list', { name: 'Notifications' });
      await expect.poll(() => notices.getByText(`Offline notice ${RUN}`).count(), { timeout: 30_000 }).toBe(1);
      const markAll = page.getByRole('button', { name: 'Mark all as read' });
      await expect.poll(() => markAll.count(), { timeout: 30_000 }).toBe(1);
      await markAll.click();
      // Nothing left unread: the control that offers it goes.
      await expect.poll(() => markAll.count(), { timeout: 30_000 }).toBe(0);

      // 2. Somebody else's request opens on a page this device never visited, and takes a press.
      await page.goto(`${baseUrl}${sosPagePath(othersSignalId)}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.getByText(`Please pray for the journey ${RUN}`).count(), { timeout: 30_000 }).toBeGreaterThan(0);
      const praying = page.getByRole('button', { name: /I am praying/ });
      await expect.poll(() => praying.count(), { timeout: 30_000 }).toBe(1);
      await praying.click();
      await expect.poll(() => page.getByRole('button', { name: /Praying/, pressed: true }).count(), { timeout: 30_000 }).toBe(1);

      // 3. A request raised offline lands on its own page, under an id the device minted.
      await page.goto(`${baseUrl}${SOS_NEW_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const form = page.getByRole('form', { name: 'Raise a prayer request' });
      await expect.poll(() => form.count(), { timeout: 30_000 }).toBe(1);
      await form.getByRole('textbox').first().fill(`Raised with no signal ${RUN}`);
      await form.getByRole('button', { name: 'Raise' }).click();
      await page.waitForURL(/\/prayer-requests\/[0-9a-f-]{36}$/, { timeout: 30_000 });
      await expect.poll(() => page.getByText(`Raised with no signal ${RUN}`).count(), { timeout: 30_000 }).toBeGreaterThan(0);
      // The server has heard none of it yet.
      // (Asked from the test process, which is not behind the browser's cut network.)
      const before = await api<SosListPayload>(SOS_PATH, memberCookie);
      expect(before.signals.some((one) => one.description === `Raised with no signal ${RUN}`)).toBe(false);

      // Back online: the next load sends the queue, in order, and the server holds all three.
      await context.setOffline(false);
      await page.goto(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(async () => (await api<SosListPayload>(`${SOS_PATH}?status=open`, memberCookie)).signals.filter((one) => one.description === `Raised with no signal ${RUN}`).length, { timeout: 60_000 })
        .toBe(1);
      await expect
        .poll(async () => (await api<SosSignalPayload>(sosPath(othersSignalId), memberCookie)).signal.praying, { timeout: 60_000 })
        .toBe(true);
      await expect
        .poll(async () => (await api<NotificationListPayload>(NOTIFICATIONS_PATH, memberCookie)).unreadCount, { timeout: 60_000 })
        .toBe(0);
    } finally {
      await context.close();
    }
  }, 240_000);

  it('replies to a note, makes a folder, highlights a chapter and answers a Flow Tracker session — all sent afterwards', async () => {
    const { context, page } = await signedIn();
    try {
      // Download the teaching: that is what puts its notes and chapters on the device.
      await page.goto(`${baseUrl}${recordingPagePath(teachingId)}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 30_000 }).toBe(true);
      const control = page.getByLabel('Download', { exact: true });
      await expect.poll(() => control.getByRole('button', { name: 'Download' }).count(), { timeout: 30_000 }).toBe(1);
      await control.getByRole('button', { name: 'Download' }).click();
      await expect.poll(() => control.count(), { timeout: 60_000 }).toBe(0);
      await expect
        .poll(async () => {
          const kept = await keptPages(page);
          return [MY_NOTES_PAGE_PATH, HIGHLIGHTS_PAGE_PATH, FLOW_TRACKER_START_PAGE_PATH, flowSessionPagePath(TEMPLATE_ID), recordingPagePath(teachingId)].every((path) => kept.includes(path));
        }, { timeout: 60_000 })
        .toBe(true);

      await context.setOffline(true);

      // 1. A reply to somebody else's note, on the downloaded teaching.
      await page.goto(`${baseUrl}${recordingPagePath(teachingId)}`, { waitUntil: 'domcontentloaded' });
      const notes = page.getByRole('list', { name: 'Notes' });
      const card = notes.getByRole('listitem').filter({ hasText: `A thought worth answering ${RUN}` }).first();
      await expect.poll(() => card.count(), { timeout: 30_000 }).toBe(1);
      await card.getByRole('button', { name: 'Reply' }).click();
      await card.getByRole('textbox', { name: 'Write a reply' }).fill(`Answered offline ${RUN}`);
      await card.getByRole('button', { name: 'Reply', exact: true }).click();
      await expect.poll(() => page.getByText(`Answered offline ${RUN}`).count(), { timeout: 30_000 }).toBeGreaterThan(0);

      // 2. A chapter highlighted, from the same page.
      await page.getByRole('tab', { name: 'Chapters' }).click();
      const chapters = page.getByRole('region', { name: 'Chapters' });
      const pin = chapters.getByRole('button', { name: /^Highlight /, pressed: false }).first();
      await expect.poll(() => pin.count(), { timeout: 30_000 }).toBe(1);
      await pin.click();
      // At least one: a moment highlighted offline has no transcript line under it yet, so it is
      // matched to chapters within a few seconds of it — and this teaching's two chapters are a
      // second apart, where real ones are minutes.
      await expect.poll(() => chapters.getByRole('button', { name: /^Remove highlight from /, pressed: true }).count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

      // 3. A folder for notes.
      await page.goto(`${baseUrl}${MY_NOTES_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const manage = page.getByRole('button', { name: 'Manage folders' });
      await expect.poll(() => manage.count(), { timeout: 30_000 }).toBe(1);
      await manage.click();
      const dialog = page.getByRole('dialog');
      await dialog.getByPlaceholder('Folder name').fill(`Offline folder ${RUN}`);
      await dialog.getByRole('button', { name: 'Create' }).click();
      await expect.poll(() => dialog.getByRole('list', { name: 'Your folders' }).getByText(`Offline folder ${RUN}`).count(), { timeout: 30_000 }).toBe(1);

      // 4. A Flow Tracker session started and finished, on a page the server never rendered.
      await page.goto(`${baseUrl}${FLOW_TRACKER_START_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      const list = page.getByRole('list', { name: 'Teachings, newest first' });
      await expect.poll(() => list.getByRole('button', { name: new RegExp(teachingTitle) }).count(), { timeout: 30_000 }).toBe(1);
      await list.getByRole('button', { name: new RegExp(teachingTitle) }).click();
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await page.waitForURL(/\/flow-tracker\/sessions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
      const first = page.getByRole('region', { name: /^Question 1$/ });
      await expect.poll(() => first.count(), { timeout: 30_000 }).toBe(1);
      await first.getByRole('radio', { name: '2', exact: true }).click();
      const second = page.getByRole('region', { name: /^Question 2$/ });
      await expect.poll(() => second.count(), { timeout: 30_000 }).toBe(1);
      await second.getByRole('radio', { name: /^5/ }).click();
      // Finished: no third question, and no question left on the screen.
      await expect.poll(() => page.getByRole('region', { name: /^Question \d+$/ }).count(), { timeout: 30_000 }).toBe(0);

      // Back online: the next load sends the queue, and the server holds all four.
      await context.setOffline(false);
      await page.goto(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(async () => {
          const held = await api<NotesPayload>(recordingNotesPath(teachingId), memberCookie);
          return held.notes.find((one) => one.id === othersNoteId)?.replies.map((one) => one.text) ?? [];
        }, { timeout: 60_000 })
        .toEqual([`Answered offline ${RUN}`]);
      await expect
        .poll(async () => (await api<HighlightListPayload>(HIGHLIGHTS_PATH, memberCookie)).highlights.filter((one) => one.recording.id === teachingId).length, { timeout: 60_000 })
        .toBe(1);
      await expect
        .poll(async () => (await api<NoteFoldersPayload>(NOTE_FOLDERS_PATH, memberCookie)).folders.map((one) => one.name), { timeout: 60_000 })
        .toContain(`Offline folder ${RUN}`);
      await expect
        .poll(async () => {
          const sessions = await api<FlowSessionsPayload>(FLOW_SESSIONS_PATH, memberCookie);
          return sessions.completed.map((one) => [one.questionCount, one.answeredCount, one.gapCount]);
        }, { timeout: 60_000 })
        .toEqual([[2, 2, 1]]);
    } finally {
      await context.close();
    }
  }, 300_000);
});
