import type { Role } from './roles';

/**
 * The invitation wire contract.
 *
 * Read by the API, by the accept screen and by the invitation email, so none of the three can
 * invent its own idea of what an invitation looks like on the wire.
 *
 * **No shape in this file carries a token.** The raw token exists in exactly two places — the link
 * in the message, and the body of the accept request — and neither is a representation of an
 * invitation. That is deliberate: a payload type with an optional `token` field is a payload type
 * that will one day carry one.
 */

/** Paths of the invitation resource, relative to the `/api/v1` prefix. */
export const INVITATIONS_PATH = '/invitations';

/** Preview (`GET`) and accept (`POST`). The two unauthenticated invitation routes. */
export const INVITATIONS_ACCEPT_PATH = '/invitations/accept';

/** The screen an invitation link opens, on the web origin rather than under the API prefix. */
export const ACCEPT_INVITATION_PAGE_PATH = '/accept-invitation';

/** The query parameter the link carries the token in. */
export const INVITATION_TOKEN_PARAM = 'token';

/**
 * Where an invitation is in its life. Derived on read from `expires_at`, `revoked_at` and
 * `accepted_at` rather than stored — a stored status is a second source of truth that a clock can
 * make wrong.
 */
export const INVITATION_STATUSES = ['pending', 'expired', 'revoked', 'accepted'] as const;

export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** An invitation as an admin is allowed to see it. */
export interface InvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly status: InvitationStatus;
  /** ISO 8601. */
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** Body of `POST /api/v1/invitations`. */
export interface IssueInvitationRequest {
  readonly email: string;
  readonly role: Role;
}

/** Payload of `GET /api/v1/invitations`. */
export interface InvitationListPayload {
  readonly invitations: readonly InvitationSummary[];
}

/**
 * Payload of `GET /api/v1/invitations/accept?token=…` — the only thing an anonymous holder of a
 * token learns, and the reason a dead link can say "expired" before anyone chooses a password.
 */
export interface InvitationPreviewPayload {
  readonly email: string;
  readonly role: Role;
}

/** Body of `POST /api/v1/invitations/accept`. */
export interface AcceptInvitationRequest {
  readonly token: string;
  readonly password: string;
}

export function isInvitationStatus(value: unknown): value is InvitationStatus {
  return typeof value === 'string' && (INVITATION_STATUSES as readonly string[]).includes(value);
}
