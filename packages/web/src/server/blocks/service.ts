import {
  deleteMemberBlock,
  findUserById,
  insertMemberBlock,
  listBlockedMembers,
  type BlockedMemberRow,
} from '@thp/db';
import type { BlockListPayload, BlockedMemberView } from '@thp/shared';
import { actorGuard } from '@/server/api/actor-limits';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';
import { clearSearchCache } from '@/server/search/cache';

/**
 * **A member's blocked list** — reading it, adding to it, taking from it.
 *
 * Who may is the policy module's answer, asked by the routes (`block.list`, `block.create`,
 * `block.remove`), and every one of the three is the caller's own list by construction: the id in
 * the path is the member being blocked, never whose list it is. What this module decides is the
 * two refusals a block can meet — yourself, and nobody — and what a write answers.
 *
 * **Every write answers the list as it now stands**, the shape every note write takes: a screen
 * that pressed Block or Unblock renders what came back rather than merging a verdict into a list
 * it fetched earlier.
 *
 * **What a block does is not here.** The hiding is `packages/db/src/notes.ts`'s `where` through
 * `member-blocks.ts`'s one predicate; the refusals are the notes service's; the silence is the
 * notifications service's. This module only keeps the list.
 */

/** The shape a member id has to have before it is worth a statement. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listBlocksFor(actor: Actor): Promise<BlockListPayload> {
  const rows = await listBlockedMembers(actor.id);
  return { blocked: rows.map(describe) };
}

/**
 * Block a member, or leave them blocked.
 *
 * Two refusals, in order. **Yourself** is `invalid_input`: no interface offers it, so a request
 * carrying it is malformed rather than unauthorised, and the check constraint behind it is the
 * backstop. **Nobody** is `not_found`, for an id that is not an account — and deliberately not
 * for a deactivated one: deactivation ends access, not authorship
 * ([3.1.7](docs/project/prd.md)), so that account's notes are still on the teachings and a
 * block is exactly what keeps them away.
 *
 * Blocking somebody already blocked succeeds and changes nothing, for the reason pinning does:
 * a member acting on a stale screen has still got what they asked for.
 */
export async function blockMemberFor(actor: Actor, memberId: string): Promise<BlockListPayload> {
  const target = await requireMember(actor, memberId);
  // Blocks are free and reversible, which is what made a loop of them an oracle over who wrote
  // what (docs/security-audit-2026-10-29.md, findings 2 and 8). The reads no longer answer that
  // question; the budget keeps the loop slow as well.
  actorGuard().spend('block', actor);

  const created = await insertMemberBlock(actor.id, target);
  logger.info('block.create', {
    actorId: actor.id,
    action: 'block.create',
    target: `user:${target}`,
    created,
  });
  // A search answered before the block would keep serving the blocked member's notes for a week
  // otherwise (finding 7): the cache is per process and cheap to refill.
  if (created) clearSearchCache();

  return listBlocksFor(actor);
}

/**
 * Unblock a member. Unblocking somebody who was never blocked, or an id that is nobody, succeeds:
 * the member asked for an end state — this account is not on my list — and has it. Only a
 * malformed id is refused, because it is not an end state anybody can be in.
 */
export async function unblockMemberFor(
  actor: Actor,
  memberId: string,
): Promise<BlockListPayload> {
  const target = parseMemberId(memberId);

  const removed = await deleteMemberBlock(actor.id, target);
  logger.info('block.remove', {
    actorId: actor.id,
    action: 'block.remove',
    target: `user:${target}`,
    removed,
  });

  return listBlocksFor(actor);
}

/** The id as a uuid, or the refusal — before it reaches a statement that would throw on it. */
function parseMemberId(memberId: string): string {
  const trimmed = memberId.trim();
  if (!UUID.test(trimmed)) throw ApiError.invalidInput('That is not a member id.');
  return trimmed.toLowerCase();
}

/** A member who exists and is not the caller, or the refusal. */
async function requireMember(actor: Actor, memberId: string): Promise<string> {
  const target = parseMemberId(memberId);
  if (target === actor.id) {
    throw ApiError.invalidInput('You cannot block yourself.');
  }
  const row = await findUserById(target);
  if (row === null) throw ApiError.notFound('There is no member with that id.');
  return row.id;
}

function describe(row: BlockedMemberRow): BlockedMemberView {
  return { id: row.id, displayName: row.displayName, blockedAt: row.blockedAt.toISOString() };
}
