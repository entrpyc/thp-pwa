import type { EnvSource } from '@thp/shared/mock';
import {
  readServerAnalyticsConfig as readNamed,
  type AnalyticsConfig,
} from '@thp/shared/observability/analytics-config';

/**
 * **What the server-side analytics adapter reads** (docs/project/observability.md § 6.7) — the
 * same key and host the client inlines, under their runtime names, read through the same reader
 * so the mock switch silences every side the same way (`tests/guards/mock-switch.test.ts`). The
 * reader itself lives in `@thp/shared` since the worker started sending too; this module stays so
 * the API's call sites read it where they always did.
 */

export {
  SERVER_ANALYTICS_HOST_VARIABLE,
  SERVER_ANALYTICS_KEY_VARIABLE,
} from '@thp/shared/observability/analytics-config';

/** `null` means off: not production, mocked, or no key. A key without a host is refused by name. */
export function readServerAnalyticsConfig(env: EnvSource = process.env): AnalyticsConfig | null {
  return readNamed(env);
}
