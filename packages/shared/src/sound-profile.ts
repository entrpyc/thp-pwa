import type { JobStatus } from './jobs';
import { RECORDINGS_PATH } from './recordings';

/**
 * **The sound profile** ([3.4.5](docs/project/prd.md)) — the one named set of settings every
 * recording is processed under, and the vocabulary the console, the API and the worker share for
 * it.
 *
 * The profile is **three knobs over a fixed chain**, not a filtergraph an admin edits: noise
 * reduction (`afftdn`), voice clarity (a high-pass, a presence lift and a light compressor) and a
 * loudness target (`loudnorm`, two-pass). Each knob is a number inside a bounded range, and the
 * bounds are here so that the form, the route and the database all refuse the same value for the
 * same reason. A chain a person can type into is a chain a typo can break for every upload until
 * somebody notices; a knob can only be turned too far, and too far is refused.
 *
 * **Versions, not edits.** Saving the profile writes a new version and never changes an old one,
 * because a recording records which version processed it
 * ([3.4.7](docs/project/prd.md)): the number on the row has to keep meaning what it meant.
 */

export interface SoundProfileSettings {
  /**
   * How much steady background noise to take out, in dB. `0` skips the denoiser altogether. The
   * ceiling is where speech itself starts to sound processed on a real room recording.
   */
  readonly noiseReductionDb: number;
  /**
   * How much to lift the voice's presence band, in dB. `0` skips the clarity stage — no high-pass,
   * no lift, no compression — so a recording that is already clear is left alone.
   */
  readonly voiceClarityDb: number;
  /**
   * Integrated loudness to normalise to, in LUFS. −16 is the level podcast platforms recommend for
   * speech and is what [3.4.10](docs/project/prd.md) will distribute at without a second encode.
   */
  readonly loudnessTargetLufs: number;
}

/** The range each knob may be turned within. Integers, so a value reads the same on every screen. */
export const SOUND_PROFILE_BOUNDS = {
  noiseReductionDb: { min: 0, max: 30 },
  voiceClarityDb: { min: 0, max: 6 },
  loudnessTargetLufs: { min: -24, max: -12 },
} as const;

export type SoundProfileKnob = keyof typeof SOUND_PROFILE_BOUNDS;

export const SOUND_PROFILE_KNOBS: readonly SoundProfileKnob[] = [
  'noiseReductionDb',
  'voiceClarityDb',
  'loudnessTargetLufs',
];

/**
 * Version 1 — what the migration seeds, and what every recording is processed under until an
 * admin saves a second version. Moderate on every knob: enough denoising to take a room's hum
 * out, a small presence lift, and the podcast level.
 */
export const DEFAULT_SOUND_PROFILE: SoundProfileSettings = {
  noiseReductionDb: 12,
  voiceClarityDb: 3,
  loudnessTargetLufs: -16,
};

/**
 * The two loudness parameters that are **not** knobs. A true-peak ceiling of −1 dBTP is what keeps
 * a lossy encode from clipping on playback, and a loudness range of 11 LU is the broadcast figure
 * for speech. Neither is a thing an admin has a reason to turn, so neither is on the form.
 */
export const SOUND_PROFILE_TRUE_PEAK_DBTP = -1;
export const SOUND_PROFILE_LOUDNESS_RANGE_LU = 11;

/** The most a version's note may be. A sentence about why, not a memo. */
export const MAX_SOUND_PROFILE_NOTE_LENGTH = 200;

/**
 * Whether these are settings the profile accepts, and if not, why — as a sentence the form and
 * the route both print. `null` means accepted.
 *
 * Integers only: a knob is a whole number of decibels on every surface, so half a decibel typed
 * into the API would be a value the screen could not show back.
 */
export function checkSoundProfileSettings(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return 'Send the profile settings as an object with the three knobs.';
  }
  const candidate = input as Record<string, unknown>;
  for (const knob of SOUND_PROFILE_KNOBS) {
    const value = candidate[knob];
    const { min, max } = SOUND_PROFILE_BOUNDS[knob];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return `${describeKnob(knob)} must be a whole number between ${min} and ${max}.`;
    }
    if (value < min || value > max) {
      return `${describeKnob(knob)} must be between ${min} and ${max}.`;
    }
  }
  return null;
}

export function isSoundProfileSettings(input: unknown): input is SoundProfileSettings {
  return checkSoundProfileSettings(input) === null;
}

/** The three knobs and nothing else — what is written, however much arrived. */
export function pickSoundProfileSettings(input: SoundProfileSettings): SoundProfileSettings {
  return {
    noiseReductionDb: input.noiseReductionDb,
    voiceClarityDb: input.voiceClarityDb,
    loudnessTargetLufs: input.loudnessTargetLufs,
  };
}

export function sameSoundProfileSettings(
  left: SoundProfileSettings,
  right: SoundProfileSettings,
): boolean {
  return SOUND_PROFILE_KNOBS.every((knob) => left[knob] === right[knob]);
}

/** What a knob is called on screen and in a refusal. */
export function describeKnob(knob: SoundProfileKnob): string {
  switch (knob) {
    case 'noiseReductionDb':
      return 'Noise reduction (dB)';
    case 'voiceClarityDb':
      return 'Voice clarity (dB)';
    case 'loudnessTargetLufs':
      return 'Loudness target (LUFS)';
  }
}

// =================================================================================================
// The preview ([3.4.6](docs/project/prd.md)).
// =================================================================================================

/**
 * How much of a teaching a preview renders, in seconds. Long enough to hear a sentence or two
 * settle under the loudness target; short enough that the worker answers in seconds rather than
 * minutes, which is what makes trying a setting twice a thing an admin will actually do.
 */
export const PREVIEW_EXCERPT_SECONDS = 30;

/**
 * Where the excerpt starts when the admin does not say. A minute in is past the greeting and the
 * shuffling, into the voice the profile is for. Clamped to the transcript's end when the teaching
 * is shorter than that, so a short recording still previews.
 */
export const DEFAULT_PREVIEW_START_SECONDS = 60;

/** The latest a preview may start, in seconds — three hours, past any teaching this library holds. */
export const MAX_PREVIEW_START_SECONDS = 3 * 60 * 60;

/**
 * How long the two preview URLs stay valid once rendered. An hour, the playback grant's figure:
 * the console holds the page open for minutes, not days, and a grant copied out of a network tab
 * should die with the sitting.
 */
export const PREVIEW_GRANT_SECONDS = 60 * 60;

/** How often the console asks again about a preview that is still rendering, in milliseconds. */
export const SOUND_PROFILE_POLL_INTERVAL_MS = 2_000;

// =================================================================================================
// Paths.
// =================================================================================================

/** The profile in force, relative to the `/api/v1` prefix. `GET` reads it; `PUT` saves a version. */
export const SOUND_PROFILE_PATH = '/sound-profile';

/** Where a preview is asked for (`POST`). */
export const SOUND_PROFILE_PREVIEWS_PATH = `${SOUND_PROFILE_PATH}/previews`;

/** One preview, by the job that renders it (`GET`). */
export function soundProfilePreviewPath(jobId: string): string {
  return `${SOUND_PROFILE_PREVIEWS_PATH}/${jobId}`;
}

/**
 * Where one recording's rendition is produced again under the profile in force, and only the
 * rendition ([3.4.7](docs/project/prd.md), [3.4.8](docs/project/prd.md)) — the pipeline's
 * `rerun` is a different act with a cascade behind it.
 */
export function recordingReprocessPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/reprocess`;
}

/** The console's eighth panel, on the web origin rather than under the API prefix. */
export const ADMIN_SOUND_PROFILE_PAGE_PATH = '/admin/sound-profile';

// =================================================================================================
// Payloads.
// =================================================================================================

/** One version of the profile, as the console reads it. */
export interface SoundProfileView {
  readonly version: number;
  readonly settings: SoundProfileSettings;
  /** ISO 8601. */
  readonly createdAt: string;
  /** Who saved it, or `null` for the seeded first version and for an account since removed. */
  readonly createdBy: string | null;
  readonly createdByName: string | null;
  readonly note: string | null;
}

/**
 * A recording as the profile panel lists it: which version it was processed under, and what the
 * latest rendition-only re-run of it is doing.
 */
export interface SoundProfileRecordingView {
  readonly id: string;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  /** Whether a playback rendition exists at all. */
  readonly hasRendition: boolean;
  /**
   * The version that produced the rendition, or `null` — either because there is no rendition, or
   * because the rendition was made before the profile existed.
   */
  readonly soundProfileVersion: number | null;
  /** The latest rendition-only re-run, or `null` when none was ever asked for. */
  readonly reprocess: {
    readonly status: JobStatus;
    readonly attempt: number;
    readonly error: string | null;
  } | null;
}

/** Payload of `GET /api/v1/sound-profile`. */
export interface SoundProfilePayload {
  readonly profile: SoundProfileView;
  /** Every recording, newest recorded first, as the pipeline list orders them. */
  readonly recordings: readonly SoundProfileRecordingView[];
}

/** Body of `PUT /api/v1/sound-profile`. Saves a new version; never edits one. */
export interface SaveSoundProfileRequest {
  readonly settings: SoundProfileSettings;
  readonly note?: string | null;
}

/** Payload of `PUT /api/v1/sound-profile` — the version just saved. */
export interface SaveSoundProfilePayload {
  readonly profile: SoundProfileView;
}

/** Body of `POST /api/v1/sound-profile/previews`. */
export interface PreviewRequest {
  readonly recordingId: string;
  /** The settings to hear — the form's, saved or not. */
  readonly settings: SoundProfileSettings;
  /** Where the excerpt starts. Defaults as {@link DEFAULT_PREVIEW_START_SECONDS} describes. */
  readonly startSeconds?: number | null;
}

/**
 * One preview, from asked-for to heard.
 *
 * `before` and `after` are signed URLs and are `null` until the job succeeds — the excerpt of the
 * original transcoded plain, and the same excerpt under the settings that were sent. Both are
 * fresh encodes of the same thirty seconds, so what differs between them is the profile and
 * nothing else.
 */
export interface PreviewView {
  readonly jobId: string;
  readonly recordingId: string;
  readonly status: JobStatus;
  readonly error: string | null;
  readonly settings: SoundProfileSettings;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly before: string | null;
  readonly after: string | null;
  /** ISO 8601, or `null` while there is nothing to expire. */
  readonly expiresAt: string | null;
}

export interface PreviewPayload {
  readonly preview: PreviewView;
}

/** Payload of `POST /api/v1/recordings/{id}/reprocess` — the job now waiting. */
export interface ReprocessPayload {
  readonly jobId: string;
  readonly recordingId: string;
  readonly attempt: number;
}
