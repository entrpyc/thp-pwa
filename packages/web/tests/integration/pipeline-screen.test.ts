import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import postgres from 'postgres';
import {
  ADMIN_PAGE_PATH,
  ADMIN_PIPELINE_PAGE_PATH,
  API_PREFIX,
  PIPELINE_POLL_INTERVAL_MS,
  PIPELINE_PATH,
  ROLE,
  type PipelineStep,
} from '@thp/shared';
import {
  completeJob,
  createDatabase,
  enqueueJob,
  failJob,
  insertRecording,
  type DatabaseHandle,
} from '@thp/db';
import { STUB_PROVIDER_META } from '../../../worker/src/handlers';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';

/**
 * The pipeline panel, driven in a real browser against the same production build the API suite
 * uses, over the same real ledger.
 *
 * The assertions divide in four:
 *
 * 1. **That it is a panel of the console**, reachable from the panel list and refused to a member —
 *    the same two properties every admin screen has to hold.
 * 2. **What a row says.** One cell per step, the status in it, the reason when there is one, and
 *    *not built yet* where a stub succeeded.
 * 3. **That it asks again while work is in flight, and stops when it is not.** Asserted by counting
 *    requests to the API rather than by reading the screen, because "it stopped" is a statement
 *    about requests and nothing on screen can show it.
 * 4. **That pressing re-run changes the row without a page reload.**
 *
 * Rows are seeded through `@thp/db` rather than through the upload flow: what is under test is the
 * screen over the ledger, and driving three provider outcomes through a real upload each time
 * would be testing Ticket 01 again. Everything is scoped to the recordings this file creates —
 * the suite shares one database, so asserting a total would be asserting what the rest of the run
 * happened to do that second.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const PANEL_URL = `${baseUrl}${ADMIN_PIPELINE_PAGE_PATH}`;
const CONSOLE_URL = `${baseUrl}${ADMIN_PAGE_PATH}`;
const PIPELINE_API_PATH = `${API_PREFIX}${PIPELINE_PATH}`;

/** Phone, tablet, desktop — the responsive standing constraint of the implementation plan. */
const VIEWPORTS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

const DESKTOP = { width: 1280, height: 900 };

let browser: Browser;
let admin: TestAccount;
let member: TestAccount;
let sql: postgres.Sql;
let handle: DatabaseHandle;
let seeded = 0;

function unique(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** A recording row with no jobs behind it. */
async function newRecording(title: string): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/panel-${seeded}-${Date.now().toString(36)}.mp3`,
      title,
      recordedAt: '2026-07-05',
    },
    handle,
  );
  return row.id;
}

/** Put a step of a recording into one of the four statuses the ledger holds. */
async function seedStep(
  recordingId: string,
  step: PipelineStep,
  status: 'pending' | 'running' | 'succeeded' | 'failed',
  options: { reason?: string; stub?: boolean } = {},
): Promise<string> {
  const job = await enqueueJob(
    { recordingId, step, correlationId: `panel-${seeded}-${step}` },
    handle,
  );
  if (status === 'running') {
    await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
  }
  if (status === 'succeeded') {
    await completeJob(job.id, options.stub === true ? STUB_PROVIDER_META : { model: 'fake' }, handle);
  }
  if (status === 'failed') {
    await failJob(job.id, options.reason ?? 'it failed', handle);
  }
  return job.id;
}

beforeAll(async () => {
  browser = await chromium.launch();
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });
  handle = createDatabase({ url: databaseUrl, max: 6 });

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'panel-pipe-admin');
  admin = signedInAdmin.account;

  const signedInMember = await signedInAccount(
    baseUrl,
    databaseUrl,
    ROLE.member,
    'panel-pipe-member',
  );
  member = signedInMember.account;
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await handle?.close();
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

/** Signed in, on the panel, with the list loaded. */
async function openPanel(
  viewport: { width: number; height: number } = DESKTOP,
): Promise<Page> {
  const page = await signInAs(admin, viewport);
  await page.goto(PANEL_URL, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('region', { name: 'Pipeline' }).count(), { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(() => page.getByText('Loading pipeline…').count(), { timeout: 30_000 })
    .toBe(0);
  return page;
}

/** The one row for this recording, by the title nothing else in the run shares. */
function rowFor(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

/** Wait until the row for this title says `text`, letting the poll do the waiting. */
async function waitForRow(page: Page, title: string, text: string, timeout = 30_000): Promise<void> {
  await expect
    .poll(async () => ((await rowFor(page, title).textContent()) ?? '').includes(text), { timeout })
    .toBe(true);
}

/** Count requests to the pipeline read while `work` runs. */
async function pipelineRequests(page: Page, work: () => Promise<void>): Promise<number> {
  let seen = 0;
  const listener = (request: { url(): string }) => {
    if (request.url().includes(PIPELINE_API_PATH)) seen += 1;
  };
  page.on('request', listener);
  try {
    await work();
  } finally {
    page.off('request', listener);
  }
  return seen;
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(() => done(), ms));

// =================================================================================================

describe('the panel and its gate', () => {
  it('is a third entry in the console shell, reachable from it', async () => {
    const page = await signInAs(admin);
    try {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: 'Admin console' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);

      const link = page.getByRole('link', { name: 'Pipeline' });
      expect(await link.count()).toBe(1);
      await link.click();
      await page.waitForURL(PANEL_URL, { timeout: 30_000 });

      // The same shell, and the navigation now marks this panel as the current one.
      expect(await page.getByRole('heading', { level: 1, name: 'Admin console' }).count()).toBe(1);
      expect(await page.getByRole('navigation', { name: 'Console panels' }).count()).toBe(1);
      expect(await link.getAttribute('aria-current')).toBe('page');
      expect(await page.getByRole('region', { name: 'Pipeline' }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 90_000);

  it('never shows a member the panel, and never sends them its markup', async () => {
    const page = await signInAs(member);
    try {
      await page.goto(PANEL_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(`${baseUrl}/`, { timeout: 30_000 });
      expect(await page.getByRole('region', { name: 'Pipeline' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 90_000);
});

describe('what a row says', () => {
  it('shows one cell per step, carrying that step’s status', async () => {
    const waiting = unique('Waiting to transcribe');
    const waitingId = await newRecording(waiting);
    await seedStep(waitingId, 'transcribe', 'pending');

    const running = unique('Transcribing now');
    const runningId = await newRecording(running);
    await seedStep(runningId, 'transcribe', 'running');

    const done = unique('Fully transcribed');
    const doneId = await newRecording(done);
    await seedStep(doneId, 'transcribe', 'succeeded');

    const untouched = unique('Nothing has run');
    await newRecording(untouched);

    const page = await openPanel();
    try {
      // Both steps in every row, named — and the step nothing has enqueued says so rather than
      // being absent, which is what makes a stalled recording readable.
      const waitingRow = (await rowFor(page, waiting).textContent()) ?? '';
      expect(waitingRow).toContain('Transcribe');
      expect(waitingRow).toContain('Generate draft');
      expect(waitingRow).toContain('Waiting');
      expect(waitingRow).toContain('Not started');
      expect(waitingRow).toContain('attempt 1');

      expect((await rowFor(page, running).textContent()) ?? '').toContain('Running');
      expect((await rowFor(page, done).textContent()) ?? '').toContain('Succeeded');

      // A recording with no jobs at all is still on the screen, with both steps not started.
      const untouchedRow = (await rowFor(page, untouched).textContent()) ?? '';
      expect(untouchedRow).toContain('Not started');
      expect(untouchedRow).not.toContain('attempt');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('shows the reason a step failed, in the row', async () => {
    const title = unique('A refused teaching');
    const recordingId = await newRecording(title);
    const reason = `Deepgram refused the audio with HTTP 415: unsupported media type ${Date.now()}`;
    await seedStep(recordingId, 'transcribe', 'failed', { reason });

    const page = await openPanel();
    try {
      const row = (await rowFor(page, title).textContent()) ?? '';
      expect(row).toContain('Failed');
      // The whole reason the panel exists: why, in the same place as that it failed.
      expect(row).toContain(reason);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('reads a succeeded stub as not built yet, and a real success as succeeded', async () => {
    const stubbed = unique('Draft is a stub');
    const stubbedId = await newRecording(stubbed);
    await seedStep(stubbedId, 'transcribe', 'succeeded');
    await seedStep(stubbedId, 'generate_draft', 'succeeded', { stub: true });

    const real = unique('Draft did real work');
    const realId = await newRecording(real);
    await seedStep(realId, 'transcribe', 'succeeded');
    await seedStep(realId, 'generate_draft', 'succeeded');

    const page = await openPanel();
    try {
      const stubbedRow = (await rowFor(page, stubbed).textContent()) ?? '';
      // Both rows are `succeeded` in the ledger. The marker is what makes them different on
      // screen, which is the whole reason the stub leaves one.
      expect(stubbedRow).toContain('Not built yet');
      expect(stubbedRow).toContain('Nothing was generated');

      const realRow = (await rowFor(page, real).textContent()) ?? '';
      expect(realRow).not.toContain('Not built yet');
      expect(realRow).toContain('Succeeded');
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('asking again', () => {
  it('re-reads while work is in flight and stops once nothing is', async () => {
    // **The panel shows every recording, and the suite shares one database** — so "nothing on
    // screen is in flight" genuinely means nothing in the ledger is. Everything the run has left
    // waiting is settled first, which is also what makes the causality exact in the other
    // direction: the only work on screen for the rest of this test is the job seeded below.
    await sql`
      update job set status = 'succeeded', finished_at = now()
      where status in ('pending', 'running')
    `;

    const title = unique('Something still running');
    const recordingId = await newRecording(title);
    const jobId = await seedStep(recordingId, 'transcribe', 'running');

    const page = await openPanel();
    try {
      await waitForRow(page, title, 'Running');

      // Two intervals and a margin. A console watching a running job asks again on its own.
      const whileRunning = await pipelineRequests(page, () =>
        wait(PIPELINE_POLL_INTERVAL_MS * 2 + 1_000),
      );
      expect(whileRunning).toBeGreaterThanOrEqual(2);

      // The job reaches a terminal status behind the screen's back, and the next poll sees it.
      await completeJob(jobId, { model: 'fake' }, handle);
      await waitForRow(page, title, 'Succeeded');

      // And then it stops. A console left open on a finished pipeline should not query forever —
      // the poll is a consequence of there being work, not of the screen being open.
      const afterwards = await pipelineRequests(page, () =>
        wait(PIPELINE_POLL_INTERVAL_MS * 2 + 1_000),
      );
      expect(afterwards).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);
});

describe('running a step again from the screen', () => {
  it('changes the step’s status and its attempt without a page reload', async () => {
    const title = unique('Re-run from the panel');
    const recordingId = await newRecording(title);
    const reason = `the provider refused the audio ${Date.now()}`;
    await seedStep(recordingId, 'transcribe', 'failed', { reason });

    const page = await openPanel();
    try {
      // A mark that survives only if the document is never replaced.
      await page.evaluate(() => {
        (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
      });

      const row = rowFor(page, title);
      const before = (await row.textContent()) ?? '';
      expect(before).toContain('Failed');
      expect(before).toContain(reason);
      expect(before).toContain('attempt 1');

      // The first cell is `transcribe`, because the cells come off the ordered step list.
      await row.getByRole('button', { name: 'Run again' }).first().click();

      // **One press is not enough for this step.** Re-running `transcribe` sends the audio to the
      // provider again and replaces the transcript, so it takes a confirming press that names the
      // recording — the same line the account panel draws around ending somebody's access.
      await expect
        .poll(async () => ((await row.textContent()) ?? '').includes(`Transcribe “${title}” again?`), {
          timeout: 30_000,
        })
        .toBe(true);
      expect((await row.textContent()) ?? '').toContain('the transcript it has now is replaced');
      // Nothing has been queued by the asking.
      expect(
        await sql<{ count: string }[]>`
          select count(*)::text as count from job where recording_id = ${recordingId}
        `,
      ).toEqual([{ count: '1' }]);

      await row.getByRole('button', { name: 'Yes, transcribe again' }).click();

      await waitForRow(page, title, 'attempt 2');
      const after = (await row.textContent()) ?? '';
      expect(after).toContain('Waiting');
      // The new attempt carries no reason: the failure is still in the ledger, and the screen
      // shows the latest attempt and nothing older.
      expect(after).not.toContain(reason);

      const stillSame = await page.evaluate(
        () => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true,
      );
      expect(stillSame).toBe(true);

      // And it is a real row, not a rendering.
      const rows = await sql<{ status: string; attempt: number }[]>`
        select status::text as status, attempt from job
        where recording_id = ${recordingId} and step = 'transcribe' order by attempt
      `;
      expect(rows.map((one) => [one.status, one.attempt])).toEqual([
        ['failed', 1],
        ['pending', 2],
      ]);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('queues nothing when the confirming press is cancelled', async () => {
    const title = unique('Thought better of it');
    const recordingId = await newRecording(title);
    await seedStep(recordingId, 'transcribe', 'failed', { reason: 'the provider refused' });

    const page = await openPanel();
    try {
      const row = rowFor(page, title);
      await row.getByRole('button', { name: 'Run again' }).first().click();
      await row.getByRole('button', { name: 'Cancel' }).click();

      await expect
        .poll(async () => row.getByRole('button', { name: 'Yes, transcribe again' }).count(), {
          timeout: 30_000,
        })
        .toBe(0);

      // A stray tap costs the tap and nothing else — no second attempt, no spend at the provider.
      const rows = await sql<{ count: string }[]>`
        select count(*)::text as count from job where recording_id = ${recordingId}
      `;
      expect(rows).toEqual([{ count: '1' }]);
      expect((await row.textContent()) ?? '').toContain('attempt 1');
    } finally {
      await page.context().close();
    }
  }, 150_000);

  it('runs generate_draft on one press, because it destroys nothing', async () => {
    const title = unique('Generate on one press');
    const recordingId = await newRecording(title);
    await seedStep(recordingId, 'transcribe', 'failed', { reason: 'below the confidence threshold' });

    const page = await openPanel();
    try {
      const row = rowFor(page, title);
      // The second cell is `generate_draft`. No confirmation: it costs nothing and replaces
      // nothing, so a second press there would be friction with no guardrail behind it. This is
      // also 3.5.8's escape hatch being one tap — the admin read the transcript and judged it usable.
      await row.getByRole('button', { name: 'Run again' }).nth(1).click();

      await waitForRow(page, title, 'Waiting');
      const rows = await sql<{ step: string; status: string }[]>`
        select step::text as step, status::text as status from job
        where recording_id = ${recordingId} order by enqueued_at, id
      `;
      expect(rows.map((one) => [one.step, one.status])).toEqual([
        ['transcribe', 'failed'],
        ['generate_draft', 'pending'],
      ]);
    } finally {
      await page.context().close();
    }
  }, 150_000);
});

describe('at every width', () => {
  for (const viewport of VIEWPORTS) {
    it(`fits and stays usable at ${viewport.label}`, async () => {
      const title = unique(`Readable at ${viewport.label}`);
      const recordingId = await newRecording(title);
      await seedStep(recordingId, 'transcribe', 'failed', {
        reason: 'a reason long enough that it has to wrap rather than push the page sideways',
      });

      const page = await openPanel({ width: viewport.width, height: viewport.height });
      try {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        );
        expect(overflow, `${viewport.label} overflows horizontally`).toBe(false);

        // The row is readable and its control is reachable — visible, enabled, inside the viewport.
        const row = rowFor(page, title);
        await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);

        const button = row.getByRole('button', { name: 'Run again' }).first();
        await button.scrollIntoViewIfNeeded();
        expect(await button.isEnabled()).toBe(true);
        const box = await button.boundingBox();
        expect(box, `${viewport.label} has no re-run control`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      } finally {
        await page.context().close();
      }
    }, 150_000);
  }
});
