import { API_PREFIX, AUTH_SESSION_PATH } from '@thp/shared';

/**
 * **The enumerated unauthenticated surface.** Every `/api/v1` route requires a session except the
 * entries below (docs/prd.md, 3.1.2).
 *
 * This is a list, not a convention, and it is the *only* source of exceptions: `apiRoute(PUBLIC, …)`
 * consults it at request time, so declaring a route public without adding it here does not make it
 * public. Adding a public route is therefore an edit to this constant and nothing else, and
 * tests/guards/route-sweep — which discovers routes from the filesystem — subtracts exactly this
 * list before asserting that everything else refuses an anonymous caller.
 *
 * Two entries, where docs/slice-architecture.md § Extension points names one. The architecture row
 * says `GET /api/v1/health` is the only unauthenticated route; taken literally that is not
 * satisfiable, because **the sign-in route cannot require a session**. The property that row was
 * protecting is "no unauthenticated route carrying content", and both entries hold it: health
 * answers with a liveness verdict, sign-in answers with a refusal or a cookie.
 *
 * Step 3 (invitation accept) and step 4 (password reset) each add one entry. Each addition is a
 * deliberate edit here, which is the seam working rather than eroding.
 */
export interface AllowlistEntry {
  readonly method: string;
  /** Absolute path including the `/api/v1` prefix. */
  readonly path: string;
  /** Why this one is outside the rule. Present so an entry cannot be added without an answer. */
  readonly because: string;
}

export const UNAUTHENTICATED_ROUTES: readonly AllowlistEntry[] = [
  {
    method: 'GET',
    path: `${API_PREFIX}/health`,
    because:
      'It must answer while the database is down, which is precisely when a session lookup ' +
      'cannot. A probe that needs a session is no probe, and deployment depends on one.',
  },
  {
    method: 'POST',
    path: `${API_PREFIX}${AUTH_SESSION_PATH}`,
    because: 'Signing in is how a session comes to exist; requiring one would be circular.',
  },
];

export function isAllowlisted(method: string, pathname: string): boolean {
  const wanted = method.toUpperCase();
  return UNAUTHENTICATED_ROUTES.some(
    (entry) => entry.method === wanted && entry.path === pathname,
  );
}
