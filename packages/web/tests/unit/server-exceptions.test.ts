import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **The API reports what it could not handle** (docs/project/observability.md § 5.6) — driven
 * against a stub `posthog-node`, so what is asserted is the adapter's contract: the report is
 * filed under the process rather than a member, carries the correlation id, the method, the route
 * pattern and the status and nothing else, and a send that throws is a log line, not a 500 on top
 * of a 500. The adapter is imported afresh per test because its client is module-level by design:
 * one for the life of the process.
 */

const sdk = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
  on: vi.fn(),
}));

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = sdk.capture;
    captureException = sdk.captureException;
    on = sdk.on;
  },
}));

const ENV = { ...process.env };
const ON = {
  NODE_ENV: 'production',
  POSTHOG_KEY: 'phc_x',
  POSTHOG_HOST: 'https://eu.i.posthog.com',
  THP_MOCK_EXTERNAL: 'false',
  NEXT_PUBLIC_APP_VERSION: 'v9.9.9',
};

async function freshAdapter(env: Record<string, string>) {
  vi.resetModules();
  // `NODE_ENV` is read-only in the type, not at runtime; the reader reads the object.
  Object.assign(process.env, env);
  return import('@/server/observability/analytics');
}

const CONTEXT = {
  correlation_id: 'req-0001-abcd',
  method: 'POST',
  route: '/api/v1/recordings/[id]/notes',
  status: 500,
};

beforeEach(() => {
  sdk.capture.mockReset();
  sdk.captureException.mockReset();
  sdk.on.mockReset();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ENV)) delete process.env[key];
  }
  Object.assign(process.env, ENV);
});

describe('captureServerException', () => {
  it('files the error under the process id with the route pattern, the id and the version', async () => {
    const { captureServerException, API_EXCEPTION_DISTINCT_ID } = await freshAdapter(ON);
    const error = new Error('column does not exist');

    expect(captureServerException(error, CONTEXT)).toBe(true);

    expect(sdk.captureException).toHaveBeenCalledTimes(1);
    expect(sdk.captureException).toHaveBeenCalledWith(error, API_EXCEPTION_DISTINCT_ID, {
      process: 'api',
      ...CONTEXT,
      app_version: 'v9.9.9',
      $process_person_profile: false,
    });
    // The distinct id is a label for the process, never anything a member is identified by.
    expect(API_EXCEPTION_DISTINCT_ID).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('sends nothing outside production, under the mock switch, or with no key', async () => {
    for (const env of [
      { ...ON, NODE_ENV: 'development' },
      { ...ON, THP_MOCK_EXTERNAL: 'true' },
      { ...ON, POSTHOG_KEY: '' },
    ]) {
      const { captureServerException } = await freshAdapter(env);
      expect(captureServerException(new Error('x'), CONTEXT)).toBe(false);
    }
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it('survives an SDK that throws, answering false rather than failing the request twice', async () => {
    const { captureServerException } = await freshAdapter(ON);
    sdk.captureException.mockImplementation(() => {
      throw new Error('queue is closed');
    });
    expect(captureServerException(new Error('x'), CONTEXT)).toBe(false);
  });
});
