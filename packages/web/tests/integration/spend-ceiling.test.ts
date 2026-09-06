import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  MAX_SPEND_CEILING_RAISE_USD,
  PIPELINE_PATH,
  PIPELINE_STEPS,
  ROLE,
  SPEND_CEILING_PATH,
  isApiErrorBody,
  isSpendCeilingReached,
  recordingRerunPath,
  type PipelineListPayload,
  type SpendPayload,
} from '@thp/shared';
import { enqueueJob, insertRecording } from '@thp/db';
import { closeTestDatabase, signedInAccount, testDatabase } from '../support/accounts';

/**
 * The daily spend ceiling, from the API's side (docs/project/prd.md, 3.19.16 and 3.21.2.8).
 *
 * **Against the rate-limited server**, whose ceiling is one cent (tests/setup/global.ts): the
 * ledger is the shared database, so one two-cent job written here reaches that server's ceiling
 * while the primary, at the shipped two dollars, never notices. What is pinned: the number is on
 * the pipeline payload; a re-run of a paid step is refused at the press with the same numbers and
 * a free step is not; the raise is floored, capped, admin-only, and takes effect on the very next
 * press; and the raise is shown against whoever made it.
 *
 * The worker's own refusal — the one that protects the bill — is
 * `packages/worker/tests/integration/spend-ceiling.test.ts`.
 */

const baseUrl = inject('rateLimitedBaseUrl');
const databaseUrl = inject('databaseUrl');
const ceilingUsd = inject('rateLimitedSpendCeilingUsd');

let sql: postgres.Sql;
let admin: { cookie: string; account: { id: string; displayName: string } };
let member: { cookie: string };

interface Answer<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly code: string | null;
  readonly message: string | null;
}

async function call<T = unknown>(
  path: string,
  cookie: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', cookie },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    body: parsed as T,
    code: isApiErrorBody(parsed) ? parsed.error.code : null,
    message: isApiErrorBody(parsed) ? parsed.error.message : null,
  };
}

/** A recording whose transcription succeeded today at the given cost — what the worker leaves. */
async function recordingThatCost(costUsd: number): Promise<string> {
  const handle = testDatabase(databaseUrl);
  const recording = await insertRecording(
    {
      originalMediaKey: `originals/spend-ceiling-${Date.now().toString(36)}.mp3`,
      title: 'A costly teaching',
      recordedAt: '2026-06-07',
    },
    handle,
  );
  const job = await enqueueJob(
    { recordingId: recording.id, step: 'transcribe', correlationId: `spend-${recording.id}` },
    handle,
  );
  await sql`
    update job set status = 'succeeded', started_at = now(), finished_at = now(),
      provider_meta = ${sql.json({ provider: 'deepgram', costUsd })}
    where id = ${job.id}
  `;
  return recording.id;
}

beforeAll(async () => {
  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  admin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'ceiling-admin');
  member = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'ceiling-member');
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

describe('the spend ceiling on the pipeline view', () => {
  it('is on the pipeline payload, at the configured default, with the day ending in the future', async () => {
    const answer = await call<PipelineListPayload>(PIPELINE_PATH, admin.cookie);
    expect(answer.status).toBe(200);

    const { spend } = answer.body;
    expect(spend.defaultUsd).toBe(ceilingUsd);
    expect(spend.ceilingUsd).toBeGreaterThanOrEqual(ceilingUsd);
    expect(typeof spend.todayUsd).toBe('number');
    // Every step is present, the free one at zero — the split is keyed by the step list itself.
    expect(Object.keys(spend.byStep).sort()).toEqual([...PIPELINE_STEPS].sort());
    expect(spend.byStep.process_audio).toBe(0);
    expect(new Date(spend.dayEndsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a re-run of a paid step at the press once the ceiling is reached, and not a free one', async () => {
    const recordingId = await recordingThatCost(0.02);

    const listed = await call<PipelineListPayload>(PIPELINE_PATH, admin.cookie);
    expect(listed.body.spend.todayUsd).toBeGreaterThanOrEqual(0.02);
    expect(isSpendCeilingReached(listed.body.spend)).toBe(true);

    const paid = await call(recordingRerunPath(recordingId), admin.cookie, {
      method: 'POST',
      body: { step: 'transcribe' },
    });
    expect(paid.status).toBe(409);
    expect(paid.code).toBe('spend_ceiling_reached');
    expect(paid.message).toContain('$0.01');
    expect(paid.message).toContain('Raise the ceiling');

    const free = await call(recordingRerunPath(recordingId), admin.cookie, {
      method: 'POST',
      body: { step: 'process_audio' },
    });
    expect(free.status).toBe(200);
  });

  it('refuses a member who tries to raise it', async () => {
    const answer = await call(SPEND_CEILING_PATH, member.cookie, {
      method: 'PUT',
      body: { ceilingUsd: 5 },
    });
    expect(answer.status).toBe(403);
    expect(answer.code).toBe('forbidden');
  });

  it.each([
    ['nothing', null],
    ['a word', { ceilingUsd: 'five' }],
    ['below the floor', { ceilingUsd: 0.001 }],
    ['above the cap', { ceilingUsd: MAX_SPEND_CEILING_RAISE_USD + 1 }],
    ['a reason that is a memo', { ceilingUsd: 1, reason: 'x'.repeat(201) }],
  ])('refuses a raise that is %s, without writing one', async (_label, body) => {
    const before = await call<PipelineListPayload>(PIPELINE_PATH, admin.cookie);
    const answer = await call(SPEND_CEILING_PATH, admin.cookie, { method: 'PUT', body });
    expect(answer.status).toBe(400);
    expect(answer.code).toBe('invalid_input');
    const after = await call<PipelineListPayload>(PIPELINE_PATH, admin.cookie);
    expect(after.body.spend.ceilingUsd).toBe(before.body.spend.ceilingUsd);
  });

  it('raises today’s ceiling, names who raised it, and lets the very next press through', async () => {
    const recordingId = await recordingThatCost(0.02);
    expect(
      (await call(recordingRerunPath(recordingId), admin.cookie, { method: 'POST', body: { step: 'transcribe' } }))
        .status,
    ).toBe(409);

    const raised = await call<SpendPayload>(SPEND_CEILING_PATH, admin.cookie, {
      method: 'PUT',
      body: { ceilingUsd: 0.5, reason: 'Backfilling June' },
    });
    expect(raised.status).toBe(200);
    expect(raised.body.spend.ceilingUsd).toBe(0.5);
    expect(raised.body.spend.defaultUsd).toBe(ceilingUsd);
    expect(raised.body.spend.raise).toMatchObject({
      ceilingUsd: 0.5,
      raisedBy: admin.account.id,
      raisedByName: admin.account.displayName,
      reason: 'Backfilling June',
    });
    expect(isSpendCeilingReached(raised.body.spend)).toBe(false);

    const allowed = await call(recordingRerunPath(recordingId), admin.cookie, {
      method: 'POST',
      body: { step: 'transcribe' },
    });
    expect(allowed.status).toBe(200);

    // The list carries the same raise, for the next admin who looks.
    const listed = await call<PipelineListPayload>(PIPELINE_PATH, admin.cookie);
    expect(listed.body.spend.raise?.raisedByName).toBe(admin.account.displayName);
  });

  it('only ever raises: a lower number keeps the higher ceiling', async () => {
    const lower = await call<SpendPayload>(SPEND_CEILING_PATH, admin.cookie, {
      method: 'PUT',
      body: { ceilingUsd: 0.2 },
    });
    expect(lower.status).toBe(200);
    expect(lower.body.spend.ceilingUsd).toBe(0.5);
  });
});
