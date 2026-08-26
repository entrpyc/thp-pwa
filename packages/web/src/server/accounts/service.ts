import {
  deactivateUser,
  listUsers,
  reactivateUser,
  revokePasswordResetsForUser,
  revokeSessionsForUser,
  setUserRole,
  updateDisplayName,
  type GuardedWrite,
  type UserRow,
} from '@thp/db';
import {
  checkDisplayName,
  isRole,
  type AccountSummary,
  type Role,
  type UpdateAccountRequest,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { authorise } from '@/server/auth/authorise';
import { describeActor, toActor, type Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

/**
 * The admin half of the account lifecycle — listing, deactivating, reactivating, changing a role —
 * and the one self-service half, editing your own display name.
 *
 * There is no interface for any of it yet; core-listening scope plan § Ticket 5 builds the console
 * over exactly these calls, exactly as it will over ticket 3's. Every rule below is therefore
 * asserted against the **API**, because that is what has to hold against a direct request.
 *
 * Three things this module is careful about:
 *
 * 1. **Deactivation is not deletion.** The row, its password hash and everything it authored stay
 *    where they are (docs/project/prd.md, 3.1.7). What changes is that no session resolves to it, no
 *    password signs it in, and any reset it had in flight stops working.
 * 2. **The last-admin invariant belongs to the write.** This module reports the refusal; it does
 *    not decide it. The decision is a conditional write in `@thp/db`, because a count taken here and
 *    an update issued afterwards has a window in which two admins remove each other.
 * 3. **Ownership is the policy module's answer, not this one's.** `profile.update` is refused by
 *    `can` reading the resource, which is why an admin editing somebody else's name is refused by
 *    the same mechanism a member is, rather than by a special case here.
 */

/** The most a field can be before we stop reading it. */
const MAX_FIELD_LENGTH = 512;

/**
 * The row as an admin is allowed to see it.
 *
 * Built on `describeActor`, which is the only function permitted to read a role off a row
 * (tools/role-usage.ts) — so "the listing carries no password hash" is a property of the payload
 * type and of where it is assembled, not of this function remembering to leave a column out.
 */
export function describeAccount(row: UserRow): AccountSummary {
  const { id, email, displayName, role } = describeActor(toActor(row));
  return {
    id,
    email,
    displayName,
    role,
    active: row.deactivatedAt === null,
    deactivatedAt: row.deactivatedAt === null ? null : row.deactivatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAllAccounts(actor: Actor): Promise<AccountSummary[]> {
  const rows = await listUsers();
  logger.info('account.list', {
    actorId: actor.id,
    action: 'account.list',
    target: 'account:*',
    count: rows.length,
  });
  return rows.map(describeAccount);
}

/**
 * Turn a guarded write's outcome into what the caller is told.
 *
 * `last-admin` gets its own code and a message naming the invariant, so an operator reads a
 * guardrail rather than a bug: the fix is to promote somebody first, and the refusal says so.
 * `unchanged` is a conflict rather than a silent success, so a console cannot report an action it
 * did not take.
 */
function settle(
  result: GuardedWrite,
  actor: Actor,
  action: string,
  targetId: string,
  conflictMessage: string,
): UserRow {
  if (result.outcome === 'no-such-account') {
    throw ApiError.notFound('No such account.');
  }

  if (result.outcome === 'last-admin') {
    logger.warn('account.refused', {
      actorId: actor.id,
      actorEmail: actor.email,
      action,
      target: `account:${targetId}`,
      reason: 'last-active-admin',
      code: 'last_admin',
    });
    throw ApiError.lastAdmin();
  }

  if (result.outcome === 'unchanged') {
    logger.warn('account.refused', {
      actorId: actor.id,
      actorEmail: actor.email,
      action,
      target: `account:${targetId}`,
      reason: 'already-in-that-state',
      code: 'account_state_conflict',
    });
    throw ApiError.accountStateConflict(conflictMessage);
  }

  logger.info(action, {
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    target: `account:${targetId}`,
  });
  return result.user;
}

/**
 * End an account's access (docs/project/prd.md, 3.1.7).
 *
 * The sessions are revoked **immediately**, not at the next expiry — that is the behaviour
 * core-listening scope tdd § Data model says server-side sessions exist to make possible, and
 * with a 30-day rolling window the difference between the two is a month. Any reset in flight is
 * revoked with them, so a link mailed a minute ago cannot be used to walk back in.
 */
export async function deactivateAccount(actor: Actor, id: string): Promise<AccountSummary> {
  const row = settle(
    await deactivateUser(id),
    actor,
    'account.deactivate',
    id,
    'That account is already deactivated.',
  );

  const endedSessions = await revokeSessionsForUser(id);
  const endedResets = await revokePasswordResetsForUser(id);
  logger.info('account.deactivate.revoked', {
    actorId: actor.id,
    action: 'account.deactivate',
    target: `account:${id}`,
    sessions: endedSessions,
    passwordResets: endedResets,
  });

  return describeAccount(row);
}

/**
 * Restore an account, after which it signs in again with the password it already had.
 *
 * docs/project/prd.md 3.1.7 names only deactivation. Reactivation is here because deactivation is a nullable
 * timestamp and the inverse is the same write, and because a console that can only ever disable
 * accounts is one mis-click away from a support ticket nobody can close.
 */
export async function reactivateAccount(actor: Actor, id: string): Promise<AccountSummary> {
  const row = settle(
    await reactivateUser(id),
    actor,
    'account.reactivate',
    id,
    'That account is already active.',
  );
  return describeAccount(row);
}

/**
 * `PATCH /api/v1/users/:id`. Two fields, authorised separately, because they are two different
 * questions: `role` is an operator acting on somebody else, and `displayName` is a person acting on
 * themselves.
 *
 * The route declares `SESSION` rather than `permits(...)`, because ownership is a fact about the
 * request and `permits` is evaluated when the module loads. The decision still happens in the policy
 * module — see `server/auth/authorise.ts` — and the refusal is logged with the same fields.
 */
export async function updateAccount(
  actor: Actor,
  id: string,
  body: unknown,
): Promise<AccountSummary> {
  const requested = parseUpdate(body);

  let row: UserRow | null = null;

  if (requested.displayName !== undefined) {
    // The first owned resource in the product. `can` compares `ownerId` against the actor; nothing
    // in this function compares an id, and that is the whole point of doing it here.
    authorise(actor, 'profile.update', `account:${id}`, {
      kind: 'profile',
      id,
      ownerId: id,
    });

    const weakness = checkDisplayName(requested.displayName);
    if (weakness !== null) throw ApiError.invalidInput(weakness);

    row = await updateDisplayName(id, requested.displayName);
    if (row === null) throw ApiError.notFound('No such account.');
    logger.info('profile.update', {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'profile.update',
      target: `account:${id}`,
    });
  }

  if (requested.assignedRole !== undefined) {
    authorise(actor, 'role.assign', `account:${id}`);

    const result = await setUserRole(id, requested.assignedRole);
    if (result.outcome === 'unchanged') {
      // Setting an account to the role it already holds reports the current state rather than an
      // error: an operator pressing "make member" on a member has not made a mistake, and a control
      // that is idempotent is one a console can safely retry after a lost response. Deactivation is
      // the opposite case on purpose — there, "already like that" is a conflict, because the admin
      // is being told an action happened that did not.
      logger.info('role.assign', {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'role.assign',
        target: `account:${id}`,
        changed: false,
      });
      row = result.user;
    } else {
      row = settle(result, actor, 'role.assign', id, 'That account already has that role.');
    }
  }

  // Unreachable: `parseUpdate` refuses a body carrying neither field, so one of the two branches
  // above has run. Stated rather than cast, so a future third field cannot fall through it silently.
  if (row === null) throw ApiError.invalidInput('Send a role or a display name to change.');

  return describeAccount(row);
}

/**
 * What was actually asked for. Separate from {@link UpdateAccountRequest} only because the wire type
 * describes a body somebody sends and this describes a body we have finished reading.
 */
interface ParsedUpdate {
  /**
   * Named for what it is rather than after the wire field, because tools/role-usage.ts refuses a
   * role field access outside the policy module. Carrying the value is fine; reaching for the
   * field by that name is what the rule stops, and renaming it here costs nothing.
   */
  assignedRole?: Role | undefined;
  displayName?: string | undefined;
}

/** `invalid_input` for anything the route does not accept, before any authorisation is asked. */
function parseUpdate(body: unknown): ParsedUpdate {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a role or a display name.');
  }
  const { role, displayName } = body as Partial<UpdateAccountRequest>;

  const parsed: ParsedUpdate = {};

  if (role !== undefined) {
    // `isRole` is the enum's own guard, so "only the roles this product has are acceptable" is a
    // property of the one place they are declared rather than a second list to keep in step with it.
    if (!isRole(role)) throw ApiError.invalidInput('Pick a role this product has.');
    parsed.assignedRole = role;
  }

  if (displayName !== undefined) {
    if (typeof displayName !== 'string' || displayName.length > MAX_FIELD_LENGTH) {
      throw ApiError.invalidInput('A display name is a string.');
    }
    parsed.displayName = displayName;
  }

  if (parsed.assignedRole === undefined && parsed.displayName === undefined) {
    throw ApiError.invalidInput('Send a role or a display name to change.');
  }

  return parsed;
}
