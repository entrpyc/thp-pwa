import {
  API_PREFIX,
  AUTH_SESSION_PATH,
  INVITATIONS_ACCEPT_PATH,
  PASSWORD_RESET_COMPLETE_PATH,
  PASSWORD_RESET_PATH,
} from '@thp/shared';

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
 * Seven entries, where docs/slice-architecture.md § Extension points names one. The architecture row
 * says `GET /api/v1/health` is the only unauthenticated route; taken literally that is not
 * satisfiable, because **the sign-in route cannot require a session**. The property that row was
 * actually protecting is "no unauthenticated route carrying content", and every entry holds it:
 * health answers with a liveness verdict, sign-in answers with a refusal or a cookie, and the four
 * token routes answer only about the address the token they were handed was already mailed to.
 *
 * **Step 3 added two and step 4 adds three**, where the extension point anticipated one apiece. The
 * extra one in each pair is a preview, and the argument is the same both times: it lets a dead link
 * say "this expired, ask for another" *before* somebody chooses a password, instead of after they
 * have typed one into a form that was always going to fail. Each preview discloses the address the
 * token was already mailed to, to a caller already holding that token, and nothing else.
 *
 * It is worth noticing that this is the third consecutive step to grow the list. Every entry still
 * holds the property the row protects, but the list is no longer short: **step 5 should add none**,
 * and any later step proposing an entry should have to argue against these seven rather than beside
 * them.
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
  {
    method: 'POST',
    path: `${API_PREFIX}${PASSWORD_RESET_PATH}`,
    because:
      'Somebody who cannot sign in is by definition anonymous. It answers one fixed payload for ' +
      'every outcome — sent, unknown address, deactivated account, malformed input — so it ' +
      'carries no content at all, not even the fact that the address has an account.',
  },
  {
    method: 'GET',
    path: `${API_PREFIX}${PASSWORD_RESET_PATH}`,
    because:
      'A dead reset link must be able to say so before anybody chooses a password. It answers ' +
      'only with the address the token was already mailed to, to a caller already holding that ' +
      'token, and with nothing else about the account.',
  },
  {
    method: 'POST',
    path: `${API_PREFIX}${PASSWORD_RESET_COMPLETE_PATH}`,
    because:
      'Setting the new password is what ends the anonymous half of the flow; requiring a session ' +
      'to recover a password would be circular in exactly the way sign-in is.',
  },
];

export function isAllowlisted(method: string, pathname: string): boolean {
  const wanted = method.toUpperCase();
  return UNAUTHENTICATED_ROUTES.some(
    (entry) => entry.method === wanted && entry.path === pathname,
  );
}
