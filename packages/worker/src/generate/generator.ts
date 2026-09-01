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

/**
 * **One line of the transcript, as the model is shown it.**
 *
 * The offset travels with the words, and that is what makes two later requirements answerable at
 * all: a scripture reference can carry *where in the recording the passage is cited*
 * ([3.7.10](docs/project/prd.md)), and a chapter boundary can be proposed as a moment rather than
 * as a phrase somebody downstream would have to find again ([3.22.1](docs/project/prd.md),
 * [3.22.5](docs/project/prd.md)).
 *
 * It costs about eight characters a line — some seven kilobytes on a ninety-minute teaching — and
 * that is the whole price of both. The alternative is a second call over the same transcript, which
 * is the cost this port was shaped to avoid.
 */
export interface TranscriptLine {
  /** Inclusive start offset from the beginning of the recording, in milliseconds. */
  readonly startMs: number;
  readonly text: string;
}

export interface GenerationRequest {
  /** What the teaching is called. Context the transcript alone does not carry. */
  readonly title: string;
  /**
   * The whole transcript, in playback order, one entry per segment.
   *
   * A list rather than the joined string it used to be, so the offsets survive as far as the
   * prompt — see {@link TranscriptLine}. What the model reads is still one block of text; building
   * it is the prompt module's business, which is the one place that decides how a transcript is
   * shown to a model.
   */
  readonly lines: readonly TranscriptLine[];
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

// =================================================================================================
// The second thing this port does: cut a teaching into chapters ([3.22.1](docs/project/prd.md)).
//
// A second method rather than a fourth `ReviewKind`, and the requirements say why outright: what a
// chapter generation produces does **not** go through the review gate
// ([3.22.6](docs/project/prd.md)) and is not one field of one draft — it is a list of boundaries
// with text hanging off each. `REVIEW_FIELD`'s one-field-per-kind shape cannot carry it, and
// bending it to would bend the queue and the review form with it.
//
// It is still **one adapter and one vendor named in configuration** (project tdd 4.10 — "one
// language model behind an adapter for all text generation ... chapter segmentation ... is one
// capability used seven ways"). What differs is the call, not the boundary.
// =================================================================================================

/** What the model is asked to cut into chapters. */
export interface ChapterRequest {
  /** What the teaching is called. */
  readonly title: string;
  /** The whole transcript, in playback order — the same lines a draft request carries. */
  readonly lines: readonly TranscriptLine[];
  /**
   * How long the teaching runs, in milliseconds — the end of the last transcript segment
   * ([4.2](docs/project/prd.md), *Duration: auto-derived*).
   *
   * Handed over rather than derived from the lines, because a line carries only its start: the
   * adapter would have to guess at the last one's length, and the caller already knows.
   */
  readonly durationMs: number;
}

/**
 * **One chapter as the model proposes it** — a moment and the two pieces of text that name it.
 *
 * `startMs` is a proposal and nothing more: [3.22.5](docs/project/prd.md) requires a boundary to
 * fall on the start of a transcript segment, and the handler snaps it to one. Asking the adapter to
 * do that would put a product rule inside a vendor file, and asking the *model* to do it would make
 * a requirement depend on a model getting arithmetic right.
 *
 * There is no `endMs`, because a chapter has none (project tdd 3.7): it ends where the next one
 * begins.
 */
export interface ProposedChapter {
  readonly startMs: number;
  readonly title: string;
  readonly summary: string;
}

/**
 * What one segmentation answered.
 *
 * **In the order the model gave them, unsorted and unchecked.** Whether they ascend, whether they
 * are far enough apart and whether there are enough of them to be a list at all are all
 * [3.22.4](docs/project/prd.md)'s questions, and they are answered once, in the handler, where the
 * refusals are counted — never inside a vendor adapter.
 */
export interface ChapterResult {
  readonly chapters: readonly ProposedChapter[];
  /** Which prompt produced it. Its own label, because it is its own prompt. */
  readonly promptVersion: string;
  readonly spend: GenerationSpend;
}

export interface Generator {
  /** Which adapter is in use, for the log line. Never a vendor decision made in code. */
  readonly name: string;
  generate(request: GenerationRequest): Promise<GenerationResult>;
  /**
   * Cut this teaching into chapters ([3.22.1](docs/project/prd.md)).
   *
   * Answers with an **empty list** for a teaching it cannot usefully divide, which is a result
   * rather than a failure: [3.22.4](docs/project/prd.md) says a recording too short to hold two
   * chapters gets none, and a port that could not express that would make the ordinary case an
   * error on the pipeline screen.
   */
  segmentChapters(request: ChapterRequest): Promise<ChapterResult>;
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
