/**
 * The review gate's vocabulary and wire contract (Story 3).
 *
 * **One table, one queue, one query** — docs/epics/epic-core-listening/architecture.md § Data model
 * (epic) settles that every AI artefact this product ever generates arrives as a `review_item` with
 * a `kind`, rather than as a table of its own. Scripture references, tags, topics, mind maps and
 * video scripts each add a value to {@link REVIEW_KINDS} in a later epic and change nothing else:
 * not the queue read, not the form, not the route. That property is the whole reason this file is
 * shaped the way it is.
 *
 * The two enums are declared here exactly once for the repository — the Postgres enums are
 * *derived* from these tuples rather than restated beside them, which is what
 * tests/guards/domain-declarations.test.ts already enforces for `ROLES`, `PIPELINE_STEPS` and
 * `JOB_STATUSES`.
 */

import type { ScriptureCitation } from './scripture';

/**
 * What kind of artefact is waiting on an admin.
 *
 * Two in this epic. `summary` is the teaching's summary ([3.6.1](docs/project/prd.md));
 * `recording_metadata` is the suggested description ([4.17.1](docs/project/prd.md) — topics, tags
 * and scripture references are deferred with the epics that generate them).
 */
export const REVIEW_KINDS = ['summary', 'recording_metadata', 'scripture'] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

export function isReviewKind(value: unknown): value is ReviewKind {
  return typeof value === 'string' && (REVIEW_KINDS as readonly string[]).includes(value);
}

/**
 * Where an item is in its life.
 *
 * `draft` is the only open state and therefore **the whole of the Pending Reviews query**
 * ([3.19.2](docs/project/prd.md)). `published` and `discarded` are both closed and both terminal:
 * an item is acted on once, and what the machine proposed stays in the row afterwards, which is
 * what keeps the audit trail intact when a draft is rejected.
 *
 * There is no `regenerating`. A regeneration *discards* the item it replaces and writes a fresh
 * `draft`, so "how many are waiting on me" never has to subtract a state.
 */
export const REVIEW_STATUSES = ['draft', 'published', 'discarded'] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && (REVIEW_STATUSES as readonly string[]).includes(value);
}

/**
 * **What shape a kind's draft is.**
 *
 * `text` is one string, which is what every kind was until scripture arrived. `list` is a list of
 * structured entries — the first artefact whose draft is not a paragraph, and, per
 * [1.4](docs/active-scope/prd.md), the first of four: tags, mind maps and video scripts are queued
 * behind it and are not one string either.
 *
 * The distinction lives here rather than in the form so that the form can *ask* rather than
 * branch: a renderer is chosen by shape, and a kind added to {@link REVIEW_KINDS} says which
 * renderer it wants by saying what shape it is.
 */
export const REVIEW_FIELD_SHAPES = ['text', 'list'] as const;

export type ReviewFieldShape = (typeof REVIEW_FIELD_SHAPES)[number];

/** The one field a kind carries: what it is called, and what shape it is. */
export interface ReviewFieldSpec {
  readonly name: string;
  readonly shape: ReviewFieldShape;
}

/**
 * The field each kind carries.
 *
 * **One field per kind still**, and the form does not know that:
 * [4.17.2](docs/project/prd.md) wants accept/edit/discard per field, and the review form is built
 * generically over the `fields` and `provenance` objects a row holds. This map exists for the two
 * writers — the generator, which turns one answer into `{ summary }`, `{ description }` or
 * `{ citations }`, and the approve path, which reads the value back out to write it through to the
 * canonical entity.
 *
 * It widened from a bare field *name* to a name and a shape when scripture arrived
 * ([1.2.2](docs/active-scope/implementation-plan.md)). The two text kinds are read and written
 * exactly as they were; what a reader now has is a way to ask what it is holding without knowing
 * which kinds exist.
 *
 * `Record<ReviewKind, ReviewFieldSpec>` rather than a lookup with a fallback: a kind added to
 * {@link REVIEW_KINDS} stops the build until it says which field it carries and what shape it is.
 */
export const REVIEW_FIELD: Record<ReviewKind, ReviewFieldSpec> = {
  summary: { name: 'summary', shape: 'text' },
  recording_metadata: { name: 'description', shape: 'text' },
  scripture: { name: 'citations', shape: 'list' },
};

/** What a kind is called on screen. A kind with no entry here would be a compiler error. */
export const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  summary: 'Summary',
  recording_metadata: 'Description',
  scripture: 'Scripture',
};

/** Paths of the review resource, relative to the `/api/v1` prefix. */
export const REVIEWS_PATH = '/reviews';

/** Where one item is acted on — approve, edit-then-approve, or discard. */
export function reviewPath(id: string): string {
  return `${REVIEWS_PATH}/${id}`;
}

/** Where a draft is thrown away and asked for again, optionally with a sentence of steering. */
export function reviewRegeneratePath(id: string): string {
  return `${REVIEWS_PATH}/${id}/regenerate`;
}

/** The Pending Reviews panel, on the web origin rather than under the API prefix. */
export const ADMIN_REVIEWS_PAGE_PATH = '/admin/reviews';

/**
 * The query parameter the recordings row links with, so "review this recording's drafts" is one
 * link into the queue rather than a per-recording admin page nobody asked for
 * ([3.6.4](docs/project/prd.md)).
 */
export const REVIEW_RECORDING_PARAM = 'recording';

/**
 * The most a steering sentence may be. A sentence, not a second prompt: it is prepended to a
 * prompt the model already has, and a wall of text there is a prompt nobody can reason about.
 */
export const MAX_STEERING_PROMPT_LENGTH = 500;

/**
 * What one field of a draft holds.
 *
 * One member per {@link ReviewFieldShape} — a paragraph, or a list of citations. The list arm names
 * scripture because scripture is the only list-shaped artefact there is; tags and mind maps widen
 * this union when they arrive, and everything reading it already asks the shape rather than the
 * kind.
 */
export type ReviewFieldValue = string | readonly ScriptureCitation[];

/** What the machine wrote for one field, and whether a person has changed it since. */
export interface FieldProvenance {
  /** True for every field this epic writes — nothing here is authored from scratch. */
  readonly aiSuggested: boolean;
  /** Set when an admin edited the text before approving it ([4.17.5](docs/project/prd.md)). */
  readonly editedByAdmin: boolean;
}

/**
 * Where this draft came from.
 *
 * The three labels are [4.17.5](docs/project/prd.md)'s "which model, which version, which prompt
 * version", and `steeringPrompt` is what the admin asked for when this draft is a regeneration —
 * present so somebody reading a second draft can see what they steered it with.
 */
export interface ReviewProvenance {
  readonly model: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  /** `null` on a first pass, the admin's sentence on a steered regeneration. */
  readonly steeringPrompt: string | null;
  /** Per field, by the same key `fields` uses. */
  readonly fields: Readonly<Record<string, FieldProvenance>>;
}

/** One item, as the queue and the form read it. */
export interface ReviewItemView {
  readonly id: string;
  readonly recordingId: string;
  readonly recordingTitle: string;
  /** `YYYY-MM-DD`. The queue's sort key, descending, as every other admin list is. */
  readonly recordedAt: string;
  readonly kind: ReviewKind;
  readonly status: ReviewStatus;
  /** The draft itself, keyed by field name, in whatever shape the kind's field declares. */
  readonly fields: Readonly<Record<string, ReviewFieldValue>>;
  readonly provenance: ReviewProvenance;
  /**
   * The transcript's word count, summed over the segment rows at read time. Nothing stores it: at
   * ~900 segments the sum is cheaper than a column somebody has to keep in step.
   */
  readonly wordCount: number;
  readonly createdAt: string;
}

/** Payload of `GET /api/v1/reviews`. */
export interface ReviewListPayload {
  readonly reviews: readonly ReviewItemView[];
}

/**
 * Body of `POST /api/v1/reviews/{id}`.
 *
 * `approve` writes through to the canonical entity and closes the item; `discard` closes it with
 * no replacement ([3.6.10](docs/project/prd.md)). `fields` is the admin's text when they edited it
 * before approving, and absent when they took the machine's as it stands.
 */
export interface ResolveReviewRequest {
  readonly action: 'approve' | 'discard';
  readonly fields?: Readonly<Record<string, string>>;
}

/** Payload of `POST /api/v1/reviews/{id}` — the item as it now reads. */
export interface ResolveReviewPayload {
  readonly id: string;
  readonly status: ReviewStatus;
}

/** Body of `POST /api/v1/reviews/{id}/regenerate`. Omitting the prompt is legal. */
export interface RegenerateReviewRequest {
  readonly prompt?: string;
}

/** Payload of `POST /api/v1/reviews/{id}/regenerate` — the job now waiting. */
export interface RegenerateReviewPayload {
  readonly jobId: string;
  readonly recordingId: string;
  readonly kind: ReviewKind;
}
