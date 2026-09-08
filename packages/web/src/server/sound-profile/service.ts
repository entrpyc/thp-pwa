import {
  findPreviewJob,
  findRecordingById,
  findTranscriptEndMs,
  findUserById,
  hasRenditionWorkInFlight,
  insertSoundProfileVersion,
  isUniqueViolation,
  listRecordingsForSoundProfile,
  readCurrentSoundProfile,
  settingsOf,
  type PreviewJobRow,
  type SoundProfileRecordingRow,
  type SoundProfileRow,
} from '@thp/db';
import { mediaStore } from '@thp/media';
import {
  DEFAULT_PREVIEW_START_SECONDS,
  MAX_PREVIEW_START_SECONDS,
  MAX_SOUND_PROFILE_NOTE_LENGTH,
  PREVIEW_EXCERPT_SECONDS,
  PREVIEW_GRANT_SECONDS,
  checkSoundProfileSettings,
  pickSoundProfileSettings,
  sameSoundProfileSettings,
  type PreviewPayload,
  type PreviewRequest,
  type PreviewView,
  type ReprocessPayload,
  type SaveSoundProfilePayload,
  type SaveSoundProfileRequest,
  type SoundProfilePayload,
  type SoundProfileRecordingView,
  type SoundProfileSettings,
  type SoundProfileView,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { queue } from '@/server/jobs/queue';
import { audit } from '@/server/observability/audit';
import { logger } from '@/server/observability/logger';

/**
 * **The sound profile, from the API's side** ([3.4.5](docs/project/prd.md)–
 * [3.4.8](docs/project/prd.md)).
 *
 * Four things, and the line between them is where the work happens:
 *
 * 1. **Reading and saving the profile** is this process's own: a row read, a row written. Saving
 *    is a new version every time and never an edit ([3.4.7](docs/project/prd.md)), and a save
 *    that changes nothing is refused rather than written — a version identical to the one before
 *    it is a number that means nothing on the recordings that carry it.
 * 2. **Previewing** ([3.4.6](docs/project/prd.md)) is the worker's: the encoder lives on that host
 *    and the API is never in the audio path. So a preview is a job — enqueued through the port
 *    like every other, carrying the unsaved settings as its payload — and reading it back is a
 *    read of the ledger plus two signed URLs once the row says succeeded.
 * 3. **Re-processing one recording** ([3.4.7](docs/project/prd.md)) is a job too, of the
 *    standalone step the chain does not contain, so nothing downstream runs behind it.
 * 4. **Which version processed what** rides the same payload as the profile, so the panel shows
 *    the version in force and the versions in the library in one refresh.
 *
 * Nothing here decides who may ask; the routes' `permits(...)` did that before this was called.
 */

export async function readSoundProfile(actor: Actor): Promise<SoundProfilePayload> {
  const [current, recordings] = await Promise.all([
    readCurrentSoundProfile(),
    listRecordingsForSoundProfile(),
  ]);

  logger.info('sound-profile.read', {
    ...audit(actor, 'sound-profile.read', `sound-profile:${current.version}`),
    recordings: recordings.length,
  });

  return {
    profile: await describeProfile(current),
    recordings: recordings.map(describeRecording),
  };
}

/**
 * Save the next version.
 *
 * Refused when nothing changed, so that pressing Save on an untouched form leaves the library's
 * numbering alone. The rare race — two admins saving in the same instant — is refused as a
 * conflict rather than retried, because the second admin should read what the first one wrote
 * before deciding whether their own change still stands.
 */
export async function saveSoundProfile(
  actor: Actor,
  body: unknown,
): Promise<SaveSoundProfilePayload> {
  const { settings, note } = parseSaveRequest(body);

  const current = await readCurrentSoundProfile();
  if (sameSoundProfileSettings(settingsOf(current), settings)) {
    throw ApiError.invalidInput(
      `These are already the settings of version ${current.version}. Change a knob before saving.`,
    );
  }

  let saved: SoundProfileRow;
  try {
    saved = await insertSoundProfileVersion({ settings, note, createdBy: actor.id });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ApiError(
        'rendition_in_flight',
        409,
        'Somebody else saved the profile at the same moment. Reload to read their version, then save again.',
      );
    }
    throw cause;
  }

  logger.warn('sound-profile.saved', {
    ...audit(actor, 'sound-profile.update', `sound-profile:${saved.version}`),
    fromVersion: current.version,
    toVersion: saved.version,
    settings,
    note,
  });

  return { profile: await describeProfile(saved) };
}

/**
 * Ask for a preview: thirty seconds of one teaching, plain and under the settings sent.
 *
 * One preview per recording at a time. A second request while one is rendering would otherwise
 * be answered with the first one's job — the partial unique index says so — and the first one's
 * settings, which is a wrong answer dressed as success. So it is refused, in the same words the
 * regenerate route uses for the same shape of problem.
 */
export async function requestPreview(actor: Actor, body: unknown): Promise<PreviewPayload> {
  const { recordingId, settings, startSeconds: requestedStart } = parsePreviewRequest(body);

  const recording = await findRecordingById(recordingId);
  if (recording === null) throw ApiError.notFound('There is no recording with that id.');

  const startSeconds = await resolvePreviewStart(recordingId, requestedStart);

  const inFlight = await queue().findUnfinished(recordingId, 'preview_audio');
  if (inFlight !== null) {
    throw new ApiError(
      'rendition_in_flight',
      409,
      'A preview of this recording is already rendering. Wait for it to finish, then try again.',
    );
  }

  const enqueued = await queue().enqueue({
    recordingId,
    step: 'preview_audio',
    payload: { settings, startSeconds },
  });

  logger.info('sound-profile.preview', {
    ...audit(actor, 'sound-profile.update', `recording:${recordingId}`),
    jobId: enqueued.id,
    startSeconds,
    settings,
  });

  return {
    preview: {
      jobId: enqueued.id,
      recordingId,
      status: 'pending',
      error: null,
      settings,
      startSeconds,
      durationSeconds: PREVIEW_EXCERPT_SECONDS,
      before: null,
      after: null,
      expiresAt: null,
    },
  };
}

/** One preview as it stands now — and, once it has succeeded, the two URLs to hear it. */
export async function readPreview(actor: Actor, jobId: string): Promise<PreviewPayload> {
  const row = await findPreviewJob(jobId);
  if (row === null) throw ApiError.notFound('There is no such preview.');

  logger.info('sound-profile.preview.read', {
    ...audit(actor, 'sound-profile.update', `recording:${row.recordingId}`),
    jobId: row.id,
    status: row.status,
  });

  return { preview: await describePreview(row) };
}

/**
 * Produce one recording's rendition again under the profile in force, and nothing else
 * ([3.4.7](docs/project/prd.md)). Refused while a rendition of it is already being written by
 * either step, for the reason `hasRenditionWorkInFlight` gives.
 */
export async function reprocessRecording(
  actor: Actor,
  recordingId: string,
): Promise<ReprocessPayload> {
  const recording = await findRecordingById(recordingId);
  if (recording === null) throw ApiError.notFound('There is no recording with that id.');

  if (await hasRenditionWorkInFlight(recordingId)) {
    throw new ApiError(
      'rendition_in_flight',
      409,
      'The audio of this recording is already being processed. Wait for it to finish, then try again.',
    );
  }

  const enqueued = await queue().enqueue({ recordingId, step: 'reprocess_audio' });

  logger.info('sound-profile.reprocess', {
    ...audit(actor, 'pipeline.rerun', `recording:${recordingId}`),
    step: enqueued.step,
    jobId: enqueued.id,
    attempt: enqueued.attempt,
  });

  return { jobId: enqueued.id, recordingId, attempt: enqueued.attempt };
}

// -------------------------------------------------------------------------------------------------

async function describeProfile(row: SoundProfileRow): Promise<SoundProfileView> {
  const createdByName =
    row.createdBy === null ? null : ((await findUserById(row.createdBy))?.displayName ?? null);
  return {
    version: row.version,
    settings: settingsOf(row),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    createdByName,
    note: row.note,
  };
}

function describeRecording(row: SoundProfileRecordingRow): SoundProfileRecordingView {
  return {
    id: row.id,
    title: row.title,
    recordedAt: row.recordedAt,
    hasRendition: row.playbackMediaKey !== null,
    soundProfileVersion: row.soundProfileVersion,
    reprocess: row.reprocess,
  };
}

/**
 * What the worker left, read back. The payload carries what was asked for, so a pending preview
 * already says which settings it is of; the meta carries the keys, and the URLs are minted here,
 * now, for this reader — never stored, exactly as playback's are.
 */
async function describePreview(row: PreviewJobRow): Promise<PreviewView> {
  const payload = (row.payload ?? {}) as { settings?: unknown; startSeconds?: unknown };
  const settings = pickSoundProfileSettings(
    (checkSoundProfileSettings(payload.settings) === null
      ? payload.settings
      : { noiseReductionDb: 0, voiceClarityDb: 0, loudnessTargetLufs: -16 }) as SoundProfileSettings,
  );
  const startSeconds = typeof payload.startSeconds === 'number' ? payload.startSeconds : 0;

  const base = {
    jobId: row.id,
    recordingId: row.recordingId,
    status: row.status,
    error: row.error,
    settings,
    startSeconds,
    durationSeconds: PREVIEW_EXCERPT_SECONDS,
  };

  const meta = (row.providerMeta ?? {}) as { beforeKey?: unknown; afterKey?: unknown };
  if (
    row.status !== 'succeeded' ||
    typeof meta.beforeKey !== 'string' ||
    typeof meta.afterKey !== 'string'
  ) {
    return { ...base, before: null, after: null, expiresAt: null };
  }

  const expiresAt = new Date(Date.now() + PREVIEW_GRANT_SECONDS * 1000);
  const store = mediaStore();
  const [before, after] = await Promise.all([
    store.presignGet({ key: meta.beforeKey, expiresInSeconds: PREVIEW_GRANT_SECONDS }),
    store.presignGet({ key: meta.afterKey, expiresInSeconds: PREVIEW_GRANT_SECONDS }),
  ]);
  return { ...base, before, after, expiresAt: expiresAt.toISOString() };
}

/**
 * Where the excerpt starts.
 *
 * The transcript's end is the one length the product knows ([4.2](docs/project/prd.md)), so when
 * there is one the start is clamped to leave a whole excerpt before it — and an explicit start
 * past that end is refused naming the length, because a preview of silence tells an admin
 * nothing about the profile. A recording without a transcript takes the request at its word;
 * the worker fails with a sentence if the excerpt turns out to be empty.
 */
async function resolvePreviewStart(
  recordingId: string,
  requested: number | null,
): Promise<number> {
  const endMs = await findTranscriptEndMs(recordingId);
  const latestStart =
    endMs === null ? null : Math.max(0, Math.floor(endMs / 1000) - PREVIEW_EXCERPT_SECONDS);

  if (requested === null) {
    return latestStart === null
      ? DEFAULT_PREVIEW_START_SECONDS
      : Math.min(DEFAULT_PREVIEW_START_SECONDS, latestStart);
  }
  if (latestStart !== null && requested > latestStart) {
    throw ApiError.invalidInput(
      `This teaching runs about ${Math.floor((endMs ?? 0) / 1000)} seconds, so the excerpt can start ` +
        `no later than ${latestStart} seconds in.`,
    );
  }
  return requested;
}

function parseSaveRequest(body: unknown): {
  readonly settings: SoundProfileSettings;
  readonly note: string | null;
} {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the profile settings.');
  }
  const { settings, note } = body as Partial<SaveSoundProfileRequest>;
  const refused = checkSoundProfileSettings(settings);
  if (refused !== null) throw ApiError.invalidInput(refused);

  return {
    settings: pickSoundProfileSettings(settings as SoundProfileSettings),
    note: parseNote(note),
  };
}

function parseNote(note: unknown): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string') {
    throw ApiError.invalidInput('The note, if given, is a short sentence.');
  }
  const trimmed = note.trim();
  if (trimmed.length > MAX_SOUND_PROFILE_NOTE_LENGTH) {
    throw ApiError.invalidInput(`Keep the note to ${MAX_SOUND_PROFILE_NOTE_LENGTH} characters.`);
  }
  return trimmed === '' ? null : trimmed;
}

function parsePreviewRequest(body: unknown): {
  readonly recordingId: string;
  readonly settings: SoundProfileSettings;
  readonly startSeconds: number | null;
} {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object naming the recording and the settings to hear.');
  }
  const { recordingId, settings, startSeconds } = body as Partial<PreviewRequest>;
  if (typeof recordingId !== 'string' || recordingId.trim() === '') {
    throw ApiError.invalidInput('Name the recording to preview.');
  }
  const refused = checkSoundProfileSettings(settings);
  if (refused !== null) throw ApiError.invalidInput(refused);

  let start: number | null = null;
  if (startSeconds !== undefined && startSeconds !== null) {
    if (
      typeof startSeconds !== 'number' ||
      !Number.isInteger(startSeconds) ||
      startSeconds < 0 ||
      startSeconds > MAX_PREVIEW_START_SECONDS
    ) {
      throw ApiError.invalidInput(
        `The start, if given, is a whole number of seconds from 0 to ${MAX_PREVIEW_START_SECONDS}.`,
      );
    }
    start = startSeconds;
  }

  return {
    recordingId: recordingId.trim(),
    settings: pickSoundProfileSettings(settings as SoundProfileSettings),
    startSeconds: start,
  };
}
