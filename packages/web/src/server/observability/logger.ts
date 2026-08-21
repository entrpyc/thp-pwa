/**
 * The structured logger, **re-exported**.
 *
 * It lives in `@thp/shared/observability/logger` from Story 2 Ticket 02, so the API and the worker
 * emit one shape rather than two that drift. This module stays so the API's call sites read
 * `@/server/observability/logger` exactly as they did.
 */
export {
  logger,
  setLogSink,
  type LogLevel,
  type LogLine,
  type LogSink,
} from '@thp/shared/observability/logger';
