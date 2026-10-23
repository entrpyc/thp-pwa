import type { EnvSource } from '@thp/shared/mock';
import { readAnalyticsConfigNamed, type AnalyticsConfig } from '@/client/observability/config';

/**
 * **What the server-side analytics adapter reads** (docs/project/observability.md § 6.7) — the
 * same key and host the client inlines, under their runtime names, read through the same reader
 * so the mock switch silences both sides the same way (`tests/guards/mock-switch.test.ts`).
 */

export const SERVER_ANALYTICS_KEY_VARIABLE = 'POSTHOG_KEY';
export const SERVER_ANALYTICS_HOST_VARIABLE = 'POSTHOG_HOST';

/** `null` means off: not production, mocked, or no key. A key without a host is refused by name. */
export function readServerAnalyticsConfig(env: EnvSource = process.env): AnalyticsConfig | null {
  return readAnalyticsConfigNamed(env, {
    key: SERVER_ANALYTICS_KEY_VARIABLE,
    host: SERVER_ANALYTICS_HOST_VARIABLE,
  });
}
