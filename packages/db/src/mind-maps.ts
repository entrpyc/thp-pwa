import { eq, sql } from 'drizzle-orm';
import type { MindMapNode } from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import { mindMap } from './schema';

/**
 * The approved mind map's queries ([3.8](docs/project/prd.md)). Query construction lives in this
 * package and nowhere else — the import-boundary guard refuses a `drizzle-orm` import outside it.
 *
 * Two reads and one write, the shape `summaries.ts` takes: the approve path upserts the one row a
 * recording may have, and the member route reads it back. Nothing here decides visibility; that is
 * the recording's publication, read by the caller through the visibility module.
 */

export interface MindMapRow {
  readonly id: string;
  readonly recordingId: string;
  /** The tree as written. `jsonb`, so the reader checks the shape rather than trusting it. */
  readonly root: unknown;
  readonly editedByAdmin: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Write the approved tree, **replacing whatever this recording had.**
 *
 * An upsert on the unique recording index, so approving a regenerated draft updates the row a
 * member already reads rather than failing on the one that is there. The previous tree is not
 * kept here — the closed `review_item` is the record of what was proposed and approved before.
 */
export async function publishMindMap(
  recordingId: string,
  root: MindMapNode,
  editedByAdmin: boolean,
  executor: Executor = getDatabase(),
): Promise<MindMapRow> {
  const rows = await queryable(executor)
    .insert(mindMap)
    .values({ recordingId, root, editedByAdmin })
    .onConflictDoUpdate({
      target: mindMap.recordingId,
      set: { root, editedByAdmin, updatedAt: sql`now()` },
    })
    .returning();

  const row = rows[0] as MindMapRow | undefined;
  if (!row) throw new Error('publishMindMap returned no row');
  return row;
}

/** The recording's approved map, or `null` while nobody has approved one. */
export async function findMindMapByRecording(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<MindMapRow | null> {
  const rows = await queryable(executor)
    .select()
    .from(mindMap)
    .where(eq(mindMap.recordingId, recordingId))
    .limit(1);
  return (rows[0] as MindMapRow | undefined) ?? null;
}
