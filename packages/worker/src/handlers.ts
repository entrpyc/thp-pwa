import type { JobRow, ProviderMeta } from '@thp/db';
import type { PipelineStep } from '@thp/shared';
import { createTranscribeHandler, type TranscribeDependencies } from './transcribe';

/**
 * **What a pipeline step is, as far as the worker is concerned.**
 *
 * A handler takes the claimed row and does the step's work. Three properties are settled here and
 * everything later in this epic and every later epic inherits them:
 *
 * 1. **Failure is a throw.** There is no failed-result shape and no boolean to forget to check, so
 *    there is exactly one way to fail and it is the one a bug takes by accident anyway.
 * 2. **A handler must be idempotent.** Claiming is at-least-once: a worker killed mid-job has its
 *    row reclaimed at the next boot and the handler runs again on the same recording. That is a
 *    property of the dispatch mechanism, not a preference — a handler that cannot survive running
 *    twice is a bug.
 * 3. **What it returns is *evidence*, not an outcome.** Returning at all is what "succeeded"
 *    means; the returned object, when there is one, is recorded in `provider_meta` so
 *    docs/project/prd.md §7 can measure spend per job. Returning nothing records nothing.
 */
export type JobHandler = (
  job: JobRow,
) => ProviderMeta | void | Promise<ProviderMeta | void>;

/**
 * The steps this worker knows how to run.
 *
 * A map the worker is **constructed with** rather than a module-level singleton, so a test supplies
 * its own and drives the loop with a handler it can make succeed, throw or hang. Partial on
 * purpose: a step with no handler is a job that fails naming the step, which is a far better
 * failure than a worker that silently ignores work it was given.
 */
export type HandlerRegistry = Readonly<Partial<Record<PipelineStep, JobHandler>>>;

/**
 * The marker a stub handler leaves behind.
 *
 * **This is what keeps the ledger honest.** With a stub in place a recording reads as fully
 * processed while having no draft, and the difference between "this step ran" and "this step exists
 * yet" would otherwise be invisible — a row that succeeded looks the same either way. The marker
 * makes it a query. Ticket 03 replaced the `transcribe` stub and its marker went with it; Story 3
 * does the same for `generate_draft`, which is the last one left.
 */
export const STUB_PROVIDER_META: ProviderMeta = { stub: true };

/**
 * The steps this worker runs: `transcribe` for real, `generate_draft` still a stub.
 *
 * A function rather than a constant, because the real handler has dependencies — a provider, a
 * bucket — and a module-level value would read the environment at import time. So a worker with
 * nothing but drafts to run would refuse to start over an ASR key it never uses, and every test
 * importing this module would need one.
 *
 * Listed one by one rather than generated from `PIPELINE_STEPS`, because a step silently acquiring
 * a stub the day it is added to the list is exactly the failure the "no handler" case exists to
 * make loud.
 */
export function createHandlers(deps: TranscribeDependencies = {}): HandlerRegistry {
  return {
    transcribe: createTranscribeHandler(deps),
    generate_draft: () => STUB_PROVIDER_META,
  };
}
