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
