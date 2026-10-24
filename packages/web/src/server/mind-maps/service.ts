import { findMindMapByRecording, findVisibleRecording } from '@thp/db';
import { checkMindMapTree, type RecordingMindMapPayload } from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

/**
 * **The approved mind map of a published teaching** ([3.8.3](docs/project/prd.md),
 * [3.8.4](docs/project/prd.md)).
 *
 * Read-only, behind the recording's own gate: an unpublished id and an id that never existed
 * answer the same `not_found`, exactly as the scripture read does. What a teaching's map says is
 * decided in Pending Reviews and nowhere else.
 *
 * The stored document is read through the same check that admitted it, so a row this process
 * cannot read as a tree answers as no map rather than as a shape the client has to defend against.
 */
export async function readMindMapFor(
  actor: Actor,
  recordingId: string,
): Promise<RecordingMindMapPayload> {
  const visible = await findVisibleRecording(recordingId, { includeUnpublished: false });
  if (visible === null) {
    logger.warn('mind_map.read.refused', {
      actorId: actor.id,
      action: 'recording.browse',
      target: `recording:${recordingId}`,
      reason: 'not-visible',
      code: 'not_found',
    });
    throw ApiError.notFound('There is no such teaching.');
  }

  const row = await findMindMapByRecording(recordingId);
  const checked = row === null ? null : checkMindMapTree(row.root);

  logger.info('mind_map.read', {
    actorId: actor.id,
    action: 'recording.browse',
    target: `recording:${recordingId}`,
    present: checked?.ok === true,
  });

  if (row === null || checked === null || !checked.ok) return { mindMap: null };
  return {
    mindMap: {
      root: checked.root,
      editedByAdmin: row.editedByAdmin,
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}
