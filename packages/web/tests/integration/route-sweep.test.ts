import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { API_PREFIX, isApiErrorBody } from '@thp/shared';
import { UNAUTHENTICATED_ROUTES, isAllowlisted } from '@/server/auth/allowlist';
import {
  UNGUARDED_FIXTURE_HEADER,
  UNGUARDED_FIXTURE_VALUE,
} from '@/server/api/diagnostics';
import {
  discoverRoutes,
  exportedMethods,
  formatSweepViolations,
  sweepAnonymousAccess,
  type DiscoveredRoute,
  type ProbeResult,
} from '../../../../tools/route-sweep';
import { closeTestDatabase } from '../support/accounts';

const baseUrl = inject('apiBaseUrl');
const APP_DIR = resolve(import.meta.dirname, '..', '..', 'src', 'app');
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

const routes = discoverRoutes(APP_DIR, 'api/v1', REPO_ROOT);

afterAll(async () => {
  await closeTestDatabase();
});

/** Anonymous. No cookie, ever — that is the whole point of the sweep. */
function probeWith(extraHeaders: Record<string, string> = {}) {
  return async (route: DiscoveredRoute): Promise<ProbeResult> => {
    const response = await fetch(`${baseUrl}${route.path}`, {
      method: route.method,
      headers: { accept: 'application/json', ...extraHeaders },
      redirect: 'manual',
    });
    if (route.method === 'HEAD') return { status: response.status, code: null, hasBody: false };
    const body: unknown = await response.json().catch(() => undefined);
    return {
      status: response.status,
      code: isApiErrorBody(body) ? body.error.code : null,
      hasBody: true,
    };
  };
}

describe('every /api/v1 route not on the allowlist refuses an anonymous request', () => {
  beforeAll(() => {
    // A sweep that discovered nothing would pass silently, which is the one failure mode that
    // matters for a guard like this.
    expect(routes.length).toBeGreaterThan(5);
  });

  it('discovers the routes from the filesystem, not from a list', () => {
    const paths = new Set(routes.map((route) => route.path));

    expect(paths).toContain(`${API_PREFIX}/health`);
    expect(paths).toContain(`${API_PREFIX}/auth/session`);
    expect(paths).toContain(`${API_PREFIX}/diagnostics/admin-only`);
    expect(paths).toContain(`${API_PREFIX}/invitations`);
    expect(paths).toContain(`${API_PREFIX}/invitations/accept`);
    expect(paths).toContain(`${API_PREFIX}/auth/password-reset`);
    expect(paths).toContain(`${API_PREFIX}/auth/password-reset/complete`);
    expect(paths).toContain(`${API_PREFIX}/users`);
    // Story 4's five. Named here so the sweep below is provably about them too: a route the
    // discovery missed would be a route nothing asserted refuses an anonymous caller.
    expect(paths).toContain(`${API_PREFIX}/recordings/sweep-probe-value`);
    expect(paths).toContain(`${API_PREFIX}/recordings/sweep-probe-value/playback`);
    expect(paths).toContain(`${API_PREFIX}/recordings/sweep-probe-value/progress`);
    expect(paths).toContain(`${API_PREFIX}/recordings/resume`);
    expect(paths).toContain(`${API_PREFIX}/users/me/playback-speed`);
    // Story 5's three. Named here for the same reason Story 4's five are: a route the discovery
    // missed would be a route nothing asserted refuses an anonymous caller — and the correction
    // route is the first in the product with **two** dynamic segments, which is exactly the shape a
    // path-building bug would silently drop.
    expect(paths).toContain(`${API_PREFIX}/recordings/sweep-probe-value/transcript`);
    expect(paths).toContain(
      `${API_PREFIX}/recordings/sweep-probe-value/transcript/segments/sweep-probe-value`,
    );
    expect(paths).toContain(`${API_PREFIX}/recordings/sweep-probe-value/summary/regenerate`);
    // Story 6's three. Named for the reason the earlier groups are: a route the discovery missed
    // would be a route nothing asserted refuses an anonymous caller.
    expect(paths).toContain(`${API_PREFIX}/series`);
    expect(paths).toContain(`${API_PREFIX}/series/sweep-probe-value`);
    expect(paths).toContain(`${API_PREFIX}/recordings/sweep-probe-value/series`);
    // The catch-all is discovered too, standing in for any path no route claims.
    expect(routes.some((route) => route.isCatchAll)).toBe(true);
  });

  it('finds every method a route file exports, whichever form it is written in', () => {
    expect(exportedMethods('export const GET = apiRoute(PUBLIC, () => ({}));')).toEqual(['GET']);
    expect(exportedMethods('export async function POST(request: Request) {}')).toEqual(['POST']);
    expect(exportedMethods('const h = 1;\nexport { h as PUT, h as DELETE };')).toEqual([
      'PUT',
      'DELETE',
    ]);
    expect(exportedMethods('// GET is only mentioned in a comment')).toEqual([]);
  });

  it('holds against the running server', async () => {
    const violations = await sweepAnonymousAccess({
      routes,
      isAllowlisted,
      probe: probeWith(),
      expectedCode: 'unauthenticated',
      expectedStatus: 401,
    });
    expect(formatSweepViolations(violations)).toBe('');
  }, 60_000);

  it('subtracts exactly one named list, and it is the one the API reads', () => {
    expect(UNAUTHENTICATED_ROUTES).toHaveLength(7);
    for (const entry of UNAUTHENTICATED_ROUTES) {
      expect(isAllowlisted(entry.method, entry.path), `${entry.method} ${entry.path}`).toBe(true);
      expect(entry.because.length).toBeGreaterThan(20);
    }
    expect(isAllowlisted('GET', `${API_PREFIX}/auth/session`)).toBe(false);
    // The three step-4 entries are the reset flow and nothing beside it: the admin account routes
    // added in the same step are on the far side of the line, and the sweep proves it.
    expect(isAllowlisted('GET', `${API_PREFIX}/users`)).toBe(false);
    expect(isAllowlisted('PATCH', `${API_PREFIX}/users/anything`)).toBe(false);
    expect(isAllowlisted('POST', `${API_PREFIX}/health`)).toBe(false);
  });

  it('reaches every allowlisted route anonymously', async () => {
    for (const entry of UNAUTHENTICATED_ROUTES) {
      const response = await fetch(`${baseUrl}${entry.path}`, {
        method: entry.method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        ...(entry.method === 'POST' ? { body: JSON.stringify({}) } : {}),
      });
      // Reachable means "not refused for want of a session" — a sign-in with no credentials is
      // still answered by the route rather than turned away before it.
      const body: unknown = await response.json().catch(() => undefined);
      const code = isApiErrorBody(body) ? body.error.code : null;
      expect(code, `${entry.method} ${entry.path}`).not.toBe('unauthenticated');
      expect(response.status, `${entry.method} ${entry.path}`).not.toBe(404);
    }
  });

  it('discloses no account content to an anonymous caller with no credential', async () => {
    // Reachable is half the property. The other half is what the row is actually protecting: an
    // unauthenticated route may exist, but none of them may hand out account content. Asked with
    // nothing — no cookie, no token, no credentials — every one of the seven must answer with a
    // verdict or a refusal, never with a person.
    for (const entry of UNAUTHENTICATED_ROUTES) {
      const response = await fetch(`${baseUrl}${entry.path}`, {
        method: entry.method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        ...(entry.method === 'POST' ? { body: JSON.stringify({}) } : {}),
      });
      const body: unknown = await response.json().catch(() => undefined);
      const keys = typeof body === 'object' && body !== null ? Object.keys(body) : [];

      const where = `${entry.method} ${entry.path}`;
      expect(keys, where).not.toContain('user');
      for (const field of ['id', 'email', 'displayName', 'role', 'passwordHash', 'token']) {
        expect(JSON.stringify(body), `${where} disclosed ${field}`).not.toContain(`"${field}"`);
      }
    }
  });

  it('reports a route written without going through the wrapper', async () => {
    // The negative control. `/api/v1/diagnostics/unguarded` is a real, discovered route file that
    // never calls `apiRoute` — the one case the required-access argument cannot catch — and it
    // answers 200 anonymously when asked by this header. A guard nobody has seen fail is not a
    // guard.
    const violations = await sweepAnonymousAccess({
      routes,
      isAllowlisted,
      probe: probeWith({ [UNGUARDED_FIXTURE_HEADER]: UNGUARDED_FIXTURE_VALUE }),
      expectedCode: 'unauthenticated',
      expectedStatus: 401,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.route.path).toBe(`${API_PREFIX}/diagnostics/unguarded`);
    expect(violations[0]?.reason).toBe('answered-anonymously');
    expect(formatSweepViolations(violations)).toContain('unguarded/route.ts');
  }, 60_000);
});

describe('an unknown path refuses before it says it does not exist', () => {
  it('answers unauthenticated, not not_found, to an anonymous caller', async () => {
    const response = await fetch(`${baseUrl}${API_PREFIX}/there-is-no-such-route`);
    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    if (!isApiErrorBody(body)) throw new Error('expected an error envelope');
    expect(body.error.code).toBe('unauthenticated');
    expect(body.error.code).not.toBe('not_found');
  });

  it('answers the same for a path that does exist but needs a session', async () => {
    const real = await fetch(`${baseUrl}${API_PREFIX}/auth/session`);
    const imaginary = await fetch(`${baseUrl}${API_PREFIX}/there-is-no-such-route`);

    expect(real.status).toBe(imaginary.status);
    const [realBody, imaginaryBody] = await Promise.all([real.json(), imaginary.json()]);
    if (!isApiErrorBody(realBody) || !isApiErrorBody(imaginaryBody)) {
      throw new Error('expected error envelopes');
    }
    // Indistinguishable, so route existence is not probeable without a session.
    expect(imaginaryBody.error.code).toBe(realBody.error.code);
    expect(imaginaryBody.error.message).toBe(realBody.error.message);
  });
});
