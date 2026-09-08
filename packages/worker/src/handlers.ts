import type { JobRow, ProviderMeta } from '@thp/db';
import type { JobStep } from '@thp/shared';
import {
  createGenerateChaptersHandler,
  type GenerateChaptersDependencies,
} from './generate-chapters';
import { createGenerateDraftHandler, type GenerateDraftDependencies } from './generate-draft';
import { createPreviewAudioHandler } from './preview-audio';
import { createProcessAudioHandler, type ProcessAudioDependencies } from './process-audio';
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
 *
 * Keyed by `JobStep` rather than `PipelineStep`: the ledger holds the standalone steps too
 * ([§3.4](docs/project/prd.md)), and a worker that could not be handed a handler for one would be
 * a worker that fails every preview naming the step.
 */
export type HandlerRegistry = Readonly<Partial<Record<JobStep, JobHandler>>>;

/**
 * What this worker is built with. Two steps, two sets of dependencies, kept apart so a test can
 * hand in a fake provider for one without having to satisfy the other.
 */
export interface WorkerDependencies
  extends ProcessAudioDependencies,
    TranscribeDependencies,
    GenerateDraftDependencies,
    GenerateChaptersDependencies {}

/**
 * The steps this worker runs — **all of them for real.**
 *
 * Ticket 03 of Story 2 replaced the `transcribe` stub; Story 3 Ticket 01 replaces
 * `generate_draft`, and with it goes `STUB_PROVIDER_META` and the last reason `/admin/pipeline` had
 * to say *not built yet* about anything. `isStubProviderMeta` stays in `@thp/shared` because the
 * panel still reads it: a job written while the stub existed is still in the ledger and still says
 * so, and a screen that stopped being able to tell would be lying about history.
 *
 * A function rather than a constant, because the real handlers have dependencies — a provider, a
 * bucket — and a module-level value would read the environment at import time. So a worker with
 * nothing but drafts to run would refuse to start over an ASR key it never uses, and every test
 * importing this module would need one.
 *
 * Listed one by one rather than generated from `JOB_STEPS`, because a step silently acquiring a
 * handler the day it is added to the list is exactly the failure the "no handler" case exists to
 * make loud. `reprocess_audio` is `process_audio`'s handler under a second name on purpose: the
 * work is identical, and whether `transcribe` follows is the chain rule's decision, made from the
 * step name and never from inside the handler.
 */
export function createHandlers(deps: WorkerDependencies = {}): HandlerRegistry {
  const processAudio = createProcessAudioHandler(deps);
  return {
    process_audio: processAudio,
    transcribe: createTranscribeHandler(deps),
    generate_draft: createGenerateDraftHandler(deps),
    generate_chapters: createGenerateChaptersHandler(deps),
    reprocess_audio: processAudio,
    preview_audio: createPreviewAudioHandler(deps),
  };
}
