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
 * The current user as the policy module describes them — everything in {@link SessionUser} that
 * can be read straight off the account row.
 *
 * Split from the payload because one field cannot be: the avatar travels as a signed URL, and
 * signing is the store's answer rather than the row's. The policy module builds this
 * synchronously; the accounts module adds the one asynchronous field and hands back the payload.
 */
export interface SessionIdentity {
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
  /**
   * Whether this account has turned product analytics off (Apple guideline 5.1.1(ii)).
   *
   * In the session payload for the reason the speed is, with more at stake: the analytics client
   * starts when the member surface mounts, and it has to know *before* its first event whether it
   * may send one. A preference fetched afterwards would be a preference applied after the page
   * view it was meant to withhold. `false` is the ordinary state — analytics on — and the member
   * changes it from `/profile/settings`.
   */
  readonly analyticsOptedOut: boolean;
}

/**
 * The current user, as the client is allowed to see it. `role` is here so the interface can *hide*
 * what a member cannot do; it is never what permits anything — the API refuses independently.
 *
 * `avatarUrl` is a signed, day-cacheable grant to the picture, or `null` — the ordinary state, and
 * the one every account starts in (docs/project/prd.md 3.1.12: the avatar is optional). **Never the
 * key**: a client is handed a URL it can paint from, not a name in the bucket.
 */
export interface SessionUser extends SessionIdentity {
  readonly avatarUrl: string | null;
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
 * The screen at `/sign-up`, on the web origin rather than under the API prefix.
 *
 * **Registration is closed.** The app is published for the members of one private group, so the
 * screen no longer carries a form: it says that an admin can invite the person (3.1.3) and names
 * the operator's mailbox (`SUPPORT_EMAIL`). There is no `POST /api/v1/auth/sign-up` any more — the
 * route was removed rather than switched off, so nothing can create an account without an
 * invitation. The path is kept because sign-in and a dead invitation link still point here.
 */
export const SIGN_UP_PAGE_PATH = '/sign-up';
