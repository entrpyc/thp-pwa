import type { Role, SessionUser } from '@thp/shared';
import type { UserRow } from '@thp/db';

/**
 * **The single place `(actor, action, resource)` is evaluated.**
 *
 * This is one of the three structures docs/epics/epic-core-listening/prd.md § Rationale names as making this epic
 * throwaway if skipped: Contributor arriving in a later epic is one enum value plus four widened
 * cases *only if* every check in the product goes through here. Nothing else in `src/` is allowed
 * to read a role or compare against one — tools/role-usage.ts fails the build if anything does,
 * which is why this file is also where an actor is built and where an actor is turned into the
 * payload the client renders from.
 *
 * Two properties the tests pin:
 *
 * - **Denies by default.** An action nobody has written a rule for is refused, not permitted, and
 *   not an exception.
 * - **Exhaustive over roles.** Every rule in {@link RULES} answers per role in a `Record<Role,
 *   boolean>`, so adding a role to the enum stops the build until every action says what that role
 *   may do. That is what turns "widen four cases" from a search of the codebase into a compiler
 *   error.
 * - **Ownership is a rule, not a comparison.** From ticket 4 an action may be conditioned on the
 *   actor owning the resource, and that condition lives in the table below rather than at any call
 *   site.
 */

/**
 * Every action the API can be asked to authorise. Ticket 2 shipped three, ticket 3 added four and step
 * 4 adds five; each later ticket adds the actions it needs alongside the routes that use them.
 */
export const POLICY_ACTIONS = [
  /** Read the signed-in account. Any session may. */
  'session.read',
  /** Exercise the diagnostics routes the integration suite drives. */
  'diagnostics.run',
  /** The admin-only diagnostic, which exists so "the API refuses, not the client" is testable. */
  'diagnostics.admin',
  /**
   * The four invitation actions (ticket 3). Four rather than one `invitation.manage`, because the
   * roles that may issue and the roles that may merely *see* who is pending are the same question
   * only for as long as there are two roles — and Contributor arriving is supposed to be four
   * widened cases, not a rewrite of what one coarse action meant.
   */
  'invitation.issue',
  'invitation.list',
  'invitation.revoke',
  'invitation.resend',
  /**
   * The four admin account actions (ticket 4). Split for the same reason the invitation four are:
   * "who may see the member list" and "who may end somebody's access" are the same question only
   * while there are two roles.
   *
   * `role.assign` rather than `account.role.change`, because tools/role-usage.ts refuses a role
   * field access anywhere outside this module and reads the three-segment name as one. Naming the
   * action after the thing being assigned is the better name anyway.
   */
  'account.list',
  'account.deactivate',
  'account.reactivate',
  'role.assign',
  /**
   * **The first owned action in the product** (ticket 4). Editing a display name is permitted on your
   * own account and on nobody else's — including, deliberately, to an admin. Every later owned
   * thing (a note, a highlight, a progress row) is this same shape.
   */
  'profile.update',
  /**
   * The two recording actions (Story 2 Ticket 01). Two rather than one `recording.manage`, and the
   * same split the invitation four and the account four already take: "who may put a teaching into
   * the product" and "who may see what is in it" are the same question only while there are two
   * roles, and Contributor arriving is meant to be widened cases rather than a rewrite of what one
   * coarse action meant (docs/project/prd.md, 3.2.1 — admin-only *in this epic*).
   */
  'recording.upload',
  'recording.list',
  /**
   * The two pipeline actions (Story 2 Ticket 04–05), split for the reason every pair above is:
   * "who may see what the pipeline is doing" and "who may make it do it again" are the same
   * question only while there are two roles. Reading is a console panel; re-running spends money
   * at a provider and discards a transcript, and the day a Contributor may watch the first without
   * being able to press the second is the day that split stops being decoration.
   */
  'pipeline.read',
  'pipeline.rerun',
  /**
   * The three review-gate actions (Story 3 Tickets 02–03), split for the reason every group above
   * is: reading the queue, acting on an item, and spending a provider call to draft it again are
   * the same question only while there are two roles. The day a Contributor may read what is
   * waiting without being able to approve it, the split stops being decoration.
   */
  'review.list',
  'review.resolve',
  'review.regenerate',
  /**
   * Publishing, and the summary's own gate (Story 3 Ticket 04). Four rather than one
   * `recording.publish`, because a summary has a publication state the recording does not share
   * ([3.6.12](docs/project/prd.md)) — taking a summary down and taking a teaching down are not the
   * same act and should not be the same permission.
   */
  'recording.publish',
  'recording.unpublish',
  'summary.edit',
  'summary.unpublish',
  /**
   * **The first action in the product a member may take over somebody else's content.**
   *
   * Reading the published library. Deliberately not a widening of `recording.list`: that action is
   * "see the console's list of everything uploaded", and the two answer different questions about
   * the same rows — which is exactly why one route can serve both without a member ever seeing an
   * unpublished teaching or an object key.
   */
  'recording.browse',
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
 * What is being acted on.
 *
 * Ticket 2 shipped this parameter with nothing yet using it — nothing existed to own. Ticket 4 is where
 * it starts being read: `ownerId` is what {@link RULES}' ownership rules are evaluated against.
 * Having it from the start is why that change is one function here rather than a visit to every
 * call site.
 */
export interface PolicyResource {
  readonly kind: string;
  readonly id?: string;
  readonly ownerId?: string;
}

/**
 * One action's rule: which roles may take it, and whether it is additionally conditioned on the
 * actor owning the resource.
 *
 * `roles` is `Record<Role, boolean>` rather than `readonly Role[]`, deliberately — a list of
 * permitted roles still compiles when a role is added to the enum, and a record does not.
 *
 * `requiresOwnership` is a flag on the rule rather than a comparison at the call site. That is the
 * whole decision: the day a route compares `actor.id === resource.ownerId` itself is the day
 * ownership stops being one auditable table and becomes a convention spread across handlers, and
 * every owned thing this product will later have — a note, a highlight, a progress row — is the
 * same shape as this one.
 */
export interface PolicyRule {
  readonly roles: Record<Role, boolean>;
  readonly requiresOwnership?: true;
}

/**
 * The shape of {@link RULES}: one rule per action, with an answer per role inside it. Exported so
 * the exhaustiveness fixture (tests/fixtures/type-errors) can assert that property against the real
 * type rather than a restatement of it.
 */
export type PolicyRules = Record<PolicyAction, PolicyRule>;

const RULES: PolicyRules = {
  'session.read': { roles: { admin: true, member: true } },
  'diagnostics.run': { roles: { admin: true, member: true } },
  'diagnostics.admin': { roles: { admin: true, member: false } },
  // Members join by invitation; they do not issue one, and they do not get to read the list of
  // addresses somebody has invited. Refused by the API, not merely absent from an interface.
  'invitation.issue': { roles: { admin: true, member: false } },
  'invitation.list': { roles: { admin: true, member: false } },
  'invitation.revoke': { roles: { admin: true, member: false } },
  'invitation.resend': { roles: { admin: true, member: false } },
  // Ending or restoring somebody's access, and deciding what they may do, is operator work.
  'account.list': { roles: { admin: true, member: false } },
  'account.deactivate': { roles: { admin: true, member: false } },
  'account.reactivate': { roles: { admin: true, member: false } },
  'role.assign': { roles: { admin: true, member: false } },
  // Both roles, and only over themselves. An admin may end an account; an admin may not rename its
  // owner, because a display name is not an operator control.
  'profile.update': { roles: { admin: true, member: true }, requiresOwnership: true },
  // Uploading a teaching, and reading the admin list of everything uploaded. Admin-only in this
  // epic; nothing here is member-visible until Story 3 publishes it.
  'recording.upload': { roles: { admin: true, member: false } },
  'recording.list': { roles: { admin: true, member: false } },
  // Reading what the pipeline is doing, and running one step of it again. Operator work in this
  // epic; a member has nothing to see here and nothing to press.
  'pipeline.read': { roles: { admin: true, member: false } },
  'pipeline.rerun': { roles: { admin: true, member: false } },
  // The review gate is operator work whole: a member has nothing waiting on them, and a draft they
  // could read would be a draft nobody approved.
  'review.list': { roles: { admin: true, member: false } },
  'review.resolve': { roles: { admin: true, member: false } },
  'review.regenerate': { roles: { admin: true, member: false } },
  // Deciding what is live, and deciding what the summary of a live teaching says.
  'recording.publish': { roles: { admin: true, member: false } },
  'recording.unpublish': { roles: { admin: true, member: false } },
  'summary.edit': { roles: { admin: true, member: false } },
  'summary.unpublish': { roles: { admin: true, member: false } },
  // Both roles. What a member sees through it is decided by the visibility condition, not here —
  // the policy answers "may this person ask", and the query answers "about which rows".
  'recording.browse': { roles: { admin: true, member: true } },
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
 * (docs/project/prd.md, 3.1.5).
 */
export function describeActor(actor: Actor): SessionUser {
  return { id: actor.id, email: actor.email, displayName: actor.displayName, role: actor.role };
}

/**
 * The evaluation. `action` is a plain `string` on purpose: an unknown action must be answerable at
 * runtime, and answerable with `false`.
 *
 * Two gates, in order. The role gate is the one every action has had since ticket 2. The ownership
 * gate applies only to actions whose rule asks for it, and it **denies when no resource is
 * given** — an owned action asked in the abstract has no owner to compare against, and answering
 * `true` there would make "permitted on your own" mean "permitted".
 */
export function can(actor: Actor | null, action: string, resource?: PolicyResource): boolean {
  if (actor === null) return false;
  if (!isPolicyAction(action)) return false;

  const rule = RULES[action];
  if (rule.roles[actor.role] !== true) return false;
  if (rule.requiresOwnership !== true) return true;

  return resource !== undefined && resource.ownerId === actor.id;
}
