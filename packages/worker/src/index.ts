import { pathToFileURL } from 'node:url';
import { PIPELINE_STEPS } from '@thp/shared';

/**
 * The worker process — a stub. It polls nothing: the job ledger arrives with
 * docs/implementation-plan.md Step 7, and until then this package exists only so the pipeline-step
 * vocabulary has a third consumer and the monorepo boundaries are exercised from day one.
 */
export function plannedSteps(): readonly string[] {
  return PIPELINE_STEPS;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.stdout.write(
    `worker stub: no ledger to poll yet; planned steps are ${plannedSteps().join(' -> ')}\n`,
  );
}
