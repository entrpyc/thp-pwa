/**
 * **When a playback grant has to be replaced.**
 *
 * A teaching runs to ninety minutes and a signed URL lasts an hour, so a grant expiring mid-listen
 * is not an edge case — it is the ordinary path for anything long. The client therefore renews,
 * and the member does not find out.
 *
 * Two triggers, whichever comes first:
 *
 * 1. **The element errored.** The definite signal, and the one that catches a URL that died for a
 *    reason the clock does not know about.
 * 2. **Expiry is close.** The pre-emptive one, which is what stops the member hearing the gap the
 *    first trigger costs.
 *
 * This function is the second, and it is a **pure function of two instants** rather than a timer
 * reading the clock itself — which is the whole reason it is testable without one. What calls it is
 * a ticker in the player; what it knows is only "is this grant nearly out of time".
 */

/**
 * Five minutes.
 *
 * Long enough to cover a renewal that has to retry over a slow connection, short enough that the
 * grant is genuinely most of its life old before anything happens. Against a one-hour grant that is
 * one renewal per sitting for a normal-length teaching, and two for a long one.
 */
export const GRANT_RENEWAL_MARGIN_MS = 5 * 60 * 1000;

export interface GrantRenewalInput {
  /** The `expiresAt` the grant came with, as ISO 8601. */
  readonly expiresAt: string;
  /** Now, in epoch milliseconds. Passed in, never read here. */
  readonly now: number;
}

/**
 * `true` when this grant is within the margin of expiring, or already past it.
 *
 * An unparseable `expiresAt` answers `true`: a grant whose expiry we cannot read is a grant we
 * cannot trust, and re-requesting one costs a request where trusting it costs the listen.
 */
export function shouldRenewGrant({ expiresAt, now }: GrantRenewalInput): boolean {
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return true;
  return expiry - now <= GRANT_RENEWAL_MARGIN_MS;
}
