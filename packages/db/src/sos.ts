import { and, asc, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import {
  blockPlacedAgainstViewer,
  noBlockBetween,
  visibleAcrossBlocks,
  type BlockViewer,
} from './member-blocks';
import { notification, sosPraying, sosReply, sosSignal, user } from './schema';
import { SOS_URGENCIES, type SosUrgency } from '@thp/shared';

/**
 * **SOS signals at the database** ([3.16](docs/project/prd.md); [4.15](docs/project/prd.md)).
 *
 * Every statement against `sos_signal`, `sos_praying` and `sos_reply` lives here. The module
 * answers *which rows* and never *may this person*: the service holds the policy, and what is
 * decided here is the shape of a read — which is where the rules the whole channel rests on are
 * stated, once each:
 *
 * - **The board's order** ([3.16.4](docs/project/prd.md)): most urgent first, then most recently
 *   raised. One `order by` over the urgency's rank and `raised_at`, in {@link listSosSignals}, and
 *   the client's comparator in `@thp/shared` says the same thing for a re-sort after a write.
 * - **The block rule** (`member-blocks.ts`): every read of member content takes the viewer's
 *   block predicate over the author column, so a signal, a reply or a name on the praying list by a
 *   member either side of a block is not read — not withheld later, not read. **With one carve-out
 *   for an anonymous signal** ({@link signalVisibleTo}): only a block the *author* placed may hide
 *   it, never one the viewer placed, because the viewer's own block would otherwise be an oracle
 *   over who the author is (docs/security-audit-2026-10-29.md, finding 2). The author's own
 *   replies under their anonymous signal are read under the same carve-out, for the same reason.
 * - **A moderator reads past blocks placed against them** (`BlockViewer.moderator`): an admin
 *   closing or removing a post the group reported must find it whoever blocked whom (finding 5).
 * - **A removed signal is not read** ({@link removeSosSignal}): removal is a mark on the row, not
 *   a delete, so the report that caused it, the replies other members wrote and the record of
 *   who removed what survive (finding 6). Every viewer read filters `removed_at is null`.
 *
 * **Counts ride on the row.** The board shows how many are praying and how many replied under
 * every signal, so the list read carries both as correlated subqueries rather than leaving the
 * service to make two more round trips per row. The praying count is **everybody's**, blocked or
 * not: a count is not a name, and 3.16.5's "how many members have done so" is a fact about the
 * signal rather than about who the reader may see.
 *
 * **Crosses its boundary as row types in and row types out**, plus an {@link Executor} so a
 * caller can pull a write into a transaction. Drizzle never leaves the package.
 */

/** Who is reading the channel: the account, and whether it reads as a moderator (`sos.moderate`). */
export type SosViewer = BlockViewer;

/** One `sos_signal` row. */
export interface SosSignalRow {
  readonly id: string;
  readonly authorId: string;
  readonly urgency: SosUrgency;
  readonly description: string;
  readonly anonymous: boolean;
  readonly raisedAt: Date;
  readonly closedAt: Date | null;
  readonly closedBy: string | null;
  readonly closingNote: string | null;
  /** Set when an admin removed the request ([3.16.11](docs/project/prd.md)). Null while it stands. */
  readonly removedAt: Date | null;
  readonly removedBy: string | null;
}

/**
 * A signal as a list reads it: the row, the author's name and avatar key (one join rather than
 * N+1, as `notes.ts` does), the two counts, and whether the viewer is among those praying.
 */
export interface SosSignalListRow extends SosSignalRow {
  readonly authorDisplayName: string;
  readonly authorAvatarKey: string | null;
  readonly prayingCount: number;
  readonly replyCount: number;
  readonly praying: boolean;
  /** Whether the viewer's own Praying row, if any, is anonymous. */
  readonly prayingAnonymously: boolean;
}

export interface NewSosSignal {
  readonly authorId: string;
  readonly urgency: SosUrgency;
  readonly description: string;
  readonly anonymous: boolean;
}

/** One `sos_reply` row, with its author joined for the reason the signal's is. */
export interface SosReplyRow {
  readonly id: string;
  readonly signalId: string;
  readonly authorId: string;
  /** The top-level reply this one answers, or null for a reply to the signal itself. */
  readonly parentId: string | null;
  readonly text: string;
  readonly createdAt: Date;
  readonly authorDisplayName: string;
  readonly authorAvatarKey: string | null;
}

export interface NewSosReply {
  readonly signalId: string;
  readonly authorId: string;
  readonly parentId: string | null;
  readonly text: string;
}

const SIGNAL_COLUMNS = {
  id: sosSignal.id,
  authorId: sosSignal.authorId,
  urgency: sosSignal.urgency,
  description: sosSignal.description,
  raisedAt: sosSignal.raisedAt,
  closedAt: sosSignal.closedAt,
  closedBy: sosSignal.closedBy,
  closingNote: sosSignal.closingNote,
  anonymous: sosSignal.anonymous,
  removedAt: sosSignal.removedAt,
  removedBy: sosSignal.removedBy,
} as const;

const REPLY_COLUMNS = {
  id: sosReply.id,
  signalId: sosReply.signalId,
  authorId: sosReply.authorId,
  parentId: sosReply.parentId,
  text: sosReply.text,
  createdAt: sosReply.createdAt,
  authorDisplayName: user.displayName,
  authorAvatarKey: user.avatarKey,
} as const;

/**
 * Where an urgency sorts, as the database computes it — the shared tuple's own order, spelled as
 * an array literal so the rank is derived from one list rather than a `case` that restates it.
 */
const URGENCY_RANK = sql`array_position(${sql.raw(
  `array['${SOS_URGENCIES.join("','")}']::sos_urgency[]`,
)}, ${sosSignal.urgency})`;

// =================================================================================================
// The block predicates
// =================================================================================================

/**
 * **The author of an anonymous signal is visible to this viewer** unless the author blocked them.
 * Never the viewer's own block — the module comment says why — and for a moderator no block at
 * all: a member cannot hide what the group reported by blocking the people asked to judge it.
 */
function anonymousAuthorVisibleTo(viewer: SosViewer): SQL {
  return viewer.moderator ? sql`true` : sql`not ${blockPlacedAgainstViewer(viewer.id, sosSignal.authorId)}`;
}

/** **This signal is one the viewer may read**, under the block rule and its anonymous carve-out. */
function signalVisibleTo(viewer: SosViewer): SQL {
  return sql`(case when ${sosSignal.anonymous} then ${anonymousAuthorVisibleTo(viewer)} else ${visibleAcrossBlocks(viewer, sosSignal.authorId)} end)`;
}

/**
 * **This reply is one the viewer may read.** A reply by the signal's own author under their
 * anonymous signal takes the signal's carve-out, so the author's "thank you all" cannot be made
 * to vanish by a block the viewer placed; every other reply takes the ordinary rule. Needs
 * `sos_signal` in scope, joined or correlated.
 */
function replyVisibleTo(viewer: SosViewer): SQL {
  return sql`(case when ${sosSignal.anonymous} and ${sosReply.authorId} = ${sosSignal.authorId} then ${anonymousAuthorVisibleTo(viewer)} else ${visibleAcrossBlocks(viewer, sosReply.authorId)} end)`;
}

/** A standing signal: not removed by an admin. Every viewer read carries it. */
const STANDING = isNull(sosSignal.removedAt);

// =================================================================================================
// Signals
// =================================================================================================

export async function insertSosSignal(
  input: NewSosSignal,
  executor: Executor = getDatabase(),
): Promise<SosSignalRow> {
  const rows = await queryable(executor)
    .insert(sosSignal)
    .values({
      authorId: input.authorId,
      urgency: input.urgency,
      description: input.description,
      anonymous: input.anonymous,
    })
    .returning(SIGNAL_COLUMNS);
  const row = rows[0] as SosSignalRow | undefined;
  if (!row) throw new Error('insertSosSignal returned no row');
  return row;
}

/**
 * **Raise a signal under the cap** ([3.16.12](docs/project/prd.md)): count this author's open
 * signals and insert the new one in one transaction, serialised per author by an advisory lock,
 * so two raises in the same instant cannot both pass the count and leave the member at eleven
 * (docs/security-audit-2026-10-29.md, finding 17). Answers `null` when the cap is already met.
 */
export async function insertSosSignalUnderCap(
  input: NewSosSignal,
  cap: number,
  executor: Executor = getDatabase(),
): Promise<SosSignalRow | null> {
  return queryable(executor).transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sos-raise:${input.authorId}`}))`);
    if ((await countOpenSosSignalsByAuthor(input.authorId, tx)) >= cap) return null;
    return insertSosSignal(input, tx);
  });
}

/**
 * How many signals this member holds open — what the cap ([3.16.12](docs/project/prd.md)) counts.
 * A removed signal is nobody's to close, so it does not count against its author.
 */
export async function countOpenSosSignalsByAuthor(
  authorId: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const rows = await queryable(executor)
    .select({ count: sql<number>`count(*)::int` })
    .from(sosSignal)
    .where(and(eq(sosSignal.authorId, authorId), isNull(sosSignal.closedAt), STANDING));
  return rows[0]?.count ?? 0;
}

/**
 * The board's list for one viewer: every open signal, or every closed one, in the board's order,
 * less those the block rule hides from the viewer and less those an admin removed.
 */
export async function listSosSignals(
  input: { readonly viewer: SosViewer; readonly open: boolean },
  executor: Executor = getDatabase(),
): Promise<SosSignalListRow[]> {
  const rows = await queryable(executor)
    .select({
      ...SIGNAL_COLUMNS,
      authorDisplayName: user.displayName,
      authorAvatarKey: user.avatarKey,
      prayingCount: prayingCount(),
      replyCount: replyCount(input.viewer),
      praying: viewerPraying(input.viewer.id),
      prayingAnonymously: viewerPrayingAnonymously(input.viewer.id),
    })
    .from(sosSignal)
    .innerJoin(user, eq(sosSignal.authorId, user.id))
    .where(
      and(
        input.open ? isNull(sosSignal.closedAt) : isNotNull(sosSignal.closedAt),
        STANDING,
        signalVisibleTo(input.viewer),
      ),
    )
    .orderBy(asc(URGENCY_RANK), desc(sosSignal.raisedAt), desc(sosSignal.id));
  return rows as SosSignalListRow[];
}

/**
 * How many **open** signals there are at each urgency, for this viewer — the home card's four
 * chips, under the same block rule as the list so the chips never count a row the list would
 * not show.
 */
export async function countOpenSosSignalsByUrgency(
  viewer: SosViewer,
  executor: Executor = getDatabase(),
): Promise<Record<SosUrgency, number>> {
  const rows = await queryable(executor)
    .select({ urgency: sosSignal.urgency, count: sql<number>`count(*)::int` })
    .from(sosSignal)
    .where(and(isNull(sosSignal.closedAt), STANDING, signalVisibleTo(viewer)))
    .groupBy(sosSignal.urgency);
  const counts = Object.fromEntries(SOS_URGENCIES.map((one) => [one, 0])) as Record<
    SosUrgency,
    number
  >;
  for (const row of rows) counts[row.urgency as SosUrgency] = row.count;
  return counts;
}

/**
 * One signal as this viewer may read it, or `null` — for an id nobody has, for a signal an admin
 * removed **and** for a signal the block rule hides, which answer alike so the route discloses
 * none of the three.
 */
export async function findSosSignalForViewer(
  signalId: string,
  viewer: SosViewer,
  executor: Executor = getDatabase(),
): Promise<SosSignalListRow | null> {
  const rows = await queryable(executor)
    .select({
      ...SIGNAL_COLUMNS,
      authorDisplayName: user.displayName,
      authorAvatarKey: user.avatarKey,
      prayingCount: prayingCount(),
      replyCount: replyCount(viewer),
      praying: viewerPraying(viewer.id),
      prayingAnonymously: viewerPrayingAnonymously(viewer.id),
    })
    .from(sosSignal)
    .innerJoin(user, eq(sosSignal.authorId, user.id))
    .where(and(eq(sosSignal.id, signalId), STANDING, signalVisibleTo(viewer)))
    .limit(1);
  return (rows[0] as SosSignalListRow | undefined) ?? null;
}

/**
 * One signal by id, **with no block condition and removed or not** — a write path's precondition,
 * as `findNoteById` is: the service asks what state the signal is in before refusing an action on
 * it, and the reports console must still find a request it has already removed.
 */
export async function findSosSignalById(
  signalId: string,
  executor: Executor = getDatabase(),
): Promise<SosSignalRow | null> {
  const rows = await queryable(executor)
    .select(SIGNAL_COLUMNS)
    .from(sosSignal)
    .where(eq(sosSignal.id, signalId))
    .limit(1);
  return (rows[0] as SosSignalRow | undefined) ?? null;
}

/**
 * Close a signal ([3.16.8](docs/project/prd.md), [3.16.9](docs/project/prd.md)), and answer it as
 * it now reads — or `null` when it was already closed, so a second press on a stale screen is a
 * refusal the service can name rather than a silent rewrite of who closed it and when.
 */
export async function closeSosSignal(
  input: { readonly signalId: string; readonly closedBy: string; readonly note: string | null },
  executor: Executor = getDatabase(),
): Promise<SosSignalRow | null> {
  const rows = await queryable(executor)
    .update(sosSignal)
    .set({ closedAt: new Date(), closedBy: input.closedBy, closingNote: input.note })
    .where(and(eq(sosSignal.id, input.signalId), isNull(sosSignal.closedAt), STANDING))
    .returning(SIGNAL_COLUMNS);
  return (rows[0] as SosSignalRow | undefined) ?? null;
}

/**
 * Remove a signal ([3.16.11](docs/project/prd.md)) — **a mark, not a delete.** The row stays, with
 * who removed it and when, and so do the report that asked for it, the replies and the praying
 * rows: every viewer read filters the mark, so to the group the request is gone, while the
 * moderation record keeps its subject (docs/security-audit-2026-10-29.md, finding 6). What does go
 * is every bell entry that pointed at it, because a press on one would land on nothing.
 *
 * Answers whether there was a standing signal to remove: a second removal changes nothing.
 */
export async function removeSosSignal(
  input: { readonly signalId: string; readonly removedBy: string },
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const db = queryable(executor);
  const rows = await db
    .update(sosSignal)
    .set({ removedAt: new Date(), removedBy: input.removedBy })
    .where(and(eq(sosSignal.id, input.signalId), STANDING))
    .returning({ id: sosSignal.id });
  if (rows.length === 0) return false;
  await db.delete(notification).where(eq(notification.sosSignalId, input.signalId));
  return true;
}

/**
 * **Hand a leaving member's signals and replies to their placeholder** — the account-deletion
 * step for this channel (`account-deletion.ts`; README.md beside the schema). A prayer request is
 * a thread other members wrote into, and the cascade that used to take it took their words too
 * (docs/security-audit-2026-10-29.md, finding 6); re-pointing keeps the thread and names nobody,
 * exactly as a public note's re-pointing does. Answers how many of each moved.
 */
export async function reassignSosOfDeletedAuthor(
  authorId: string,
  placeholderId: string,
  executor: Executor = getDatabase(),
): Promise<{ readonly signals: number; readonly replies: number }> {
  const db = queryable(executor);
  const signals = await db
    .update(sosSignal)
    .set({ authorId: placeholderId })
    .where(eq(sosSignal.authorId, authorId))
    .returning({ id: sosSignal.id });
  const replies = await db
    .update(sosReply)
    .set({ authorId: placeholderId })
    .where(eq(sosReply.authorId, authorId))
    .returning({ id: sosReply.id });
  return { signals: signals.length, replies: replies.length };
}

// =================================================================================================
// Praying
// =================================================================================================

/**
 * Say this member is praying, named or not. Pressing again keeps the one row and its place in the
 * order, and takes the press's word on the name: a member who pressed with their name and presses
 * again without it has changed their mind, not pressed twice.
 */
export async function setSosPraying(
  input: { readonly signalId: string; readonly userId: string; readonly anonymous: boolean },
  executor: Executor = getDatabase(),
): Promise<void> {
  await queryable(executor)
    .insert(sosPraying)
    .values({ signalId: input.signalId, userId: input.userId, anonymous: input.anonymous })
    .onConflictDoUpdate({
      target: [sosPraying.signalId, sosPraying.userId],
      set: { anonymous: input.anonymous },
    });
}

/** Take it back. Clearing when nothing is set succeeds: the member asked for a state and has it. */
export async function clearSosPraying(
  input: { readonly signalId: string; readonly userId: string },
  executor: Executor = getDatabase(),
): Promise<void> {
  await queryable(executor)
    .delete(sosPraying)
    .where(and(eq(sosPraying.signalId, input.signalId), eq(sosPraying.userId, input.userId)));
}

/** One member praying, as the signal's page lists them: the name, and whether it may be printed. */
export interface SosPrayingRow {
  readonly userId: string;
  readonly displayName: string;
  readonly anonymous: boolean;
}

/**
 * Everybody praying for one signal, in the order they pressed, less those either side of a block
 * with the viewer — a name is member content; the count is not. The caller prints the named ones
 * and counts the rest. The ordinary rule, not the moderator's: a name on this list is never what
 * a report is about.
 */
export async function listSosPraying(
  signalId: string,
  viewerId: string,
  executor: Executor = getDatabase(),
): Promise<SosPrayingRow[]> {
  return queryable(executor)
    .select({ userId: sosPraying.userId, displayName: user.displayName, anonymous: sosPraying.anonymous })
    .from(sosPraying)
    .innerJoin(user, eq(sosPraying.userId, user.id))
    .where(and(eq(sosPraying.signalId, signalId), noBlockBetween(viewerId, sosPraying.userId)))
    .orderBy(asc(sosPraying.prayedAt));
}

// =================================================================================================
// Replies
// =================================================================================================

export async function insertSosReply(
  input: NewSosReply,
  executor: Executor = getDatabase(),
): Promise<SosReplyRow> {
  const inserted = await queryable(executor)
    .insert(sosReply)
    .values({
      signalId: input.signalId,
      authorId: input.authorId,
      parentId: input.parentId,
      text: input.text,
    })
    .returning({ id: sosReply.id });
  const id = inserted[0]?.id;
  if (id === undefined) throw new Error('insertSosReply returned no row');
  const row = await findSosReplyById(id, executor);
  if (row === null) throw new Error('insertSosReply wrote a row it cannot read back');
  return row;
}

/** One reply by id, with no block condition — a write path's precondition. */
export async function findSosReplyById(
  replyId: string,
  executor: Executor = getDatabase(),
): Promise<SosReplyRow | null> {
  const rows = await queryable(executor)
    .select(REPLY_COLUMNS)
    .from(sosReply)
    .innerJoin(user, eq(sosReply.authorId, user.id))
    .where(eq(sosReply.id, replyId))
    .limit(1);
  return (rows[0] as SosReplyRow | undefined) ?? null;
}

/** One signal's replies as this viewer may read them, oldest first. */
export async function listSosReplies(
  signalId: string,
  viewer: SosViewer,
  executor: Executor = getDatabase(),
): Promise<SosReplyRow[]> {
  const rows = await queryable(executor)
    .select(REPLY_COLUMNS)
    .from(sosReply)
    .innerJoin(user, eq(sosReply.authorId, user.id))
    .innerJoin(sosSignal, eq(sosSignal.id, sosReply.signalId))
    .where(and(eq(sosReply.signalId, signalId), replyVisibleTo(viewer)))
    .orderBy(asc(sosReply.createdAt), asc(sosReply.id));
  return rows as SosReplyRow[];
}

/** Remove one reply. Answers whether there was one. */
export async function deleteSosReply(
  replyId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .delete(sosReply)
    .where(eq(sosReply.id, replyId))
    .returning({ id: sosReply.id });
  return rows.length > 0;
}

// =================================================================================================
// The correlated counts
// =================================================================================================

/** Everybody's, blocked or not — see the module comment. */
function prayingCount() {
  return sql<number>`(select count(*)::int from ${sosPraying} where ${sosPraying.signalId} = ${sosSignal.id})`;
}

/** Only the replies this viewer would be shown, so the number on the row matches the list under it. */
function replyCount(viewer: SosViewer) {
  return sql<number>`(select count(*)::int from ${sosReply} where ${sosReply.signalId} = ${sosSignal.id} and ${replyVisibleTo(viewer)})`;
}

function viewerPraying(viewerId: string) {
  return sql<boolean>`exists (select 1 from ${sosPraying} where ${sosPraying.signalId} = ${sosSignal.id} and ${sosPraying.userId} = ${viewerId}::uuid)`;
}

/** Whether the viewer's own Praying row is anonymous — false when there is none. */
function viewerPrayingAnonymously(viewerId: string) {
  return sql<boolean>`coalesce((select ${sosPraying.anonymous} from ${sosPraying} where ${sosPraying.signalId} = ${sosSignal.id} and ${sosPraying.userId} = ${viewerId}::uuid), false)`;
}
