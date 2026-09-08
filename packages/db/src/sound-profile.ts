import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { JobStatus, SoundProfileSettings } from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import { job, recording, soundProfile } from './schema';

/**
 * The sound profile's reads and writes ([3.4.5](docs/project/prd.md)–[3.4.7](docs/project/prd.md)).
 *
 * Query construction lives here and nowhere else, as it does for every other table. Two of these
 * read the `job` table — which version's re-run is in flight, and what a preview job left behind
 * — and they read it the way `pipeline.ts` does: as **queryable pipeline state**, not as dispatch.
 * Nothing here enqueues, claims or completes, so tools/queue-boundary.ts, which derives its
 * forbidden names from `jobs.ts`, has nothing to say about them.
 */

export interface SoundProfileRow {
  readonly id: string;
  readonly version: number;
  readonly noiseReductionDb: number;
  readonly voiceClarityDb: number;
  readonly loudnessTargetLufs: number;
  readonly note: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface NewSoundProfileVersion {
  readonly settings: SoundProfileSettings;
  readonly note: string | null;
  readonly createdBy: string;
}

/** The three knobs off a row, in the shape the processor takes. */
export function settingsOf(row: SoundProfileRow): SoundProfileSettings {
  return {
    noiseReductionDb: row.noiseReductionDb,
    voiceClarityDb: row.voiceClarityDb,
    loudnessTargetLufs: row.loudnessTargetLufs,
  };
}

/**
 * The version in force: the highest one.
 *
 * Never `null` in a migrated database — the migration seeds version 1 — so the throw is the
 * honest answer to a database this module was not told about, not a state the product has.
 */
export async function readCurrentSoundProfile(
  executor: Executor = getDatabase(),
): Promise<SoundProfileRow> {
  const rows = await queryable(executor)
    .select()
    .from(soundProfile)
    .orderBy(desc(soundProfile.version))
    .limit(1);
  const row = rows[0] as SoundProfileRow | undefined;
  if (!row) {
    throw new Error('no sound profile exists — the migration that seeds version 1 has not run');
  }
  return row;
}

/**
 * Save the next version.
 *
 * `version` is computed **inside the insert** as `max(version) + 1`, the way a job's `attempt`
 * is: two admins saving in the same second cannot read the same number and both write it — one
 * wins the unique index and the other's insert fails, which the caller reports rather than
 * retries. A read-then-write would have a window in which both see the same `max`.
 */
export async function insertSoundProfileVersion(
  input: NewSoundProfileVersion,
  executor: Executor = getDatabase(),
): Promise<SoundProfileRow> {
  const nextVersion = sql<number>`(select coalesce(max(${soundProfile.version}), 0) + 1 from ${soundProfile})`;
  const rows = await queryable(executor)
    .insert(soundProfile)
    .values({
      version: nextVersion,
      noiseReductionDb: input.settings.noiseReductionDb,
      voiceClarityDb: input.settings.voiceClarityDb,
      loudnessTargetLufs: input.settings.loudnessTargetLufs,
      note: input.note,
      createdBy: input.createdBy,
    })
    .returning();
  const row = rows[0] as SoundProfileRow | undefined;
  if (!row) throw new Error('insertSoundProfileVersion returned no row');
  return row;
}

/** One recording as the profile panel lists it, with the latest rendition-only re-run of it. */
export interface SoundProfileRecordingRow {
  readonly id: string;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  readonly playbackMediaKey: string | null;
  readonly soundProfileVersion: number | null;
  readonly reprocess: {
    readonly status: JobStatus;
    readonly attempt: number;
    readonly error: string | null;
  } | null;
}

/**
 * Every recording, newest recorded first, with which version processed it and what its latest
 * `reprocess_audio` job is doing — the profile panel's list, in one statement.
 *
 * The same shape `readPipeline` takes: a left join from `recording` onto the latest attempt of
 * one step, `distinct on (recording_id)` ordered by descending `attempt`. Left, because a
 * recording nobody has re-processed is still a recording the panel has to show a version for.
 */
export async function listRecordingsForSoundProfile(
  executor: Executor = getDatabase(),
): Promise<SoundProfileRecordingRow[]> {
  const on = queryable(executor);

  const latest = on
    .selectDistinctOn([job.recordingId], {
      recordingId: job.recordingId,
      status: job.status,
      attempt: job.attempt,
      error: job.error,
    })
    .from(job)
    .where(eq(job.step, 'reprocess_audio'))
    .orderBy(job.recordingId, desc(job.attempt))
    .as('latest');

  const rows = await on
    .select({
      id: recording.id,
      title: recording.title,
      recordedAt: recording.recordedAt,
      playbackMediaKey: recording.playbackMediaKey,
      soundProfileVersion: recording.soundProfileVersion,
      status: latest.status,
      attempt: latest.attempt,
      error: latest.error,
    })
    .from(recording)
    .leftJoin(latest, eq(latest.recordingId, recording.id))
    .orderBy(desc(recording.recordedAt), desc(recording.createdAt));

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    recordedAt: row.recordedAt,
    playbackMediaKey: row.playbackMediaKey,
    soundProfileVersion: row.soundProfileVersion,
    reprocess:
      row.status === null || row.attempt === null
        ? null
        : { status: row.status as JobStatus, attempt: row.attempt, error: row.error },
  }));
}

/** A preview job as the console reads it back: the row, less what only the worker needs. */
export interface PreviewJobRow {
  readonly id: string;
  readonly recordingId: string;
  readonly status: JobStatus;
  readonly error: string | null;
  readonly enqueuedAt: Date;
  readonly finishedAt: Date | null;
  readonly payload: unknown;
  readonly providerMeta: unknown;
}

/**
 * One `preview_audio` job by id, or `null` — for no such job **and** for a job of any other step,
 * because a preview route answering with a transcription's row would be a route that leaks the
 * ledger one id at a time.
 */
export async function findPreviewJob(
  id: string,
  executor: Executor = getDatabase(),
): Promise<PreviewJobRow | null> {
  const rows = await queryable(executor)
    .select({
      id: job.id,
      recordingId: job.recordingId,
      status: job.status,
      error: job.error,
      enqueuedAt: job.enqueuedAt,
      finishedAt: job.finishedAt,
      payload: job.payload,
      providerMeta: job.providerMeta,
    })
    .from(job)
    .where(and(eq(job.id, id), eq(job.step, 'preview_audio')))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : (row as PreviewJobRow);
}

/**
 * Whether any `process_audio` or `reprocess_audio` job for this recording is still in flight —
 * asked before a rendition-only re-run is queued, because two renditions being written for one
 * recording at once would end with whichever finished last, which is not an answer anybody chose.
 */
export async function hasRenditionWorkInFlight(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        eq(job.recordingId, recordingId),
        inArray(job.step, ['process_audio', 'reprocess_audio']),
        inArray(job.status, ['pending', 'running']),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
