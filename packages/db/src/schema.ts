import { pgEnum } from 'drizzle-orm/pg-core';
import { PIPELINE_STEPS, ROLES } from '@thp/shared';

/**
 * The Drizzle schema. Server-only by construction: this package is never imported by a client
 * module, and the import-boundary guard fails the build if it ever is.
 *
 * **No tables yet.** Slice 01 step 1 ships the migration mechanism, not the data model — `user`,
 * `recording`, `job` and the rest each arrive with the step that uses them.
 *
 * What does exist is the two domain enums, and they are **derived** from the shared TypeScript
 * constants rather than restated beside them. That is what keeps "each enum is declared exactly
 * once in the repository" true, and it is enforced by tests/guards/domain-declarations.test.ts.
 */
export const userRole = pgEnum('user_role', ROLES);

export const pipelineStep = pgEnum('pipeline_step', PIPELINE_STEPS);
