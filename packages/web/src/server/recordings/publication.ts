import {
  deleteCrossReferencesTouching,
  deleteEmbeddingsForSources,
  findRecordingById,
  findSummaryByRecording,
  setRecordingPublication,
  setSummaryPublication,
  updateSummaryContent,
  withTransaction,
  type SummaryRow,
} from '@thp/db';
import type { EditSummaryRequest, PublicationPayload } from '@thp/shared';
import { emitDomainEvent } from '@thp/shared/observability/events';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { queue } from '@/server/jobs/queue';
import { notifyRecordingPublished } from '@/server/notifications/service';
import { audit } from '@/server/observability/audit';
import { logger } from '@/server/observability/logger';
import { clearSearchCache } from '@/server/search/cache';

/**
 * **Publishing — the only thing in this product that makes anything visible to a member**
 * ([3.2.2](docs/project/prd.md), [3.2.11](docs/project/prd.md),
 * [4.17.3](docs/project/prd.md)).
 *
 * Four controls, and the reasoning behind each is one sentence:
 *
 * - **Publish has no precondition beyond the recording existing.** Open drafts, a discarded summary
 *   and a missing transcript all leave a recording publishable
 *   ([3.6.10](docs/project/prd.md)). Nothing publishes automatically, and nothing blocks an admin
 *   who has decided. A precondition here would be this module second-guessing the one judgement the
 *   review gate exists to leave with a person.
 * - **Publishing twice is harmless.** The second press answers with the timestamp the recording
 *   already has rather than moving it — "when did this go live" is a fact, and a stray tap should
 *   not rewrite it.
 * - **Unpublish deletes nothing.** One write of `null`. The summary, the transcript, the segments,
 *   the jobs and the review items all survive, so re-publishing restores the recording exactly as
 *   it was.
 * - **The summary has its own gate**, so [3.6.12](docs/project/prd.md)'s return-to-draft takes a
 *   summary off a teaching that stays live, and [3.6.11](docs/project/prd.md)'s edit changes the
 *   text of one that does not.
 *
 * **What decides who may read the result is not here.** That is `@thp/db`'s visibility module, and
 * tests/guards/visibility-boundary.test.ts refuses a second copy of it. Setting a timestamp and
 * comparing one are different acts.
 */

/** The longest a summary an admin types may be. The same ceiling the review form's field takes. */
const MAX_SUMMARY_LENGTH = 20_000;

export async function publishRecording(actor: Actor, id: string): Promise<PublicationPayload> {
  const existing = await requireRecording(id);

  // Already live: answer with what it already says. Re-stamping would move a fact.
  if (existing.publishedAt !== null) {
    logger.info('recording.publish', {
      ...audit(actor, 'recording.publish', `recording:${id}`),
      alreadyPublished: true,
    });
    return describe(id, existing.publishedAt, await findSummaryByRecording(id));
  }

  const row = await withTransaction(async (tx) => {
    const published = await setRecordingPublication(id, new Date(), tx);
    // A teaching gives and receives links only once it is published ([3.9](docs/project/prd.md)),
    // so the chain's run of `cross_reference` — made while this was a draft — wrote nothing for
    // it. The step is asked again in the publish's own transaction: a teaching a member can open
    // is a teaching whose links are being computed, with no gap a crash could widen. `embed` ran
    // already and is not re-asked; this step alone is what publication changes.
    if (published !== null) await queue().enqueue({ recordingId: id, step: 'cross_reference' }, tx);
    return published;
  });
  if (row === null) throw notFound();
  // A search answered while this was a draft must not keep answering without it (finding 7).
  clearSearchCache();

  logger.info('recording.publish', {
    ...audit(actor, 'recording.publish', `recording:${id}`),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  });

  emitDomainEvent({ type: 'recording_published', recordingId: id });

  // The first subscriber ([3.17.4](docs/project/prd.md)): every active account is told, after the
  // publish is committed and never as a condition of it. A notice that cannot be written is a
  // line in the log; the teaching is live either way.
  await notifyRecordingPublished({ recordingId: id, title: existing.title });

  return describe(id, row.publishedAt, await findSummaryByRecording(id));
}

export async function unpublishRecording(actor: Actor, id: string): Promise<PublicationPayload> {
  await requireRecording(id);

  const row = await withTransaction(async (tx) => {
    const taken = await setRecordingPublication(id, null, tx);
    // The one thing unpublishing deletes, and it is a cache rather than content (project tdd
    // 3.3): every cross-reference touching this teaching, on either end, goes in the same
    // transaction. An unpublished teaching neither gives nor receives links, other teachings'
    // pages would otherwise still hold rows pointing at it until their own runs happened to
    // re-execute, and the read's gate hiding those rows is the second line, not the first.
    if (taken !== null) await deleteCrossReferencesTouching(id, tx);
    return taken;
  });
  if (row === null) throw notFound();
  // A kept search would keep serving this teaching's passages for a week otherwise (finding 7).
  clearSearchCache();

  logger.info('recording.unpublish', audit(actor, 'recording.unpublish', `recording:${id}`));

  // No event. Taking something down is not something anybody is notified about, and inventing an
  // event with no consumer and no requirement behind it would be the wrong kind of anticipation.
  return describe(id, row.publishedAt, await findSummaryByRecording(id));
}

/** Change a summary's text without touching its gate ([3.6.11](docs/project/prd.md)). */
export async function editSummary(
  actor: Actor,
  id: string,
  body: unknown,
): Promise<PublicationPayload> {
  const recording = await requireRecording(id);
  const content = parseEditRequest(body);

  const row = await withTransaction(async (tx) => {
    const updated = await updateSummaryContent(id, content, tx);
    // New words under the same gate: the published summary's vector is stale, and the step is
    // asked for in the write's own transaction. A draft's edit enqueues too and embeds nothing,
    // which is the step's rule rather than this route's to repeat.
    if (updated !== null) await queue().enqueue({ recordingId: id, step: 'embed' }, tx);
    return updated;
  });
  if (row === null) {
    // No summary exists — which means no draft was ever approved. Editing one into existence here
    // would be a second way to create a summary, bypassing the gate the whole story is about.
    throw ApiError.notFound(
      'This recording has no summary yet. Approve a draft in Pending Reviews first.',
    );
  }

  logger.info('summary.edit', audit(actor, 'summary.edit', `recording:${id}`));

  return describe(id, recording.publishedAt, row);
}

/** Return a published summary to draft, keeping the text ([3.6.12](docs/project/prd.md)). */
export async function unpublishSummary(actor: Actor, id: string): Promise<PublicationPayload> {
  const recording = await requireRecording(id);

  const row = await withTransaction(async (tx) => {
    const taken = await setSummaryPublication(id, false, tx);
    // Returned to draft is returned to unfindable ([3.6.12](docs/project/prd.md),
    // [3.10.9](docs/project/prd.md)): the vector goes in the same transaction rather than at the
    // next embed run, so there is no moment in which search surfaces words the page no longer
    // shows. The visibility rule would hide the row anyway; removing it is the honest state.
    if (taken !== null) await deleteEmbeddingsForSources('summary', [taken.id], tx);
    return taken;
  });
  if (row === null) throw ApiError.notFound('This recording has no summary to take down.');

  logger.info('summary.unpublish', audit(actor, 'summary.unpublish', `recording:${id}`));

  return describe(id, recording.publishedAt, row);
}

async function requireRecording(id: string) {
  const row = await findRecordingById(id);
  if (row === null) throw notFound();
  return row;
}

function notFound(): ApiError {
  return ApiError.notFound('There is no recording with that id.');
}

function describe(
  id: string,
  publishedAt: Date | null,
  summary: SummaryRow | null,
): PublicationPayload {
  return {
    id,
    publishedAt: publishedAt?.toISOString() ?? null,
    summaryPublishedAt: summary?.publishedAt?.toISOString() ?? null,
  };
}

function parseEditRequest(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object carrying the summary text.');
  }
  const { content } = body as Partial<EditSummaryRequest>;
  if (typeof content !== 'string' || content.trim() === '' || content.length > MAX_SUMMARY_LENGTH) {
    throw ApiError.invalidInput('Give the summary some text.');
  }
  return content;
}
