import type { Role } from './roles';

/**
 * The auth wire contract. The client and the API read the cookie name and the session payload
 * shape from here so neither can drift; nothing about *deciding* anything lives in this file —
 * authorisation is evaluated server-side only (docs/project/prd.md, 3.1.5).
 */

/** Name of the session cookie. Its value is an opaque token, never anything about the user. */
export const SESSION_COOKIE_NAME = 'thp_session';

/** Paths of the auth resource. Sign-in, sign-out and "who am I" are one resource, three methods. */
export const AUTH_SESSION_PATH = '/auth/session';

/** Body of `POST /api/v1/auth/session`. */
export interface SignInRequest {
  readonly email: string;
  readonly password: string;
}

/**
 * The current user, as the client is allowed to see it. `role` is here so the interface can *hide*
 * what a member cannot do; it is never what permits anything — the API refuses independently.
 */
export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  /**
   * The speed this account plays teachings at (Story 4 Ticket 03,
   * [3.2.4](docs/project/prd.md)).
   *
   * Here rather than behind a read of its own, for the reason `role` is: the session lookup has
   * already read the row, and a second request to learn one number would mean the transport bar
   * rendering at the wrong rate until it came back. Unlike `role` it decides nothing — it is a
   * preference the interface applies, and the API refuses a value outside the six whoever sends it.
   */
  readonly preferredPlaybackSpeed: number;
}

/** Payload of `POST /api/v1/auth/session` and `GET /api/v1/auth/session`. */
export interface SessionPayload {
  readonly user: SessionUser;
}

/** Payload of `DELETE /api/v1/auth/session`. */
export interface SignOutPayload {
  readonly signedOut: true;
}

/**
 * Path of `POST /api/v1/auth/sign-up` — registering an account without an invitation.
 *
 * Its own path rather than a second method on {@link AUTH_SESSION_PATH}: signing up creates an
 * *account* and a session, where signing in creates only a session, and one path answering two
 * different creations is a path whose `201` means two things.
 */
export const SIGN_UP_PATH = '/auth/sign-up';

/** The screen that registration happens on, on the web origin rather than under the API prefix. */
export const SIGN_UP_PAGE_PATH = '/sign-up';

/**
 * Body of `POST /api/v1/auth/sign-up`.
 *
 * **No `role` field, deliberately.** A registrant is a Member and says nothing about it
 * (docs/project/prd.md, 3.1.15); a request shape with a role in it is a request shape somebody
 * will one day trust. Changing a role is an admin action on an account that already exists
 * (3.1.5), and it travels on `PATCH /api/v1/users/:id` where it can be authorised.
 */
export interface SignUpRequest {
  readonly email: string;
  readonly password: string;
}
