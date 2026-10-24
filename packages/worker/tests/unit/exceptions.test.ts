import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLogSink } from '@thp/shared/observability/logger';
import {
  NO_EXCEPTION_REPORTER,
  WORKER_EXCEPTION_DISTINCT_ID,
  createExceptionReporter,
  type ExceptionSink,
} from '../../src/observability/exceptions';

/**
 * **The worker's exception reporter** (docs/project/observability.md § 5.6) — asserted against a
 * stub SDK: what a report carries, that it is filed under the process rather than a person, that
 * a sink that throws costs the loop nothing, and that an environment with no tracker configured
 * says so once and reports nothing.
 */

let lines: { message: string; [key: string]: unknown }[] = [];
let restoreSink: () => void;

beforeAll(() => {
  restoreSink = setLogSink((line) => {
    lines.push(line as { message: string });
  });
});
afterAll(() => restoreSink());
beforeEach(() => {
  lines = [];
});

const CONTEXT = {
  correlation_id: 'run-job-1-correlation',
  job_id: 'a3f1c2d4-0000-4000-8000-000000000001',
  step: 'transcribe',
  attempt: 1,
  recording_id: 'a3f1c2d4-0000-4000-8000-000000000002',
};

describe('reporting a failed job', () => {
  it('hands the error to the sink under the process id, with the job’s context and the version', () => {
    const sink: ExceptionSink = { captureException: vi.fn() };
    const reporter = createExceptionReporter({ sink, appVersion: 'v1.2.3' });
    const error = new Error('the provider refused the audio');

    expect(reporter.report(error, CONTEXT)).toBe(true);

    expect(sink.captureException).toHaveBeenCalledWith(error, WORKER_EXCEPTION_DISTINCT_ID, {
      process: 'worker',
      ...CONTEXT,
      app_version: 'v1.2.3',
      $process_person_profile: false,
    });
  });

  it('files a thrown non-error as an error, so the tool has something to group', () => {
    const sink: ExceptionSink = { captureException: vi.fn() };
    createExceptionReporter({ sink }).report('a string', CONTEXT);
    const [filed] = (sink.captureException as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(filed).toBeInstanceOf(Error);
    expect((filed as Error).message).toBe('a string');
  });

  it('never throws when the sink does, and says so in the log', () => {
    const sink: ExceptionSink = {
      captureException: () => {
        throw new Error('queue is closed');
      },
    };
    expect(createExceptionReporter({ sink }).report(new Error('x'), CONTEXT)).toBe(false);
    expect(lines.map((line) => line.message)).toContain('exceptions.send.failed');
  });
});

describe('with no tracker configured', () => {
  it('reports nothing and says so once at boot', () => {
    const reporter = createExceptionReporter({ env: { NODE_ENV: 'production' } });
    expect(reporter).toBe(NO_EXCEPTION_REPORTER);
    expect(reporter.report(new Error('x'), CONTEXT)).toBe(false);
    expect(lines.filter((line) => line.message === 'worker.exceptions.off')).toHaveLength(1);
  });

  it('is off outside production and under the mock switch, whatever the key says', () => {
    const configured = { POSTHOG_KEY: 'phc_x', POSTHOG_HOST: 'https://eu.i.posthog.com' };
    expect(createExceptionReporter({ env: { ...configured, NODE_ENV: 'test' } })).toBe(NO_EXCEPTION_REPORTER);
    expect(
      createExceptionReporter({ env: { ...configured, NODE_ENV: 'production', THP_MOCK_EXTERNAL: 'true' } }),
    ).toBe(NO_EXCEPTION_REPORTER);
  });

  it('refuses a key without a host by logging rather than by throwing at boot', () => {
    const reporter = createExceptionReporter({ env: { NODE_ENV: 'production', POSTHOG_KEY: 'phc_x' } });
    expect(reporter).toBe(NO_EXCEPTION_REPORTER);
    const line = lines.find((entry) => entry.message === 'worker.exceptions.off');
    expect(String(line?.['error'])).toContain('POSTHOG_HOST');
  });
});
