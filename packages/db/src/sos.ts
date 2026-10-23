import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import { noBlockBetween } from './member-blocks';
import { sosPraying, sosReply, sosSignal, user } from './schema';
import { SOS_URGENCIES, type SosUrgency } from '@thp/shared';

/**
 * **SOS signals at the database** ([3.16](docs/project/prd.md); [4.15](docs/project/prd.md)).
 *
 * Every statement against `sos_signal`, `sos_praying` and `sos_reply` lives here. The module
 * answers *which rows* and never *may this person*: the service holds the policy, and what is
 * decided here is the shape of a read — which is where the two rules the whole channel rests on
 * are stated, once each:
 *
 * - **The board's order** ([3.16.4](docs/project/prd.md)): most urgent first, then most recently
 *   raised. One `order by` over the urgency's rank and `raised_at`, in {@link listSosSignals}, and
 *   the client's comparator in `@thp/shared` says the same thing for a re-sort after a write.
 * - **The block rule** (`member-blocks.ts`): every read of member content takes
 *   `noBlockBetween(viewerId, <author column>)`, so a signal, a reply or a name on the praying
 *   list by a member either side of a block is not read — not withheld later, not read.
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

/** One `sos_signal` row. */
export interface SosSignalRow {
  readonly id: string;
  readonly authorId: string;
  readonly urgency: SosUrgency;
  readonly description: string;
  readonly raisedAt: Date;
  readonly closedAt: Date | null;
  readonly closedBy: string | null;
  readonly closingNote: string | null;
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
}

export interface NewSosSignal {
  readonly authorId: string;
  readonly urgency: SosUrgency;
  readonly description: string;
}

/** One `sos_reply` row, with its author joined for the reason the signal's is. */
export interface SosReplyRow {
  readonly id: string;
  readonly signalId: string;
  readonly authorId: string;
  readonly text: string;
  readonly createdAt: Date;
  readonly authorDisplayName: string;
  readonly authorAvatarKey: string | null;
}

export interface NewSosReply {
  readonly signalId: string;
  readonly authorId: string;
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
} as const;

const REPLY_COLUMNS = {
  id: sosReply.id,
  signalId: sosReply.signalId,
  authorId: sosReply.authorId,
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
// Signals
// =================================================================================================

export async function insertSosSignal(
  input: NewSosSignal,
  executor: Executor = getDatabase(),
): Promise<SosSignalRow> {
  const rows = await queryable(executor)
    .insert(sosSignal)
    .values({ authorId: input.authorId, urgency: input.urgency, description: input.description })
    .returning(SIGNAL_COLUMNS);
  const row = rows[0] as SosSignalRow | undefined;
  if (!row) throw new Error('insertSosSignal returned no row');
  return row;
}

/** How many signals this member holds open — what the cap ([3.16.12](docs/project/prd.md)) counts. */
export async function countOpenSosSignalsByAuthor(
  authorId: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const rows = await queryable(executor)
    .select({ count: sql<number>`count(*)::int` })
    .from(sosSignal)
    .where(and(eq(sosSignal.authorId, authorId), isNull(sosSignal.closedAt)));
  return rows[0]?.count ?? 0;
}

/**
 * The board's list for one viewer: every open signal, or every closed one, in the board's order,
 * less those by members either side of a block with the viewer.
 */
export async function listSosSignals(
  input: { readonly viewerId: string; readonly open: boolean },
  executor: Executor = getDatabase(),
): Promise<SosSignalListRow[]> {
  const rows = await queryable(executor)
    .select({
      ...SIGNAL_COLUMNS,
      authorDisplayName: user.displayName,
      authorAvatarKey: user.avatarKey,
      prayingCount: prayingCount(),
      replyCount: replyCount(input.viewerId),
      praying: viewerPraying(input.viewerId),
    })
    .from(sosSignal)
    .innerJoin(user, eq(sosSignal.authorId, user.id))
    .where(
      and(
        input.open ? isNull(sosSignal.closedAt) : isNotNull(sosSignal.closedAt),
        noBlockBetween(input.viewerId, sosSignal.authorId),
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
  viewerId: string,
  executor: Executor = getDatabase(),
): Promise<Record<SosUrgency, number>> {
  const rows = await queryable(executor)
    .select({ urgency: sosSignal.urgency, count: sql<number>`count(*)::int` })
    .from(sosSignal)
    .where(and(isNull(sosSignal.closedAt), noBlockBetween(viewerId, sosSignal.authorId)))
    .groupBy(sosSignal.urgency);
  const counts = Object.fromEntries(SOS_URGENCIES.map((one) => [one, 0])) as Record<
    SosUrgency,
    number
  >;
  for (const row of rows) counts[row.urgency as SosUrgency] = row.count;
  return counts;
}

/**
 * One signal as this viewer may read it, or `null` — for an id nobody has **and** for a signal by
 * a member either side of a block, which answer alike so the route discloses neither.
 */
export async function findSosSignalForViewer(
  signalId: string,
  viewerId: string,
  executor: Executor = getDatabase(),
): Promise<SosSignalListRow | null> {
  const rows = await queryable(executor)
    .select({
      ...SIGNAL_COLUMNS,
      authorDisplayName: user.displayName,
      authorAvatarKey: user.avatarKey,
      prayingCount: prayingCount(),
      replyCount: replyCount(viewerId),
      praying: viewerPraying(viewerId),
    })
    .from(sosSignal)
    .innerJoin(user, eq(sosSignal.authorId, user.id))
    .where(and(eq(sosSignal.id, signalId), noBlockBetween(viewerId, sosSignal.authorId)))
    .limit(1);
  return (rows[0] as SosSignalListRow | undefined) ?? null;
}

/**
 * One signal by id, **with no block condition** — a write path's precondition, as
 * `findNoteById` is: the service asks what state the signal is in before refusing an action on
 * it, and an admin removing a signal by a member who blocked them must still find the row.
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
    .where(and(eq(sosSignal.id, input.signalId), isNull(sosSignal.closedAt)))
    .returning(SIGNAL_COLUMNS);
  return (rows[0] as SosSignalRow | undefined) ?? null;
}

/**
 * Remove a signal outright ([3.16.11](docs/project/prd.md)): the row, and through the cascades its
 * replies, its acknowledgements and every notification that pointed at it. Answers whether there
 * was one to remove.
 */
export async function deleteSosSignal(
  signalId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .delete(sosSignal)
    .where(eq(sosSignal.id, signalId))
    .returning({ id: sosSignal.id });
  return rows.length > 0;
}

// =================================================================================================
// Praying
// =================================================================================================

/** Say this member is praying, or leave them saying so: `on conflict do nothing`. */
export async function setSosPraying(
  input: { readonly signalId: string; readonly userId: string },
  executor: Executor = getDatabase(),
): Promise<void> {
  await queryable(executor)
    .insert(sosPraying)
    .values({ signalId: input.signalId, userId: input.userId })
    .onConflictDoNothing();
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

/**
 * The names of everybody praying for one signal, in the order they pressed, less those either
 * side of a block with the viewer — a name is member content; the count is not.
 */
export async function listSosPrayingNames(
  signalId: string,
  viewerId: string,
  executor: Executor = getDatabase(),
): Promise<string[]> {
  const rows = await queryable(executor)
    .select({ displayName: user.displayName })
    .from(sosPraying)
    .innerJoin(user, eq(sosPraying.userId, user.id))
    .where(and(eq(sosPraying.signalId, signalId), noBlockBetween(viewerId, sosPraying.userId)))
    .orderBy(asc(sosPraying.prayedAt));
  return rows.map((row) => row.displayName);
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
    .values({ signalId: input.signalId, authorId: input.authorId, text: input.text })
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
  viewerId: string,
  executor: Executor = getDatabase(),
): Promise<SosReplyRow[]> {
  const rows = await queryable(executor)
    .select(REPLY_COLUMNS)
    .from(sosReply)
    .innerJoin(user, eq(sosReply.authorId, user.id))
    .where(and(eq(sosReply.signalId, signalId), noBlockBetween(viewerId, sosReply.authorId)))
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
function replyCount(viewerId: string) {
  return sql<number>`(select count(*)::int from ${sosReply} where ${sosReply.signalId} = ${sosSignal.id} and ${noBlockBetween(viewerId, sosReply.authorId)})`;
}

function viewerPraying(viewerId: string) {
  return sql<boolean>`exists (select 1 from ${sosPraying} where ${sosPraying.signalId} = ${sosSignal.id} and ${sosPraying.userId} = ${viewerId}::uuid)`;
}
