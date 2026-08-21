/**
 * The correlation store, **re-exported**.
 *
 * It lives in `@thp/shared/observability/correlation` from Story 2 Ticket 02, because the worker is
 * a second process that has to stamp the same id on the same rows — see the note there. This module
 * stays so the API's call sites read `@/server/observability/correlation` exactly as they did.
 */
export {
  currentCorrelationId,
  resolveCorrelationId,
  withCorrelationId,
  type RequestContext,
} from '@thp/shared/observability/correlation';
