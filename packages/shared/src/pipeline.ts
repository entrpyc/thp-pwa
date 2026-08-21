/**
 * The pipeline step enum. This epic runs two steps in order; the worker that executes them arrives
 * in a later ticket, but the vocabulary is fixed here so the API, the worker and the job ledger
 * never drift apart.
 */
export const PIPELINE_STEPS = ['transcribe', 'generate_draft'] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export function isPipelineStep(value: unknown): value is PipelineStep {
  return typeof value === 'string' && (PIPELINE_STEPS as readonly string[]).includes(value);
}
