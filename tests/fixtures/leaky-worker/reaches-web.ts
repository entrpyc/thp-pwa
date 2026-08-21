/**
 * The negative control for `checkWorkerBoundary`. A worker module that reaches into the API's
 * source instead of sharing a package with it.
 */
import { logger } from '@/server/observability/logger';

export function leaked(): void {
  logger.info('this belongs to the other process');
}
