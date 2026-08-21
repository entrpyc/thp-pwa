import type { Role, SessionUser } from '@thp/shared';
import type { UserRow } from '@thp/db';

/**
 * **The single place `(actor, action, resource)` is evaluated.**
 *
 * This is one of the three structures docs/slice-prd.md § Rationale names as making this slice
 * throwaway if skipped: Contributor arriving in a later slice is one enum value plus four widened
 * cases *only if* every check in the product goes through here. Nothing else in `src/` is allowed
 * to read a role or compare against one — tools/role-usage.ts fails the build if anything does,
 * which is why this file is also where an actor is built and where an actor is turned into the
 * payload the client renders from.
 *
 * Two properties the tests pin:
 *
 * - **Denies by default.** An action nobody has written a rule for is refused, not permitted, and
 *   not an exception.
 * - **Exhaustive over roles.** {@link RULES} is a `Record<PolicyAction, Record<Role, boolean>>`, so
 *   adding a role to the enum stops the build until every action says what that role may do. That
 *   is what turns "widen four cases" from a search of the codebase into a compiler error.
 */

/**
 * Every action the API can be asked to authorise. Slice 01 step 2 has three; each later step adds
 * the actions it needs alongside the routes that use them.
 */
export const POLICY_ACTIONS = [
  /** Read the signed-in account. Any session may. */
  'session.read',
  /** Exercise the diagnostics routes the integration suite drives. */
  'diagnostics.run',
  /** The admin-only diagnostic, which exists so "the API refuses, not the client" is testable. */
  'diagnostics.admin',
] as const;

export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** Who is asking. Built by {@link toActor} from a row the session module re-read this request. */
export interface Actor {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
}

/**
 * What is being acted on. Slice 01 step 2 authorises no owned resource yet — nothing exists to
 * own — so every rule is role-only. The parameter is here from the start because retrofitting it
 * would mean touching every call site, which is the cost this module exists to avoid.
 */
export interface PolicyResource {
  readonly kind: string;
  readonly id?: string;
  readonly ownerId?: string;
}

/**
 * The shape of {@link RULES}: an answer per role, per action.
 *
 * `Record<Role, boolean>` rather than `readonly Role[]`, deliberately — a list of permitted roles
 * still compiles when a role is added to the enum, and a record does not. Exported so the
 * exhaustiveness fixture (tests/fixtures/type-errors) can assert that property against the real
 * type rather than a restatement of it.
 */
export type PolicyRules = Record<PolicyAction, Record<Role, boolean>>;

const RULES: PolicyRules = {
  'session.read': { admin: true, member: true },
  'diagnostics.run': { admin: true, member: true },
  'diagnostics.admin': { admin: true, member: false },
};

export function isPolicyAction(value: string): value is PolicyAction {
  return (POLICY_ACTIONS as readonly string[]).includes(value);
}

/** The account row, as the rest of the request is allowed to see it. */
export function toActor(row: UserRow): Actor {
  return { id: row.id, email: row.email, displayName: row.displayName, role: row.role };
}

/**
 * What the client renders from. It carries the role so the interface can *hide* what a member
 * cannot do — it is never what permits anything, because the client holds no decision
 * (docs/prd.md, 3.1.5).
 */
export function describeActor(actor: Actor): SessionUser {
  return { id: actor.id, email: actor.email, displayName: actor.displayName, role: actor.role };
}

/**
 * The evaluation. `action` is a plain `string` on purpose: an unknown action must be answerable at
 * runtime, and answerable with `false`.
 */
export function can(actor: Actor | null, action: string, _resource?: PolicyResource): boolean {
  if (actor === null) return false;
  if (!isPolicyAction(action)) return false;
  return RULES[action][actor.role] === true;
}
