import {
  closeReviewItem,
  findReviewItem,
  listPendingReviews,
  publishSummary,
  replaceScriptureReferences,
  setRecordingDescription,
  withTransaction,
  type PendingReviewRow,
  type ReviewItemRow,
} from '@thp/db';
import {
  MAX_STEERING_PROMPT_LENGTH,
  REVIEW_FIELD,
  SCRIPTURE_ORIGINS,
  isScriptureCitation,
  type FieldProvenance,
  type RegenerateReviewPayload,
  type RegenerateReviewRequest,
  type ResolveReviewPayload,
  type ResolveReviewRequest,
  type ReviewFieldValue,
  type ReviewItemView,
  type ReviewKind,
  type ReviewProvenance,
  type ScriptureCitation,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { queue } from '@/server/jobs/queue';
import { logger } from '@/server/observability/logger';

/**
 * **The review gate, as an admin acts on it** ([3.6.4](docs/project/prd.md)–
 * [3.6.10](docs/project/prd.md)).
 *
 * Three things happen here and nothing else does:
 *
 * 1. **The queue is read** — one call into `@thp/db`'s review module, which filters one column and
 *    branches on `kind` nowhere. This service does not branch on `kind` either.
 * 2. **An item is resolved** — approved, edited-then-approved, or discarded. Approving is the only
 *    path in the product that writes to a canonical entity from a draft, and it closes the item in
 *    the same transaction, so there is no state in which a summary exists and the item that
 *    produced it is still waiting.
 * 3. **A draft is asked for again**, which discards the current one and enqueues the step through
 *    the queue port with the kind and the steering sentence in the payload.
 *
 * **Every transition is logged with actor, action, target and timestamp** — the standing
 * constraint of docs/epics/epic-core-listening/implementation-plan.md § Standing constraints, and
 * the reason a closed item is readable as *what happened* rather than only as *what it now says*.
 */

/** The most a field's text may be. A summary, not a book; the same ceiling shape every route uses. */
const MAX_FIELD_LENGTH = 20_000;

export async function readReviewQueue(actor: Actor): Promise<ReviewItemView[]> {
  const rows = await listPendingReviews();

  logger.info('review.list', {
    actorId: actor.id,
    action: 'review.list',
    target: 'review_item:*',
    count: rows.length,
  });

  return rows.map(describeReview);
}

/**
 * Approve, edit-then-approve, or discard one item.
 *
 * **Approve writes through, then closes, in one transaction.** A crash between the two would leave
 * either a summary nobody approved or a draft still waiting for work that already landed, and both
 * are states an operator would have to reconcile by hand.
 *
 * **The close is what refuses a closed item.** `closeReviewItem` updates only where the status is
 * still `draft`, so a second press — or two admins at once — is answered with `review_closed` from
 * the database rather than from a check with a window in it.
 *
 * **Discard leaves the draft text in the closed row.** What [3.6.10](docs/project/prd.md) calls
 * deletion is satisfied in the sense that matters — no summary exists and nothing is
 * member-visible — while the row stays the record of what was proposed and who rejected it. The
 * recording remains publishable; nothing here is a precondition of anything.
 */
export async function resolveReview(
  actor: Actor,
  id: string,
  body: unknown,
): Promise<ResolveReviewPayload> {
  const item = await requireOpenItem(id);
  const request = parseResolveRequest(body, item.kind);

  if (request.action === 'discard') {
    const closed = await closeReviewItem({ id, status: 'discarded', reviewedBy: actor.id });
    if (closed === null) throw closedAlready();

    logger.info('review.discard', {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'review.resolve',
      target: `review_item:${id}`,
      recordingId: item.recordingId,
      kind: item.kind,
    });
    return { id, status: 'discarded' };
  }

  const spec = REVIEW_FIELD[item.kind];

  if (spec.shape === 'list') {
    return approveList(actor, id, item, spec.name);
  }

  const field = spec.name;
  const machine = readField(item.fields, field);
  const supplied = request.fields?.[field];
  const edited = supplied !== undefined && supplied !== machine;
  const content = supplied ?? machine;

  if (content.trim() === '') {
    throw ApiError.invalidInput(`Give the ${field} some text, or discard this draft instead.`);
  }

  await withTransaction(async (tx) => {
    // The write-through, per kind. This is the one place `kind` decides anything, and it decides
    // *where the approved text goes* — not what the queue is, not what the form renders.
    if (item.kind === 'summary') {
      await publishSummary(item.recordingId, content, tx);
    } else {
      await setRecordingDescription(item.recordingId, content, tx);
    }

    const closed = await closeReviewItem(
      {
        id,
        status: 'published',
        reviewedBy: actor.id,
        fields: { ...readFields(item.fields), [field]: content },
        provenance: withEdit(item.provenance, field, edited),
      },
      tx,
    );
    if (closed === null) throw closedAlready();
  });

  logger.info('review.approve', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'review.resolve',
    target: `review_item:${id}`,
    recordingId: item.recordingId,
    kind: item.kind,
    // Whether the admin took the machine's words or their own, which is the fact
    // docs/project/prd.md 4.17.5 is asking to be able to read back.
    edited,
  });

  return { id, status: 'published' };
}

/**
 * **Approving a list makes it the teaching's references** ([3.2.6](docs/active-scope/prd.md)).
 *
 * The write-through for a list-shaped kind, and the same two statements in the same one
 * transaction the text kinds use: what was approved goes to the canonical table, and the item that
 * proposed it closes. A failure in either leaves neither, so there is no state in which a teaching
 * carries references nobody approved.
 *
 * **The list written is the item's own.** Nothing an admin sends is read here, because in this
 * group the rows are read-only — editing, removing and adding are group 2, and the server
 * re-validating what a client sent arrives with them. An empty list is legal and correct: it
 * deletes whatever the teaching had and records, in the closed item, that somebody looked and
 * found none ([3.2.7](docs/active-scope/prd.md)).
 */
async function approveList(
  actor: Actor,
  id: string,
  item: ReviewItemRow,
  field: string,
): Promise<ResolveReviewPayload> {
  const citations = readCitations(item.fields, field);

  await withTransaction(async (tx) => {
    // **The close goes first, and that ordering is the concurrency control.** Two admins pressing
    // at the same moment both reach here; the second blocks on the review item's row lock, and
    // when the first commits it sees a row that is no longer a draft and is refused before it has
    // written anything. Writing the references first would have both transactions racing to delete
    // and re-insert the same passages, which is a unique-violation rather than a refusal.
    const closed = await closeReviewItem({ id, status: 'published', reviewedBy: actor.id }, tx);
    if (closed === null) throw closedAlready();

    await replaceScriptureReferences(
      item.recordingId,
      citations.map((citation) => ({
        ...citation,
        // Everything in this group came from the machine and nobody has changed it. Group 2 is what
        // makes either of these say something else.
        origin: SCRIPTURE_ORIGINS[0],
        editedByAdmin: false,
      })),
      tx,
    );
  });

  logger.info('review.approve', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'review.resolve',
    target: `review_item:${id}`,
    recordingId: item.recordingId,
    kind: item.kind,
    edited: false,
    references: citations.length,
  });

  return { id, status: 'published' };
}

/**
 * Throw this draft away and ask for another, optionally saying what was wrong with it
 * ([3.6.9](docs/project/prd.md)).
 *
 * **One generation in flight per recording.** A second request while one is unfinished is refused
 * with `generation_in_flight` rather than answered with the existing job: the partial unique index
 * over `(recording_id, step)` would make the second enqueue a no-op returning work for whichever
 * kind the *first* request asked for, and handing that back would be a wrong answer wearing a
 * success. At 4.3 recordings a month, refusing is the honest one.
 *
 * The discard and the enqueue are one transaction, so an admin never ends up with a queue entry
 * they cannot act on and no job coming to replace it.
 */
export async function regenerateReview(
  actor: Actor,
  id: string,
  body: unknown,
): Promise<RegenerateReviewPayload> {
  const item = await requireOpenItem(id);
  const prompt = parseRegenerateRequest(body);

  const inFlight = await queue().findUnfinished(item.recordingId, 'generate_draft');
  if (inFlight !== null) {
    throw new ApiError(
      'generation_in_flight',
      409,
      'A draft for this recording is already being generated. Wait for it to finish, then try again.',
    );
  }

  const enqueued = await withTransaction(async (tx) => {
    const closed = await closeReviewItem({ id, status: 'discarded', reviewedBy: actor.id }, tx);
    if (closed === null) throw closedAlready();

    // Through the port, so the row carries this request's correlation id and computes `attempt`
    // inside the insert. The payload is what makes it the *same* handler rather than a second path.
    return queue().enqueue(
      {
        recordingId: item.recordingId,
        step: 'generate_draft',
        payload: { kinds: [item.kind], ...(prompt === null ? {} : { prompt }) },
      },
      tx,
    );
  });

  logger.info('review.regenerate', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'review.regenerate',
    target: `review_item:${id}`,
    recordingId: item.recordingId,
    kind: item.kind,
    steered: prompt !== null,
    jobId: enqueued.id,
    attempt: enqueued.attempt,
  });

  return { jobId: enqueued.id, recordingId: item.recordingId, kind: item.kind };
}

/** The item, or the refusal a caller reads. Asked before anything is written, every time. */
async function requireOpenItem(id: string): Promise<ReviewItemRow> {
  const item = await findReviewItem(id);
  if (item === null) throw ApiError.notFound('There is no review item with that id.');
  if (item.status !== 'draft') throw closedAlready();
  return item;
}

function closedAlready(): ApiError {
  return new ApiError(
    'review_closed',
    409,
    'That draft has already been dealt with. Reload the queue to see where it went.',
  );
}

/** The row, as the queue and the form are allowed to see it. */
export function describeReview(row: PendingReviewRow): ReviewItemView {
  return {
    id: row.id,
    recordingId: row.recordingId,
    recordingTitle: row.recordingTitle,
    recordedAt: row.recordedAt,
    kind: row.kind,
    status: row.status,
    fields: readFields(row.fields),
    provenance: row.provenance as ReviewProvenance,
    wordCount: row.wordCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `jsonb` comes back as `unknown`. Everything read out of it is checked before it is used.
 *
 * A field is kept when it is one of the shapes a draft may be — a paragraph, or a list of
 * citations. Anything else is dropped rather than passed on, so a row written by a version of the
 * worker this one does not know about cannot put an arbitrary value on the wire.
 */
function readFields(value: unknown): Record<string, ReviewFieldValue> {
  if (typeof value !== 'object' || value === null) return {};
  const found: Record<string, ReviewFieldValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') found[key] = entry;
    else if (Array.isArray(entry)) found[key] = entry.filter(isScriptureCitation);
  }
  return found;
}

function readField(fields: unknown, name: string): string {
  const value = readFields(fields)[name];
  return typeof value === 'string' ? value : '';
}

/** The citations a list-shaped field holds. Anything that is not one is not there. */
function readCitations(fields: unknown, name: string): readonly ScriptureCitation[] {
  const value = readFields(fields)[name];
  return Array.isArray(value) ? value : [];
}

/**
 * The provenance the approved row carries: what generation wrote, with this field's
 * `editedByAdmin` set to what actually happened ([4.17.5](docs/project/prd.md)).
 */
function withEdit(provenance: unknown, field: string, edited: boolean): ReviewProvenance {
  const existing = (provenance ?? {}) as ReviewProvenance;
  const perField = (existing.fields ?? {}) as Record<string, FieldProvenance>;
  const before = perField[field] ?? { aiSuggested: true, editedByAdmin: false };
  return {
    ...existing,
    fields: { ...perField, [field]: { ...before, editedByAdmin: edited } },
  };
}

interface ParsedResolve {
  readonly action: 'approve' | 'discard';
  readonly fields?: Record<string, string>;
}

function parseResolveRequest(body: unknown, kind: ReviewKind): ParsedResolve {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object naming the action to take.');
  }
  const { action, fields } = body as Partial<ResolveReviewRequest>;
  if (action !== 'approve' && action !== 'discard') {
    throw ApiError.invalidInput('That is not something you can do to a draft.');
  }
  if (action === 'discard' || fields === undefined) return { action };

  if (typeof fields !== 'object' || fields === null) {
    throw ApiError.invalidInput('Send the edited text as an object of fields.');
  }

  // Only the field this kind carries is read. A body naming a field the kind has no business with
  // is ignored rather than refused — the form sends what it rendered, and nothing else is written.
  const spec = REVIEW_FIELD[kind];
  // A list-shaped draft is approved as it stands in this group: its rows are read-only, so there is
  // nothing an admin could have edited and nothing to accept from them. Task 2.1 is what makes an
  // edited list arrive here, and what re-validates it.
  if (spec.shape === 'list') return { action };

  const name = spec.name;
  const value = (fields as Record<string, unknown>)[name];
  if (value === undefined) return { action };
  if (typeof value !== 'string' || value.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput(`The ${name} is not text this can store.`);
  }
  return { action, fields: { [name]: value } };
}

function parseRegenerateRequest(body: unknown): string | null {
  // A body-less request is legal: regenerating with no steer is the common case.
  if (body === null || body === undefined) return null;
  if (typeof body !== 'object') {
    throw ApiError.invalidInput('Send a JSON object, optionally naming what to change.');
  }
  const { prompt } = body as Partial<RegenerateReviewRequest>;
  if (prompt === undefined || prompt === null) return null;
  if (typeof prompt !== 'string' || prompt.length > MAX_STEERING_PROMPT_LENGTH) {
    throw ApiError.invalidInput(
      `Say what to change in ${MAX_STEERING_PROMPT_LENGTH} characters or fewer.`,
    );
  }
  return prompt.trim() === '' ? null : prompt.trim();
}
