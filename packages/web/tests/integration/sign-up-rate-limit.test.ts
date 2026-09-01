import { afterAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  CORRELATION_ID_HEADER,
  SIGN_UP_PATH,
  isApiErrorBody,
} from '@thp/shared';
import { closeTestDatabase, signIn } from '../support/accounts';

/**
 * The sign-up budget, driven over HTTP (docs/project/prd.md, 3.1.18).
 *
 * **Against its own server**, started by tests/setup/global.ts with a budget of three per caller.
 * Every other server in the suite has the limit lifted out of the way, because a test run has no
 * proxy in front of it and is therefore one caller as far as a limiter can tell — left at the
 * shipped defaults, which test got refused would depend on the order the files ran in.
 *
 * What this file is for is the **wiring and the HTTP contract**: that the limiter is actually in
 * front of the route, that a refusal is the product's envelope rather than a framework page, that
 * it carries `Retry-After`, and that nothing is created by a request it refused. The arithmetic —
 * windows, eviction, the ceiling, the boundary — is unit-tested against an injected clock in
 * `tests/unit/rate-limit.test.ts`, where none of it has to race a real second.
 *
 * Each test uses a client address of its own. Without a proxy in front, `X-Real-IP` is whatever the
 * caller sends — which is exactly the property nginx removes in production by overwriting the
 * header (deploy/nginx/thp.conf), and exactly what makes a fresh budget available here without a
 * fresh server.
 */

const baseUrl = inject('rateLimitedBaseUrl');
const primaryBaseUrl = inject('apiBaseUrl');
const { perAddress } = inject('rateLimitedSignUp');

const SIGN_UP_URL = `${baseUrl}${API_PREFIX}${SIGN_UP_PATH}`;

/** Long enough for the shipped rule, and obviously not a real password. */
const PASSWORD = 'chosen-against-the-limit';

afterAll(async () => {
  await closeTestDatabase();
});

let addresses = 0;

/** A caller nothing else in this file is. Documentation addresses, never a routable one. */
function freshAddress(): string {
  addresses += 1;
  return `203.0.113.${addresses}`;
}

function freshEmail(label: string): string {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  return `${label}-${suffix}@example.test`;
}

interface Answer {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly correlationId: string | null;
  readonly retryAfter: string | null;
}

async function attempt(address: string, body: unknown = null, email?: string): Promise<Answer> {
  const payload = body ?? { email: email ?? freshEmail('limited'), password: PASSWORD };
  const response = await fetch(SIGN_UP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': address },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    code: isApiErrorBody(parsed) ? parsed.error.code : null,
    message: isApiErrorBody(parsed) ? parsed.error.message : null,
    correlationId: response.headers.get(CORRELATION_ID_HEADER),
    retryAfter: response.headers.get('retry-after'),
  };
}

describe('the sign-up rate limit', () => {
  it('lets a caller spend their budget and refuses the next request', async () => {
    const address = freshAddress();

    for (let n = 0; n < perAddress; n += 1) {
      expect((await attempt(address)).status).toBe(201);
    }

    const refused = await attempt(address);
    expect(refused.status).toBe(429);
    expect(refused.code).toBe('rate_limited');
  });

  it('answers in the product envelope, with a correlation id and a Retry-After', async () => {
    const address = freshAddress();
    for (let n = 0; n < perAddress; n += 1) await attempt(address);

    const refused = await attempt(address);

    // Not a framework error page: the same envelope every other refusal in the product uses.
    expect(refused.correlationId).toBeTruthy();
    expect(refused.message).toContain('Too many sign-up attempts');
    // The wait is a number the client is handed rather than one it has to invent.
    expect(refused.retryAfter).toBeTruthy();
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  });

  it('counts one caller and not another', async () => {
    const spent = freshAddress();
    const fresh = freshAddress();

    for (let n = 0; n < perAddress; n += 1) await attempt(spent);
    expect((await attempt(spent)).status).toBe(429);

    // Somebody else registering at the same moment is unaffected. This is the assertion that makes
    // the limit a limit on abuse rather than on the product.
    expect((await attempt(fresh)).status).toBe(201);
  });

  it('creates no account for a request it refused', async () => {
    const address = freshAddress();
    for (let n = 0; n < perAddress; n += 1) await attempt(address);

    const email = freshEmail('never-created');
    expect((await attempt(address, null, email)).status).toBe(429);

    // Asked on the *primary* server, which shares the database and has no budget in the way: the
    // address has no account, so signing in with the credentials that were refused fails.
    const attemptedSignIn = await signIn(primaryBaseUrl, email, PASSWORD);
    expect(attemptedSignIn.status).toBe(401);
  });

  it('spends the budget on attempts, not on successes', async () => {
    const address = freshAddress();

    // Three requests that could never have created anything — a body that is not even an object.
    for (let n = 0; n < perAddress; n += 1) {
      const rejected = await attempt(address, 'null');
      expect(rejected.status).toBe(400);
    }

    // A perfectly good registration is still refused, which is what "the check runs before the
    // body is read" has to mean: probing costs the prober whether or not the probe would have won.
    const refused = await attempt(address);
    expect(refused.status).toBe(429);
    expect(refused.code).toBe('rate_limited');
  });

  it('does not extend the block when a refused caller keeps hammering', async () => {
    const address = freshAddress();
    for (let n = 0; n < perAddress; n += 1) await attempt(address);

    const first = await attempt(address);
    const later = await attempt(address);

    expect(first.status).toBe(429);
    expect(later.status).toBe(429);
    // A refusal spends nothing, so the wait counts down rather than restarting at every knock.
    expect(Number(later.retryAfter)).toBeLessThanOrEqual(Number(first.retryAfter));
  });

  it('leaves every other route alone — the budget is this one route', async () => {
    const address = freshAddress();
    for (let n = 0; n < perAddress; n += 1) await attempt(address);
    expect((await attempt(address)).status).toBe(429);

    // Sign-in from the same caller, on the same server, is untouched. The limit is on the route
    // that writes and discloses, not on being that IP address.
    const health = await fetch(`${baseUrl}${API_PREFIX}/health`, {
      headers: { 'x-real-ip': address },
    });
    expect(health.status).toBe(200);
  });
});
