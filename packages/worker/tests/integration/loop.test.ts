import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  enqueueJob,
  insertRecording,
  runMigrations,
  type DatabaseHandle,
  type JobRow,
} from '@thp/db';
import { PIPELINE_STEPS, type PipelineStep } from '@thp/shared';
import { setLogSink, type LogLine } from '@thp/shared/observability/logger';
import { STUB_PROVIDER_META, type HandlerRegistry } from '../../src/handlers';
import { startWorkerLoop, type WorkerLoop } from '../../src/loop';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The loop, driven against a real database at a poll interval measured in milliseconds.
 *
 * Everything here is about the loop's *shape* rather than about any step: that an empty queue is
 * the normal case and not a stopping condition, that work is taken one job at a time, and that
 * asking it to stop does not abandon the job in flight. The handlers are fakes throughout, because a
 * loop that only behaved this way for real steps would not be a loop worth having.
 */
describe('the worker loop', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let handle: DatabaseHandle;
  let recordings = 0;
  let running: WorkerLoop | null = null;
  let restoreSink: () => void;

  /** A poll interval short enough that the suite does not wait on it. */
  const POLL_MS = 20;

  /**
   * Both steps, doing nothing, succeeding — and marking themselves so the ledger stays readable.
   *
   * Passed explicitly rather than left to the loop's default. From Story 2 Ticket 03 the default is
   * the real registry, and `transcribe` in it needs a bucket and a provider — which this suite has
   * nothing to say about. What the loop does with a handler is what is under test here; that the
   * default registry is the right one is asserted in run-job.test.ts, and that it works end to end
   * in packages/web/tests/integration/upload-starts-the-pipeline.test.ts.
   */
  const succeeds: HandlerRegistry = {
    transcribe: () => STUB_PROVIDER_META,
    generate_draft: () => STUB_PROVIDER_META,
  };

  async function queueJob(step: PipelineStep = 'transcribe'): Promise<JobRow> {
    recordings += 1;
    const recording = await insertRecording(
      {
        originalMediaKey: `originals/loop-${recordings}.mp3`,
        title: `Teaching ${recordings}`,
        recordedAt: '2026-08-21',
      },
      handle,
    );
    return enqueueJob(
      {
        recordingId: recording.id,
        step,
        correlationId: `loop-${recordings}-correlation`,
      },
      handle,
    );
  }

  async function statusOf(jobId: string): Promise<string | undefined> {
    const [row] = await sql<{ status: string }[]>`
      select status::text as status from job where id = ${jobId}
    `;
    return row?.status;
  }

  /** Wait for something the loop does in the background, or fail saying what never happened. */
  async function waitFor(what: string, predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  function start(options: Parameters<typeof startWorkerLoop>[0] = {}): WorkerLoop {
    running = startWorkerLoop({ executor: handle, pollIntervalMs: POLL_MS, ...options });
    return running;
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'loop');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 4, onnotice: () => {} });
    handle = createDatabase({ url: target.url, max: 8 });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  beforeEach(() => {
    restoreSink = setLogSink(() => {});
    return async () => {
      // Whatever the test did, the loop stops before the next one starts.
      running?.stop();
      await running?.done;
      running = null;
      restoreSink();
    };
  });

  it('survives an empty queue and picks up work enqueued afterwards', async () => {
    const loop = start({ handlers: succeeds });

    // Several polls with nothing there. A loop that treated this as a stopping condition — or as an
    // error — would be dead by now, which is what the enqueue below detects.
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));

    const job = await queueJob();
    await waitFor('the job to be picked up and finished', async () => {
      return (await statusOf(job.id)) === 'succeeded';
    });

    loop.stop();
    await loop.done;
  });

  it('runs one job at a time', async () => {
    const first = await queueJob();
    const second = await queueJob();

    let inFlight = 0;
    let mostAtOnce = 0;
    const overlapping = {
      transcribe: async () => {
        inFlight += 1;
        mostAtOnce = Math.max(mostAtOnce, inFlight);
        // Long enough that a second claim would visibly overlap this one if the loop made it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        inFlight -= 1;
      },
    };

    const loop = start({ handlers: overlapping });
    await waitFor('both jobs to finish', async () => {
      return (await statusOf(first.id)) === 'succeeded' && (await statusOf(second.id)) === 'succeeded';
    });
    loop.stop();
    await loop.done;

    // Concurrency is pinned to 1 by the shape of the loop, not by a setting.
    expect(mostAtOnce).toBe(1);
  });

  it('keeps polling after a job fails', async () => {
    const failing = await queueJob();
    const following = await queueJob();

    const loop = start({
      handlers: {
        transcribe: (job) => {
          if (job.id === failing.id) throw new Error('the provider refused the audio');
        },
      },
    });

    await waitFor('the second job to be run', async () => {
      return (await statusOf(following.id)) === 'succeeded';
    });
    loop.stop();
    await loop.done;

    // One recording's bad audio is not a reason to stop processing everybody else's.
    expect(await statusOf(failing.id)).toBe('failed');
  });

  it('stops claiming when asked, and lets the job in flight finish first', async () => {
    const job = await queueJob();
    const waiting = await queueJob();

    let notifyStarted: () => void = () => {};
    const handlerStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const loop = start({
      handlers: {
        transcribe: async () => {
          notifyStarted();
          await held;
        },
      },
    });

    await handlerStarted;
    // The signal arrives mid-job.
    loop.stop();
    release();
    await loop.done;

    // The job in flight reached a terminal status rather than being abandoned `running` for the
    // next boot's sweep to explain.
    expect(await statusOf(job.id)).toBe('succeeded');
    // And nothing new was taken after the stop.
    expect(await statusOf(waiting.id)).toBe('pending');
  });

  it('logs the claim, and drains the whole chain rather than one step of it', async () => {
    const captured: LogLine[] = [];
    restoreSink();
    restoreSink = setLogSink((line) => captured.push(line));

    const job = await queueJob();
    const loop = start({ handlers: succeeds });

    await waitFor('the chain to reach a draft', async () => {
      const rows = await sql<{ count: string }[]>`
        select count(*)::text as count from job
        where recording_id = ${job.recordingId} and status = 'succeeded'
      `;
      return Number(rows[0]?.count ?? '0') === 2;
    });
    loop.stop();
    await loop.done;

    // Claimed, run, chained, run again — one claim per step, from one enqueue.
    const rows = await sql<{ step: string; provider_meta: unknown }[]>`
      select step::text as step, provider_meta from job
      where recording_id = ${job.recordingId} order by enqueued_at, id
    `;
    // The whole pipeline, in the order the shared list declares it.
    expect(rows.map((row) => row.step)).toEqual([...PIPELINE_STEPS]);
    for (const row of rows) expect(row.provider_meta).toEqual(STUB_PROVIDER_META);

    // This recording's claims: the loop drains whatever else the earlier tests left queued, which
    // is the behaviour under test rather than noise to be avoided.
    const claims = captured.filter(
      (line) => line.message === 'job.claimed' && line['recordingId'] === job.recordingId,
    );
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      jobId: job.id,
      step: 'transcribe',
      recordingId: job.recordingId,
      correlationId: job.correlationId,
    });
  });
});
