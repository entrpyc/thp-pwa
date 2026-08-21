import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { closeDatabase } from '@thp/db';
import { queue } from '@/server/jobs/queue';
import { withCorrelationId } from '@/server/observability/correlation';

/**
 * The queue port, driven against the **real** database the suite's servers use.
 *
 * What is asserted here and nowhere else is the property that only exists on the API side of the
 * seam: **the row carries the correlation id of the request that caused it**, without the caller
 * passing one. The worker is a second process with no request behind it
 * (docs/epics/epic-core-listening/architecture.md § Key choices, the correlation-id row), so the id
 * has to be on the row — and it gets there by the port reading the same async store the logger
 * reads, which is a thing only an in-process test can see.
 *
 * The ledger's own rules — what `attempt` counts, what happens on a second enqueue — are asserted
 * against the queries in packages/db/tests/integration/jobs.test.ts. They are not restated here.
 */
describe('the queue port', () => {
  let sql: postgres.Sql;
  let recordings = 0;

  async function newRecording(): Promise<string> {
    recordings += 1;
    const [row] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values (${`originals/port-${recordings}.mp3`}, 'A teaching', '2026-02-15')
      returning id
    `;
    return row?.id as string;
  }

  async function jobsFor(recordingId: string): Promise<{ id: string; correlation_id: string }[]> {
    return (await sql<{ id: string; correlation_id: string }[]>`
      select id, correlation_id from job where recording_id = ${recordingId}
    `) as unknown as { id: string; correlation_id: string }[];
  }

  beforeAll(() => {
    // The port reaches the database through `@thp/db`, which reads DATABASE_URL with no default —
    // so the worker process running this file is given the same database the servers got.
    const databaseUrl = inject('databaseUrl');
    process.env['DATABASE_URL'] = databaseUrl;
    sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    await closeDatabase();
    await sql?.end({ timeout: 5 });
  });

  it('stamps the job with the correlation id of the request in flight', async () => {
    const recordingId = await newRecording();

    const enqueued = await withCorrelationId('a-known-request-id', () =>
      queue().enqueue({ recordingId, step: 'transcribe' }),
    );

    expect(enqueued.correlationId).toBe('a-known-request-id');
    expect(enqueued.step).toBe('transcribe');
    expect(enqueued.attempt).toBe(1);

    const rows = await jobsFor(recordingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.correlation_id).toBe('a-known-request-id');
    expect(rows[0]?.id).toBe(enqueued.id);
  });

  it('enqueues the same step twice as one job, not two', async () => {
    const recordingId = await newRecording();

    const first = await withCorrelationId('the-first-request', () =>
      queue().enqueue({ recordingId, step: 'transcribe' }),
    );
    const second = await withCorrelationId('the-second-request', () =>
      queue().enqueue({ recordingId, step: 'transcribe' }),
    );

    expect(second.id).toBe(first.id);
    expect(await jobsFor(recordingId)).toHaveLength(1);
  });

  it('still stamps an id when there is no request behind the enqueue', async () => {
    const recordingId = await newRecording();

    // Nothing in this epic enqueues outside a request, but a job nobody can trace is worse than a
    // job traced to an id that spans only itself.
    const enqueued = await queue().enqueue({ recordingId, step: 'generate_draft' });
    expect(enqueued.correlationId).not.toBe('');

    const explicit = await queue().enqueue({
      recordingId,
      step: 'transcribe',
      correlationId: 'a-caller-supplied-id',
    });
    expect(explicit.correlationId).toBe('a-caller-supplied-id');
  });
});
