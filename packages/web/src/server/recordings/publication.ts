import {
  findRecordingById,
  findSummaryByRecording,
  setRecordingPublication,
  setSummaryPublication,
  updateSummaryContent,
  type SummaryRow,
} from '@thp/db';
import type { EditSummaryRequest, PublicationPayload } from '@thp/shared';
import { emitDomainEvent } from '@thp/shared/observability/events';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

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
      ...audit(actor, 'recording.publish', id),
      alreadyPublished: true,
    });
    return describe(id, existing.publishedAt, await findSummaryByRecording(id));
  }

  const row = await setRecordingPublication(id, new Date());
  if (row === null) throw notFound();

  logger.info('recording.publish', {
    ...audit(actor, 'recording.publish', id),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  });

  // Nothing subscribes. §3.17's "a teaching you follow has been published" is what will.
  emitDomainEvent({ type: 'recording_published', recordingId: id });

  return describe(id, row.publishedAt, await findSummaryByRecording(id));
}

export async function unpublishRecording(actor: Actor, id: string): Promise<PublicationPayload> {
  await requireRecording(id);

  const row = await setRecordingPublication(id, null);
  if (row === null) throw notFound();

  logger.info('recording.unpublish', audit(actor, 'recording.unpublish', id));

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

  const row = await updateSummaryContent(id, content);
  if (row === null) {
    // No summary exists — which means no draft was ever approved. Editing one into existence here
    // would be a second way to create a summary, bypassing the gate the whole story is about.
    throw ApiError.notFound(
      'This recording has no summary yet. Approve a draft in Pending Reviews first.',
    );
  }

  logger.info('summary.edit', audit(actor, 'summary.edit', id));

  return describe(id, recording.publishedAt, row);
}

/** Return a published summary to draft, keeping the text ([3.6.12](docs/project/prd.md)). */
export async function unpublishSummary(actor: Actor, id: string): Promise<PublicationPayload> {
  const recording = await requireRecording(id);

  const row = await setSummaryPublication(id, false);
  if (row === null) throw ApiError.notFound('This recording has no summary to take down.');

  logger.info('summary.unpublish', audit(actor, 'summary.unpublish', id));

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

/** Actor, action and target, under the request's correlation id. The logger supplies the time. */
function audit(actor: Actor, action: string, id: string): Record<string, unknown> {
  return {
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    target: `recording:${id}`,
  };
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
