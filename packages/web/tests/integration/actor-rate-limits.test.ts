import { afterAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  AVATAR_UPLOADS_PATH,
  FEEDBACK_PATH,
  RECORDING_UPLOADS_PATH,
  ROLE,
  SERIES_PATH,
  isApiErrorBody,
  seriesArtworkUploadsPath,
} from '@thp/shared';
import { ACTOR_BUDGETS } from '@/server/api/actor-limits';
import { closeTestDatabase, signedInAccount } from '../support/accounts';

/**
 * The per-account budgets, driven over HTTP (docs/project/prd.md, 3.1.22).
 *
 * **Against the primary server**, because the budgets are constants and the same on every server;
 * what keeps this file from spending anybody else's budget is that every test signs in a fresh
 * account. The shipped numbers are tens per hour, and a grant or a report is cheap, so each test
 * drives the real number rather than a lowered one — the refusal proved here is the one a member
 * would meet.
 *
 * What this file is for is the **placement**: that each guard sits after validation and before
 * the side effect, so a refused body costs nothing and the request past the budget produces
 * nothing. The arithmetic is unit-tested against an injected clock in
 * `tests/unit/actor-limits.test.ts`.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

afterAll(async () => {
  await closeTestDatabase();
});

interface Answer<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly code: string | null;
  readonly message: string | null;
  readonly retryAfter: string | null;
}

async function call<T = unknown>(
  path: string,
  cookie: string,
  body: unknown,
  method = 'POST',
): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    body: parsed as T,
    code: isApiErrorBody(parsed) ? parsed.error.code : null,
    message: isApiErrorBody(parsed) ? parsed.error.message : null,
    retryAfter: response.headers.get('retry-after'),
  };
}

const REPORT = { kind: 'bug', title: 'The player skips', description: 'At the chapter boundary.' };
const AVATAR = { filename: 'me.png', contentType: 'image/png', size: 4096 };
const RECORDING = { filename: 'sunday.wav', contentType: 'audio/x-wav', size: 4096 };
const ARTWORK = { filename: 'cover.jpg', contentType: 'image/jpeg', size: 4096 };

describe('the feedback budget', () => {
  it('refuses the report past the budget, and refuses nothing before it', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'reporter');

    for (let n = 0; n < ACTOR_BUDGETS.feedback.limit; n += 1) {
      expect((await call(FEEDBACK_PATH, cookie, REPORT)).status).toBe(200);
    }

    const refused = await call(FEEDBACK_PATH, cookie, REPORT);
    expect(refused.status).toBe(429);
    expect(refused.code).toBe('rate_limited');
    expect(refused.message).toContain('reports in the last hour');
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  });

  it('spends nothing on a report it refused on its merits', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'fumbling');

    // As many malformed reports as the budget holds — none of them sent, none of them counted.
    for (let n = 0; n < ACTOR_BUDGETS.feedback.limit; n += 1) {
      expect((await call(FEEDBACK_PATH, cookie, { kind: 'bug', title: '   ' })).status).toBe(400);
    }
    expect((await call(FEEDBACK_PATH, cookie, REPORT)).status).toBe(200);
  });
});

describe('the avatar grant budget', () => {
  it('refuses the grant past the budget, and leaves the same member’s other budgets alone', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'picker');

    for (let n = 0; n < ACTOR_BUDGETS['avatar-grant'].limit; n += 1) {
      expect((await call(AVATAR_UPLOADS_PATH, cookie, AVATAR)).status).toBe(200);
    }

    const refused = await call(AVATAR_UPLOADS_PATH, cookie, AVATAR);
    expect(refused.status).toBe(429);
    expect(refused.message).toContain('upload attempts');
    // No URL rides along with a refusal.
    expect(JSON.stringify(refused.body)).not.toContain('X-Amz-Signature');

    // One counter per kind: a report from the same member is still taken.
    expect((await call(FEEDBACK_PATH, cookie, REPORT)).status).toBe(200);
  });

  it('spends nothing on a grant it refused on its merits', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'wrong-format');

    for (let n = 0; n < ACTOR_BUDGETS['avatar-grant'].limit; n += 1) {
      const rejected = await call(AVATAR_UPLOADS_PATH, cookie, { ...AVATAR, contentType: 'image/gif' });
      expect(rejected.status).toBe(400);
    }
    expect((await call(AVATAR_UPLOADS_PATH, cookie, AVATAR)).status).toBe(200);
  });
});

describe('the recording grant budget', () => {
  it('refuses the grant past the budget', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'uploader');

    for (let n = 0; n < ACTOR_BUDGETS['recording-grant'].limit; n += 1) {
      expect((await call(RECORDING_UPLOADS_PATH, cookie, RECORDING)).status).toBe(200);
    }

    const refused = await call(RECORDING_UPLOADS_PATH, cookie, RECORDING);
    expect(refused.status).toBe(429);
    expect(refused.code).toBe('rate_limited');
    expect(JSON.stringify(refused.body)).not.toContain('X-Amz-Signature');
  });
});

describe('the artwork grant budget', () => {
  it('refuses the grant past the budget, and is not the recording budget', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'curator');
    const created = await call<{ series: { id: string } }>(SERIES_PATH, cookie, {
      title: `Budgeted series ${Date.now().toString(36)}`,
      description: null,
    });
    expect(created.status).toBe(201);
    const grantPath = seriesArtworkUploadsPath(created.body.series.id);

    for (let n = 0; n < ACTOR_BUDGETS['artwork-grant'].limit; n += 1) {
      expect((await call(grantPath, cookie, ARTWORK)).status).toBe(200);
    }

    const refused = await call(grantPath, cookie, ARTWORK);
    expect(refused.status).toBe(429);
    expect(refused.message).toContain('upload attempts');

    // The same admin's recording uploads are a different counter, untouched by all of that.
    expect((await call(RECORDING_UPLOADS_PATH, cookie, RECORDING)).status).toBe(200);
  });
});
