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
  type DraftedCitation,
  type ScriptureCitation,
} from '@thp/shared';
import { resolvePassages, type BibleSource } from '@thp/bible';
import { emitDomainEvent } from '@thp/shared/observability/events';
import { logger } from '@thp/shared/observability/logger';
import { generator as configuredGenerator, type Generator } from './generate';
import { readProposedCitations, resolveProposedCitations } from './scripture-draft';
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
  /** Where verse text comes from. Defaults to the one this process is configured with. */
  readonly bibleSource?: BibleSource;
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

    /*
     * Playback order, which is the order `listSegments` already decided — and **with the offsets
     * still on**, so a citation can come back saying where in the teaching it was read out
     * ([3.7.10](docs/project/prd.md)). Joining them into one string is the prompt module's job;
     * doing it here would throw away the numbers before the prompt could show them.
     */
    const lines = segments.map((one) => ({ startMs: one.startMs, text: one.text }));

    let result;
    try {
      result = await model.generate({
        title: recording.title,
        lines,
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
      fields: { [REVIEW_FIELD[kind].name]: aiSuggested() },
    });

    // What a list-shaped kind proposed, resolved against the canon before anything is written.
    // Summed across the kinds rather than kept per kind, because there is one such kind and the
    // number is read as "how much of this run's answer was not usable".
    let dropped = 0;
    let duplicates = 0;

    const draftOf = (kind: ReviewKind): string | readonly DraftedCitation[] => {
      const field = REVIEW_FIELD[kind];
      const value = result.drafts[kind];

      if (field.shape === 'text') return typeof value === 'string' ? value : '';

      // **The structure was required, so prose is a failure** (scope prd 3.1.2).
      // Thrown before anything is written, so a run that answered in the wrong shape leaves no
      // partial draft behind it. The adapter refuses this too; this is the handler refusing to
      // trust that it did.
      if (!Array.isArray(value)) {
        throw fail(
          fields,
          `the ${field.name} came back as ${typeof value} rather than as a list of citations`,
        );
      }

      const resolved = resolveProposedCitations(readProposedCitations(value));
      dropped += resolved.dropped;
      duplicates += resolved.duplicates;
      return resolved.citations;
    };

    const items: NewReviewItem[] = kinds.map((kind) => ({
      kind,
      fields: { [REVIEW_FIELD[kind].name]: draftOf(kind) },
      provenance: provenance(kind),
    }));

    // **The verses of what was just drafted, before the item is written**
    // (scope plan 3.2.3). Before rather than after, so an admin
    // opening the item the moment it appears reads the passages rather than watching them arrive.
    const verses = await resolveVerses(citationsIn(items), deps, fields);

    await replaceOpenDrafts(job.recordingId, items, deps.executor);

    const providerMeta: ProviderMeta = {
      model: result.spend.model,
      modelVersion: result.spend.modelVersion,
      promptVersion: result.promptVersion,
      inputTokens: result.spend.inputTokens,
      outputTokens: result.spend.outputTokens,
      costUsd: result.spend.costUsd,
      requestId: result.spend.requestId,
      // scope prd 3.1.3: what the machine proposed and could not be stored is a
      // number on the run that proposed it, so a prompt going wrong is visible rather than quiet.
      citationsDropped: dropped,
      citationsDuplicated: duplicates,
      // scope prd 3.3.9: what the lookups cost, on the job that caused them. A
      // free source spends nothing and says so; what is worth reading is the second number — the
      // calls the cache meant nobody had to make.
      versesFetched: verses.fetched,
      versesHeld: verses.held,
      verseSourceRequestId: verses.requestId,
    };

    logger.info('generate_draft.succeeded', {
      ...fields,
      provider: model.name,
      items: items.length,
      ...providerMeta,
    });

    if (dropped > 0 || duplicates > 0) {
      // Its own line, at warn, because it is the one thing about a *successful* run that somebody
      // should look at: the step worked and part of what the model said was not usable.
      logger.warn('generate_draft.citations_discarded', { ...fields, dropped, duplicates });
    }

    // Nothing subscribes. §3.17's notifications are what will — see the events module.
    emitDomainEvent({ type: 'draft_generated', recordingId: job.recordingId, kinds });

    return providerMeta;
  };
}

/** What a freshly generated field's provenance says. */
function aiSuggested(): FieldProvenance {
  return { aiSuggested: true, editedByAdmin: false };
}

/** Every citation across the items this run is about to write, whatever kind carried them. */
function citationsIn(items: readonly NewReviewItem[]): ScriptureCitation[] {
  const found: ScriptureCitation[] = [];
  for (const item of items) {
    // `fields` is `unknown` on the way into the `jsonb` column, so it is read as what this handler
    // just put there rather than trusted to be anything.
    for (const value of Object.values(item.fields as Record<string, unknown>)) {
      if (Array.isArray(value)) found.push(...(value as readonly ScriptureCitation[]));
    }
  }
  return found;
}

/**
 * **Resolve the passages, and never fail the step over them**
 * (scope plan 3.2.4).
 *
 * The deliberate exception to docs/project/prd.md 3.21.2.3's halt-on-failure rule, and the reason
 * it is deliberate is scope prd 3.3.5: the artefact this step produces is the
 * citation, and verse text is a convenience on top of it. A source that is down leaves the
 * references exactly where they are, marked as having no text yet by there being none — which is
 * the state the review form and the member surface already draw a quiet line for.
 *
 * The port promises not to throw over a source that refuses. This catches anyway, because the write
 * behind it can: a cache that will not accept a row is still not a reason to lose the draft.
 */
async function resolveVerses(
  citations: readonly ScriptureCitation[],
  deps: GenerateDraftDependencies,
  fields: Record<string, string | boolean | readonly ReviewKind[]>,
): Promise<{ fetched: number; held: number; requestId: string | null }> {
  if (citations.length === 0) return { fetched: 0, held: 0, requestId: null };

  try {
    const resolved = await resolvePassages(citations, {
      ...(deps.bibleSource === undefined ? {} : { source: deps.bibleSource }),
      ...(deps.executor === undefined ? {} : { executor: deps.executor }),
    });
    return { fetched: resolved.fetched, held: resolved.held, requestId: resolved.requestId };
  } catch (cause) {
    // At warn, not error: the step is succeeding, and what an operator wants to know is that the
    // teaching went through with its citations carrying no text.
    logger.warn('generate_draft.verses_unresolved', {
      ...fields,
      citations: citations.length,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return { fetched: 0, held: 0, requestId: null };
  }
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
