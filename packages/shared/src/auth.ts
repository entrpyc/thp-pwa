import type { Role } from './roles';

/**
 * The auth wire contract. The client and the API read the cookie name and the session payload
 * shape from here so neither can drift; nothing about *deciding* anything lives in this file —
 * authorisation is evaluated server-side only (docs/prd.md, 3.1.5).
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
}

/** Payload of `POST /api/v1/auth/session` and `GET /api/v1/auth/session`. */
export interface SessionPayload {
  readonly user: SessionUser;
}

/** Payload of `DELETE /api/v1/auth/session`. */
export interface SignOutPayload {
  readonly signedOut: true;
}
