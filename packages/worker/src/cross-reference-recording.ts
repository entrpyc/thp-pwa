import {
  findNearestSegments,
  findRecordingById,
  findTranscriptByRecording,
  listChapters,
  listSegments,
  replaceCrossReferencesForRun,
  type Executor,
  type JobRow,
  type NearestSegmentRow,
  type NewCrossReference,
  type ProviderMeta,
  type SegmentRow,
} from '@thp/db';
import {
  CROSS_REFERENCES_PER_CHAPTER,
  chapterIdAt,
  pickStrongest,
  type RankedCandidate,
} from '@thp/shared';
import { emitDomainEvent } from '@thp/shared/observability/events';
import { logger } from '@thp/shared/observability/logger';
import type { JobHandler } from './handlers';

/**
 * **The `cross_reference` step** — the last of the chain, and the one that turns a library of
 * teachings into a connected one ([3.9](docs/project/prd.md); project tdd 5.7).
 *
 * For one recording: every sentence of its transcript is run against the sentences of every
 * *other published* teaching in the vector index `embed` keeps, and the strongest matches are
 * written as links — three per chapter, each to a different teaching, each anchored to the exact
 * sentence on both sides, and each stored from both sides so the other teaching gains the link
 * too ([3.9.6](docs/project/prd.md)). Five properties, each a requirement rather than a taste:
 *
 * 1. **A draft neither gives nor receives links.** An unpublished recording ends the step with no
 *    rows of its own and nothing asked of the index. Publishing enqueues the step; unpublishing
 *    removes the rows outright rather than waiting for a run. The gate on the *other* side is
 *    inside the query, spelled by `visibility.ts`.
 * 2. **It replaces rather than appends.** The run's own rows — and only those — are swapped for
 *    the new set in one transaction, which is what at-least-once dispatch requires of it and what
 *    makes a re-run after a transcript correction leave one set of links.
 * 3. **It is linear in the one recording** (project tdd 5.7). Nothing recomputes the library:
 *    the new arrival asks the index once per sentence, and the library gains its links to the
 *    arrival as the mirrored rows of the same pass.
 * 4. **It spends nothing.** The vectors were paid for by `embed`; this step asks Postgres and no
 *    provider, so it is not a spending step and the ceiling never refuses it.
 * 5. **Nothing to link is a success.** A teaching whose sentences match nothing strongly enough,
 *    or whose transcript was discarded, ends with an empty set of rows rather than a red row on
 *    `/admin/pipeline`.
 *
 * **What it does not do, and why.** project tdd 3.3 names shared tags and shared scripture as
 * two more bases; this round builds the transcript basis alone, by product decision — see
 * `CROSS_REFERENCE_BASES`. So neither a tag change nor an approved reference list enqueues this
 * step, and the enqueue sites named for them in the ticket do not exist.
 */

export interface CrossReferenceDependencies {
  /** Where the rows are read and written. Defaults to the process's pool. */
  readonly executor?: Executor;
}

/**
 * **The similarity a pair must reach to become a link: cosine 0.70.**
 *
 * The one number here that is a product decision rather than an engineering one, and the one
 * most worth revisiting against a real library. For the model in use (`text-embedding-3-small`,
 * project tdd 4.4), two unrelated sentences from the same kind of teaching sit near 0.1–0.3, two
 * on one theme near 0.5, and a near-paraphrase — the same illustration told twice, the same verse
 * quoted in the same words — above 0.7. The operator chose the strict end: fewer links, almost
 * none of them false, over a fuller surface that sometimes links on a turn of phrase. Lowering it
 * raises the number of candidates every chapter has to choose three from and the number of
 * sentences that match *something*; it does not change the table's size, which the per-chapter
 * cap bounds on its own.
 */
export const CROSS_REFERENCE_MIN_SIMILARITY = 0.7;

/**
 * **Candidates asked of the index per sentence: 5.**
 *
 * This decides query cost: one lateral scan per sentence, each returning at most this many rows,
 * so a ninety-minute teaching of a thousand sentences is a thousand small index probes in a few
 * batched statements. It is small because the cap on what is kept is small — three links per
 * chapter across a hundred sentences — and because the fifth-nearest sentence to anything is
 * rarely above the threshold. It is more than one because the nearest candidate can be a second
 * sentence of a teaching already chosen for this chapter, and the selection then wants the next.
 */
export const CROSS_REFERENCE_CANDIDATES_PER_SEGMENT = 5;

/**
 * **A sentence shorter than this many words is not matched: 8.**
 *
 * The index does not know that "Let us pray." and "Amen." open and close every teaching in the
 * library. Two short formulaic sentences embed nearly identically, score near 1.0, and would
 * outrank every real match in every chapter. Eight words is roughly the point at which a sentence
 * carries content of its own; it is a first setting, like the threshold, and it excludes nothing
 * from being *linked to* — only from being the sentence that asks.
 */
export const CROSS_REFERENCE_MIN_WORDS = 8;

/** Source sentences per index statement. The lateral join makes one probe per row either way. */
export const CROSS_REFERENCE_BATCH_SIZE = 128;

/** A candidate with everything the selection and the write need. */
interface Candidate extends RankedCandidate {
  readonly targetSegmentId: string;
}

/**
 * Build the handler.
 *
 * A factory rather than a function for the same reason the others are: so a test hands in the
 * executor it migrated, and so nothing reads the environment until a job arrives.
 */
export function createCrossReferenceHandler(
  deps: CrossReferenceDependencies = {},
): JobHandler {
  return async function crossReferenceRecording(job: JobRow): Promise<ProviderMeta> {
    const fields = { jobId: job.id, recordingId: job.recordingId };
    logger.info('cross_reference.started', fields);

    const recording = await findRecordingById(job.recordingId, deps.executor);
    if (!recording) throw fail(fields, `no recording ${job.recordingId}`);

    try {
      // Property 1: a draft gives nothing. Its own rows are cleared too — none should exist, since
      // unpublishing removes them, but a run that found some would otherwise leave them standing.
      if (recording.publishedAt === null) {
        await replaceCrossReferencesForRun(job.recordingId, [], deps.executor);
        const meta: ProviderMeta = { provider: 'pgvector', skipped: 'unpublished', links: 0 };
        logger.info('cross_reference.succeeded', { ...fields, ...meta });
        return meta;
      }

      const transcript = await findTranscriptByRecording(job.recordingId, deps.executor);
      const segments =
        transcript === null ? [] : await listSegments(transcript.id, deps.executor);
      const chapters = await listChapters(job.recordingId, deps.executor);

      const asking = segments.filter((segment) => wordCount(segment.text) >= CROSS_REFERENCE_MIN_WORDS);
      const byId = new Map(segments.map((segment) => [segment.id, segment]));

      const candidates: Candidate[] = [];
      let probed = 0;
      for (let start = 0; start < asking.length; start += CROSS_REFERENCE_BATCH_SIZE) {
        const batch = asking.slice(start, start + CROSS_REFERENCE_BATCH_SIZE);
        const nearest = await findNearestSegments(
          batch.map((segment) => segment.id),
          CROSS_REFERENCE_CANDIDATES_PER_SEGMENT,
          deps.executor,
        );
        probed += batch.length;
        for (const row of nearest) {
          if (row.score < CROSS_REFERENCE_MIN_SIMILARITY) continue;
          const source = byId.get(row.sourceSegmentId);
          if (source === undefined) continue;
          candidates.push(toCandidate(row, source));
        }
      }

      // Property 3's other half, and the cap: the strongest three of each chapter, chosen by the
      // same function the read uses, over buckets drawn by the same arithmetic.
      const buckets = new Map<string | null, Candidate[]>();
      for (const candidate of candidates) {
        const key = chapterIdAt(chapters, candidate.sourceStartMs);
        buckets.set(key, [...(buckets.get(key) ?? []), candidate]);
      }
      const links: NewCrossReference[] = [];
      for (const bucket of buckets.values()) {
        for (const chosen of pickStrongest(bucket, CROSS_REFERENCES_PER_CHAPTER)) {
          links.push({
            sourceRecordingId: job.recordingId,
            sourceSegmentId: chosen.sourceSegmentId,
            targetRecordingId: chosen.targetRecordingId,
            targetSegmentId: chosen.targetSegmentId,
            // Clamped at the write rather than trusted: floating-point cosine over unit vectors
            // can answer 1.0000001, and the column's check would refuse the whole run for it.
            score: Math.min(1, Math.max(0, chosen.score)),
            basis: 'semantic',
          });
        }
      }

      // Property 2: one transaction, this run's rows only.
      await replaceCrossReferencesForRun(job.recordingId, links, deps.executor);

      const meta: ProviderMeta = {
        provider: 'pgvector',
        // What the run saw and what it kept, on the job that caused it — so a teaching with no
        // links reads as "a thousand sentences asked, nothing above the threshold" rather than as
        // a step that did nothing.
        segments: segments.length,
        asked: probed,
        candidates: candidates.length,
        chapters: chapters.length,
        links: links.length,
        threshold: CROSS_REFERENCE_MIN_SIMILARITY,
      };
      logger.info('cross_reference.succeeded', { ...fields, ...meta });
      emitDomainEvent({ type: 'recording_cross_referenced', recordingId: job.recordingId });
      return meta;
    } catch (cause) {
      throw fail(fields, cause instanceof Error ? cause.message : String(cause), cause);
    }
  };
}

function toCandidate(row: NearestSegmentRow, source: SegmentRow): Candidate {
  return {
    score: row.score,
    sourceSegmentId: source.id,
    sourceStartMs: source.startMs,
    targetRecordingId: row.targetRecordingId,
    targetSegmentId: row.targetSegmentId,
  };
}

/** Words as whitespace-separated runs. Punctuation-only runs count; a sentence rarely has one. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/** Log the failure with the whole of it, and hand back the sentence the job row will carry. */
function fail(fields: Record<string, unknown>, reason: string, cause?: unknown): Error {
  logger.error('cross_reference.failed', {
    ...fields,
    reason,
    ...(cause instanceof Error ? { error: cause.stack ?? cause.message } : {}),
  });
  return new Error(reason);
}
