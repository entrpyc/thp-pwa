import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { MIGRATIONS_DIR, runMigrations } from '@thp/db';
import {
  JOB_STATUSES,
  PIPELINE_STEPS,
  PLAYBACK_SPEEDS,
  REVIEW_KINDS,
  REVIEW_STATUSES,
  SCRIPTURE_ORIGINS,
} from '@thp/shared';
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
              ('user_role', 'pipeline_step', 'job_status', 'review_kind', 'review_status',
               'note_visibility', 'scripture_origin')
        order by typname
      `;
      expect(types.map((row) => row.typname)).toEqual([
        'job_status',
        'note_visibility',
        'pipeline_step',
        'review_kind',
        'review_status',
        'scripture_origin',
        'user_role',
      ]);

      // Tables arrive with the ticket that uses them. Ticket 2 added accounts and sessions, ticket 3
      // invitations, ticket 4 password resets, Story 2 Ticket 01 `recording`, Ticket 02 `job` and
      // Ticket 03 `transcript` and `segment`. Story 3 Ticket 01 added `review_item` and `summary`,
      // Story 4 Ticket 04 `playback_progress` and Story 6 Ticket 01 `series` — the last of that
      // epic. The notes scope adds `note` (Task 1.1), then `note_reaction` (Task 4.1) and
      // `note_pin` (Task 6.2). The scripture scope adds `scripture_reference` (Task 1.4) and then
      // `verse_text` (Task 3.2). The chapters scope adds `chapter`
      // ([3.22](docs/project/prd.md), [4.19](docs/project/prd.md)) — and, notably, nothing else:
      // 3.7.10's anchor is a column on a table that already existed, and chapters own no member
      // content of their own (project tdd 3.8), so there is no join table beside this one.
      const tables = await sql<{ tablename: string }[]>`
        select tablename from pg_tables where schemaname = 'public' order by tablename
      `;
      expect(tables.map((row) => row.tablename)).toEqual([
        'chapter',
        'invitation',
        'job',
        'note',
        'note_pin',
        'note_reaction',
        'password_reset',
        'playback_progress',
        'recording',
        'review_item',
        'scripture_reference',
        'segment',
        'series',
        'session',
        'summary',
        'transcript',
        'user',
        'verse_text',
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
 * core-listening scope tdd § Extension points names `processed_media_key` as
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
 * core-listening scope tdd § Extension points names as a later epic's
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

    // The one that matters: core-listening scope tdd § Extension points has
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
 * project tdd 6.2 is protecting: everything waiting on an
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

  it('admits exactly the kinds and statuses this migration declared, in their order', async () => {
    // Bounded by the migration this block is about, like every column set above it: `scripture`
    // arrives at 0014 and is asserted there, against the shared constant as it now stands. Naming
    // the two here rather than reading the constant is what keeps *this* block about *this*
    // migration — the enum a database at 0008 admits is two values however many the product has
    // since grown.
    const kinds = await sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'review_kind' order by pg_enum.enumsortorder
    `;
    expect(kinds.map((row) => row.enumlabel)).toEqual(['summary', 'recording_metadata']);
    expect([...REVIEW_KINDS].slice(0, 2)).toEqual(kinds.map((row) => row.enumlabel));

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
 * true by convention — the speeds the check constraint admits, the composite primary key that
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
    /*
     * The six, at the database. A route that forgot to check still cannot write a seventh value,
     * which is what makes "the column cannot hold a rate no control can produce" a property.
     *
     * Spelled out rather than read from `PLAYBACK_SPEEDS`, because this database is migrated to
     * `0010` and no further: the tuple has since grown a `1.75` step that `0017` is what admits.
     * Asserting the live tuple here would assert a later migration against an earlier schema.
     */
    for (const rejected of [0, 0.6, 1.75, 3]) {
      await expect(
        sql`update "user" set preferred_playback_speed = ${rejected} where id = ${existingUserId}`,
      ).rejects.toThrow();
    }
    for (const allowed of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
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

/**
 * The `series` table and the one column it puts on `recording` — asserted by **exact column set**,
 * for the reason every block above is: what is absent is the design.
 *
 * `recording_count` and `date_range` are auto-calculated ([4.3](docs/project/prd.md)) and must
 * therefore not be columns; artwork is deferred ([3.3.3](docs/project/prd.md)); reordering is
 * deferred, so there is no position column; podcast and external-publication fields arrive with
 * distribution. A `toContain` assertion would not notice any of them arriving.
 */
describe('series, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  /** A recording written before the column existed, to read back afterwards. */
  let existingRecordingId: string;
  let seriesId: string;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'series_migration');

    const priorCount = journalCountBefore('0011_series');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    const [written] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values ('originals/before-series.mp3', 'A teaching from before series', '2026-05-04')
      returning id
    `;
    existingRecordingId = written?.id as string;

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);

    const [created] = await sql<{ id: string }[]>`
      insert into series (title, description) values ('The Book of Romans', 'A verse-by-verse study.')
      returning id
    `;
    seriesId = created?.id as string;
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.has('series')).toBe(false);
    expect(before.get('recording')).not.toContain('series_id');
    expect(after.has('series')).toBe(true);
    expect(after.get('recording')).toContain('series_id');
  });

  it('adds one column to recording, one table, and nothing anywhere else', () => {
    for (const [table, columns] of before) {
      const expected = table === 'recording' ? [...columns, 'series_id'].sort() : columns;
      expect(after.get(table), `${table} changed`).toEqual(expected);
    }
    expect([...after.keys()].sort()).toEqual([...before.keys(), 'series'].sort());
  });

  it('gives series exactly these columns, and none of the deferred ones', () => {
    expect(after.get('series')).toEqual(['created_at', 'description', 'id', 'title']);

    // Every one of these is deferred with a named home. A count or a range as a *column* would also
    // be a second answer to a question one query already answers — and the console's count and a
    // member's count of the same series legitimately differ (3.2.2), which a column cannot express.
    for (const deferred of [
      'recording_count',
      'date_range',
      'first_recorded_at',
      'last_recorded_at',
      'artwork_key',
      'artwork_url',
      'cover_image',
      'position',
      'sort_order',
      'slug',
      'podcast_feed_url',
      'external_published_at',
      'published_at',
    ]) {
      expect(after.get('series'), `${deferred} is deferred and must not exist`).not.toContain(
        deferred,
      );
    }
  });

  it('gives recording exactly one new column and no artwork or duration of its own', () => {
    expect(after.get('recording')).toEqual([
      'created_at',
      'description',
      'id',
      'original_media_key',
      'published_at',
      'recorded_at',
      'series_id',
      'title',
    ]);
  });

  it('leaves every recording that already existed in no series, with nobody back-filled', async () => {
    const rows = await sql<{ series_id: string | null }[]>`
      select series_id from recording where id = ${existingRecordingId}
    `;
    expect(rows.map((row) => row.series_id)).toEqual([null]);

    // Nullable is the whole of "at most one, and usually none" (3.3.2, 3.3.9): a recording with no
    // series is the ordinary case rather than a state somebody has to represent.
    const [column] = await sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'recording' and column_name = 'series_id'
    `;
    expect(column?.is_nullable).toBe('YES');
  });

  it('indexes series_id, because every series read filters on it', async () => {
    const rows = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'recording'
    `;
    expect(rows.some((row) => row.indexdef.includes('series_id'))).toBe(true);
  });

  it('refuses a recording pointed at a series that does not exist', async () => {
    await expect(
      sql`
        update recording set series_id = '00000000-0000-0000-0000-000000000000'
        where id = ${existingRecordingId}
      `,
    ).rejects.toThrow();
  });

  it('sets the column null when a series is deleted, and never takes the recording with it', async () => {
    await sql`update recording set series_id = ${seriesId} where id = ${existingRecordingId}`;
    // The delete itself is half the assertion: a cascading foreign key would take the teaching with
    // the grouping, which is the one thing this column must never do.
    await sql`delete from series where id = ${seriesId}`;

    const rows = await sql<{ id: string; series_id: string | null; title: string }[]>`
      select id, series_id, title from recording where id = ${existingRecordingId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.series_id).toBeNull();
    expect(rows[0]?.title).toBe('A teaching from before series');
  });

  it('lets two series share a title — nothing makes a title an identifier', async () => {
    await expect(
      sql`insert into series (title) values ('Life of David'), ('Life of David')`,
    ).resolves.toBeTruthy();
  });
});

/**
 * **Scripture references** (Task 1.4) — one table, one enum, and one value added to an enum that
 * already existed.
 *
 * Two things this block is for beyond the usual before-and-after. The `review_kind` value is added
 * to a live enum rather than created with it, which is the one migration shape in this repository
 * that can fail on a database with rows already in it. And the table deliberately has **no status
 * column**: `project prd 4.6`'s *suggested or accepted* is the state of the review item holding the
 * draft, and a second answer to it here is exactly what
 * scope prd § 8 records as the refinement.
 */
describe('scripture references, and nothing beside them', () => {
  let target: ThrowawayDatabase;
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  /** A recording written before the table existed, so the foreign key has something real to hold. */
  let existingRecordingId: string;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'scripture_migration');

    const priorCount = journalCountBefore('0014_scripture_references');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    const [written] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values ('originals/before-scripture.mp3', 'A teaching from before references', '2026-05-04')
      returning id
    `;
    existingRecordingId = written?.id as string;
    // A row using the enum as it stood, so widening it is a widening rather than a fresh start.
    await sql`
      insert into review_item (recording_id, kind, status, fields, provenance)
      values (${existingRecordingId}, 'summary', 'draft', '{}'::jsonb, '{}'::jsonb)
    `;

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.has('scripture_reference')).toBe(false);
    expect(after.has('scripture_reference')).toBe(true);
  });

  it('adds one table and changes no column of any table that already existed', () => {
    for (const [table, columns] of before) {
      expect(after.get(table), `${table} must be untouched`).toEqual(columns);
    }
    expect([...after.keys()].filter((table) => !before.has(table))).toEqual([
      'scripture_reference',
    ]);
  });

  // 1.4.1 — the exact column set, and the absence that is the design.
  it('gives scripture_reference exactly these columns, and no status beside them', () => {
    expect(after.get('scripture_reference')).toEqual([
      'book',
      'chapter',
      'created_at',
      'edited_by_admin',
      'id',
      'origin',
      'recording_id',
      'verse_end',
      'verse_start',
    ]);

    // `status` would be a second answer to a question the review item already answers.
    // `review_item_id` would tie a reference to the draft that proposed it, which the recording
    // already leads to. `text` would put the verse in the row rather than in the shared cache
    // group 3 builds, and `translation` belongs to that cache rather than to a citation.
    for (const deferred of ['status', 'review_item_id', 'text', 'translation', 'position']) {
      expect(after.get('scripture_reference'), `${deferred} must not exist`).not.toContain(deferred);
    }
  });

  // 1.2.1 — derived from the one declaration rather than restated beside it, and added to an enum
  // that already had rows using it.
  it('adds scripture to the review kinds an existing database already admits', async () => {
    const kinds = await sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'review_kind' order by pg_enum.enumsortorder
    `;
    expect(kinds.map((row) => row.enumlabel)).toEqual([...REVIEW_KINDS]);
    expect(kinds.map((row) => row.enumlabel)).toContain('scripture');

    // The row written before the widening is still readable and still says what it said.
    const rows = await sql<{ kind: string }[]>`
      select kind::text as kind from review_item where recording_id = ${existingRecordingId}
    `;
    expect(rows.map((row) => row.kind)).toEqual(['summary']);
  });

  it('admits exactly the origins the shared constant declares, in their order', async () => {
    const origins = await sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'scripture_origin' order by pg_enum.enumsortorder
    `;
    expect(origins.map((row) => row.enumlabel)).toEqual([...SCRIPTURE_ORIGINS]);
  });

  it('refuses the same passage on the same teaching twice, and allows it on another', async () => {
    const insert = (recordingId: string) => sql`
      insert into scripture_reference (recording_id, book, chapter, verse_start, verse_end, origin)
      values (${recordingId}, 'romans', 8, 1, 4, 'machine')
    `;

    await expect(insert(existingRecordingId)).resolves.toBeTruthy();
    await expect(insert(existingRecordingId)).rejects.toThrow();

    const [other] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values ('originals/another-scripture.mp3', 'Another teaching', '2026-05-11')
      returning id
    `;
    // A verse cited by a second teaching is a second reference, not a conflict.
    await expect(insert(other?.id as string)).resolves.toBeTruthy();
  });

  it('takes a teaching’s references with it when the teaching is deleted', async () => {
    const [doomed] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values ('originals/doomed-scripture.mp3', 'A teaching about to go', '2026-05-18')
      returning id
    `;
    const recordingId = doomed?.id as string;
    await sql`
      insert into scripture_reference (recording_id, book, chapter, verse_start, verse_end, origin)
      values (${recordingId}, 'john', 3, 16, 16, 'machine')
    `;

    // A reference to a teaching that is gone is not a record of anything.
    await sql`delete from recording where id = ${recordingId}`;
    const rows = await sql`select id from scripture_reference where recording_id = ${recordingId}`;
    expect(rows).toHaveLength(0);
  });

  it('refuses a reference pointed at a teaching that does not exist', async () => {
    await expect(
      sql`
        insert into scripture_reference (recording_id, book, chapter, verse_start, verse_end, origin)
        values ('00000000-0000-0000-0000-000000000000', 'acts', 2, 1, 4, 'machine')
      `,
    ).rejects.toThrow();
  });
});

/**
 * The verse text cache, asserted by its **exact column set**, for the reason every block above is:
 * what is absent is the design.
 *
 * scope plan 3.2.1 — one row per translation, book, chapter and
 * verse, with the text and when it was fetched, keyed so that a verse cited by a second teaching is
 * the same row rather than a second copy.
 */
describe('the verse text cache, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;

  const hold = (
    translation: string,
    book: string,
    chapter: number,
    verse: number,
    text: string,
  ) => sql`
    insert into verse_text (translation, book, chapter, verse, text)
    values (${translation}, ${book}, ${chapter}, ${verse}, ${text})
  `;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'verse_text_migration');

    const priorCount = journalCountBefore('0015_verse_text');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.has('verse_text')).toBe(false);
    expect(after.has('verse_text')).toBe(true);
  });

  it('adds one table and changes no column of any table that already existed', () => {
    for (const [table, columns] of before) {
      expect(after.get(table), `${table} must be untouched`).toEqual(columns);
    }
    expect([...after.keys()].filter((table) => !before.has(table))).toEqual(['verse_text']);
  });

  it('gives verse_text exactly these columns, and none of the deferred ones', () => {
    expect(after.get('verse_text')).toEqual([
      'book',
      'chapter',
      'fetched_at',
      'text',
      'translation',
      'verse',
    ]);

    // `id` would let the same verse be held twice under two ids, with nothing able to say which one
    // a reader gets. `recording_id` or `scripture_reference_id` would tie a verse to one teaching,
    // which is the opposite of what the shared cache is for. `expires_at` is a refresh policy, and
    // there is not one. `translation_name` and `copyright` are the source's to state, not ours.
    for (const deferred of [
      'id',
      'recording_id',
      'scripture_reference_id',
      'expires_at',
      'translation_name',
      'copyright',
      'edited_at',
      'edited_by_user_id',
    ]) {
      expect(after.get('verse_text'), `${deferred} must not exist`).not.toContain(deferred);
    }
  });

  it('holds one row per verse per translation, and refuses a second', async () => {
    await expect(hold('BSB', 'john', 3, 16, 'The first answer.')).resolves.toBeTruthy();
    // The primary key *is* the passage, which is what makes "already held" a question with one
    // answer rather than a race between two rows.
    await expect(hold('BSB', 'john', 3, 16, 'A second answer.')).rejects.toThrow();

    // The same verse in another translation is a different verse as far as this cache is concerned.
    await expect(hold('WEB', 'john', 3, 16, 'Another translation.')).resolves.toBeTruthy();
    // And a different verse of the same chapter is simply another row.
    await expect(hold('BSB', 'john', 3, 17, 'The next verse.')).resolves.toBeTruthy();
  });

  it('stamps when the source answered, without anybody passing a time', async () => {
    await hold('BSB', 'romans', 8, 1, 'A verse of Romans.');
    const rows = await sql<{ fetched_at: string | null }[]>`
      select fetched_at from verse_text
      where translation = 'BSB' and book = 'romans' and chapter = 8 and verse = 1
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fetched_at).not.toBeNull();
  });

  it('belongs to no teaching, so deleting one takes no verse with it', async () => {
    const [written] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values ('originals/verse-text-owner.mp3', 'A teaching that cites a verse', '2026-06-01')
      returning id
    `;
    const recordingId = written?.id as string;
    await sql`
      insert into scripture_reference (recording_id, book, chapter, verse_start, verse_end, origin)
      values (${recordingId}, 'acts', 2, 1, 4, 'machine')
    `;
    await hold('BSB', 'acts', 2, 1, 'A verse of Acts.');

    await sql`delete from recording where id = ${recordingId}`;

    // The verse survives its citer, because it belongs to the translation rather than to the
    // teaching — which is the whole of why the cache is shared.
    const rows = await sql`
      select 1 from verse_text where translation = 'BSB' and book = 'acts' and chapter = 2
    `;
    expect(rows).toHaveLength(1);
  });
});

describe('the series artwork pointer, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  /** A series written before the column existed, to read back afterwards. */
  let existingSeriesId: string;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'series_artwork_migration');

    const priorCount = journalCountBefore('0016_series_artwork');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    const [written] = await sql<{ id: string }[]>`
      insert into series (title, description)
      values ('A study from before covers', 'Written when a series had no artwork.')
      returning id
    `;
    existingSeriesId = written?.id as string;

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.get('series')).not.toContain('artwork_key');
    expect(after.get('series')).toContain('artwork_key');
  });

  it('adds one column to series and nothing anywhere else', () => {
    // scope plan 1.1.1. One nullable pointer is the whole of scope tdd 2.1, and this is the
    // before-and-after that says so rather than a list somebody typed out.
    for (const [table, columns] of before) {
      const expected = table === 'series' ? [...columns, 'artwork_key'].sort() : columns;
      expect(after.get(table), `${table} changed`).toEqual(expected);
    }
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('gives series exactly these columns, and none of the deferred ones', () => {
    expect(after.get('series')).toEqual([
      'artwork_key',
      'created_at',
      'description',
      'id',
      'title',
    ]);

    // Every one of these is excluded with a named reason. Width, height, byte size, content type
    // and an uploaded-at are a second copy of what the store already knows and `head` already
    // answers (scope tdd 2.1). The rendition columns are scope prd § 5 — there are no renditions.
    // `artwork_original_key` is the same section: the file the admin chose is not kept.
    for (const deferred of [
      'artwork_width',
      'artwork_height',
      'artwork_bytes',
      'artwork_content_type',
      'artwork_uploaded_at',
      'artwork_thumbnail_key',
      'artwork_banner_key',
      'artwork_original_key',
      'artwork_url',
      'cover_image',
    ]) {
      expect(after.get('series'), `${deferred} must not exist`).not.toContain(deferred);
    }
  });

  it('leaves a series written before the column with no cover rather than a default one', async () => {
    // Nullable, and no backfill: scope prd 3.1.7 makes "no cover" ordinary, so every series that
    // already existed keeps being an ordinary series rather than acquiring a placeholder.
    const rows = await sql<{ artwork_key: string | null; title: string }[]>`
      select artwork_key, title from series where id = ${existingSeriesId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.artwork_key).toBeNull();
    expect(rows[0]?.title).toBe('A study from before covers');
  });
});

// =================================================================================================

/**
 * **The `1.75` step** — `0017_playback_speed_step`.
 *
 * The check constraint on `user.preferred_playback_speed` is derived from `PLAYBACK_SPEEDS`, so a
 * step added to the tuple is a step the column must admit. That is the whole of this migration, and
 * the two halves of it are asserted here: the value the column refused before it and takes after,
 * and the six that were already allowed still being allowed — a widened constraint that quietly
 * dropped one of the old steps would be a member's saved rate becoming unwritable.
 *
 * `PLAYBACK_SPEEDS` is read live here, unlike in the `0010` block above, because this is the
 * migration that catches the schema up to it: if the two ever disagree again, this is the test that
 * says so rather than a route failing in production.
 */
describe('the 1.75 playback step, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  let existingUserId: string;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'playback_step_migration');

    const priorCount = journalCountBefore('0017_playback_speed_step');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    const [account] = await sql<{ id: string }[]>`
      insert into "user" (email, password_hash, display_name, role)
      values ('before-the-faster-step@example.test', 'hash', 'A listener', 'member')
      returning id
    `;
    existingUserId = account?.id as string;

    // The step the constraint refused right up until this migration — the before half of the pair.
    await expect(
      sql`update "user" set preferred_playback_speed = 1.75 where id = ${existingUserId}`,
    ).rejects.toThrow();

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('changes no column anywhere — a constraint is not a schema change', () => {
    for (const [table, columns] of before) {
      expect(after.get(table), `${table} changed`).toEqual(columns);
    }
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('admits every step the tuple names, and nothing outside it', async () => {
    for (const allowed of PLAYBACK_SPEEDS) {
      await expect(
        sql`update "user" set preferred_playback_speed = ${allowed} where id = ${existingUserId}`,
      ).resolves.toBeTruthy();
    }
    for (const rejected of [0, 0.6, 1.1, 1.9, 3]) {
      await expect(
        sql`update "user" set preferred_playback_speed = ${rejected} where id = ${existingUserId}`,
      ).rejects.toThrow();
    }
  });

  it('leaves an account written before the step at the rate it already had', async () => {
    // No backfill and no reset: widening what is allowed must not move anybody who chose.
    await sql`update "user" set preferred_playback_speed = 1.25 where id = ${existingUserId}`;
    const rows = await sql<{ preferred_playback_speed: number }[]>`
      select preferred_playback_speed from "user" where id = ${existingUserId}
    `;
    expect(rows[0]?.preferred_playback_speed).toBe(1.25);
  });
});

/**
 * **The scripture reference's anchor** ([3.7.10](docs/project/prd.md)) — one nullable column, and
 * nothing else anywhere.
 *
 * The before-and-after is what makes "and nothing else" a comparison rather than a claim, and this
 * migration is the one that unblocks chapters: a citation with no offset cannot be scoped to a
 * chapter ([3.22.14](docs/project/prd.md)), which is why 3.7.10 had to land first.
 */
describe('the scripture anchor, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  /** A reference written before the column existed, so the widening is a widening. */
  let existingRecordingId: string;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'scripture_anchor_migration');

    const priorCount = journalCountBefore('0018_scripture_anchor');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    const [written] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values ('originals/before-anchors.mp3', 'A teaching from before anchors', '2026-05-04')
      returning id
    `;
    existingRecordingId = written?.id as string;
    await sql`
      insert into scripture_reference (recording_id, book, chapter, verse_start, verse_end, origin)
      values (${existingRecordingId}, 'romans', 8, 1, 4, 'machine')
    `;

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('adds one column to one table and changes nothing else', () => {
    for (const [table, columns] of before) {
      const expected =
        table === 'scripture_reference' ? [...columns, 'anchor_ms'].sort() : [...columns];
      expect([...(after.get(table) ?? [])].sort(), `${table} changed`).toEqual(expected);
    }
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  /**
   * **Nullable, and nothing back-fills it.** A reference written before the column existed keeps no
   * anchor, which is exactly what 3.7.10 says such a reference has — it "belongs to the recording
   * rather than to any chapter". Inventing an offset for it would be inventing a moment.
   */
  it('leaves a reference written before it with no anchor at all', async () => {
    const rows = await sql<{ anchor_ms: number | null }[]>`
      select anchor_ms from scripture_reference where recording_id = ${existingRecordingId}
    `;
    expect(rows[0]?.anchor_ms).toBeNull();
  });

  it('takes an offset, and refuses one that names no moment of any teaching', async () => {
    await expect(
      sql`update scripture_reference set anchor_ms = 90000 where recording_id = ${existingRecordingId}`,
    ).resolves.toBeTruthy();
    await expect(
      sql`update scripture_reference set anchor_ms = -1 where recording_id = ${existingRecordingId}`,
    ).rejects.toThrow();
  });

  /**
   * **The anchor is not part of the passage's identity.** A teaching cites a passage once, so citing
   * it at two moments is not two references — and putting the anchor in the unique key would make
   * it so.
   */
  it('still refuses the same passage twice on one teaching, whatever their anchors', async () => {
    await expect(
      sql`insert into scripture_reference
            (recording_id, book, chapter, verse_start, verse_end, origin, anchor_ms)
          values (${existingRecordingId}, 'romans', 8, 1, 4, 'machine', 500000)`,
    ).rejects.toThrow();
  });
});

/**
 * **The chapter table** ([3.22](docs/project/prd.md), [4.19](docs/project/prd.md)), asserted by its
 * **exact column set**.
 *
 * Exact rather than "contains", because what is absent is the design (project tdd 3.7, 3.8): there
 * is no `end_ms`, because a chapter ends where the next begins; no `position`, because order is
 * `start_ms` ascending and storing it would make a split renumber every row after it; and no
 * `status`, because chapters carry no gate of their own ([3.22.6](docs/project/prd.md)). A
 * `toContain` assertion would not notice any of the three arriving.
 */
describe('the chapter table, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  let existingRecordingId: string;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'chapters_migration');

    const priorCount = journalCountBefore('0019_chapters');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    const [written] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values ('originals/before-chapters.mp3', 'A teaching from before chapters', '2026-05-04')
      returning id
    `;
    existingRecordingId = written?.id as string;
    // A job using the step enum as it stood, so widening it is a widening rather than a fresh start.
    await sql`
      insert into job (recording_id, step, status, attempt, correlation_id)
      values (${existingRecordingId}, 'transcribe', 'succeeded', 1, 'before-chapters')
    `;

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.has('chapter')).toBe(false);
    expect(after.has('chapter')).toBe(true);
  });

  it('adds one table and changes no column of any table that already existed', () => {
    for (const [table, columns] of before) {
      expect(after.get(table), `${table} must be untouched`).toEqual(columns);
    }
    expect([...after.keys()].filter((table) => !before.has(table))).toEqual(['chapter']);
  });

  it('gives chapter exactly these columns, and none of the four that are the design', () => {
    expect(after.get('chapter')).toEqual([
      'created_at',
      'edited_by_admin',
      'generated_by',
      'id',
      'recording_id',
      'start_ms',
      'summary',
      'title',
    ]);

    // `end_ms` would make a gap and an overlap representable, which project tdd 3.7 refuses.
    // `position` would make a split renumber every row after it, which is what makes 3.22.7's
    // boundary move "one write to one row" untrue. `status` would be a second answer to a question
    // the recording's own publication already answers (3.22.6). `artwork_key` is 3.22.3's "no
    // artwork of its own", said as an absence.
    for (const deferred of ['end_ms', 'position', 'status', 'published_at', 'artwork_key']) {
      expect(after.get('chapter'), `${deferred} must not exist`).not.toContain(deferred);
    }
  });

  it('adds generate_chapters to the pipeline steps an existing database already admits', async () => {
    const steps = await sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'pipeline_step' order by pg_enum.enumsortorder
    `;
    // Derived from the one declaration rather than restated beside it, exactly as every other enum
    // in this file is.
    expect(steps.map((row) => row.enumlabel)).toEqual([...PIPELINE_STEPS]);
    expect(steps.map((row) => row.enumlabel)).toContain('generate_chapters');

    // The job written before the widening is still readable and still says what it said.
    const rows = await sql<{ step: string }[]>`
      select step::text as step from job where recording_id = ${existingRecordingId}
    `;
    expect(rows.map((row) => row.step)).toEqual(['transcribe']);
  });
});

// =================================================================================================

/**
 * **The avatar pointer** — `0022_user_avatar` (docs/project/prd.md 3.1.12).
 *
 * The series cover's migration, one table over, and it is held to the same three claims: the
 * column did not exist and now does, nothing else anywhere changed, and every account that already
 * existed keeps the state it was in — no picture — rather than acquiring a placeholder.
 */
describe('the avatar pointer, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  /** An account written before the column existed, to read back afterwards. */
  let existingUserId: string;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'user_avatar_migration');

    const priorCount = journalCountBefore('0022_user_avatar');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    const [written] = await sql<{ id: string }[]>`
      insert into "user" (email, password_hash, display_name, role)
      values ('before-avatars@example.test', 'not-a-real-hash', 'From Before Pictures', 'member')
      returning id
    `;
    existingUserId = written?.id as string;

    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount + 1) });
    after = await readColumnSets(target.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.get('user')).not.toContain('avatar_key');
    expect(after.get('user')).toContain('avatar_key');
  });

  it('adds one column to user and nothing anywhere else', () => {
    for (const [table, columns] of before) {
      const expected = table === 'user' ? [...columns, 'avatar_key'].sort() : columns;
      expect(after.get(table), `${table} changed`).toEqual(expected);
    }
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('is one nullable text pointer, and none of the deferred columns', async () => {
    const rows = await sql<{ data_type: string; is_nullable: string }[]>`
      select data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'user' and column_name = 'avatar_key'
    `;
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);

    // Width, height, byte size, content type and an uploaded-at are a second copy of what the store
    // already knows and `head` already answers; a URL is minted per response and never stored.
    for (const deferred of [
      'avatar_url',
      'avatar_width',
      'avatar_height',
      'avatar_bytes',
      'avatar_content_type',
      'avatar_uploaded_at',
      'image_url',
    ]) {
      expect(after.get('user'), `${deferred} must not exist`).not.toContain(deferred);
    }
  });

  it('leaves an account written before the column with no picture rather than a default one', async () => {
    const rows = await sql<{ avatar_key: string | null; display_name: string }[]>`
      select avatar_key, display_name from "user" where id = ${existingUserId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.avatar_key).toBeNull();
    expect(rows[0]?.display_name).toBe('From Before Pictures');
  });
});
