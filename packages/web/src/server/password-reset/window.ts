/**
 * How long a reset lives, and how often one can be asked for.
 *
 * **One hour.** Much shorter than an invitation's seven days, and deliberately so: an invitation is
 * a standing offer to somebody who has no account yet, while a reset is a live key to an account
 * that already exists. The window only has to cover the walk from "I asked for this" to "I am
 * reading my email", and every extra hour is an hour a forwarded or intercepted message stays
 * usable.
 *
 * **Sixty seconds between requests.** Not a rate limiter, and it does not pretend to be. There is
 * still no *general* rate limiting (carried from ticket 2's assumption 10 and ticket 3's assumption
 * 12); registration has a real one because it creates accounts and discloses that an address is
 * taken (docs/project/prd.md, 3.1.18), and nothing else does. Reset is a different exposure again
 * from both: it is an unauthenticated route
 * that causes **mail to be sent to an arbitrary address**, which is a nuisance vector and a billed
 * one. A database check on the outstanding reset's age removes the cheapest version of that abuse
 * without adding infrastructure, and a person who genuinely pressed the button twice sees the same
 * confirmation either way.
 *
 * Both constants are read by the request path and by nothing else, so the two cannot come to mean
 * different windows.
 */

export const PASSWORD_RESET_LIFETIME_MS = 60 * 60 * 1000;

export const PASSWORD_RESET_RESEND_INTERVAL_MS = 60 * 1000;

export function passwordResetExpiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + PASSWORD_RESET_LIFETIME_MS);
}

/** Whether an outstanding reset is young enough that a second request should send no message. */
export function isWithinResendInterval(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() < PASSWORD_RESET_RESEND_INTERVAL_MS;
}
