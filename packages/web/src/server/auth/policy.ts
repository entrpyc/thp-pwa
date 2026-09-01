import type { Role, SessionUser } from '@thp/shared';
import type { UserRow } from '@thp/db';

/**
 * **The single place `(actor, action, resource)` is evaluated.**
 *
 * This is one of the three structures core-listening scope prd § Rationale names as making this epic
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
   * **Correcting the two things an admin typed at the upload** ([3.2.16](docs/project/prd.md)) —
   * the title and the date recorded.
   *
   * Its own action rather than a widening of `recording.upload`, and the split is the one every
   * pair above takes: putting a teaching into the product and correcting what an existing one is
   * called are the same question only while there are two roles. The day a Contributor may fix a
   * misheard title without being able to add a teaching — or the reverse — is the day it stops
   * being decoration.
   *
   * Deliberately **not** `recording.publish`: renaming a live teaching leaves it live, and moving
   * its date changes where it sits in the library rather than whether anybody may see it.
   */
  'recording.edit',
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
  /**
   * The two Story 5 actions, split for the reason every group above is: correcting what the machine
   * misheard and spending a provider call to re-draft the summary from the corrected words are the
   * same question only while there are two roles.
   *
   * `transcript.correct` is admin-only **in this epic**; [3.5.5](docs/project/prd.md) widens it to
   * Contributor when that role arrives, and widening it is one case in the table below — which is
   * the whole of what an action in this list costs and the whole of what it buys.
   */
  'transcript.correct',
  'summary.regenerate',
  /**
   * **The five series actions** (Story 6). Five rather than one `series.manage`, and the same split
   * every group above takes: naming a study, wording it, and deciding which teaching belongs to it
   * are the same question only while there are two roles.
   *
   * The split is not decoration here. Widening series management to Contributor is one of the four
   * cases core-listening scope tdd § Extension points already names, and
   * "widen four cases" is only true if the cases exist to be widened.
   *
   * `series.list` / `series.browse` are the `recording.list` / `recording.browse` pair again, and
   * they mean the same two things: *see the console's list of every series* and *read the series a
   * member may read*. One route answers both, and which answer it gives is decided by the surface
   * parameter plus this pair — never by a role read at the call site.
   */
  'series.create',
  'series.update',
  'series.assign',
  'series.list',
  'series.browse',
  /**
   * **Setting a series' cover** (scope tdd 1.5), and its own action rather than more of
   * `series.update`. The split is the one every pair above takes: naming a study and giving it a
   * face are the same question only while there are two roles, and
   * [3.1](docs/project/prd.md)'s role table already points at the day they part — a Contributor
   * manages series *and series artwork*, and either could arrive without the other.
   *
   * One action covers both calls of the upload, because they are two halves of one act: a grant
   * nobody may finalise is a grant nobody should have been given.
   */
  'series.artwork',
  /**
   * **The two note actions this scope's first group needs** (active-scope architecture § 8).
   *
   * Two rather than one `note.use`, and the same split every group above takes: reading what the
   * group has written and adding to it are the same question only while both roles answer it the
   * same way. The six that moderate, edit, delete, react and pin arrive with the tasks that need
   * them — an action with no route behind it is a rule nobody can see fail.
   *
   * Both roles, on the same terms (scope prd 3.1.12): nothing about writing a
   * note differs by role, and nothing about reading one does either. **What a member sees through
   * `note.read` is the query's answer, not this one** — the private-note condition lives in
   * `packages/db/src/notes.ts` and an admin is not a caller it bends for.
   */
  'note.read',
  'note.write',
  /**
   * **The six the rest of the scope needs** (active-scope architecture § 8), and the split is the
   * habit every group above follows rather than an exception to it.
   *
   * `note.edit` and `note.delete` are the product's second and third **owned** actions: permitted
   * on what you wrote and on nothing else, with the comparison inside the rule rather than at a
   * route. They are two rather than one `note.own`, because the day the two part is the day
   * `note.moderate` arrives — and it already has: an admin may delete a member's note and may not
   * rewrite it (scope prd 3.6.2), which is one action widened and one left alone.
   *
   * `note.pin` and `note.unpin` are two for the reason `recording.publish` / `unpublish` are two.
   * They were arguably one while re-pinning was how a pin got replaced; with any number of pins
   * allowed that is gone, and lowering something the whole group was reading first is its own act.
   */
  'note.edit',
  'note.delete',
  'note.moderate',
  'note.react',
  'note.pin',
  'note.unpin',
  /**
   * **Editing a teaching's chapters in place** ([3.22.7](docs/project/prd.md),
   * [3.19.14](docs/project/prd.md)) — retitling one, rewriting its summary, moving a boundary,
   * splitting a chapter in two, merging two adjacent ones.
   *
   * **One action for all five**, which is a departure from the split every group above takes, and
   * the departure is deliberate. Those groups are split because the day two roles answer their
   * questions differently is foreseeable — a Contributor who may watch the pipeline without
   * re-running it, who may read the queue without approving it. Here there is no such day:
   * [3.22.7](docs/project/prd.md) grants all five to Admin *and* Contributor in one sentence, and
   * nothing in the requirements points at a role that may rename a chapter but not move its
   * boundary. Splitting it into five would be five rules that widen together forever, which is
   * decoration rather than a seam.
   *
   * There is deliberately **no `chapter.read`**. Chapters ride the recording's publication
   * ([3.22.6](docs/project/prd.md)), so reading them is `recording.browse` — the same action the
   * teaching, its transcript and its scripture are behind. A second action would be a second gate,
   * which is exactly what 3.22.6 refuses.
   */
  'chapter.edit',
] as const;

export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** Who is asking. Built by {@link toActor} from a row the session module re-read this request. */
export interface Actor {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  /**
   * The speed this account plays teachings at (Story 4 Ticket 03). Not an authorisation input and
   * never consulted by {@link can} — it is here because the member layout renders the transport bar
   * server-side and has to hand the player a starting rate, and the alternative is a second
   * round trip on every page load to fetch one number the session lookup already read.
   */
  readonly preferredPlaybackSpeed: number;
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
  // Correcting the title and the date recorded. Operator work: a member reads both fields and
  // writes neither, and a display name is the only text in this product its subject may change.
  'recording.edit': { roles: { admin: true, member: false } },
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
  // Fixing a misheard name, and asking for a summary built on the fix. A member reads the
  // transcript and does not write to it — refused by the API, not merely absent from the screen.
  'transcript.correct': { roles: { admin: true, member: false } },
  'summary.regenerate': { roles: { admin: true, member: false } },
  // Naming a study, wording it, and putting a teaching into it. Admin-only **in this epic**;
  // [3.3.6](docs/project/prd.md) widens all three to Contributor when that role arrives, and
  // widening them is three lines here and nothing else anywhere.
  'series.create': { roles: { admin: true, member: false } },
  'series.update': { roles: { admin: true, member: false } },
  'series.assign': { roles: { admin: true, member: false } },
  // The console's reading of the series list. The same question `recording.list` asks about
  // teachings, and it is not what admits a member to the series screens.
  'series.list': { roles: { admin: true, member: false } },
  // Both roles, exactly as `recording.browse`. What a member sees through it is decided by the
  // visibility condition, not here — the policy answers "may this person ask", and the query
  // answers "about which rows".
  'series.browse': { roles: { admin: true, member: true } },
  // Giving a study a face. Admin-only **in this scope** — the Contributor role that
  // [3.1](docs/project/prd.md) grants series artwork to does not exist in the enum yet, so this is
  // the only reachable answer, and widening it is one line the day it does.
  'series.artwork': { roles: { admin: true, member: false } },
  // Both roles, on the same terms. Reading a teaching's notes and writing one are the two things
  // every member of a study group does with notes, and an admin does them as a member does — the
  // moderation actions this scope adds later are where the roles part.
  'note.read': { roles: { admin: true, member: true } },
  'note.write': { roles: { admin: true, member: true } },
  // Both roles, and only over what they wrote. `requiresOwnership` is what refuses **an admin**
  // editing a member's note (3.5.6, 3.6.2) with no special case written anywhere: moderation is
  // deletion, never rewriting somebody's words.
  'note.edit': { roles: { admin: true, member: true }, requiresOwnership: true },
  'note.delete': { roles: { admin: true, member: true }, requiresOwnership: true },
  // Admin alone, and the only note action that is logged. `note.delete` above falls through to
  // this one when ownership denies, which is what makes "author or admin" two policy answers
  // rather than an id comparison at a route — and makes 3.6.4's audit condition exactly "the
  // second question was the one that answered".
  'note.moderate': { roles: { admin: true, member: false } },
  // Both roles, on the same terms. Which notes take a reaction is a resource-state question the
  // service answers (a private note takes none), never this one.
  'note.react': { roles: { admin: true, member: true } },
  // Admin alone. Raising a note changes what the whole group reads first, and lowering one takes
  // that away — the `recording.publish` / `unpublish` split, for the same reason.
  'note.pin': { roles: { admin: true, member: false } },
  'note.unpin': { roles: { admin: true, member: false } },
  // Admin alone **in this scope**. [3.22.7](docs/project/prd.md) grants chapter editing to
  // Contributor as well, and that role does not exist in the enum yet — so this is the only
  // reachable answer, and widening it is one word the day it does.
  'chapter.edit': { roles: { admin: true, member: false } },
};

export function isPolicyAction(value: string): value is PolicyAction {
  return (POLICY_ACTIONS as readonly string[]).includes(value);
}

/** The account row, as the rest of the request is allowed to see it. */
export function toActor(row: UserRow): Actor {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    preferredPlaybackSpeed: row.preferredPlaybackSpeed,
  };
}

/**
 * What the client renders from. It carries the role so the interface can *hide* what a member
 * cannot do — it is never what permits anything, because the client holds no decision
 * (docs/project/prd.md, 3.1.5).
 */
export function describeActor(actor: Actor): SessionUser {
  return {
    id: actor.id,
    email: actor.email,
    displayName: actor.displayName,
    role: actor.role,
    preferredPlaybackSpeed: actor.preferredPlaybackSpeed,
  };
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
