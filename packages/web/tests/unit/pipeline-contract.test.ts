import { describe, expect, it } from 'vitest';
import {
  ADMIN_PIPELINE_PAGE_PATH,
  JOB_STATUSES,
  NOT_STARTED,
  PIPELINE_PATH,
  PIPELINE_POLL_INTERVAL_MS,
  PIPELINE_STEPS,
  STUB_PROVIDER_META_KEY,
  isPipelineInFlight,
  isStubProviderMeta,
  recordingRerunPath,
  type RecordingPipeline,
} from '@thp/shared';
import { STUB_PROVIDER_META } from '../../../worker/src/handlers';

/**
 * The pipeline panel's contract, in the four places it has to be a value rather than a convention.
 *
 * Nothing here reaches a database or a browser: what is under test is the vocabulary two processes
 * and a screen agree on, and the two derived answers — "is anything still moving" and "was this a
 * stub" — that decide what the panel does.
 */

/** One recording with the steps set to the statuses named. */
function pipelineOf(...statuses: readonly string[]): RecordingPipeline[] {
  return [
    {
      recordingId: 'a-recording',
      title: 'A teaching',
      recordedAt: '2026-05-17',
      steps: PIPELINE_STEPS.map((step, index) => ({
        step,
        status: (statuses[index] ?? NOT_STARTED) as RecordingPipeline['steps'][number]['status'],
        attempt: null,
        error: null,
        enqueuedAt: null,
        startedAt: null,
        finishedAt: null,
        stub: false,
      })),
    },
  ];
}

describe('the poll interval is one named constant', () => {
  it('is five seconds, stated once', () => {
    // A first setting rather than a measured one, and moving it is one edit here — not a number
    // written into a screen and a test that would then disagree.
    expect(PIPELINE_POLL_INTERVAL_MS).toBe(5_000);
  });
});

describe('whether there is anything left to ask about', () => {
  it('is true while any step on screen is waiting or running', () => {
    expect(isPipelineInFlight(pipelineOf('running', NOT_STARTED))).toBe(true);
    expect(isPipelineInFlight(pipelineOf('succeeded', 'pending'))).toBe(true);
  });

  it('is false once every step has reached a terminal status, or never started', () => {
    // A console left open on a finished pipeline should not query forever: the poll is a
    // consequence of there being work, not a property of the screen being open.
    expect(isPipelineInFlight(pipelineOf('succeeded', 'succeeded'))).toBe(false);
    expect(isPipelineInFlight(pipelineOf('failed', NOT_STARTED))).toBe(false);
    expect(isPipelineInFlight(pipelineOf(NOT_STARTED, NOT_STARTED))).toBe(false);
    expect(isPipelineInFlight([])).toBe(false);
  });

  it('reads every status the ledger can hold, so a new one cannot be silently terminal', () => {
    for (const status of JOB_STATUSES) {
      const answer = isPipelineInFlight(pipelineOf(status, NOT_STARTED));
      expect(answer, status).toBe(status === 'pending' || status === 'running');
    }
  });
});

describe('the stub marker is stated once', () => {
  it('is the key the worker writes and the panel reads', () => {
    // The worker builds its marker from this key rather than spelling one, which is what stops the
    // process that writes it and the screen that renders "not built yet" from drifting apart.
    expect(isStubProviderMeta(STUB_PROVIDER_META)).toBe(true);
    expect(Object.keys(STUB_PROVIDER_META)).toEqual([STUB_PROVIDER_META_KEY]);
  });

  it('says no to a real handler’s provider_meta, and to nothing at all', () => {
    // What the transcribe handler actually writes: a model, a cost, a request id — and no marker.
    expect(isStubProviderMeta({ model: 'general-nova-3', costUsd: 0.39 })).toBe(false);
    expect(isStubProviderMeta(null)).toBe(false);
    expect(isStubProviderMeta(undefined)).toBe(false);
    // Not `true`, so a column that happens to carry the word does not read as a stub.
    expect(isStubProviderMeta({ [STUB_PROVIDER_META_KEY]: 'yes' })).toBe(false);
  });
});

describe('the paths the panel and its control are at', () => {
  it('names the step in the body rather than in the path', () => {
    // One route for every step there will ever be, so §3.4's `process_audio` arriving needs no new
    // path — it is already a value `PIPELINE_STEPS` carries.
    expect(recordingRerunPath('abc')).toBe('/recordings/abc/rerun');
    expect(PIPELINE_PATH).toBe('/pipeline');
    expect(ADMIN_PIPELINE_PAGE_PATH).toBe('/admin/pipeline');
  });

  it('keeps not-started outside the ledger’s statuses', () => {
    // No row ever holds it: it is the answer for a step that has never been enqueued, and adding
    // it to `JOB_STATUSES` would be adding a status nothing writes.
    expect((JOB_STATUSES as readonly string[]).includes(NOT_STARTED)).toBe(false);
  });
});
