import type { JobRow, ProviderMeta } from '@thp/db';
import type { PipelineStep } from '@thp/shared';

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
 * **This is what keeps the ledger honest.** With stubs in place a recording reads as fully
 * processed while having no transcript and no draft, and the difference between "this step ran" and
 * "this step exists yet" would otherwise be invisible — a row that succeeded looks the same either
 * way. The marker makes it a query. Ticket 03 replaces the `transcribe` stub and the marker goes
 * with it; Story 3 does the same for `generate_draft`.
 */
export const STUB_PROVIDER_META: ProviderMeta = { stub: true };

/**
 * The handlers this ticket ships: both steps, doing nothing, succeeding.
 *
 * They exist so the chain runs green end to end today — an upload reaches `generate_draft`
 * succeeded, and the dispatch mechanism is provable without a provider behind it. Listed one by one
 * rather than generated from `PIPELINE_STEPS`, because a step silently acquiring a stub the day it
 * is added to the list is exactly the failure the "no handler" case exists to make loud.
 */
export const STUB_HANDLERS: HandlerRegistry = {
  transcribe: () => STUB_PROVIDER_META,
  generate_draft: () => STUB_PROVIDER_META,
};
