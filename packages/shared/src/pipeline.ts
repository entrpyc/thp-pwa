import { isUnfinishedJobStatus, type JobStatus } from './jobs';
import { RECORDINGS_PATH } from './recordings';

/**
 * The pipeline step enum. This epic runs two steps in order; the worker that executes them arrives
 * in a later ticket, but the vocabulary is fixed here so the API, the worker and the job ledger
 * never drift apart.
 *
 * `generate_chapters` is the chapters scope's addition ([3.22.1](docs/project/prd.md)) and it is
 * **its own step** rather than more of `generate_draft`, for two reasons the requirement gives
 * outright: what it produces reaches members with the recording rather than through the review
 * gate ([3.22.6](docs/project/prd.md)), and re-running it destroys human work where re-running a
 * draft does not ([3.22.8](docs/project/prd.md)). A step is the unit an admin re-runs
 * ([3.21.2.4](docs/project/prd.md)) and the unit a confirmation attaches to, so two facts that
 * differ per step have to sit on two steps.
 *
 * It runs **after** drafting rather than beside it because the chain is a list: the successor of a
 * step is read from this array and nowhere else, so ordering it here is the whole of ordering it.
 *
 * `process_audio` is the step [§3.4](docs/project/prd.md) reserved a place for, arrived: it
 * transcodes the uploaded original into a **playback rendition** whose container carries an exact
 * seek index. It exists because browsers cannot seek a VBR MP3 accurately — measured on a real
 * teaching, `currentTime` after a seek was up to nine seconds away from the audio actually
 * playing, which dragged captions, note anchors and chapter boundaries with it while the
 * transcript's own timings were right to within a frame. It runs **first**, before `transcribe`,
 * exactly where the reservation put it — the rendition is what members hear, so it is the thing to
 * produce before anything downstream spends money.
 */
export const PIPELINE_STEPS = [
  'process_audio',
  'transcribe',
  'generate_draft',
  'generate_chapters',
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/**
 * **Steps the ledger runs that are not links in the chain** ([§3.4](docs/project/prd.md)).
 *
 * Both exist because of one property of the chain rule: a step that succeeds enqueues its
 * successor, and the successor of `process_audio` is `transcribe`. Two things the sound profile
 * needs must produce a rendition *without* that cascade, and the only honest way to say so in a
 * ledger whose chain is a list is a step that is not in the list — `nextPipelineStep` answers
 * `null` for it, which is the same answer the last step of the chain gets.
 *
 * - `reprocess_audio` — the rendition again, under the profile in force
 *   ([3.4.7](docs/project/prd.md)). What an admin presses after saving a new version; it repoints
 *   the recording and touches nothing downstream, because the transcript's timings describe the
 *   original and the original is unchanged.
 * - `preview_audio` — thirty seconds of one teaching, plain and under a candidate profile
 *   ([3.4.6](docs/project/prd.md)). It repoints nothing at all; what it leaves is two objects a
 *   signed URL can be minted for.
 *
 * They ride the ledger rather than a second queue because the ledger *is* the queue
 * (project tdd 4.7): the worker claims them the way it claims anything, the sweep reclaims them,
 * and every attempt is a row an operator can read. They are simply absent from the pipeline
 * view's columns, which are `PIPELINE_STEPS` and nothing wider.
 */
export const STANDALONE_STEPS = ['reprocess_audio', 'preview_audio'] as const;

export type StandaloneStep = (typeof STANDALONE_STEPS)[number];

/**
 * Everything the `job.step` column can hold — the chain, then the standalone steps. The database
 * enum derives from this list; the chain rule reads `PIPELINE_STEPS` and never this.
 */
export const JOB_STEPS = [...PIPELINE_STEPS, ...STANDALONE_STEPS] as const;

export type JobStep = (typeof JOB_STEPS)[number];

export function isJobStep(value: unknown): value is JobStep {
  return typeof value === 'string' && (JOB_STEPS as readonly string[]).includes(value);
}

/**
 * Where a recording's pipeline starts.
 *
 * Read from the list rather than named, for the same reason the successor is: inserting
 * `process_audio` ahead of `transcribe` ([§3.4](docs/project/prd.md)) has to change what
 * finalising an upload enqueues, and it does — without an edit anywhere near the upload code.
 */
export const FIRST_PIPELINE_STEP: PipelineStep = PIPELINE_STEPS[0];

/**
 * The steps that spend money at a provider (docs/project/prd.md, 3.21.2.8).
 *
 * `process_audio` is ffmpeg on our own box and costs nothing that a budget could count. The other
 * three each make one billed call, and each records what it cost on the job row it ran as
 * (3.19.13) — which is what the daily spend ceiling reads. Listed here beside the steps rather
 * than inferred from a provider name so the worker and the API agree on which jobs the ceiling
 * applies to without either having to know how a step is implemented.
 */
export const SPENDING_STEPS: readonly PipelineStep[] = [
  'transcribe',
  'generate_draft',
  'generate_chapters',
];

export function isSpendingStep(step: JobStep): boolean {
  return (SPENDING_STEPS as readonly string[]).includes(step);
}

export function isPipelineStep(value: unknown): value is PipelineStep {
  return typeof value === 'string' && (PIPELINE_STEPS as readonly string[]).includes(value);
}

/**
 * The step that follows this one, or `null` when this is the last.
 *
 * **The whole of the pipeline-step-chain seam.** A step that succeeds enqueues its successor, and
 * the successor is read from this list and from nowhere else — so
 * [§3.4](docs/project/prd.md) inserting `process_audio` before `transcribe` is an edit to one
 * array rather than to a chain of handlers that each name the next.
 *
 * The list is a parameter so the rule can be driven from a different order in a test; production
 * passes nothing and gets `PIPELINE_STEPS`. A step that is not in the list has no successor,
 * which is the honest answer rather than an error: the chain has nowhere to go from a step it does
 * not contain.
 */
export function nextPipelineStep(
  step: JobStep,
  steps: readonly PipelineStep[] = PIPELINE_STEPS,
): PipelineStep | null {
  const index = (steps as readonly string[]).indexOf(step);
  if (index < 0) return null;
  return steps[index + 1] ?? null;
}

// =================================================================================================
// The pipeline status surface (Story 2 Ticket 04–05).
//
// One admin screen over the job ledger, and one control on it. The vocabulary sits here beside the
// step list because the screen's columns *are* the step list — a step added to `PIPELINE_STEPS` is
// a column nobody edits the panel to add.
// =================================================================================================

/** Where the pipeline status is read, relative to the `/api/v1` prefix. */
export const PIPELINE_PATH = '/pipeline';

/** The pipeline panel, on the web origin rather than under the API prefix. */
export const ADMIN_PIPELINE_PAGE_PATH = '/admin/pipeline';

/**
 * Where a single step is run again. The step is in the body rather than in the path, so
 * [§3.4](docs/project/prd.md)'s `process_audio` arriving needs no new route.
 */
export function recordingRerunPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/rerun`;
}

/**
 * How often the panel asks again **while work is in flight**, in milliseconds.
 *
 * Five seconds is a first setting, not a measured one — the same kind of number the confidence
 * threshold and the worker's poll interval are, and moving it is one edit here. The polling is a
 * consequence of there being work: a console left open on a finished pipeline stops asking.
 */
export const PIPELINE_POLL_INTERVAL_MS = 5_000;

/**
 * The key a stub handler marks `provider_meta` with.
 *
 * **Declared here rather than in the worker** because two processes have to agree on it: the
 * worker writes it, and the panel reads it to say *not built yet* where a bare row says
 * *succeeded*. The value the worker writes under this key stays the worker's business.
 */
export const STUB_PROVIDER_META_KEY = 'stub';

/** Whether this job's `provider_meta` says a stub produced it. */
export function isStubProviderMeta(providerMeta: unknown): boolean {
  return (
    typeof providerMeta === 'object' &&
    providerMeta !== null &&
    (providerMeta as Record<string, unknown>)[STUB_PROVIDER_META_KEY] === true
  );
}

/**
 * What a step reads as on the panel: one of the ledger's four statuses, or **not started**.
 *
 * `not_started` is not a `JobStatus` and deliberately never will be — no row holds it. It is the
 * answer for a step that has never been enqueued, and it exists so the screen has one entry per
 * step of the chain rather than a hole where a step has not been reached yet.
 */
export const NOT_STARTED = 'not_started';

export type PipelineStepStatus = JobStatus | typeof NOT_STARTED;

/**
 * One step of one recording, as the **latest attempt** of it.
 *
 * The ledger is append-only, so a step that has run three times is three rows; what the screen
 * shows is the row with the highest `attempt`, and the older ones stay readable in the table. No
 * duration is computed — the three timestamps the ledger holds are what is shown.
 */
export interface PipelineStepView {
  readonly step: PipelineStep;
  readonly status: PipelineStepStatus;
  /** `null` only when the step has never been enqueued. */
  readonly attempt: number | null;
  /** Why the latest attempt failed. The full text is in the log under the same correlation id. */
  readonly error: string | null;
  /** ISO 8601, or `null`. */
  readonly enqueuedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /**
   * `true` when this step succeeded and a **stub** is what succeeded. Read from the marker the
   * worker leaves, so "this step ran" and "this step exists yet" are different answers on screen
   * rather than the same one.
   */
  readonly stub: boolean;
}

/** One recording and every step of its pipeline, in the chain's order. */
export interface RecordingPipeline {
  readonly recordingId: string;
  readonly title: string;
  /** `YYYY-MM-DD`. The list's sort key, descending, as the recordings list is. */
  readonly recordedAt: string;
  readonly steps: readonly PipelineStepView[];
  /**
   * **How many of this teaching's chapters a human has changed**
   * ([3.22.8](docs/project/prd.md)).
   *
   * On the pipeline payload rather than fetched by the panel, because it is read at exactly one
   * moment: the confirmation before `generate_chapters` runs again, which has to *name* what the
   * re-run discards rather than warning about it in the abstract. A second request to find that
   * out would be a request made for a sentence.
   *
   * `0` for a teaching with no chapters and for one nobody has edited — which are the two cases
   * where the re-run destroys nothing, and the sentence says so.
   */
  readonly editedChapters: number;
}

/** Payload of `GET /api/v1/pipeline`. */
export interface PipelineListPayload {
  readonly recordings: readonly RecordingPipeline[];
  /** Today's paid work against today's ceiling — see {@link SpendView}. */
  readonly spend: SpendView;
}

/** Body of `POST /api/v1/recordings/{id}/rerun`. */
export interface RerunRequest {
  readonly step: PipelineStep;
}

/**
 * Payload of `POST /api/v1/recordings/{id}/rerun` — the job that is now waiting.
 *
 * A re-run of a step already in flight answers with **that** job rather than with a conflict: the
 * partial unique index refused the second row and the first one is the honest answer, so pressing
 * twice is harmless without the API inventing a failure the database already resolved.
 */
export interface RerunPayload {
  readonly jobId: string;
  readonly recordingId: string;
  readonly step: PipelineStep;
  /** 1 for the first run of this step, one higher for each run after. */
  readonly attempt: number;
}

/** Whether anything on screen is still moving, and therefore whether to ask again. */
export function isPipelineInFlight(recordings: readonly RecordingPipeline[]): boolean {
  return recordings.some((entry) =>
    entry.steps.some(
      (step) => step.status !== NOT_STARTED && isUnfinishedJobStatus(step.status),
    ),
  );
}

// =================================================================================================
// The daily spend ceiling on the pipeline view (docs/project/prd.md, 3.19.16 and 3.21.2.8).
// =================================================================================================

/** Where today's ceiling is raised, relative to the `/api/v1` prefix. `PUT`, admin only. */
export const SPEND_CEILING_PATH = `${PIPELINE_PATH}/spend-ceiling`;

/**
 * The most a day's ceiling may be raised to, in dollars. A typo of 500 should not be a valid
 * instruction: a hundred dollars is a quarter's worth of teachings in one day, which is a deliberate
 * backfill and not something the product should accept on one keystroke more than that.
 */
export const MAX_SPEND_CEILING_RAISE_USD = 100;

/** The most a raise's reason may be. A sentence, not a memo. */
export const MAX_SPEND_RAISE_REASON_LENGTH = 200;

export interface SpendRaiseView {
  readonly ceilingUsd: number;
  readonly raisedBy: string | null;
  /** The admin's display name at the time of reading, or `null` for an account since removed. */
  readonly raisedByName: string | null;
  readonly raisedAt: string;
  readonly reason: string | null;
}

/**
 * Today's paid work against today's ceiling, on the same payload as the recordings so the panel
 * sees the failure and the fix in one refresh.
 */
export interface SpendView {
  readonly todayUsd: number;
  /** The same, by the step that spent it. Every step is present; the free one is always zero. */
  readonly byStep: Readonly<Record<PipelineStep, number>>;
  /** The ceiling in force today: the configured default, or today's raise if it is higher. */
  readonly ceilingUsd: number;
  /** The configured default — the floor a raise may not go under. */
  readonly defaultUsd: number;
  readonly raise: SpendRaiseView | null;
  /** When the UTC day ends and the budget starts again. */
  readonly dayEndsAt: string;
}

export interface RaiseSpendCeilingRequest {
  /** The whole ceiling for the rest of today, not an increment. */
  readonly ceilingUsd: number;
  readonly reason?: string | null;
}

export interface SpendPayload {
  readonly spend: SpendView;
}

/** Whether today's paid work may still start: it may while the spend is under the ceiling. */
export function isSpendCeilingReached(spend: Pick<SpendView, 'todayUsd' | 'ceilingUsd'>): boolean {
  return spend.todayUsd >= spend.ceilingUsd;
}
