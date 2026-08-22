import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ReviewKind, ReviewStatus } from '@thp/shared';
import { getDatabase, queryable, withTransaction, type Executor } from './client';
import { recording, reviewItem, segment, transcript } from './schema';

/**
 * The review gate's queries (Story 3). Query construction lives in this package and nowhere else —
 * the import-boundary guard refuses a `drizzle-orm` import outside it.
 *
 * **The read below is the property this epic is protecting.** docs/project/prd.md 3.19.2 asks for
 * one place holding everything waiting on an admin, and
 * docs/project/architecture.md § Cross-cutting concerns says that must not degrade into a union of
 * six as artefact types arrive. {@link listPendingReviews} filters **one column** and branches on
 * `kind` nowhere at all; a later epic adding scripture references, tags, mind maps or video scripts
 * adds a value to the enum and does not touch this file.
 */

/** One row of `review_item`, as the rest of the application sees it. */
export interface ReviewItemRow {
  readonly id: string;
  readonly recordingId: string;
  readonly kind: ReviewKind;
  readonly status: ReviewStatus;
  /** The draft, keyed by field name. `jsonb`, so the shape is the writer's business. */
  readonly fields: unknown;
  readonly provenance: unknown;
  readonly createdAt: Date;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
}

/** One draft as a writer supplies it. The id, the status and the timestamps are the table's. */
export interface NewReviewItem {
  readonly kind: ReviewKind;
  readonly fields: unknown;
  readonly provenance: unknown;
}

/**
 * Write this recording's fresh drafts, **replacing whatever was still open for the same kinds**.
 *
 * Delete-then-insert in one transaction, which is the whole of what makes the `generate_draft`
 * handler idempotent: dispatch is at-least-once, so running it twice on the same recording has to
 * leave one draft per kind rather than two. The same shape `replaceTranscript` takes, and for the
 * same reason.
 *
 * **Only open drafts are deleted.** A closed item — approved or discarded — is the record of what
 * the machine proposed and who acted on it, and a regeneration must not erase the thing it is
 * replacing. That is what keeps the audit trail intact when a draft is rejected and asked for
 * again.
 *
 * Kinds not named are left alone, which is what makes a single-kind regeneration
 * ([3.6.9](docs/project/prd.md)) leave the other kind's open draft where it is.
 */
export async function replaceOpenDrafts(
  recordingId: string,
  items: readonly NewReviewItem[],
  executor: Executor = getDatabase(),
): Promise<ReviewItemRow[]> {
  if (items.length === 0) return [];
  const kinds = items.map((one) => one.kind);

  return withTransaction(async (tx) => {
    await tx
      .delete(reviewItem)
      .where(
        and(
          eq(reviewItem.recordingId, recordingId),
          eq(reviewItem.status, 'draft'),
          inArray(reviewItem.kind, kinds),
        ),
      );

    const inserted = await tx
      .insert(reviewItem)
      .values(
        items.map((one) => ({
          recordingId,
          kind: one.kind,
          status: 'draft' as const,
          fields: one.fields,
          provenance: one.provenance,
        })),
      )
      .returning();

    return inserted as ReviewItemRow[];
  }, executor);
}

/** One item, or `null`. The first question every route acting on one asks. */
export async function findReviewItem(
  id: string,
  executor: Executor = getDatabase(),
): Promise<ReviewItemRow | null> {
  const rows = await queryable(executor)
    .select()
    .from(reviewItem)
    .where(eq(reviewItem.id, id))
    .limit(1);
  return (rows[0] as ReviewItemRow | undefined) ?? null;
}

/** The open draft of this kind for this recording, if there is one. */
export async function findOpenDraft(
  recordingId: string,
  kind: ReviewKind,
  executor: Executor = getDatabase(),
): Promise<ReviewItemRow | null> {
  const rows = await queryable(executor)
    .select()
    .from(reviewItem)
    .where(
      and(
        eq(reviewItem.recordingId, recordingId),
        eq(reviewItem.kind, kind),
        eq(reviewItem.status, 'draft'),
      ),
    )
    .limit(1);
  return (rows[0] as ReviewItemRow | undefined) ?? null;
}

export interface CloseReviewItem {
  readonly id: string;
  /** `published` when it was approved, `discarded` when it was thrown away or regenerated. */
  readonly status: Exclude<ReviewStatus, 'draft'>;
  readonly reviewedBy: string;
  /** The admin's text when they edited before approving. Omitted leaves the machine's. */
  readonly fields?: unknown;
  /** Provenance with the edited flags set. Omitted leaves what generation wrote. */
  readonly provenance?: unknown;
}

/**
 * Close an item, stamping who did it and when.
 *
 * **Only an open one.** The `status = 'draft'` predicate is what makes acting on a closed item a
 * refusal rather than a silent re-apply — two admins pressing approve at the same moment have one
 * of them answered with "already closed", from the database rather than from a check-then-write
 * with a window in it. `null` back means it was not open.
 *
 * The draft text stays in the row when it is discarded. What [3.6.10](docs/project/prd.md) calls
 * deletion is satisfied in the sense that matters — no summary exists and nothing is
 * member-visible — while the row remains the record of what was proposed and who rejected it.
 */
export async function closeReviewItem(
  input: CloseReviewItem,
  executor: Executor = getDatabase(),
): Promise<ReviewItemRow | null> {
  const rows = await queryable(executor)
    .update(reviewItem)
    .set({
      status: input.status,
      reviewedBy: input.reviewedBy,
      reviewedAt: sql`now()`,
      ...(input.fields === undefined ? {} : { fields: input.fields }),
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    })
    .where(and(eq(reviewItem.id, input.id), eq(reviewItem.status, 'draft')))
    .returning();

  return (rows[0] as ReviewItemRow | undefined) ?? null;
}

/** One item, plus the recording it is about and how long that teaching is. */
export interface PendingReviewRow extends ReviewItemRow {
  readonly recordingTitle: string;
  /** `YYYY-MM-DD`. A SQL `date`, so it comes back as the string it was written as. */
  readonly recordedAt: string;
  /** Words in the transcript, summed over the segment rows. `0` when there is no transcript. */
  readonly wordCount: number;
}

/**
 * **Everything waiting on an admin, in one query over one column.**
 *
 * The `where` is `status = 'draft'` and nothing else. There is no branch on `kind`, no union and
 * no per-artefact read — which is the property the single-table design exists to hold, and the one
 * a later epic's fifth artefact type must not cost.
 *
 * Newest recording first, matching every other admin list, with `created_at` breaking the tie
 * because a `date` has no time of day and two teachings recorded on the same Sunday would
 * otherwise come back in whatever order the planner chose that second.
 *
 * The word count is **computed here rather than stored** ([3.6.5](docs/project/prd.md)): a
 * correlated sum over the segments of the recording's transcript, in the same statement. At ~900
 * segments that is cheaper than a column somebody has to keep in step with every re-transcription
 * and every Story 5 correction. A recording with no transcript counts zero, which is the honest
 * answer rather than a hole.
 */
export async function listPendingReviews(
  executor: Executor = getDatabase(),
): Promise<PendingReviewRow[]> {
  // `regexp_split_to_array` over runs of whitespace is what a word count is; `nullif` is what
  // stops an empty segment counting as one word, and the outer coalesce is the no-transcript case.
  const wordCount = sql<number>`(
    select coalesce(sum(
      coalesce(array_length(regexp_split_to_array(nullif(btrim(${segment.text}), ''), '\\s+'), 1), 0)
    ), 0)::int
    from ${segment}
    join ${transcript} on ${transcript.id} = ${segment.transcriptId}
    where ${transcript.recordingId} = ${recording.id}
  )`;

  const rows = await queryable(executor)
    .select({
      id: reviewItem.id,
      recordingId: reviewItem.recordingId,
      kind: reviewItem.kind,
      status: reviewItem.status,
      fields: reviewItem.fields,
      provenance: reviewItem.provenance,
      createdAt: reviewItem.createdAt,
      reviewedBy: reviewItem.reviewedBy,
      reviewedAt: reviewItem.reviewedAt,
      recordingTitle: recording.title,
      recordedAt: recording.recordedAt,
      wordCount,
    })
    .from(reviewItem)
    .innerJoin(recording, eq(recording.id, reviewItem.recordingId))
    .where(eq(reviewItem.status, 'draft'))
    .orderBy(desc(recording.recordedAt), desc(recording.createdAt), desc(reviewItem.createdAt));

  return rows as unknown as PendingReviewRow[];
}
