import type { Actor, PolicyAction, PolicyResource } from '@/server/auth/policy';

/**
 * How a route states who may call it. Every `/api/v1` route passes one of these to `apiRoute` as
 * its **first argument**, which is what "refused by construction rather than by review" has to mean
 * to be worth anything: a route with no access declared does not compile.
 *
 * The three kinds are separate types rather than one union member each, so the wrapper can give the
 * handler the right actor type — `null` on a public route, an `Actor` everywhere else — without a
 * cast at the call site.
 */
export interface PublicAccess {
  readonly kind: 'public';
}

export interface SessionAccess {
  readonly kind: 'session';
}

export interface PolicyAccess {
  readonly kind: 'policy';
  readonly action: PolicyAction;
  readonly resource?: PolicyResource;
}

export type RouteAccess = PublicAccess | SessionAccess | PolicyAccess;

/** What the handler for a given access declaration is handed as its caller. */
export type ActorFor<TAccess extends RouteAccess> = TAccess extends PublicAccess ? null : Actor;

/**
 * No session required — **and only honoured for a path on the allowlist**. Declaring a route public
 * that nobody added to `UNAUTHENTICATED_ROUTES` refuses anonymous callers exactly like any other
 * route, so the list stays the single source of exceptions rather than one of two.
 */
export const PUBLIC: PublicAccess = { kind: 'public' };

/** Any signed-in account. The right answer for a route that authorises nothing beyond "who". */
export const SESSION: SessionAccess = { kind: 'session' };

/** A signed-in account the policy module permits for this `(action, resource)`. */
export function permits(action: PolicyAction, resource?: PolicyResource): PolicyAccess {
  return resource === undefined ? { kind: 'policy', action } : { kind: 'policy', action, resource };
}
