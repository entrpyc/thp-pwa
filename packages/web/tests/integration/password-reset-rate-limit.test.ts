import { afterAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  CORRELATION_ID_HEADER,
  PASSWORD_RESET_PATH,
  isApiErrorBody,
} from '@thp/shared';
import { closeTestDatabase, createAccount } from '../support/accounts';
import { mailOffset, readCapturedMail, waitForMail } from '../support/mail';

/**
 * The reset-request budget, driven over HTTP (docs/project/prd.md, 3.1.21).
 *
 * **Against the rate-limited server**, started by tests/setup/global.ts with three requests per
 * caller. Every other server has the limit lifted out of the way, for the reason the sign-up
 * budget is.
 *
 * What this file is for is the **wiring and the HTTP contract**: that the guard is in front of the
 * route, that a refusal is the product's envelope with a `Retry-After`, that the fixed payload is
 * still what every allowed request gets, and — the one that matters — that a refused request for a
 * real member's address sends them nothing. The arithmetic is unit-tested against an injected
 * clock in `tests/unit/password-reset-limits.test.ts`.
 *
 * Each test uses a client address of its own, as the sign-up tests do.
 */

const baseUrl = inject('rateLimitedBaseUrl');
const databaseUrl = inject('databaseUrl');
const mailPath = inject('rateLimitedMailCapturePath');
const { perAddress } = inject('rateLimitedPasswordReset');

const REQUEST_URL = `${baseUrl}${API_PREFIX}${PASSWORD_RESET_PATH}`;

afterAll(async () => {
  await closeTestDatabase();
});

let addresses = 0;

/** A caller nothing else in this file is. Documentation addresses, never a routable one. */
function freshAddress(): string {
  addresses += 1;
  return `203.0.113.${addresses}`;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly code: string | null;
  readonly message: string | null;
  readonly correlationId: string | null;
  readonly retryAfter: string | null;
}

async function request(address: string, email: string): Promise<Answer> {
  const response = await fetch(REQUEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': address },
    body: JSON.stringify({ email }),
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    body: parsed,
    code: isApiErrorBody(parsed) ? parsed.error.code : null,
    message: isApiErrorBody(parsed) ? parsed.error.message : null,
    correlationId: response.headers.get(CORRELATION_ID_HEADER),
    retryAfter: response.headers.get('retry-after'),
  };
}

/** Spend a caller's whole budget on addresses nobody holds, which is what a probe does. */
async function exhaust(address: string): Promise<void> {
  for (let n = 0; n < perAddress; n += 1) {
    const allowed = await request(address, `nobody-${address}-${n}@example.test`);
    expect(allowed.status).toBe(200);
    // The fixed payload, exactly as an allowed request for a real address gets it.
    expect(allowed.body).toEqual({ requested: true });
  }
}

describe('the reset-request rate limit', () => {
  it('lets a caller spend their budget and refuses the next request', async () => {
    const address = freshAddress();
    await exhaust(address);

    const refused = await request(address, 'anybody@example.test');
    expect(refused.status).toBe(429);
    expect(refused.code).toBe('rate_limited');
  });

  it('answers in the product envelope, with a correlation id and a Retry-After', async () => {
    const address = freshAddress();
    await exhaust(address);

    const refused = await request(address, 'anybody@example.test');

    expect(refused.correlationId).toBeTruthy();
    expect(refused.message).toContain('Too many password-reset requests');
    expect(refused.retryAfter).toBeTruthy();
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  });

  it('counts one caller and not another', async () => {
    const spent = freshAddress();
    const fresh = freshAddress();

    await exhaust(spent);
    expect((await request(spent, 'anybody@example.test')).status).toBe(429);
    expect((await request(fresh, 'anybody@example.test')).status).toBe(200);
  });

  it('sends nothing for a request it refused, even to a real member', async () => {
    const member = await createAccount(databaseUrl, 'member', 'never-mailed');
    const address = freshAddress();
    await exhaust(address);

    const before = mailOffset(mailPath);
    const refused = await request(address, member.email);
    expect(refused.status).toBe(429);

    // An allowed request from somebody else proves the outbox is live and the read is not
    // vacuous: their message arrives, and the member's still does not.
    const other = await createAccount(databaseUrl, 'member', 'mailed');
    expect((await request(freshAddress(), other.email)).status).toBe(200);
    await waitForMail(mailPath, before, (messages) =>
      messages.some((message) => message.to.includes(other.email)),
    );

    const sent = readCapturedMail(mailPath, before);
    expect(sent.some((message) => message.to.includes(member.email))).toBe(false);
  });

  it('does not extend the block when a refused caller keeps hammering', async () => {
    const address = freshAddress();
    await exhaust(address);

    const first = await request(address, 'anybody@example.test');
    const later = await request(address, 'anybody@example.test');

    expect(first.status).toBe(429);
    expect(later.status).toBe(429);
    expect(Number(later.retryAfter)).toBeLessThanOrEqual(Number(first.retryAfter));
  });

  it('leaves the preview alone — the budget is on asking, not on reading a link', async () => {
    const address = freshAddress();
    await exhaust(address);
    expect((await request(address, 'anybody@example.test')).status).toBe(429);

    // A dead token from the same caller is still answered on its merits, not with a 429.
    const preview = await fetch(`${REQUEST_URL}?token=not-a-real-token`, {
      headers: { 'x-real-ip': address },
    });
    expect(preview.status).not.toBe(429);
  });
});
