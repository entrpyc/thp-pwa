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
  checkAnchorMs,
  checkCitation,
  citationKey,
  citationsEqual,
  formatCitation,
  isScriptureCitation,
  type FieldProvenance,
  type RegenerateReviewPayload,
  type RegenerateReviewRequest,
  type ResolveReviewPayload,
  type ResolveReviewRequest,
  type ReviewFieldValue,
  type ReviewItemView,
  type ReviewKind,
  type DraftedCitation,
  type ReviewProvenance,
  type ScriptureReferenceView,
  type SubmittedReference,
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
 * constraint of core-listening scope plan § Standing constraints, and
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
    return approveList(actor, id, item, spec.name, request.references);
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
 * **Approving a list makes it the teaching's references** (scope prd 3.2.6).
 *
 * The write-through for a list-shaped kind, and the same two statements in the same one
 * transaction the text kinds use: what was approved goes to the canonical table, and the item that
 * proposed it closes. A failure in either leaves neither, so there is no state in which a teaching
 * carries references nobody approved.
 *
 * **The list written is the admin's, when they sent one** (scope plan 2.1.4).
 * A body carrying no list approves the item's own, which is what taking the machine's as it stands
 * means. Either way the *draft* is left exactly as it was written: the correction is a fact about
 * what was approved, and overwriting the proposal with it would lose the comparison that makes a
 * closed item worth keeping.
 *
 * An empty list is legal and correct: it deletes whatever the teaching had and records, in the
 * closed item, that somebody looked and found none (scope prd 3.2.7).
 */
async function approveList(
  actor: Actor,
  id: string,
  item: ReviewItemRow,
  field: string,
  submitted: readonly unknown[] | undefined,
): Promise<ResolveReviewPayload> {
  const proposed = readCitations(item.fields, field);
  const references =
    submitted === undefined ? asProposed(proposed) : resolveReferences(submitted, proposed);
  // The list as a whole was changed, which is what the field-level flag has always meant. Both
  // halves are reachable only through a correction: nothing a person added or edited is here
  // otherwise, and a removal is what changes the length.
  const edited =
    references.length !== proposed.length ||
    references.some((one) => one.origin === PERSON || one.editedByAdmin);

  await withTransaction(async (tx) => {
    // **The close goes first, and that ordering is the concurrency control.** Two admins pressing
    // at the same moment both reach here; the second blocks on the review item's row lock, and
    // when the first commits it sees a row that is no longer a draft and is refused before it has
    // written anything. Writing the references first would have both transactions racing to delete
    // and re-insert the same passages, which is a unique-violation rather than a refusal.
    const closed = await closeReviewItem(
      {
        id,
        status: 'published',
        // `fields` deliberately unset: the draft stays the machine's proposal. What was approved,
        // and where each reference in it came from, goes beside the model that proposed it
        // (scope plan 2.2.4).
        reviewedBy: actor.id,
        provenance: withEntries(item.provenance, field, references, edited),
      },
      tx,
    );
    if (closed === null) throw closedAlready();

    await replaceScriptureReferences(item.recordingId, references, tx);
  });

  logger.info('review.approve', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'review.resolve',
    target: `review_item:${id}`,
    recordingId: item.recordingId,
    kind: item.kind,
    edited,
    references: references.length,
  });

  return { id, status: 'published' };
}

/** The two things a reference can have come from, spelled once, where the enum declares them. */
const [MACHINE, PERSON] = SCRIPTURE_ORIGINS;

/**
 * The machine's list, approved as it stands: nobody added anything and nobody changed anything.
 *
 * The anchor comes across untouched ([3.7.10](docs/project/prd.md)) — taking the machine's proposal
 * as it stands means taking where it placed each passage as well as which passage it named.
 */
function asProposed(citations: readonly DraftedCitation[]): ScriptureReferenceView[] {
  return citations.map((citation) => ({
    ...citation,
    origin: MACHINE,
    editedByAdmin: false,
  }));
}

/**
 * **What the admin sent, checked and placed** (scope plan 2.1.5,
 * scope plan 2.2.3).
 *
 * Two questions per entry, and the order matters. First, *is this a citation* — asked of the same
 * validator the worker refuses a model's proposal with, because what one screen allowed is not what
 * the product allows and a client is not the authority on either. Then, *where did it come from* —
 * derived from the proposal the row names rather than from anything the client asserts about
 * itself.
 *
 * **The same passage twice is refused.** The form will not build such a list
 * (scope prd 3.2.5), and the references table will not hold one — so refusing it
 * here is what turns a unique-violation into a sentence an admin can act on.
 *
 * Refusals throw before the transaction opens, so a list holding one bad entry writes nothing at
 * all rather than most of itself.
 */
function resolveReferences(
  submitted: readonly unknown[],
  proposed: readonly DraftedCitation[],
): ScriptureReferenceView[] {
  const seen = new Set<string>();

  return submitted.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw ApiError.invalidInput('Every reference has to name a book, a chapter and its verses.');
    }
    const { book, chapter, verseStart, verseEnd, anchorMs, from } =
      entry as Partial<SubmittedReference>;

    const checked = checkCitation({
      book: typeof book === 'string' ? book : '',
      chapter: typeof chapter === 'number' ? chapter : Number.NaN,
      // An absent verse and a null one are the same thing said twice — the whole chapter.
      verseStart: verseStart ?? null,
      verseEnd: verseEnd ?? null,
    });
    if (!checked.ok) throw ApiError.invalidInput(checked.problem.message);

    const key = citationKey(checked.citation);
    if (seen.has(key)) {
      throw ApiError.invalidInput(
        `${formatCitation(checked.citation)} is in this list twice. A teaching cites a passage once.`,
      );
    }
    seen.add(key);

    // Which proposal this row replaced, if any. An index naming nothing reads as no proposal at
    // all — the answer that never claims the machine's authorship for a row that cannot show it.
    const source =
      typeof from === 'number' && Number.isInteger(from) && from >= 0 && from < proposed.length
        ? proposed[from]
        : undefined;

    /*
     * **The anchor is checked, never trusted** ([3.7.10](docs/project/prd.md)).
     *
     * The same function the worker checks a model's proposal with, asked again here, because what
     * one screen allowed is not what the product allows. Anything that is not a whole, non-negative
     * offset reads as no anchor — which is a legal state for a reference rather than a refusal, so
     * a form that sent a blank field is answered rather than rejected.
     */
    const anchor = checkAnchorMs(anchorMs);

    if (source === undefined) {
      /*
       * A reference an admin added by hand. 3.7.10 says it "carries none" — but that is the
       * *ordinary* case rather than a prohibition: an admin who typed a moment has said where the
       * passage is cited, and discarding it would make the field unfillable on exactly the rows
       * 3.7.2 exists for. What is guaranteed is that nothing invents one.
       */
      return { ...checked.citation, origin: PERSON, editedByAdmin: false, anchorMs: anchor };
    }
    return {
      ...checked.citation,
      origin: MACHINE,
      // The passage, or where it was placed. Moving an anchor is editing the reference as much as
      // changing a verse number is — both are the admin correcting what the machine proposed.
      editedByAdmin: !citationsEqual(checked.citation, source) || anchor !== source.anchorMs,
      anchorMs: anchor,
    };
  });
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
    else if (Array.isArray(entry)) {
      /*
       * The citation's shape is checked, and the anchor is **normalised on the way out**
       * ([3.7.10](docs/project/prd.md)): a draft written before anchors existed carries none at
       * all, and one written by a model that answered with rubbish carries something that is not an
       * offset. Both read as `null` here, so the review form gets one shape to render and a draft
       * from last week still opens.
       */
      found[key] = entry.filter(isScriptureCitation).map((one) => ({
        ...one,
        anchorMs: checkAnchorMs((one as { anchorMs?: unknown }).anchorMs),
      }));
    }
  }
  return found;
}

function readField(fields: unknown, name: string): string {
  const value = readFields(fields)[name];
  return typeof value === 'string' ? value : '';
}

/**
 * The citations a list-shaped field holds. Anything that is not one is not there.
 *
 * A draft written before anchors existed has entries with no `anchorMs` on them at all, and they
 * read here as `null` — the same as a passage the model could not place
 * ([3.7.10](docs/project/prd.md)). That is what makes the widening cost nothing: an open draft from
 * last week still approves, and the references it writes simply belong to the recording rather than
 * to any chapter.
 */
function readCitations(fields: unknown, name: string): readonly DraftedCitation[] {
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

/**
 * The provenance a closed list-shaped item carries: what generation wrote, plus what was actually
 * approved and where each reference in it came from
 * (scope plan 2.2.4).
 */
function withEntries(
  provenance: unknown,
  field: string,
  entries: readonly ScriptureReferenceView[],
  edited: boolean,
): ReviewProvenance {
  const existing = (provenance ?? {}) as ReviewProvenance;
  const perField = (existing.fields ?? {}) as Record<string, FieldProvenance>;
  const before = perField[field] ?? { aiSuggested: true, editedByAdmin: false };
  return {
    ...existing,
    fields: { ...perField, [field]: { ...before, editedByAdmin: edited, entries } },
  };
}

interface ParsedResolve {
  readonly action: 'approve' | 'discard';
  readonly fields?: Record<string, string>;
  /** The list an admin corrected, unchecked. `undefined` when they sent none. */
  readonly references?: readonly unknown[];
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
  const name = spec.name;
  const value = (fields as Record<string, unknown>)[name];
  if (value === undefined) return { action };

  // A list-shaped draft arrives as the rows the form rendered. What is *in* them is
  // `resolveReferences`'s question — this is only that a list is what came.
  if (spec.shape === 'list') {
    if (!Array.isArray(value)) {
      throw ApiError.invalidInput(`Send the ${name} as a list of references.`);
    }
    return { action, references: value as readonly unknown[] };
  }

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
