/**
 * The pipeline step enum. This epic runs two steps in order; the worker that executes them arrives
 * in a later ticket, but the vocabulary is fixed here so the API, the worker and the job ledger
 * never drift apart.
 */
export const PIPELINE_STEPS = ['transcribe', 'generate_draft'] as const;

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
