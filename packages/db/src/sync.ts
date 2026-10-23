import { and, eq, inArray } from 'drizzle-orm';
import type { ApiErrorCode, SyncEntryKind } from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import { syncReceipt } from './schema';

/**
 * **Receipts for flushed outbox entries** — the statements against `sync_receipt`, and nothing
 * else's (docs/project/prd.md 3.18.14, 3.18.15; project tdd 5.3).
 *
 * One read and one write. The read answers "which of these client ids has this member already
 * flushed", so the service can skip them before it applies anything; the write records one
 * handled entry. The write is `on conflict do nothing`: two flushes of the same outbox racing
 * each other both reach the apply step with no receipt in hand, and whichever writes second must
 * not fail the whole request over a row that says what it was about to say. The apply itself is
 * idempotent enough for that race — a position upsert, a note insert that at worst doubles once —
 * and the receipt is what stops every flush after it.
 *
 * Crosses its boundary as row types and an {@link Executor}, like every module beside it. Drizzle
 * never leaves the package.
 */

/** One `sync_receipt` row as stored. The status is never `duplicate`: that is a reply, not a fact. */
export interface SyncReceiptRow {
  readonly userId: string;
  readonly clientId: string;
  readonly kind: SyncEntryKind;
  readonly status: 'applied' | 'refused';
  readonly code: ApiErrorCode | null;
  readonly message: string | null;
  /** The note an applied note entry became, or null — including after that note was deleted. */
  readonly noteId: string | null;
  readonly appliedAt: Date;
}

export interface NewSyncReceipt {
  readonly userId: string;
  readonly clientId: string;
  readonly kind: SyncEntryKind;
  readonly status: 'applied' | 'refused';
  readonly code?: ApiErrorCode | null;
  readonly message?: string | null;
  readonly noteId?: string | null;
}

const COLUMNS = {
  userId: syncReceipt.userId,
  clientId: syncReceipt.clientId,
  kind: syncReceipt.kind,
  status: syncReceipt.status,
  code: syncReceipt.code,
  message: syncReceipt.message,
  noteId: syncReceipt.noteId,
  appliedAt: syncReceipt.appliedAt,
} as const;

/** The receipts this member already holds for any of these client ids. Empty input answers empty. */
export async function findSyncReceipts(
  userId: string,
  clientIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<SyncReceiptRow[]> {
  if (clientIds.length === 0) return [];
  const rows = await queryable(executor)
    .select(COLUMNS)
    .from(syncReceipt)
    .where(and(eq(syncReceipt.userId, userId), inArray(syncReceipt.clientId, [...clientIds])));
  return rows as SyncReceiptRow[];
}

/**
 * Record one handled entry. Answers the row written, or `null` when a receipt for the pair was
 * already there — the race described above, in which case the earlier receipt stands.
 */
export async function insertSyncReceipt(
  input: NewSyncReceipt,
  executor: Executor = getDatabase(),
): Promise<SyncReceiptRow | null> {
  const rows = await queryable(executor)
    .insert(syncReceipt)
    .values({
      userId: input.userId,
      clientId: input.clientId,
      kind: input.kind,
      status: input.status,
      code: input.code ?? null,
      message: input.message ?? null,
      noteId: input.noteId ?? null,
    })
    .onConflictDoNothing({ target: [syncReceipt.userId, syncReceipt.clientId] })
    .returning(COLUMNS);
  return (rows[0] as SyncReceiptRow | undefined) ?? null;
}
