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
 */
export const PIPELINE_STEPS = ['transcribe', 'generate_draft', 'generate_chapters'] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/**
 * Where a recording's pipeline starts.
 *
 * Read from the list rather than named, for the same reason the successor is: inserting
 * `process_audio` ahead of `transcribe` ([§3.4](docs/project/prd.md)) has to change what
 * finalising an upload enqueues, and it does — without an edit anywhere near the upload code.
 */
export const FIRST_PIPELINE_STEP: PipelineStep = PIPELINE_STEPS[0];

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
  step: PipelineStep,
  steps: readonly PipelineStep[] = PIPELINE_STEPS,
): PipelineStep | null {
  const index = steps.indexOf(step);
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
