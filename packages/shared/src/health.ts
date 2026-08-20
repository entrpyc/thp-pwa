/** Payload of `GET /api/v1/health`. `database` reflects a real query, not a configuration value. */
export interface HealthPayload {
  readonly status: 'ok' | 'degraded';
  readonly database: {
    readonly reachable: boolean;
    readonly latencyMs: number | null;
  };
}
