import type { Actor } from '@/server/auth/policy';

/**
 * **The audit line, written once** (active-scope architecture § 5.4).
 *
 * This shape was already the product's convention — an identical private `audit()` sat in
 * `server/recordings/publication.ts` and in `server/series/service.ts`, and the notes service
 * (3.6.4) would have been the third copy. A convention written three times is a convention right up
 * until the third copy drifts, and drift here is silent: a renamed field still logs, and the line
 * still looks like an audit line to everyone except the search that was supposed to find it.
 *
 * **Four fields, and they are not negotiable.** `actorId` and `actorEmail` say who; `action` says
 * what; `target` says which thing. The time and the request's correlation id are the logger's, so
 * one search on a correlation id returns the refused request, the write and this line together.
 *
 * **The prefix stays at the call site.** `recording:`, `series:` and `note:` are how a target is
 * read back, and a helper that assembled them would need a kind parameter that is exactly the
 * prefix with extra steps. Callers pass the whole target string.
 *
 * What the Auditability NFR asks for is a structured log and not a table
 * (scope prd), so there is no row written anywhere here.
 */
export function audit(actor: Actor, action: string, target: string): Record<string, unknown> {
  return {
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    target,
  };
}
