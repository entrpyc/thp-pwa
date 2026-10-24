import { describe, expect, it } from 'vitest';
import {
  EXCEPTION_MESSAGE_LIMIT,
  apiRoutePattern,
  exceptionProperties,
  normaliseException,
} from '../../src/observability/exceptions';

/**
 * **What an exception report may carry** (docs/project/observability.md § 5.6), asserted without
 * an SDK: the route pattern hides every id, the properties are the declared ones and no more, and
 * the error itself is bounded.
 */

const UUID = 'a3f1c2d4-0000-4000-8000-000000000001';

describe('apiRoutePattern', () => {
  it('replaces a UUID, a number and an opaque token with [id], and leaves the words', () => {
    expect(apiRoutePattern(`/api/v1/recordings/${UUID}/notes`)).toBe('/api/v1/recordings/[id]/notes');
    expect(apiRoutePattern(`/api/v1/recordings/${UUID}/chapters/${UUID}`)).toBe(
      '/api/v1/recordings/[id]/chapters/[id]',
    );
    expect(apiRoutePattern('/api/v1/jobs/42')).toBe('/api/v1/jobs/[id]');
    expect(apiRoutePattern(`/api/v1/password-reset/${'a'.repeat(40)}`)).toBe('/api/v1/password-reset/[id]');
  });

  it('leaves a static route alone, with or without a trailing slash', () => {
    expect(apiRoutePattern('/api/v1/health')).toBe('/api/v1/health');
    expect(apiRoutePattern('/api/v1/health/')).toBe('/api/v1/health');
    expect(apiRoutePattern('/')).toBe('/');
  });
});

describe('exceptionProperties', () => {
  it('carries the declared fields by name and drops the undefined ones', () => {
    expect(
      exceptionProperties({ process: 'worker', correlation_id: 'job-1', job_id: UUID, step: 'transcribe', attempt: 2 }),
    ).toEqual({ process: 'worker', correlation_id: 'job-1', job_id: UUID, step: 'transcribe', attempt: 2 });
    expect(exceptionProperties({ process: 'client' })).toEqual({ process: 'client' });
    // `null` is a value — a recording in no series, a job with no id — and travels as one.
    expect(exceptionProperties({ process: 'worker', recording_id: null })).toEqual({
      process: 'worker',
      recording_id: null,
    });
  });
});

describe('normaliseException', () => {
  it('passes an ordinary error through untouched', () => {
    const error = new TypeError('cannot read it');
    expect(normaliseException(error)).toBe(error);
  });

  it('bounds a message past the limit and keeps the name and the cause', () => {
    const inner = new Error('inner');
    const huge = new RangeError('x'.repeat(EXCEPTION_MESSAGE_LIMIT * 3), { cause: inner });
    const bounded = normaliseException(huge);
    expect(bounded).not.toBe(huge);
    expect(bounded.name).toBe('RangeError');
    expect(bounded.message).toHaveLength(EXCEPTION_MESSAGE_LIMIT + 1);
    expect(bounded.message.endsWith('…')).toBe(true);
    expect(bounded.cause).toBe(inner);
    expect(bounded.stack ?? '').not.toContain('x'.repeat(EXCEPTION_MESSAGE_LIMIT + 1));
  });

  it('turns a thrown non-error into an error named for what it was', () => {
    expect(normaliseException('a string was thrown')).toMatchObject({
      name: 'NonError(string)',
      message: 'a string was thrown',
    });
    expect(normaliseException({ code: 7 }).name).toBe('NonError(object)');
    expect(normaliseException(undefined).message).toBe('undefined');
  });
});
