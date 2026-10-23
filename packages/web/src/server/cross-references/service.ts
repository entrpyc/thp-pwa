import {
  findVisibleRecording,
  listChapters,
  listOutgoingCrossReferences,
  type OutgoingCrossReferenceRow,
} from '@thp/db';
import {
  CROSS_REFERENCES_PER_CHAPTER,
  chapterIdAt,
  pickStrongest,
  type CrossReferenceGroupView,
  type RecordingCrossReferencesPayload,
  type RelatedSegmentView,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';
import { mintArtworkGrant } from '@/server/series/artwork-grant';

/**
 * **A published teaching's related moments, as a member reads them**
 * ([3.9.2](docs/project/prd.md), [3.9.5](docs/project/prd.md)).
 *
 * **Two gates, both the recording's.** Whether the member may read *this* teaching is the
 * question `findVisibleRecording` answers for the page itself, asked here first and answered
 * `not_found` the same way for a draft and for an id that never existed. Whether a link's *other*
 * teaching may be named is the gate inside the read, spelled by `visibility.ts`: a link to an
 * unpublished recording is never shown ([3.9](docs/project/prd.md)), whatever the table holds in
 * the moment between an unpublish and its delete.
 *
 * **The cap is applied again here**, not only by the worker. A teaching's chapter holds the rows
 * its own run chose *and* the mirrored rows other teachings' runs wrote pointing at it
 * ([3.9.6](docs/project/prd.md)), so a chapter can hold more than three. The same `pickStrongest`
 * over the same `chapterIdAt` buckets is what makes "three per chapter, one per other teaching"
 * true of what a member sees rather than only of what one run wrote. The same pair found by both
 * runs is one link, under the higher of the two scores.
 *
 * **Grouped by the sentence of this teaching that triggered them**, in the order those sentences
 * are spoken, with the chapter each falls in — so the page shows a chapter's links while that
 * chapter plays and nothing otherwise, without a second request as the playhead moves.
 */
export async function readCrossReferencesFor(
  actor: Actor,
  recordingId: string,
): Promise<RecordingCrossReferencesPayload> {
  const visible = await findVisibleRecording(recordingId, { includeUnpublished: false });
  if (visible === null) {
    logger.warn('cross_reference.read.refused', {
      actorId: actor.id,
      action: 'recording.browse',
      target: `recording:${recordingId}`,
      reason: 'not-visible',
      code: 'not_found',
    });
    throw ApiError.notFound('There is no such teaching.');
  }

  const [rows, chapters] = await Promise.all([
    listOutgoingCrossReferences(recordingId),
    listChapters(recordingId),
  ]);

  // One link per pair: the stronger opinion wins. The read orders by score descending, so the
  // first row seen for a pair is the one kept.
  const byPair = new Map<string, OutgoingCrossReferenceRow>();
  for (const row of rows) {
    const key = `${row.sourceSegmentId}:${row.targetSegmentId}`;
    if (!byPair.has(key)) byPair.set(key, row);
  }

  // The cap, per chapter, by the worker's rule.
  const buckets = new Map<string | null, Ranked[]>();
  for (const row of byPair.values()) {
    const key = chapterIdAt(chapters, row.sourceStartMs);
    buckets.set(key, [
      ...(buckets.get(key) ?? []),
      {
        row,
        score: row.score,
        sourceSegmentId: row.sourceSegmentId,
        sourceStartMs: row.sourceStartMs,
        targetRecordingId: row.targetRecordingId,
      },
    ]);
  }

  const groups = new Map<string, { chapterId: string | null; rows: OutgoingCrossReferenceRow[] }>();
  for (const [chapterId, bucket] of buckets) {
    for (const chosen of pickStrongest(bucket, CROSS_REFERENCES_PER_CHAPTER)) {
      const group = groups.get(chosen.row.sourceSegmentId) ?? { chapterId, rows: [] };
      group.rows.push(chosen.row);
      groups.set(chosen.row.sourceSegmentId, group);
    }
  }

  const payload: CrossReferenceGroupView[] = [];
  for (const [segmentId, group] of groups) {
    const first = group.rows[0] as OutgoingCrossReferenceRow;
    payload.push({
      segmentId,
      startMs: first.sourceStartMs,
      endMs: first.sourceEndMs,
      text: first.sourceText,
      chapterId: group.chapterId,
      links: await Promise.all(
        [...group.rows].sort((a, b) => b.score - a.score).map((row) => toView(row)),
      ),
    });
  }
  payload.sort((a, b) => a.startMs - b.startMs);

  logger.info('cross_reference.read', {
    actorId: actor.id,
    action: 'recording.browse',
    target: `recording:${recordingId}`,
    groups: payload.length,
    links: payload.reduce((sum, group) => sum + group.links.length, 0),
  });

  return { groups: payload };
}

/** A row with the fields the selection reads, beside the row itself. */
interface Ranked {
  readonly row: OutgoingCrossReferenceRow;
  readonly score: number;
  readonly sourceSegmentId: string;
  readonly sourceStartMs: number;
  readonly targetRecordingId: string;
}

/** The other teaching named, its cover signed for this response as every other read signs it. */
async function toView(row: OutgoingCrossReferenceRow): Promise<RelatedSegmentView> {
  return {
    recordingId: row.targetRecordingId,
    title: row.targetTitle,
    series:
      row.targetSeriesId === null || row.targetSeriesTitle === null
        ? null
        : {
            id: row.targetSeriesId,
            title: row.targetSeriesTitle,
            artworkUrl: await mintArtworkGrant(row.targetSeriesArtworkKey),
          },
    segmentId: row.targetSegmentId,
    startMs: row.targetStartMs,
    text: row.targetText,
    score: row.score,
    basis: row.basis,
  };
}
