import { and, asc, eq, exists, not, or, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { getDatabase, queryable, type Executor } from './client';
import { memberBlock, user } from './schema';

/**
 * **The block condition, written once** — and the two questions it answers.
 *
 * A member who has blocked another, or been blocked by them, should neither see that member's
 * content nor be able to act on theirs. Every read of member-written content states that rule
 * through {@link blockBetween}, and every write that aims one member at another's content asks
 * {@link isBlockedEitherWay} before it goes ahead. This module is the only place the
 * `member_block` table is read, so "respects blocking" is a property of calling one of these two
 * rather than of every query remembering a join.
 *
 * **Symmetric by decision.** A block hides each member from the other, whichever of them pressed
 * the control: `blockBetween(a, b)` and `blockBetween(b, a)` are the same condition. The
 * alternative — the blocker stops seeing the blocked, and the blocked carries on seeing the
 * blocker but is refused when they try to act — tells the blocked member they were blocked at
 * the moment they press Reply, which is the worst moment to learn it. One symmetric condition
 * also means a thread cannot be half-visible: if A cannot see B's note, B cannot see A's reply
 * under it.
 *
 * **Where the later features call it:**
 *
 * - **SOS signals** ([3.16](docs/project/prd.md)): the list of open and resolved signals, the
 *   replies under a signal and the "praying" count are reads of member content, so each `where`
 *   takes `not(blockBetween(viewerId, <author column>))` exactly as `sos.ts` does. Raising a
 *   signal broadcasts to everybody (3.16.3) **less anybody blocked either way with the author**
 *   (`insertNotificationForSosAudience`): the list read hides the signal from them, so a notice
 *   would be a press that lands on nothing. A reply to a signal is a write aimed at its author;
 *   the signal is already `not_found` to a member blocked either way, and 3.16.7's notification
 *   asks {@link isBlockedEitherWay} once more before it is written.
 * - **Push notifications** ([3.17.1](docs/project/prd.md)): push is a second delivery of the same
 *   rows the in-app centre already writes, so the suppression in
 *   `packages/web/src/server/notifications/service.ts` already covers it — a notification that is
 *   never written is never pushed. A push path that composes its own message about one member's
 *   act on another's content, without going through `insertNotification`, must ask
 *   {@link isBlockedEitherWay} itself before sending.
 *
 * **Crosses its boundary as row types in and row types out**, plus an {@link Executor}, like
 * every module beside it. Drizzle never leaves the package — {@link blockBetween} is the one
 * export that is a query fragment, and it is consumed only by sibling modules in this package.
 */

/** One `member_block` row. */
export interface MemberBlockRow {
  readonly blockerId: string;
  readonly blockedId: string;
  readonly createdAt: Date;
}

/** A blocked member as the blocked list shows them: who, by name, and since when. */
export interface BlockedMemberRow {
  readonly id: string;
  readonly displayName: string;
  readonly blockedAt: Date;
}

const BLOCK_COLUMNS = {
  blockerId: memberBlock.blockerId,
  blockedId: memberBlock.blockedId,
  createdAt: memberBlock.createdAt,
} as const;

// =================================================================================================
// The predicate
// =================================================================================================

/**
 * **A block exists between the viewer and the member this column names, in either direction.**
 *
 * A correlated `exists` rather than a join, for the reason `hasLiveReply` in `notes.ts` is one:
 * the answer is needed as a *condition* on a row, the enclosing statement stays one index scan,
 * and nothing about the block — not even its direction — reaches the caller. Reads state it
 * negated: `not(blockBetween(readerId, note.authorId))` keeps every row whose author the reader
 * has no block with.
 *
 * `other` is a column rather than an id because the question is asked of every row a statement
 * is selecting, and the member it is about is on the row. For the one-pair question a write
 * asks, {@link isBlockedEitherWay} wraps this with a literal.
 *
 * Both directions are spelled as two `or`-ed comparisons against the primary key and the
 * `blocked_id` index rather than as `least/greatest` tricks, so each half is an index lookup.
 *
 * Built on a standalone {@link QueryBuilder} rather than on the pool's handle, because it is a
 * fragment and not a statement: nothing here runs, and a fragment that needed a connection to be
 * *spelled* could not be unit-tested without one (packages/db/tests/unit/member-blocks.test.ts).
 */
export function blockBetween(viewerId: string, other: AnyPgColumn | SQL): SQL {
  return exists(
    new QueryBuilder()
      .select({ one: sql`1` })
      .from(memberBlock)
      .where(
        or(
          and(eq(memberBlock.blockerId, viewerId), sql`${memberBlock.blockedId} = ${other}`),
          and(sql`${memberBlock.blockerId} = ${other}`, eq(memberBlock.blockedId, viewerId)),
        ),
      ),
  );
}

/**
 * **One direction only: the viewer placed a block on the member this column names.**
 *
 * The half of {@link blockBetween} that is the viewer's own choice. On its own it is the
 * predicate a *moderator* reads under ({@link visibleAcrossBlocks}): an admin who blocked a member
 * has chosen not to see them, and that choice stands, but a member who blocked an admin must not
 * thereby hide their posts from moderation (docs/security-audit-2026-10-29.md, finding 5).
 */
export function blockPlacedByViewer(viewerId: string, other: AnyPgColumn | SQL): SQL {
  return exists(
    new QueryBuilder()
      .select({ one: sql`1` })
      .from(memberBlock)
      .where(and(eq(memberBlock.blockerId, viewerId), sql`${memberBlock.blockedId} = ${other}`)),
  );
}

/**
 * **One direction only: the member this column names placed a block on the viewer.**
 *
 * The other half of {@link blockBetween}, and the only half an **anonymous** prayer request may
 * be hidden by (`sos.ts`). Hiding an anonymous signal because the *viewer* blocked its author
 * would let any member learn who raised it — block a candidate, reload, watch whether the request
 * vanishes (docs/security-audit-2026-10-29.md, finding 2). The author's own block against the
 * viewer carries no such information, because the viewer can see nothing of the author's to
 * compare against.
 */
export function blockPlacedAgainstViewer(viewerId: string, other: AnyPgColumn | SQL): SQL {
  return exists(
    new QueryBuilder()
      .select({ one: sql`1` })
      .from(memberBlock)
      .where(and(sql`${memberBlock.blockerId} = ${other}`, eq(memberBlock.blockedId, viewerId))),
  );
}

/**
 * **Who is reading**, as far as the block rule is concerned: the account, and whether it reads as
 * a moderator of the content in question — which the policy module decides and the data layer is
 * merely told.
 */
export interface BlockViewer {
  readonly id: string;
  /**
   * `true` when the caller holds the `*.moderate` action for what is being read. A moderator's own
   * blocks still apply; blocks placed *against* a moderator do not, so a member cannot hide a post
   * from the people the group asked to judge it.
   */
  readonly moderator: boolean;
}

/**
 * The content of the member this column names **is visible to this viewer** under the block rule:
 * {@link noBlockBetween} for a member, and only the viewer's own blocks for a moderator.
 */
export function visibleAcrossBlocks(viewer: BlockViewer, other: AnyPgColumn | SQL): SQL {
  return viewer.moderator
    ? not(blockPlacedByViewer(viewer.id, other))
    : not(blockBetween(viewer.id, other));
}

/**
 * Whether these two members have a block between them, whichever of them placed it.
 *
 * The write-path spelling of {@link blockBetween}: a reply, a reaction, an SOS reply or a direct
 * notification is one member acting on one other member's content, and the service asks this
 * before it lets the act through — and before it writes the notice the act would have raised.
 *
 * Two equal ids answer `false` without a statement: a member cannot block themselves, so the
 * table cannot hold such a row, and a member acting on their own content is never a block
 * question.
 */
export async function isBlockedEitherWay(
  memberId: string,
  otherId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  if (memberId === otherId) return false;
  const rows = await queryable(executor).execute<{ blocked: boolean }>(
    sql`select ${blockBetween(memberId, sql`${otherId}::uuid`)} as blocked`,
  );
  return rows[0]?.blocked === true;
}

// =================================================================================================
// Writing
// =================================================================================================

/**
 * Block a member, or leave them blocked.
 *
 * `on conflict do nothing`, which is what makes a second press idempotent rather than a refusal:
 * a member pressing Block on a stale screen has still got what they asked for. Answers whether a
 * row was written, which the service logs and nothing else reads. A self-block reaches the check
 * constraint only if the service's own refusal was bypassed.
 */
export async function insertMemberBlock(
  blockerId: string,
  blockedId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .insert(memberBlock)
    .values({ blockerId, blockedId })
    .onConflictDoNothing({ target: [memberBlock.blockerId, memberBlock.blockedId] })
    .returning({ blockerId: memberBlock.blockerId });
  return rows.length > 0;
}

/**
 * Unblock a member. Deleting nothing is a success, not an error, for the reason
 * `clearNoteReaction` gives: the member asked for an end state and has it.
 */
export async function deleteMemberBlock(
  blockerId: string,
  blockedId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .delete(memberBlock)
    .where(and(eq(memberBlock.blockerId, blockerId), eq(memberBlock.blockedId, blockedId)))
    .returning({ blockerId: memberBlock.blockerId });
  return rows.length > 0;
}

/**
 * **Carry the blocks others hold against a leaving member over to their placeholder** — the
 * account-deletion step for this table (`account-deletion.ts`; README.md beside the schema).
 *
 * `blocked_id` cascades with the account, and the person's public notes are re-pointed at the
 * placeholder before the row goes. Left alone, the two together would mean that a reader who had
 * blocked the author sees those same notes again the moment the author leaves, as "Removed
 * member" (docs/security-audit-2026-10-28.md, finding 15) — a block the reader placed, undone by
 * something the other person did. So each block *against* the person is written again against the
 * placeholder, keeping its date, and the originals go with the cascade. Blocks the person
 * themselves placed go: there is no reader left for them to protect.
 *
 * `on conflict do nothing` because a placeholder is fresh and has never been blocked, but the
 * statement should not be the one place that assumes it. Answers how many were carried over.
 */
export async function reassignBlocksAgainst(
  deletedId: string,
  placeholderId: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const rows = await queryable(executor).execute<{ blocker_id: string }>(sql`
    insert into ${memberBlock} (blocker_id, blocked_id, created_at)
    select ${memberBlock.blockerId}, ${placeholderId}::uuid, ${memberBlock.createdAt}
    from ${memberBlock}
    where ${memberBlock.blockedId} = ${deletedId}
    on conflict do nothing
    returning blocker_id
  `);
  return rows.length;
}

// =================================================================================================
// Reading
// =================================================================================================

/** One `member_block` row by its pair, or `null`. A test's read; the services ask the predicate. */
export async function findMemberBlock(
  blockerId: string,
  blockedId: string,
  executor: Executor = getDatabase(),
): Promise<MemberBlockRow | null> {
  const rows = await queryable(executor)
    .select(BLOCK_COLUMNS)
    .from(memberBlock)
    .where(and(eq(memberBlock.blockerId, blockerId), eq(memberBlock.blockedId, blockedId)));
  return (rows[0] as MemberBlockRow | undefined) ?? null;
}

/**
 * The members this one has blocked, **by display name**, A to Z — the blocked list in profile
 * settings. Only the blocker's own direction: who has blocked *them* is nobody's to list.
 *
 * An inner join, because `blocked_id` cascades with the account and so always has a row to join
 * to; a deactivated account still appears, by the name it had, because its notes are still on the
 * teachings and the block is what keeps them away.
 */
export async function listBlockedMembers(
  blockerId: string,
  executor: Executor = getDatabase(),
): Promise<BlockedMemberRow[]> {
  const rows = await queryable(executor)
    .select({
      id: user.id,
      displayName: user.displayName,
      blockedAt: memberBlock.createdAt,
    })
    .from(memberBlock)
    .innerJoin(user, eq(memberBlock.blockedId, user.id))
    .where(eq(memberBlock.blockerId, blockerId))
    .orderBy(asc(user.displayName), asc(user.id));
  return rows as BlockedMemberRow[];
}

/** The reads below want it negated; exported so sibling modules spell it one way. */
export function noBlockBetween(viewerId: string, other: AnyPgColumn | SQL): SQL {
  return not(blockBetween(viewerId, other));
}
