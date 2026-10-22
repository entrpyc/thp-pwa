import {
  deleteEmbeddingsForSources,
  findRecordingById,
  findSummaryByRecording,
  findTranscriptByRecording,
  listChapters,
  listEmbeddingsForRecording,
  listNotesForEmbedding,
  listSegments,
  upsertEmbeddings,
  withTransaction,
  type Executor,
  type JobRow,
  type NewEmbedding,
  type ProviderMeta,
} from '@thp/db';
import type { EmbeddingSourceKind } from '@thp/shared';
import { emitDomainEvent } from '@thp/shared/observability/events';
import { logger } from '@thp/shared/observability/logger';
import { embedder as configuredEmbedder, type Embedder } from './embed';
import type { JobHandler } from './handlers';

/**
 * **The `embed` step** — the last of the chain, and the one semantic search
 * ([3.10](docs/project/prd.md)) and cross-referencing ([3.9](docs/project/prd.md)) stand on.
 *
 * It brings the `embedding` table into line with **everything findable about one recording**:
 * its transcript segments ([3.5.2](docs/project/prd.md)), its chapters
 * ([3.22](docs/project/prd.md)), its summary once published ([3.6.7](docs/project/prd.md)), and
 * the notes written on it ([3.12](docs/project/prd.md)), public and private. Four properties,
 * each a requirement rather than a preference:
 *
 * 1. **It reconciles rather than appends.** Every source is compared, by its stored text and the
 *    model that embedded it, against what the table holds: an unchanged source costs nothing, a
 *    changed one is replaced, and a source that is gone has its row removed. That is what makes
 *    one handler serve the chain, a transcript correction ([3.5.5](docs/project/prd.md)), a
 *    chapter edit ([3.22.7](docs/project/prd.md)), a note written or edited, and an admin's
 *    re-run alike — and what makes running it twice leave one set of rows, which at-least-once
 *    dispatch requires.
 * 2. **Only published summary text is ever embedded.** The chain reaches this step while the
 *    summary is still a draft in the review queue, and a draft is nothing a member may find
 *    ([3.10.9](docs/project/prd.md)); approving it enqueues this step again. A summary returned
 *    to draft loses its row here as well as on its page.
 * 3. **Private notes carry their owner** onto the row, read off `note` by the notes module and
 *    copied, never decided here. That one column is what turns [3.10.9](docs/project/prd.md)
 *    into a `where` clause (project tdd 4.4).
 * 4. **It looks again before it finishes.** An enqueue while this step is running coalesces into
 *    the running job, which may have read its sources before the write that caused the enqueue.
 *    So after writing, the step re-reads once more and processes anything that changed; a
 *    further change during *that* pass is left to the next enqueue, bounded rather than chased.
 *
 * **Nothing to embed is a success**, not a failure: a teaching whose transcript was discarded has
 * nothing findable, and the honest result is an empty set of rows rather than a red row on
 * `/admin/pipeline`. The write replaces the recording's rows with that empty set.
 */

export interface EmbedDependencies {
  readonly embedder?: Embedder;
  /** Where the rows are written. Defaults to the process's pool. */
  readonly executor?: Executor;
}

/** Texts per provider call. Small text, so the limit is request size, not tokens. */
export const EMBED_BATCH_SIZE = 64;

/** How many times the step looks for sources that changed under it before leaving the rest to the next run. */
export const EMBED_MAX_PASSES = 3;

/** One thing to embed: what it is, whose it is, and the words. */
interface Source {
  readonly kind: EmbeddingSourceKind;
  readonly id: string;
  readonly ownerUserId: string | null;
  readonly text: string;
}

/**
 * Build the handler.
 *
 * A factory rather than a function, so a test supplies a fake embedder the same way the loop is
 * given a handler registry — and so nothing reads the environment until a job actually arrives.
 */
export function createEmbedHandler(deps: EmbedDependencies = {}): JobHandler {
  return async function embedRecording(job: JobRow): Promise<ProviderMeta> {
    const model = deps.embedder ?? configuredEmbedder();
    const fields = { jobId: job.id, recordingId: job.recordingId };

    logger.info('embed.started', fields);

    const recording = await findRecordingById(job.recordingId, deps.executor);
    if (!recording) throw fail(fields, `no recording ${job.recordingId}`);

    const totals = { requests: 0, inputTokens: 0, costUsd: 0, embedded: 0, unchanged: 0, removed: 0 };
    let passes = 0;

    try {
      while (passes < EMBED_MAX_PASSES) {
        passes += 1;
        const sources = await collectSources(job.recordingId, deps.executor);
        const existing = await listEmbeddingsForRecording(job.recordingId, deps.executor);

        const current = new Map(sources.map((source) => [keyOf(source.kind, source.id), source]));
        const stale = sources.filter((source) => {
          const row = existing.find(
            (one) => one.sourceKind === source.kind && one.sourceId === source.id,
          );
          return row === undefined || row.text !== source.text || row.model !== model.model;
        });
        const gone = existing.filter((row) => !current.has(keyOf(row.sourceKind, row.sourceId)));

        if (stale.length === 0 && gone.length === 0) {
          // The first pass finding nothing is a re-run over unchanged words; a later pass finding
          // nothing is the look-again coming up clean. Either way the table is current.
          if (passes === 1) totals.unchanged = sources.length;
          break;
        }

        const rows: NewEmbedding[] = [];
        for (let start = 0; start < stale.length; start += EMBED_BATCH_SIZE) {
          const batch = stale.slice(start, start + EMBED_BATCH_SIZE);
          const result = await model.embed(batch.map((source) => source.text));
          totals.requests += 1;
          totals.inputTokens += result.spend.inputTokens;
          totals.costUsd += result.spend.costUsd;
          batch.forEach((source, index) => {
            const vector = result.vectors[index];
            if (vector === undefined) {
              throw new Error(`the embedder answered no vector for input ${index} of a batch`);
            }
            rows.push({
              sourceKind: source.kind,
              sourceId: source.id,
              recordingId: job.recordingId,
              ownerUserId: source.ownerUserId,
              text: source.text,
              vector,
              model: result.spend.model,
            });
          });
        }

        // Replacements and removals land together: a reader never sees the new chapter's row
        // beside the row of the chapter it replaced.
        await withTransaction(async (tx) => {
          await upsertEmbeddings(rows, tx);
          for (const kind of new Set(gone.map((row) => row.sourceKind))) {
            await deleteEmbeddingsForSources(
              kind,
              gone.filter((row) => row.sourceKind === kind).map((row) => row.sourceId),
              tx,
            );
          }
        }, deps.executor);

        totals.embedded += rows.length;
        totals.removed += gone.length;
        if (passes === 1) totals.unchanged = sources.length - stale.length;
      }
    } catch (cause) {
      throw fail(fields, cause instanceof Error ? cause.message : String(cause), cause);
    }

    const providerMeta: ProviderMeta = {
      provider: model.name,
      model: model.model,
      inputTokens: totals.inputTokens,
      costUsd: totals.costUsd,
      requests: totals.requests,
      // What the run found and what it did about it, on the job that caused it — so a re-run
      // after one corrected line reads as one row replaced, and a run that replaced everything
      // reads as a model change rather than as the ordinary case.
      embedded: totals.embedded,
      unchanged: totals.unchanged,
      removed: totals.removed,
      passes,
    };

    logger.info('embed.succeeded', { ...fields, ...providerMeta });

    // Nothing subscribes. Cross-referencing (project tdd 5.7) is what will — see the events module.
    emitDomainEvent({ type: 'recording_embedded', recordingId: job.recordingId });

    return providerMeta;
  };
}

/**
 * Everything findable about the recording, right now.
 *
 * Read in one place so every pass of the handler, and every caller that enqueues it, agrees on
 * what "the recording's sources" means. A source with no words — a segment of silence, a note
 * reduced to whitespace — is left out rather than sent: a provider refuses an empty input, and a
 * vector of nothing would be a hit for nothing.
 */
async function collectSources(recordingId: string, executor?: Executor): Promise<Source[]> {
  const sources: Source[] = [];

  const transcript = await findTranscriptByRecording(recordingId, executor);
  if (transcript !== null) {
    for (const segment of await listSegments(transcript.id, executor)) {
      sources.push({ kind: 'segment', id: segment.id, ownerUserId: null, text: segment.text });
    }
  }

  for (const chapter of await listChapters(recordingId, executor)) {
    // Title and summary as one text: a chapter is found by either, and one row per chapter is what
    // lets a hit be carried back to one moment ([3.10.7](docs/project/prd.md)).
    sources.push({
      kind: 'chapter',
      id: chapter.id,
      ownerUserId: null,
      text: `${chapter.title}\n\n${chapter.summary}`,
    });
  }

  const summary = await findSummaryByRecording(recordingId, executor);
  // The second gate, applied to what is *written* rather than to who may read: a draft summary is
  // not embedded at all, so there is no row for the visibility rule to have to hide.
  if (summary !== null && summary.publishedAt !== null) {
    sources.push({ kind: 'summary', id: summary.id, ownerUserId: null, text: summary.content });
  }

  for (const note of await listNotesForEmbedding(recordingId, executor)) {
    sources.push({ kind: 'note', id: note.id, ownerUserId: note.ownerUserId, text: note.text });
  }

  return sources.filter((source) => source.text.trim() !== '');
}

function keyOf(kind: EmbeddingSourceKind, id: string): string {
  return `${kind}:${id}`;
}

/** Log the failure with the whole of it, and hand back the sentence the job row will carry. */
function fail(fields: Record<string, unknown>, reason: string, cause?: unknown): Error {
  logger.error('embed.failed', {
    ...fields,
    reason,
    ...(cause instanceof Error ? { error: cause.stack ?? cause.message } : {}),
  });
  return new Error(reason);
}
