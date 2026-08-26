import type { ProposedCitation, ReviewKind } from '@thp/shared';

/**
 * **The generation port — what drafting is, as far as this application is concerned.**
 *
 * One interface, one adapter behind it, and the vendor named in configuration rather than in code —
 * the same shape as the ASR, mail and media boundaries, and enforced the same way:
 * tests/guards/generate-boundary.test.ts fails the build if anything outside the adapter imports a
 * model SDK or names a provider's API. That is the *deliberately low reversal cost*
 * core-listening scope tdd § Key choices claims for the generate adapter, and
 * it is only a claim while this is the only door to a provider.
 *
 * The port takes **the whole transcript and which artefacts are wanted**, and answers with one
 * string per kind plus what the call cost. Everything vendor-shaped stops at the adapter: nothing
 * downstream sees a message, a tool call or a token count in the provider's own spelling.
 *
 * **One call for both artefacts.** The transcript is the expensive half of the request and sending
 * it twice would double the input cost for two answers that ought to agree with each other —
 * which is the cost and consistency decision the architecture's one-call row already took.
 */

export interface GenerationRequest {
  /** What the teaching is called. Context the transcript alone does not carry. */
  readonly title: string;
  /** The whole transcript, joined from the segment rows in playback order. */
  readonly transcript: string;
  /** Which artefacts to produce. Both on a chained run, one on a steered regeneration. */
  readonly kinds: readonly ReviewKind[];
  /**
   * The admin's sentence when they asked for this again and said what was wrong with the last one
   * ([3.6.9](docs/project/prd.md)). `null` on a first pass.
   */
  readonly steeringPrompt: string | null;
}

/**
 * What the job cost and what produced it, measured rather than estimated
 * ([§7](docs/project/prd.md)). These land in `job.provider_meta`; the raw response is not
 * persisted and lives in the log line.
 */
export interface GenerationSpend {
  readonly model: string;
  readonly modelVersion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** The provider's own id for this call, which is what completes the correlation span. */
  readonly requestId: string;
}

/**
 * What the model wrote for one kind: a paragraph, or a list of citations it proposed.
 *
 * The list arm is scope plan 1.3.1's widening — the port answers
 * with one string *or one list* per kind, and which of the two a kind wants is `REVIEW_FIELD`'s
 * declared shape rather than anything the provider decides.
 *
 * **The citations arrive unresolved.** `book` is still the words the model wrote, because whether
 * those name a book of the canon is not a question about the provider's response and is not
 * answered inside a vendor adapter — it is answered once, in `scripture-draft.ts`, where the
 * dropping is counted.
 */
export type GeneratedDraft = string | readonly ProposedCitation[];

/**
 * What the model wrote, per kind asked for.
 *
 * One value per kind because **every kind carries exactly one field** — the field's *name* is
 * `REVIEW_FIELD`'s business and the handler's, not the provider's. A later kind with two fields
 * widens this type; nothing about the transport changes.
 */
export type GeneratedDrafts = Readonly<Partial<Record<ReviewKind, GeneratedDraft>>>;

export interface GenerationResult {
  readonly drafts: GeneratedDrafts;
  /** Which prompt produced it. A hand-maintained label — see the prompt module. */
  readonly promptVersion: string;
  readonly spend: GenerationSpend;
}

export interface Generator {
  /** Which adapter is in use, for the log line. Never a vendor decision made in code. */
  readonly name: string;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

/**
 * What a generation failed with.
 *
 * One error type for every way the provider can refuse — an HTTP status, a timeout, a body that is
 * not the shape it promised, **and an answer in prose where a tool call was required**. As far as
 * the handler is concerned they are the same event: this recording has no draft and the job fails
 * with a reason an operator reads off `/admin/pipeline` and re-runs. What differs is the message.
 */
export class GenerationError extends Error {
  override readonly name = 'GenerationError';
}
