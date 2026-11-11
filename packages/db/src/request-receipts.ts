import { and, eq } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import { requestReceipt } from './schema';

/**
 * **What a replayed request is answered with** ([3.18.19](docs/project/prd.md)).
 *
 * A write a member made offline is kept on the device and sent when the connection returns. If the
 * answer to that send is lost — the signal drops between the commit and the response — the device
 * sends it again, and the second arrival must not be a second reply, a second prayer request or a
 * second session. Each queued write carries a key the device minted; the first answer is kept here
 * under it, and a later request with the same key is answered from the row without the handler
 * running.
 *
 * Only what succeeded is kept. A refusal changed nothing, so sending it again is safe and is
 * judged afresh.
 */

export interface RequestReceiptRow {
  readonly status: number;
  readonly body: unknown;
}

export async function findRequestReceipt(
  userId: string,
  key: string,
  executor: Executor = getDatabase(),
): Promise<RequestReceiptRow | null> {
  const rows = await queryable(executor)
    .select({ status: requestReceipt.status, body: requestReceipt.body })
    .from(requestReceipt)
    .where(and(eq(requestReceipt.userId, userId), eq(requestReceipt.key, key)))
    .limit(1);
  return (rows[0] as RequestReceiptRow | undefined) ?? null;
}

/** Keep an answer. The first one stands: two arrivals racing each other leave one row. */
export async function insertRequestReceipt(
  input: { readonly userId: string; readonly key: string; readonly status: number; readonly body: unknown },
  executor: Executor = getDatabase(),
): Promise<void> {
  await queryable(executor)
    .insert(requestReceipt)
    .values({ userId: input.userId, key: input.key, status: input.status, body: input.body })
    .onConflictDoNothing();
}
