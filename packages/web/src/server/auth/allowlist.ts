import { API_PREFIX, AUTH_SESSION_PATH, INVITATIONS_ACCEPT_PATH } from '@thp/shared';

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
 * Four entries, where docs/slice-architecture.md § Extension points names one. The architecture row
 * says `GET /api/v1/health` is the only unauthenticated route; taken literally that is not
 * satisfiable, because **the sign-in route cannot require a session**. The property that row was
 * actually protecting is "no unauthenticated route carrying content", and every entry holds it:
 * health answers with a liveness verdict, sign-in answers with a refusal or a cookie, and the two
 * accept routes answer only about the address the token was already mailed to.
 *
 * **Step 3 adds two, where the extension point anticipated one.** The second is the preview, and
 * it is what lets a dead link say "this expired, ask an admin to send another" *before* somebody
 * chooses a password, instead of after. It discloses the address the invitation was sent to — to
 * whoever is already holding the token that was sent to that address — and nothing else: no
 * account fields, no confirmation that the address has an account, no list. The alternative was to
 * drop it and let the invitee find out by submitting a password into a form that was always going
 * to fail, which is a worse trade for a smaller surface.
 *
 * Step 4 (password reset) adds its own, and that addition is a deliberate edit here too.
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
  {
    method: 'GET',
    path: `${API_PREFIX}${INVITATIONS_ACCEPT_PATH}`,
    because:
      'An invitee has no account yet, and a dead invitation must be able to say so before ' +
      'anybody chooses a password. It answers only with the address the token was mailed to and ' +
      'the role it carries, to a caller already holding that token.',
  },
  {
    method: 'POST',
    path: `${API_PREFIX}${INVITATIONS_ACCEPT_PATH}`,
    because:
      'Accepting an invitation is how the account comes to exist; requiring a session would be ' +
      'circular in exactly the way sign-in is.',
  },
];

export function isAllowlisted(method: string, pathname: string): boolean {
  const wanted = method.toUpperCase();
  return UNAUTHENTICATED_ROUTES.some(
    (entry) => entry.method === wanted && entry.path === pathname,
  );
}
