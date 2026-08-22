import {
  findRecordingById,
  findTranscriptByRecording,
  listSegments,
  replaceOpenDrafts,
  type Executor,
  type JobRow,
  type NewReviewItem,
  type ProviderMeta,
} from '@thp/db';
import {
  REVIEW_FIELD,
  REVIEW_KINDS,
  isReviewKind,
  MAX_STEERING_PROMPT_LENGTH,
  type FieldProvenance,
  type ReviewKind,
  type ReviewProvenance,
} from '@thp/shared';
import { emitDomainEvent } from '@thp/shared/observability/events';
import { logger } from '@thp/shared/observability/logger';
import { generator as configuredGenerator, type Generator } from './generate';
import type { JobHandler } from './handlers';

/**
 * **The `generate_draft` step, doing the work the stub stood in for** — and it is the last stub in
 * this epic.
 *
 * Transcription completing chains into this step (the chain rule is untouched; what changed is the
 * handler behind it), and one provider call produces both artefacts
 * ([3.6.1](docs/project/prd.md), [4.17.1](docs/project/prd.md)). Four properties are worth naming
 * before the code:
 *
 * 1. **Nothing it writes is member-visible.** Two `review_item` rows, and that is all: no `summary`
 *    row is created, `recording.description` is untouched and `published_at` stays null
 *    ([3.21.2.2](docs/project/prd.md), [3.6.2](docs/project/prd.md)). Making something visible is
 *    an admin pressing a button, twice, in Ticket 02 and Ticket 04.
 * 2. **Running it twice leaves one draft per kind.** Dispatch is at-least-once, so the write
 *    replaces *open* drafts for the kinds it generated rather than appending. Closed items are
 *    never touched, which is what keeps the audit trail intact.
 * 3. **The transcript is joined from the segments.** There is no concatenated copy to read, because
 *    Story 2 Ticket 03 deliberately did not write one — the segments are the text.
 * 4. **A recording with no transcript fails the job**, naming that. Generating from nothing would
 *    produce a confident draft of an empty teaching, which is worse than a red row.
 */

/**
 * What a steered regeneration puts in `job.payload` (Story 3 Ticket 03).
 *
 * `null` on every chained job, which is what makes a payload-free run generate both kinds — so the
 * chain from `transcribe` never has to know this shape exists.
 */
export interface GenerateDraftPayload {
  /** Which artefacts to produce. Absent means all of them. */
  readonly kinds?: readonly ReviewKind[];
  /** The admin's sentence about what was wrong with the last draft. */
  readonly prompt?: string;
}

export interface GenerateDraftDependencies {
  readonly generator?: Generator;
  /** Where the drafts are written. Defaults to the process's pool. */
  readonly executor?: Executor;
}

/**
 * Read a job's payload without trusting it.
 *
 * The column is `jsonb` and the row was written by a route this process does not share memory
 * with, so every field is checked. An unreadable payload is read as **no payload** rather than as a
 * failure: the honest fallback for "I could not tell which kinds were asked for" is to generate
 * all of them, which is what a chained job asks for anyway.
 *
 * Exported so the parsing is unit-testable without a database in the way.
 */
export function readPayload(value: unknown): { kinds: ReviewKind[]; prompt: string | null } {
  const all = [...REVIEW_KINDS];
  if (typeof value !== 'object' || value === null) return { kinds: all, prompt: null };

  const { kinds, prompt } = value as GenerateDraftPayload;
  const wanted = Array.isArray(kinds) ? kinds.filter(isReviewKind) : [];
  const steering =
    typeof prompt === 'string' && prompt.trim() !== ''
      ? prompt.trim().slice(0, MAX_STEERING_PROMPT_LENGTH)
      : null;

  return { kinds: wanted.length > 0 ? wanted : all, prompt: steering };
}

/**
 * Build the handler.
 *
 * A factory rather than a function, so a test supplies a fake generator the same way the loop is
 * given a handler registry — and so nothing reads the environment until a job actually arrives.
 */
export function createGenerateDraftHandler(deps: GenerateDraftDependencies = {}): JobHandler {
  return async function generateDraft(job: JobRow): Promise<ProviderMeta> {
    const model = deps.generator ?? configuredGenerator();
    const { kinds, prompt } = readPayload(job.payload);
    const fields = { jobId: job.id, recordingId: job.recordingId, kinds, steered: prompt !== null };

    logger.info('generate_draft.started', fields);

    const recording = await findRecordingById(job.recordingId, deps.executor);
    if (!recording) throw fail(fields, `no recording ${job.recordingId}`);

    const transcript = await findTranscriptByRecording(job.recordingId, deps.executor);
    if (!transcript) {
      // Asked before the provider is, so a recording with nothing to summarise fails naming that
      // rather than spending a call on an empty prompt.
      throw fail(fields, `recording ${job.recordingId} has no transcript to generate from`);
    }

    const segments = await listSegments(transcript.id, deps.executor);
    if (segments.length === 0) {
      throw fail(fields, `the transcript for recording ${job.recordingId} has no segments in it`);
    }

    // Playback order, which is the order `listSegments` already decided. One string, one call.
    const text = segments.map((one) => one.text).join(' ');

    let result;
    try {
      result = await model.generate({
        title: recording.title,
        transcript: text,
        kinds,
        steeringPrompt: prompt,
      });
    } catch (cause) {
      throw fail(fields, cause instanceof Error ? cause.message : String(cause), cause);
    }

    const provenance = (kind: ReviewKind): ReviewProvenance => ({
      model: result.spend.model,
      modelVersion: result.spend.modelVersion,
      promptVersion: result.promptVersion,
      steeringPrompt: prompt,
      // Everything this epic writes is AI-suggested and unedited at birth; the approve path is
      // what sets `editedByAdmin`. Built per field so a later kind with two fields is one loop.
      fields: { [REVIEW_FIELD[kind]]: aiSuggested() },
    });

    const items: NewReviewItem[] = kinds.map((kind) => ({
      kind,
      fields: { [REVIEW_FIELD[kind]]: result.drafts[kind] ?? '' },
      provenance: provenance(kind),
    }));

    await replaceOpenDrafts(job.recordingId, items, deps.executor);

    const providerMeta: ProviderMeta = {
      model: result.spend.model,
      modelVersion: result.spend.modelVersion,
      promptVersion: result.promptVersion,
      inputTokens: result.spend.inputTokens,
      outputTokens: result.spend.outputTokens,
      costUsd: result.spend.costUsd,
      requestId: result.spend.requestId,
    };

    logger.info('generate_draft.succeeded', {
      ...fields,
      provider: model.name,
      items: items.length,
      ...providerMeta,
    });

    // Nothing subscribes. §3.17's notifications are what will — see the events module.
    emitDomainEvent({ type: 'draft_generated', recordingId: job.recordingId, kinds });

    return providerMeta;
  };
}

/** What a freshly generated field's provenance says. */
function aiSuggested(): FieldProvenance {
  return { aiSuggested: true, editedByAdmin: false };
}

/** Log the failure with the whole of it, and hand back the sentence the job row will carry. */
function fail(fields: Record<string, unknown>, reason: string, cause?: unknown): Error {
  logger.error('generate_draft.failed', {
    ...fields,
    reason,
    ...(cause instanceof Error ? { error: cause.stack ?? cause.message } : {}),
  });
  return new Error(reason);
}
