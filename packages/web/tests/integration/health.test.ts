import { describe, expect, it, inject } from 'vitest';
import { API_PREFIX } from '@thp/shared';
import type { HealthPayload } from '@thp/shared';

const baseUrl = inject('apiBaseUrl');
const brokenDbBaseUrl = inject('brokenDbBaseUrl');

async function health(origin: string): Promise<HealthPayload> {
  const response = await fetch(`${origin}${API_PREFIX}/health`);
  expect(response.status).toBe(200);
  return (await response.json()) as HealthPayload;
}

describe('the health route reports a real database round-trip', () => {
  it('reports ok, with a measured latency, when Postgres answers', async () => {
    const body = await health(baseUrl);
    expect(body.status).toBe('ok');
    expect(body.database.reachable).toBe(true);
    expect(typeof body.database.latencyMs).toBe('number');
    expect(body.database.latencyMs ?? -1).toBeGreaterThanOrEqual(0);
  });

  it('reports degraded when the connection is broken', async () => {
    // A second server, identical but for a DATABASE_URL nothing listens on.
    const body = await health(brokenDbBaseUrl);
    expect(body.status).toBe('degraded');
    expect(body.database.reachable).toBe(false);
    expect(body.database.latencyMs).toBeNull();
  });

  it('does not put the connection failure detail on the wire', async () => {
    const response = await fetch(`${brokenDbBaseUrl}${API_PREFIX}/health`);
    const text = await response.text();
    expect(text).not.toContain('nobody');
    expect(text).not.toContain('127.0.0.1:1');
  });
});
