import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { MIGRATIONS_DIR, runMigrations } from '@thp/db';
import { JOB_STATUSES, PLAYBACK_SPEEDS, REVIEW_KINDS, REVIEW_STATUSES } from '@thp/shared';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[];
}

const journal = JSON.parse(
  readFileSync(resolve(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
) as Journal;

interface MigrationRow {
  readonly id: number;
  readonly hash: string;
  readonly created_at: string;
}

/** Every table's column set, so "this migration touched nothing else" is comparable rather than argued. */
async function readColumnSets(url: string): Promise<Map<string, string[]>> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, column_name
    `;
    const sets = new Map<string, string[]>();
    for (const row of rows) {
      sets.set(row.table_name, [...(sets.get(row.table_name) ?? []), row.column_name]);
    }
    return sets;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * A migrations folder holding only the first `count` entries of the real journal.
 *
 * This is what makes "existing tables are untouched" a **before and after** rather than a list of
 * columns somebody typed out and could equally have typed out wrong. The database is migrated to
 * the state before the new migration, photographed, migrated **exactly one migration further**, and
 * photographed again.
 *
 * One further, not all the way: each block below is about one migration, and photographing the end
 * state instead would make every earlier block fail the moment a later migration alters a table it
 * had already seen — which Story 3 Ticket 03 does to `job`. The comparison has to be bounded by the
 * migration it is about.
 */
function migrationsFolderUpTo(count: number): string {
  const folder = mkdtempSync(resolve(tmpdir(), 'thp-migrations-'));
  mkdirSync(resolve(folder, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, count);
  for (const entry of entries) {
    copyFileSync(resolve(MIGRATIONS_DIR, `${entry.tag}.sql`), resolve(folder, `${entry.tag}.sql`));
  }
  writeFileSync(
    resolve(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  );
  return folder;
}

/**
 * How many migrations precede the one tagged `tag`.
 *
 * Named rather than counted back from the end: a before-and-after comparison has to pin the
 * migration it is about, or the next migration to arrive silently re-points every one of them at
 * itself and the comparisons quietly become vacuous.
 */
function journalCountBefore(tag: string): number {
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 0) throw new Error(`no migration is tagged ${tag}`);
  return index;
}

async function readMigrationRows(url: string): Promise<MigrationRow[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return (await sql<MigrationRow[]>`
      select id, hash, created_at::text as created_at
      from drizzle.__drizzle_migrations
      order by id
    `) as unknown as MigrationRow[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe('migrations apply to an empty database by one command', () => {
  let target: ThrowawayDatabase;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'migrations');
  }, 60_000);

  afterAll(async () => {
    await target?.drop();
  }, 60_000);

  it('has at least one migration to apply — otherwise this suite is vacuous', () => {
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it('leaves a recorded, ordered migration state', async () => {
    await runMigrations({ url: target.url });
    const rows = await readMigrationRows(target.url);

    expect(rows).toHaveLength(journal.entries.length);
    expect(rows.map((row) => row.id)).toEqual([...rows.map((row) => row.id)].sort((a, b) => a - b));
    expect(rows.every((row) => row.hash.length > 0)).toBe(true);
  });

  it('is a no-op the second time', async () => {
    const before = await readMigrationRows(target.url);
    await expect(runMigrations({ url: target.url })).resolves.toBeUndefined();
    const after = await readMigrationRows(target.url);
    expect(after).toEqual(before);
  });

  it('applied the schema the migration describes', async () => {
    const sql = postgres(target.url, { max: 1, onnotice: () => {} });
    try {
      const types = await sql<{ typname: string }[]>`
        select typname from pg_type
        where typname in
              ('user_role', 'pipeline_step', 'job_status', 'review_kind', 'review_status')
        order by typname
      `;
      expect(types.map((row) => row.typname)).toEqual([
        'job_status',
        'pipeline_step',
        'review_kind',
        'review_status',
        'user_role',
      ]);

      // Tables arrive with the ticket that uses them. Ticket 2 added accounts and sessions, ticket 3
      // invitations, ticket 4 password resets, Story 2 Ticket 01 `recording`, Ticket 02 `job` and
      // Ticket 03 `transcript` and `segment`. Story 3 Ticket 01 added `review_item` and `summary`,
      // and Story 4 Ticket 04 adds `playback_progress` — the last table of this epic.
      const tables = await sql<{ tablename: string }[]>`
        select tablename from pg_tables where schemaname = 'public' order by tablename
      `;
      expect(tables.map((row) => row.tablename)).toEqual([
        'invitation',
        'job',
        'password_reset',
        'playback_progress',
        'recording',
        'review_item',
        'segment',
        'session',
        'summary',
        'transcript',
        'user',
      ]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

/**
 * The `recording` table, asserted by its **exact column set**.
 *
 * Exact rather than "contains", because what is absent is the design.
 * docs/epics/epic-core-listening/architecture.md § Extension points names `processed_media_key` as
 * the seam audio processing attaches to, `series_id` belongs to Story 6, and no `duration` exists
 * because nothing in this epic inspects the media. A nullable column added "for later" is how
 * deferral quietly stops being deferral — and a `toContain` assertion would not notice one arriving.
 */
describe('the recording table, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  /** Column sets as of the migration *before* this one, and after it. */
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'recording_migration');

    const priorCount = journalCountBefore('0004_recordings');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);
  }, 120_000);

  afterAll(async () => {
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.has('recording')).toBe(false);
    expect(after.has('recording')).toBe(true);
  });

  it('carries exactly these columns, and none of the deferred ones', () => {
    expect(after.get('recording')).toEqual([
      'created_at',
      'description',
      'id',
      'original_media_key',
      'published_at',
      'recorded_at',
      'title',
    ]);

    for (const deferred of ['duration', 'processed_media_key', 'series_id']) {
      expect(after.get('recording'), `${deferred} is deferred and must not exist`).not.toContain(
        deferred,
      );
    }
  });

  it('records the date recorded as a date, not a timestamp', async () => {
    const sql = postgres(target.url, { max: 1, onnotice: () => {} });
    try {
      const [row] = await sql<{ data_type: string }[]>`
        select data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'recording' and column_name = 'recorded_at'
      `;
      expect(row?.data_type).toBe('date');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('leaves every table that already existed exactly as it was', () => {
    // Every account table, column for column, before and after. The migration adds a table; it
    // alters nothing.
    for (const [table, columns] of before) {
      expect(after.get(table), `${table} changed`).toEqual(columns);
    }
    expect([...before.keys()].sort()).toEqual([
      'invitation',
      'password_reset',
      'session',
      'user',
    ]);
  });
});

/**
 * The `job` table — the ledger and the queue at once (Story 2 Ticket 02).
 *
 * Asserted the same way `recording` is, and for the same reason: by its **exact column set**,
 * before and after, so a column added "for later" is a failing test rather than a comment nobody
 * reads. Two properties beyond the columns are asserted here rather than in the query layer,
 * because they are properties of the *database* — the four statuses the enum admits, and the rule
 * that a recording has at most one unfinished job per step. Neither can be true by convention.
 */
describe('the job ledger, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  /** Column sets as of the migration *before* this one, and after it. */
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  let recordings = 0;

  /** A recording of its own per test, so no test can be affected by another's rows. */
  async function newRecording(): Promise<string> {
    recordings += 1;
    const key = `recordings/job-ledger-${recordings}.mp3`;
    const [row] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values (${key}, 'A teaching', '2026-01-04')
      returning id
    `;
    return row?.id as string;
  }

  /** Enqueue by hand. The query layer that will do this properly is the next slice of the ticket. */
  async function insertJob(
    recordingId: string,
    step: string,
    status: string,
    attempt: number,
  ): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into job (recording_id, step, status, attempt, correlation_id)
      values (
        ${recordingId},
        ${step}::pipeline_step,
        ${status}::job_status,
        ${attempt},
        'a-known-correlation-id'
      )
      returning id
    `;
    return row?.id as string;
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'job_migration');

    const priorCount = journalCountBefore('0005_job_ledger');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.has('job')).toBe(false);
    expect(after.has('job')).toBe(true);
  });

  it('carries exactly these columns, and none of the deferred ones', () => {
    expect(after.get('job')).toEqual([
      'attempt',
      'correlation_id',
      'enqueued_at',
      'error',
      'finished_at',
      'id',
      'provider_meta',
      'recording_id',
      'started_at',
      'status',
      'step',
    ]);

    // A retry count, a schedule and a worker's name all belong to things this epic deliberately
    // does not have: automatic retry, docs/project/prd.md 3.21.3's batching, and a worker pool.
    // `payload` was on this list too and is not any more — Story 3 Ticket 03 reversed that decision
    // in its own migration, which is the block at the end of this file.
    for (const deferred of ['max_attempts', 'scheduled_for', 'worker_id', 'updated_at']) {
      expect(after.get('job'), `${deferred} is deferred and must not exist`).not.toContain(deferred);
    }
  });

  it('admits exactly the four statuses, in the order the shared constant declares them', async () => {
    const rows = await sql<{ enumlabel: string }[]>`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'job_status'
      order by pg_enum.enumsortorder
    `;
    expect(rows.map((row) => row.enumlabel)).toEqual([...JOB_STATUSES]);
  });

  it('records what a provider reports as jsonb, since no two report the same shape', async () => {
    const [row] = await sql<{ data_type: string }[]>`
      select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'job' and column_name = 'provider_meta'
    `;
    expect(row?.data_type).toBe('jsonb');
  });

  it('leaves the outcome columns empty at enqueue', async () => {
    const id = await insertJob(await newRecording(), 'transcribe', 'pending', 1);
    const [row] = await sql<
      {
        status: string;
        started_at: Date | null;
        finished_at: Date | null;
        error: string | null;
        provider_meta: unknown;
      }[]
    >`select status, started_at, finished_at, error, provider_meta from job where id = ${id}`;

    expect(row?.status).toBe('pending');
    expect(row?.started_at).toBeNull();
    expect(row?.finished_at).toBeNull();
    expect(row?.error).toBeNull();
    expect(row?.provider_meta).toBeNull();
  });

  it('refuses a job that belongs to no recording', async () => {
    await expect(
      sql`
        insert into job (recording_id, step, status, attempt, correlation_id)
        values (null, 'transcribe', 'pending', 1, 'a-known-correlation-id')
      `,
    ).rejects.toThrow();

    await expect(
      insertJob('00000000-0000-0000-0000-000000000000', 'transcribe', 'pending', 1),
    ).rejects.toThrow();
  });

  it('refuses a second unfinished job for the same recording and step', async () => {
    const recordingId = await newRecording();
    await insertJob(recordingId, 'transcribe', 'pending', 1);

    await expect(insertJob(recordingId, 'transcribe', 'pending', 2)).rejects.toThrow();
    // Claimed counts as unfinished too — otherwise a second worker could start the step that is
    // already running.
    await expect(insertJob(recordingId, 'transcribe', 'running', 2)).rejects.toThrow();

    // A different step of the same recording is a different pair, and is not blocked.
    await expect(insertJob(recordingId, 'generate_draft', 'pending', 1)).resolves.toBeTruthy();
  });

  it('accepts a second job once the earlier one has finished', async () => {
    const recordingId = await newRecording();
    const first = await insertJob(recordingId, 'transcribe', 'pending', 1);
    await sql`update job set status = 'succeeded', finished_at = now() where id = ${first}`;

    // The ledger is append-only: the re-run is a new row, so a succeeded row must not block it.
    const second = await insertJob(recordingId, 'transcribe', 'pending', 2);
    expect(second).not.toBe(first);

    // And a failed one must not either — a human re-enqueueing the step is the whole of
    // docs/project/prd.md 3.21.2.4.
    await sql`update job set status = 'failed', finished_at = now() where id = ${second}`;
    await expect(insertJob(recordingId, 'transcribe', 'pending', 3)).resolves.toBeTruthy();
  });

  it('leaves every table that already existed exactly as it was', () => {
    for (const [table, columns] of before) {
      expect(after.get(table), `${table} changed`).toEqual(columns);
    }
    expect([...before.keys()].sort()).toEqual([
      'invitation',
      'password_reset',
      'recording',
      'session',
      'user',
    ]);
  });
});

/**
 * `transcript` and `segment` — the spine's third and fourth rows (Story 2 Ticket 03).
 *
 * Asserted the way `recording` and `job` are, and for the same reason: by their **exact column
 * sets**, before and after, so a column added "for later" is a failing test rather than a comment
 * nobody reads. The one that matters most is an embedding on `segment`, which
 * docs/epics/epic-core-listening/architecture.md § Extension points names as a later epic's
 * `ALTER TABLE` — a nullable vector column arriving here would be deferral quietly stopping being
 * deferral, and no reader of the schema would notice.
 *
 * Three properties beyond the columns are asserted here rather than in the query layer, because
 * they are properties of the *database*: one transcript per recording, a confidence that has to be
 * a score, and segments that come back in playback order however they went in.
 */
describe('the transcript and its segments, and nothing beside them', () => {
  let target: ThrowawayDatabase;
  /** Column sets as of the migration *before* this one, and after it. */
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  let recordings = 0;

  async function newRecording(): Promise<string> {
    recordings += 1;
    const key = `originals/transcripts-${recordings}.mp3`;
    const [row] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values (${key}, 'A teaching', '2026-02-08')
      returning id
    `;
    return row?.id as string;
  }

  /** Insert by hand. What the query layer does with these tables is its own suite. */
  async function insertTranscript(recordingId: string, confidence = 0.9): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into transcript (recording_id, language, confidence)
      values (${recordingId}, 'en', ${confidence})
      returning id
    `;
    return row?.id as string;
  }

  async function insertSegment(transcriptId: string, startMs: number, endMs: number): Promise<void> {
    await sql`
      insert into segment (transcript_id, start_ms, end_ms, text)
      values (${transcriptId}, ${startMs}, ${endMs}, ${`at ${startMs}`})
    `;
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'transcript_migration');

    const priorCount = journalCountBefore('0006_transcripts');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and do after — otherwise the comparison is vacuous', () => {
    expect(before.has('transcript')).toBe(false);
    expect(before.has('segment')).toBe(false);
    expect(after.has('transcript')).toBe(true);
    expect(after.has('segment')).toBe(true);
  });

  it('gives the transcript exactly these columns, and no text column beside its segments', () => {
    expect(after.get('transcript')).toEqual([
      'confidence',
      'created_at',
      'id',
      'language',
      'recording_id',
    ]);

    // A `text` column would be a concatenated second copy of the segments that Story 5's correction
    // would have to keep in step. `duration`, `provider` and `model` belong to the job that produced
    // it, and `status` would be a second reading of whether that job succeeded.
    for (const deferred of ['text', 'duration', 'provider', 'model', 'status']) {
      expect(after.get('transcript'), `${deferred} must not exist`).not.toContain(deferred);
    }
  });

  it('gives the segment exactly these columns, and no embedding', () => {
    // `speaker` is **not** here, and that is the assertion: it arrived in Ticket 04–05 as its own
    // migration over this table, and this block is bounded by the migration it is about — see the
    // block below, which is what proves nothing was written into the rows already there.
    expect(after.get('segment')).toEqual([
      'corrected_at',
      'corrected_by_user_id',
      'end_ms',
      'id',
      'start_ms',
      'text',
      'transcript_id',
    ]);

    // The one that matters: docs/epics/epic-core-listening/architecture.md § Extension points has
    // pgvector, the embedding column and the HNSW index arriving in a later epic, together.
    for (const deferred of ['embedding', 'confidence', 'words']) {
      expect(after.get('segment'), `${deferred} is deferred and must not exist`).not.toContain(
        deferred,
      );
    }
  });

  it('records offsets as integer milliseconds and confidence as a real', async () => {
    const rows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public'
        and (table_name, column_name) in
            (('segment', 'start_ms'), ('segment', 'end_ms'), ('transcript', 'confidence'))
      order by table_name, column_name
    `;
    expect(rows.map((row) => [row.table_name, row.column_name, row.data_type])).toEqual([
      ['segment', 'end_ms', 'integer'],
      ['segment', 'start_ms', 'integer'],
      ['transcript', 'confidence', 'real'],
    ]);
  });

  it('refuses a transcript that belongs to no recording', async () => {
    await expect(
      sql`insert into transcript (recording_id, language, confidence) values (null, 'en', 0.9)`,
    ).rejects.toThrow();
    await expect(
      insertTranscript('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow();
  });

  it('refuses a second transcript for the same recording', async () => {
    // docs/project/prd.md 4.4 says one transcript per recording, so the database says it too — a
    // re-run replaces rather than accumulates, and this is what leaves no other option.
    const recordingId = await newRecording();
    await insertTranscript(recordingId);
    await expect(insertTranscript(recordingId)).rejects.toThrow();
  });

  it('refuses a confidence that is not a score', async () => {
    const recordingId = await newRecording();
    await expect(insertTranscript(recordingId, 1.4)).rejects.toThrow();
    await expect(insertTranscript(recordingId, -0.2)).rejects.toThrow();
    // The ends of the range are inside it: a provider that answered 0 has answered a score.
    await expect(insertTranscript(recordingId, 0)).resolves.toBeTruthy();
  });

  it('reads a transcript back in playback order, whatever order it went in', async () => {
    const transcriptId = await insertTranscript(await newRecording());
    // Deliberately out of order: the read is what has to be ordered, not the write.
    for (const [start, end] of [
      [9000, 12000],
      [0, 4000],
      [4000, 9000],
    ] as const) {
      await insertSegment(transcriptId, start, end);
    }

    const rows = await sql<{ start_ms: number }[]>`
      select start_ms from segment where transcript_id = ${transcriptId} order by start_ms
    `;
    expect(rows.map((row) => row.start_ms)).toEqual([0, 4000, 9000]);
  });

  it('indexes the pair Story 5 follows along on', async () => {
    const rows = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = 'public' and tablename = 'segment'
      order by indexname
    `;
    expect(rows.map((row) => row.indexname)).toContain('segment_transcript_start_idx');
  });

  it('takes the segments with the transcript, and the transcript with the recording', async () => {
    const recordingId = await newRecording();
    const transcriptId = await insertTranscript(recordingId);
    await insertSegment(transcriptId, 0, 1000);

    // Both cascades, because replacing a transcript has to leave no orphan behind and a deleted
    // recording has to leave no transcript behind.
    await sql`delete from recording where id = ${recordingId}`;
    const [remaining] = await sql<{ count: string }[]>`
      select count(*)::text as count from segment where transcript_id = ${transcriptId}
    `;
    expect(remaining?.count).toBe('0');
  });

  it('leaves every table that already existed exactly as it was', () => {
    for (const [table, columns] of before) {
      expect(after.get(table), `${table} changed`).toEqual(columns);
    }
    expect([...before.keys()].sort()).toEqual([
      'invitation',
      'job',
      'password_reset',
      'recording',
      'session',
      'user',
    ]);
  });
});

/**
 * `segment.speaker` — one column, added by its own migration (Story 2 Ticket 04–05).
 *
 * Asserted before and after, like every migration since `recording`, and for one property this
 * one has that the others do not: **nothing is written into the rows that already exist.** A
 * recording transcribed before this migration gains speakers only when somebody re-runs
 * `transcribe` for it, and this block is what makes that a fact about the database rather than a
 * claim in a comment — a segment inserted before the migration is still null after it.
 */
describe('the speaker column, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  /** A segment written before the column existed, to read back afterwards. */
  let existingSegmentId: string;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'speaker_migration');

    const priorCount = journalCountBefore('0007_segment_speaker');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    const [recording] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values ('originals/before-the-speaker-column.mp3', 'An older teaching', '2026-01-11')
      returning id
    `;
    const [transcript] = await sql<{ id: string }[]>`
      insert into transcript (recording_id, language, confidence)
      values (${recording?.id as string}, 'en', 0.93) returning id
    `;
    const [segment] = await sql<{ id: string }[]>`
      insert into segment (transcript_id, start_ms, end_ms, text)
      values (${transcript?.id as string}, 0, 4000, 'Written before the column existed.')
      returning id
    `;
    existingSegmentId = segment?.id as string;

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.get('segment')).not.toContain('speaker');
    expect(after.get('segment')).toContain('speaker');
  });

  it('adds exactly one column to segment and nothing anywhere else', () => {
    // The whole of the schema change: one nullable integer. No index, no constraint, no second
    // column "for later", and no table but this one touched.
    for (const [table, columns] of before) {
      const expected = table === 'segment' ? [...columns, 'speaker'].sort() : columns;
      expect(after.get(table), `${table} changed`).toEqual(expected);
    }
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('is a nullable integer', async () => {
    const rows = await sql<{ data_type: string; is_nullable: string }[]>`
      select data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'segment' and column_name = 'speaker'
    `;
    // Nullable because a sentence the provider attributes to nobody is a real answer rather than a
    // defect — and because every row already written has no answer at all.
    expect(rows.map((row) => [row.data_type, row.is_nullable])).toEqual([['integer', 'YES']]);
  });

  it('writes nothing into the segments that were already there', async () => {
    const rows = await sql<{ speaker: number | null }[]>`
      select speaker from segment where id = ${existingSegmentId}
    `;
    // No back-fill, by design: a recording already transcribed gains speakers only when somebody
    // re-runs `transcribe`, and doing that discards any corrections Story 5 will let an admin make.
    expect(rows.map((row) => row.speaker)).toEqual([null]);
  });
});

/**
 * `review_item` and `summary` — **the review gate** (Story 3 Ticket 01), and the last two tables of
 * this epic.
 *
 * Asserted the way every table since `recording` is: by their **exact column sets**, before and
 * after, so a column added "for later" is a failing test rather than a comment nobody reads. The
 * one that matters most here is a *second* `review_item`-shaped table — a `scripture_reference` or
 * a `tag_suggestion` — which would be the first crack in the property
 * docs/project/architecture.md § Cross-cutting concerns is protecting: everything waiting on an
 * admin is one query over one column, not a union of six.
 *
 * Four properties beyond the columns are asserted here rather than in the query layer, because they
 * are properties of the *database*: the two enums admit exactly what the shared constants declare,
 * a recording has at most one summary, a closed item survives the admin who closed it, and both
 * tables go when the recording does.
 */
describe('the review gate, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  /** Column sets as of the migration *before* this one, and after it. */
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  let seeded = 0;

  async function newRecording(): Promise<string> {
    seeded += 1;
    const key = `originals/review-gate-${seeded}.mp3`;
    const [row] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values (${key}, 'A teaching', '2026-08-16')
      returning id
    `;
    return row?.id as string;
  }

  async function newAdmin(): Promise<string> {
    seeded += 1;
    const [row] = await sql<{ id: string }[]>`
      insert into "user" (email, password_hash, display_name, role)
      values (${`gate-${seeded}@example.test`}, 'not-a-hash', 'An admin', 'admin')
      returning id
    `;
    return row?.id as string;
  }

  /** Insert by hand. What the query layer does with these tables is its own suite. */
  async function insertItem(
    recordingId: string,
    kind = 'summary',
    status = 'draft',
    reviewedBy: string | null = null,
  ): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into review_item (recording_id, kind, status, fields, provenance, reviewed_by)
      values (
        ${recordingId},
        ${kind}::review_kind,
        ${status}::review_status,
        ${sql.json({ summary: 'What the machine wrote.' })},
        ${sql.json({ model: 'fake', fields: { summary: { aiSuggested: true } } })},
        ${reviewedBy}
      )
      returning id
    `;
    return row?.id as string;
  }

  async function insertSummary(recordingId: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into summary (recording_id, content) values (${recordingId}, 'Approved text.')
      returning id
    `;
    return row?.id as string;
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'review_gate_migration');

    const priorCount = journalCountBefore('0008_review_gate');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and do after — otherwise the comparison is vacuous', () => {
    expect(before.has('review_item')).toBe(false);
    expect(before.has('summary')).toBe(false);
    expect(after.has('review_item')).toBe(true);
    expect(after.has('summary')).toBe(true);
  });

  it('gives review_item exactly these columns, and none of the deferred ones', () => {
    expect(after.get('review_item')).toEqual([
      'created_at',
      'fields',
      'id',
      'kind',
      'provenance',
      'recording_id',
      'reviewed_at',
      'reviewed_by',
      'status',
    ]);

    // `job_id` would tie a draft to the run that produced it, which is findable by correlation id
    // already. `superseded_by` would thread a history nothing reads — a regeneration discards and
    // writes fresh. `summary` and `description` as columns is the shape `fields` exists to avoid,
    // and is what a per-artefact table would degrade into.
    for (const deferred of ['job_id', 'superseded_by', 'updated_at', 'summary', 'description']) {
      expect(after.get('review_item'), `${deferred} must not exist`).not.toContain(deferred);
    }
  });

  it('gives summary exactly these columns, and no status beside its timestamp', () => {
    expect(after.get('summary')).toEqual([
      'content',
      'created_at',
      'id',
      'published_at',
      'recording_id',
      'updated_at',
    ]);

    // `status` would be a second reading of `published_at` that a clock can make disagree with it.
    // `version` and `previous_content` are summary history, which this story explicitly does not
    // build — the closed review item holds what the machine said.
    for (const deferred of ['status', 'version', 'previous_content', 'reviewed_by']) {
      expect(after.get('summary'), `${deferred} must not exist`).not.toContain(deferred);
    }
  });

  it('admits exactly the kinds and statuses the shared constants declare, in their order', async () => {
    const kinds = await sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'review_kind' order by pg_enum.enumsortorder
    `;
    expect(kinds.map((row) => row.enumlabel)).toEqual([...REVIEW_KINDS]);

    const statuses = await sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'review_status' order by pg_enum.enumsortorder
    `;
    expect(statuses.map((row) => row.enumlabel)).toEqual([...REVIEW_STATUSES]);
  });

  it('holds the draft and its provenance as jsonb, since a later kind carries other fields', async () => {
    const rows = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'review_item'
        and column_name in ('fields', 'provenance')
      order by column_name
    `;
    expect(rows.map((row) => [row.column_name, row.data_type])).toEqual([
      ['fields', 'jsonb'],
      ['provenance', 'jsonb'],
    ]);
  });

  it('starts an item as a draft with nobody having reviewed it', async () => {
    const id = await insertItem(await newRecording());
    const [row] = await sql<
      { status: string; reviewed_by: string | null; reviewed_at: Date | null }[]
    >`select status::text as status, reviewed_by, reviewed_at from review_item where id = ${id}`;

    expect(row?.status).toBe('draft');
    expect(row?.reviewed_by).toBeNull();
    expect(row?.reviewed_at).toBeNull();
  });

  it('refuses an item or a summary that belongs to no recording', async () => {
    await expect(insertItem('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    await expect(insertSummary('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });

  it('refuses a second summary for the same recording', async () => {
    // docs/project/prd.md 4.5 is one summary per recording, so the database says it too — which is
    // what makes approving a second draft an update rather than a history nobody asked for.
    const recordingId = await newRecording();
    await insertSummary(recordingId);
    await expect(insertSummary(recordingId)).rejects.toThrow();
  });

  it('keeps drafts of different kinds for one recording', async () => {
    // Two kinds are two rows, not two columns — which is the whole of why there is one table.
    const recordingId = await newRecording();
    await expect(insertItem(recordingId, 'summary')).resolves.toBeTruthy();
    await expect(insertItem(recordingId, 'recording_metadata')).resolves.toBeTruthy();
  });

  it('keeps a closed item when the admin who closed it is deleted', async () => {
    // A closed item is a record of something that happened, and it should survive the account of
    // the person it happened by — the same split `invitation` takes between subject and author.
    const adminId = await newAdmin();
    const id = await insertItem(await newRecording(), 'summary', 'published', adminId);

    await sql`delete from "user" where id = ${adminId}`;

    const [row] = await sql<{ status: string; reviewed_by: string | null }[]>`
      select status::text as status, reviewed_by from review_item where id = ${id}
    `;
    expect(row?.status).toBe('published');
    expect(row?.reviewed_by).toBeNull();
  });

  it('takes both tables with the recording they are about', async () => {
    const recordingId = await newRecording();
    await insertItem(recordingId);
    await insertSummary(recordingId);

    await sql`delete from recording where id = ${recordingId}`;

    const [items] = await sql<{ count: string }[]>`
      select count(*)::text as count from review_item where recording_id = ${recordingId}
    `;
    const [summaries] = await sql<{ count: string }[]>`
      select count(*)::text as count from summary where recording_id = ${recordingId}
    `;
    expect([items?.count, summaries?.count]).toEqual(['0', '0']);
  });

  it('leaves every table that already existed exactly as it was', () => {
    for (const [table, columns] of before) {
      expect(after.get(table), `${table} changed`).toEqual(columns);
    }
    expect([...before.keys()].sort()).toEqual([
      'invitation',
      'job',
      'password_reset',
      'recording',
      'segment',
      'session',
      'transcript',
      'user',
    ]);
  });
});

/**
 * `job.payload` — one column, added by its own migration (Story 3 Ticket 03).
 *
 * **This is the one reversal in the epic, and the block exists to make it visible.** Story 2
 * Ticket 02 asserted `payload` *must not exist*, on the reasoning that a step's input is the
 * recording it names. That stopped being true when docs/project/prd.md 3.6.9 asked an admin to
 * steer one *kind* of draft with a sentence: neither the kind nor the sentence has anywhere else to
 * live.
 *
 * Asserted before and after like every migration since `recording`, and with the one property this
 * one shares with the speaker column: **nothing is written into the rows that already exist.** A
 * job enqueued before this migration still carries no payload afterwards, which is what makes
 * "null on every chained job" a fact about the database rather than a claim in a comment.
 */
describe('the job payload column, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  /** A job written before the column existed, to read back afterwards. */
  let existingJobId: string;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'job_payload_migration');

    const priorCount = journalCountBefore('0009_job_payload');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    const [written] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values ('originals/before-the-payload-column.mp3', 'An older teaching', '2026-08-09')
      returning id
    `;
    const [queued] = await sql<{ id: string }[]>`
      insert into job (recording_id, step, status, attempt, correlation_id)
      values (${written?.id as string}, 'generate_draft', 'pending', 1, 'a-known-correlation-id')
      returning id
    `;
    existingJobId = queued?.id as string;

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.get('job')).not.toContain('payload');
    expect(after.get('job')).toContain('payload');
  });

  it('adds exactly one column to job and nothing anywhere else', () => {
    // The whole of the schema change: one nullable jsonb. No index, no constraint, no second column
    // "for later", and no table but this one touched.
    for (const [table, columns] of before) {
      const expected = table === 'job' ? [...columns, 'payload'].sort() : columns;
      expect(after.get(table), `${table} changed`).toEqual(expected);
    }
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('is nullable jsonb, because what a step is asked for has no fixed shape', async () => {
    const rows = await sql<{ data_type: string; is_nullable: string }[]>`
      select data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'job' and column_name = 'payload'
    `;
    expect(rows.map((row) => [row.data_type, row.is_nullable])).toEqual([['jsonb', 'YES']]);
  });

  it('writes nothing into the jobs that were already there', async () => {
    const rows = await sql<{ payload: unknown }[]>`
      select payload from job where id = ${existingJobId}
    `;
    // No back-fill, and no default: the chain still enqueues a successor with no payload, which is
    // what leaves the chain rule untouched by this column existing.
    expect(rows.map((row) => row.payload)).toEqual([null]);
  });
});

/**
 * **Playback state** (Story 4 Ticket 04) — one column on `user` and one new table.
 *
 * Asserted the way every migration in this file is: by **exact column sets, before and after**, so
 * a column added "for later" is a failing test rather than a comment nobody reads. Three properties
 * beyond the columns are asserted here because they are properties of the *database* and cannot be
 * true by convention — the six speeds the check constraint admits, the composite primary key that
 * makes one row per pairing, and cascades on both sides.
 *
 * `duration` is checked here too, on `recording`, and it is not a stray assertion: this is the
 * story that would most plausibly have added one — the transport bar prints a total and the resume
 * card wants one — and neither does. The player learns the duration from the media element, the
 * card shows elapsed only, and the column stays deferred.
 */
describe('playback state, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  /** An account written before the column existed, to read back afterwards. */
  let existingUserId: string;
  let recordingId: string;

  async function insertProgress(
    userId: string,
    recording: string,
    positionMs: number,
  ): Promise<void> {
    await sql`
      insert into playback_progress (user_id, recording_id, position_ms)
      values (${userId}, ${recording}, ${positionMs})
    `;
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'playback_migration');

    const priorCount = journalCountBefore('0010_playback_state');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    const [account] = await sql<{ id: string }[]>`
      insert into "user" (email, password_hash, display_name, role)
      values ('before-the-speed-column@example.test', 'hash', 'An older account', 'member')
      returning id
    `;
    existingUserId = account?.id as string;

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);

    const [written] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values ('originals/playback-migration.mp3', 'A teaching', '2026-08-16')
      returning id
    `;
    recordingId = written?.id as string;
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.has('playback_progress')).toBe(false);
    expect(before.get('user')).not.toContain('preferred_playback_speed');
    expect(after.has('playback_progress')).toBe(true);
    expect(after.get('user')).toContain('preferred_playback_speed');
  });

  it('adds one column to user, one table, and nothing anywhere else', () => {
    for (const [table, columns] of before) {
      const expected = table === 'user' ? [...columns, 'preferred_playback_speed'].sort() : columns;
      expect(after.get(table), `${table} changed`).toEqual(expected);
    }
    expect([...after.keys()].sort()).toEqual([...before.keys(), 'playback_progress'].sort());
  });

  it('gives playback_progress exactly these columns, and none of the deferred ones', () => {
    expect(after.get('playback_progress')).toEqual([
      'position_ms',
      'recording_id',
      'updated_at',
      'user_id',
    ]);

    // No `id`, because the pair is the identity. `completed_at`, `listened_at` and `play_count`
    // belong to [3.2.7](docs/project/prd.md) and [3.2.8](docs/project/prd.md), which are deferred —
    // this story writes one row per pairing and keeps no play log.
    for (const deferred of ['id', 'completed_at', 'listened_at', 'play_count', 'duration_ms']) {
      expect(
        after.get('playback_progress'),
        `${deferred} is deferred and must not exist`,
      ).not.toContain(deferred);
    }
  });

  it('still has no duration anywhere, which is why the resume card shows elapsed only', () => {
    expect(after.get('recording')).not.toContain('duration');
    expect(after.get('transcript')).not.toContain('duration');
  });

  it('records the position as integer milliseconds and the speed as a real', async () => {
    const rows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public'
        and (table_name, column_name) in
            (('playback_progress', 'position_ms'), ('user', 'preferred_playback_speed'))
      order by table_name
    `;
    expect(rows.map((row) => [row.table_name, row.column_name, row.data_type])).toEqual([
      ['playback_progress', 'position_ms', 'integer'],
      ['user', 'preferred_playback_speed', 'real'],
    ]);
  });

  it('gives every account that already existed a speed of 1, with nobody back-filled by hand', async () => {
    const rows = await sql<{ preferred_playback_speed: number }[]>`
      select preferred_playback_speed from "user" where id = ${existingUserId}
    `;
    expect(rows.map((row) => row.preferred_playback_speed)).toEqual([1]);

    const [column] = await sql<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'user'
        and column_name = 'preferred_playback_speed'
    `;
    expect(column?.is_nullable).toBe('NO');
    expect(column?.column_default).toContain('1');
  });

  it('refuses a speed no control could produce', async () => {
    // The six, at the database. A route that forgot to check still cannot write a seventh value,
    // which is what makes "the column cannot hold a rate no control can produce" a property.
    for (const rejected of [0, 0.6, 1.75, 3]) {
      await expect(
        sql`update "user" set preferred_playback_speed = ${rejected} where id = ${existingUserId}`,
      ).rejects.toThrow();
    }
    for (const allowed of PLAYBACK_SPEEDS) {
      await expect(
        sql`update "user" set preferred_playback_speed = ${allowed} where id = ${existingUserId}`,
      ).resolves.toBeTruthy();
    }
  });

  it('keeps one row per person per teaching', async () => {
    const [account] = await sql<{ id: string }[]>`
      insert into "user" (email, password_hash, display_name, role)
      values ('one-row-per-pair@example.test', 'hash', 'Listener', 'member')
      returning id
    `;
    const userId = account?.id as string;

    await insertProgress(userId, recordingId, 40 * 60 * 1000);
    // The composite primary key is what makes the write an upsert rather than an append, and
    // therefore what makes "resume where I was" a question with one answer.
    await expect(insertProgress(userId, recordingId, 10 * 60 * 1000)).rejects.toThrow();

    const rows = await sql<{ position_ms: number }[]>`
      select position_ms from playback_progress
      where user_id = ${userId} and recording_id = ${recordingId}
    `;
    expect(rows).toHaveLength(1);
  });

  it('refuses progress that belongs to no account or no recording', async () => {
    await expect(
      insertProgress('00000000-0000-0000-0000-000000000000', recordingId, 60_000),
    ).rejects.toThrow();
    await expect(
      insertProgress(existingUserId, '00000000-0000-0000-0000-000000000000', 60_000),
    ).rejects.toThrow();
  });

  it('cascades from both sides, because progress is a fact about a pairing', async () => {
    const [account] = await sql<{ id: string }[]>`
      insert into "user" (email, password_hash, display_name, role)
      values ('cascades-away@example.test', 'hash', 'Listener', 'member')
      returning id
    `;
    const [written] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values ('originals/playback-cascade.mp3', 'Another teaching', '2026-08-17')
      returning id
    `;
    const userId = account?.id as string;
    const otherRecording = written?.id as string;

    // Scoped to this account's rows throughout: another test in this block left progress against
    // the shared recording, and an unscoped count would be answering about that row instead.
    await insertProgress(userId, otherRecording, 60_000);
    await sql`delete from recording where id = ${otherRecording}`;
    const afterRecordingGone = await sql`
      select 1 from playback_progress where user_id = ${userId}
    `;
    expect(afterRecordingGone).toHaveLength(0);

    await insertProgress(userId, recordingId, 60_000);
    expect(await sql`select 1 from playback_progress where user_id = ${userId}`).toHaveLength(1);

    // The delete itself is half the assertion: a restricting foreign key would throw here rather
    // than take the row with it.
    await sql`delete from "user" where id = ${userId}`;
    const afterAccountGone = await sql`
      select 1 from playback_progress where user_id = ${userId}
    `;
    expect(afterAccountGone).toHaveLength(0);
  });
});
