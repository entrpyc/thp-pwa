/**
 * How long an invitation lives.
 *
 * docs/prd.md 3.1.4 says only "a fixed window"; docs/implementation-plan.md § Step 3 settles it at
 * **7 days**. Long enough to survive a holiday weekend and an inbox somebody reads on Sunday, short
 * enough that a link found in an old mailbox is dead. Resend restarts it rather than extending it,
 * so a forgotten invitation cannot be quietly kept alive.
 *
 * One constant, read by issue and by resend, so the two cannot come to mean different windows.
 */
export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function invitationExpiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_LIFETIME_MS);
}
