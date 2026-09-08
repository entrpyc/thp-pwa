'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  MAX_PREVIEW_START_SECONDS,
  MAX_SOUND_PROFILE_NOTE_LENGTH,
  SOUND_PROFILE_BOUNDS,
  SOUND_PROFILE_KNOBS,
  SOUND_PROFILE_PATH,
  SOUND_PROFILE_POLL_INTERVAL_MS,
  SOUND_PROFILE_PREVIEWS_PATH,
  describeKnob,
  isUnfinishedJobStatus,
  recordingReprocessPath,
  sameSoundProfileSettings,
  soundProfilePreviewPath,
  type PreviewPayload,
  type PreviewView,
  type SaveSoundProfilePayload,
  type SoundProfileKnob,
  type SoundProfilePayload,
  type SoundProfileRecordingView,
  type SoundProfileSettings,
  type SoundProfileView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './sound-profile.module.css';

/**
 * The sound profile panel ([3.4.5](docs/project/prd.md)–[3.4.8](docs/project/prd.md)).
 *
 * A client module: it imports no server module, holds no database access, and calls the absolute
 * API origin like every other call the client makes. Four things this screen is careful about:
 *
 * 1. **The form is the profile, not a change to it.** Three knobs, each a bounded number, sent
 *    whole. Save is disabled while the form matches the version in force, because a save that
 *    changes nothing is refused by the API and there is no reason to let a press find that out.
 * 2. **A preview is of the form, not of the profile.** Whatever the knobs say *now* is what the
 *    worker renders — saved or not — so the comparison an admin hears is the decision they are
 *    about to make. The two players are labelled by what they are, and both are fresh encodes of
 *    the same thirty seconds.
 * 3. **It polls while something is rendering and stops when nothing is.** A preview in flight,
 *    or a re-process in flight, is the reason to ask again; a panel left open on a quiet library
 *    should not query forever.
 * 4. **Re-processing one teaching names what it does not do.** The button's note says the
 *    transcript, the drafts and the chapters are left alone, because the pipeline panel's
 *    "Process audio · Run again" is the button that does not leave them alone, and an admin has
 *    to be able to tell the two apart without reading the code.
 */

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const MOMENT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatDay(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

function formatMoment(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : MOMENT.format(parsed);
}

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

/** What a knob does, in a line beneath it. */
const KNOB_HELP: Record<SoundProfileKnob, string> = {
  noiseReductionDb: 'How much steady background noise to take out. 0 leaves it in.',
  voiceClarityDb: 'A lift of the voice, with rumble removed and quiet phrases brought up. 0 leaves it alone.',
  loudnessTargetLufs: 'The level every teaching is brought to. −16 is what podcast platforms expect.',
};

/**
 * Which version a recording was made under, in the operator's words.
 * Exported so the screen suite can assert the exact sentence rather than a loose match.
 */
export function describeVersion(recording: SoundProfileRecordingView): string {
  if (!recording.hasRendition) return 'No rendition yet';
  if (recording.soundProfileVersion === null) return 'Processed before the profile existed';
  return `Processed with version ${recording.soundProfileVersion}`;
}

export function SoundProfilePanel() {
  const [profile, setProfile] = useState<SoundProfileView | null>(null);
  const [recordings, setRecordings] = useState<readonly SoundProfileRecordingView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [form, setForm] = useState<SoundProfileSettings | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewView | null>(null);
  const [previewRecordingId, setPreviewRecordingId] = useState('');
  const [previewStart, setPreviewStart] = useState('');
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);
  const [requestingPreview, setRequestingPreview] = useState(false);

  const [busyRecording, setBusyRecording] = useState<string | null>(null);
  const [rowNotes, setRowNotes] = useState<Record<string, string>>({});

  /** Whether anything is rendering, for the poll's own use — see the pipeline panel. */
  const inFlight = useRef(false);
  const previewId = useRef<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<SoundProfilePayload>(SOUND_PROFILE_PATH, {
        credentials: 'include',
      });
      setProfile(payload.profile);
      setRecordings(payload.recordings);
      setForm((current) => current ?? payload.profile.settings);
      setPreviewRecordingId((current) => current || (payload.recordings[0]?.id ?? ''));
      setListError(null);
      inFlight.current =
        previewId.current !== null ||
        payload.recordings.some(
          (row) => row.reprocess !== null && isUnfinishedJobStatus(row.reprocess.status),
        );
    } catch (caught) {
      setListError(describeFailure(caught));
      inFlight.current = false;
    }
  }, []);

  const pollPreview = useCallback(async (): Promise<void> => {
    const id = previewId.current;
    if (id === null) return;
    try {
      const payload = await apiFetch<PreviewPayload>(soundProfilePreviewPath(id), {
        credentials: 'include',
      });
      setPreview(payload.preview);
      if (!isUnfinishedJobStatus(payload.preview.status)) previewId.current = null;
    } catch (caught) {
      setPreviewFailure(describeFailure(caught));
      previewId.current = null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (previewId.current !== null) void pollPreview();
      if (inFlight.current) void load();
    }, SOUND_PROFILE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, pollPreview]);

  const unchanged = profile !== null && form !== null && sameSoundProfileSettings(profile.settings, form);

  function setKnob(knob: SoundProfileKnob, raw: string): void {
    setForm((current) => (current === null ? current : { ...current, [knob]: Number(raw) }));
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving || form === null) return;
    setSaving(true);
    setSaveNote(null);
    setSaveFailure(null);
    try {
      const payload = await apiFetch<SaveSoundProfilePayload>(SOUND_PROFILE_PATH, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: form, note: note.trim() === '' ? null : note.trim() }),
      });
      setProfile(payload.profile);
      setForm(payload.profile.settings);
      setNote('');
      setSaveNote(
        `Version ${payload.profile.version} is saved. New uploads are processed with it; ` +
          'teachings already processed keep their rendition until you re-process them below.',
      );
    } catch (caught) {
      setSaveFailure(describeFailure(caught));
    } finally {
      setSaving(false);
    }
  }

  async function requestPreview(): Promise<void> {
    if (requestingPreview || form === null || previewRecordingId === '') return;
    setRequestingPreview(true);
    setPreviewFailure(null);
    setPreview(null);
    try {
      const payload = await apiFetch<PreviewPayload>(SOUND_PROFILE_PREVIEWS_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recordingId: previewRecordingId,
          settings: form,
          startSeconds: previewStart.trim() === '' ? null : Number(previewStart),
        }),
      });
      setPreview(payload.preview);
      previewId.current = payload.preview.jobId;
      inFlight.current = true;
    } catch (caught) {
      setPreviewFailure(describeFailure(caught));
    } finally {
      setRequestingPreview(false);
    }
  }

  async function reprocess(recordingId: string): Promise<void> {
    if (busyRecording !== null) return;
    setBusyRecording(recordingId);
    setRowNotes((current) => ({ ...current, [recordingId]: '' }));
    let failure = '';
    try {
      await apiFetch(recordingReprocessPath(recordingId), {
        method: 'POST',
        credentials: 'include',
      });
    } catch (caught) {
      failure = describeFailure(caught);
    }
    await load();
    setRowNotes((current) => ({ ...current, [recordingId]: failure }));
    setBusyRecording(null);
  }

  const noteId = useId();
  const previewRecordingSelectId = useId();
  const previewStartId = useId();

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="sound-profile-heading">
        <div>
          <h2 className={styles.sectionTitle} id="sound-profile-heading">
            Sound profile
          </h2>
          <p className={styles.sectionNote}>
            One profile, applied to every recording as it is processed. Saving writes a new version;
            what is already processed keeps the version it was made with until you re-process it.
          </p>
        </div>

        {listError !== null ? (
          <p className={styles.failure} role="alert">
            {listError}
          </p>
        ) : profile === null || form === null ? (
          <p className={styles.sectionNote}>Loading profile…</p>
        ) : (
          <>
            <p className={styles.version} data-version={profile.version}>
              Version {profile.version} is in force
              {profile.createdByName === null
                ? profile.createdBy === null
                  ? ' — the default'
                  : ' — saved by a removed account'
                : ` — saved by ${profile.createdByName}`}{' '}
              on {formatMoment(profile.createdAt)}
              {profile.note === null ? '' : ` · ${profile.note}`}
            </p>

            <form className={styles.form} onSubmit={save} noValidate>
              <div className={styles.knobs}>
                {SOUND_PROFILE_KNOBS.map((knob) => (
                  <Knob
                    key={knob}
                    knob={knob}
                    value={form[knob]}
                    disabled={saving}
                    onChange={(raw) => setKnob(knob, raw)}
                  />
                ))}
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor={noteId}>
                  Note (optional) — why this version
                </label>
                <input
                  className={styles.input}
                  id={noteId}
                  name="note"
                  type="text"
                  maxLength={MAX_SOUND_PROFILE_NOTE_LENGTH}
                  disabled={saving}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>

              <div className={styles.formActions}>
                <button className={styles.submit} type="submit" disabled={saving || unchanged}>
                  {saving ? 'Saving…' : `Save as version ${profile.version + 1}`}
                </button>
                {unchanged ? (
                  <p className={styles.hint}>These are the settings of version {profile.version}.</p>
                ) : null}
              </div>

              {saveNote === null ? null : (
                <p className={styles.done} role="status">
                  {saveNote}
                </p>
              )}
              {saveFailure === null ? null : (
                <p className={styles.failure} role="alert">
                  {saveFailure}
                </p>
              )}
            </form>

            <div className={styles.preview} aria-labelledby="preview-heading">
              <p className={styles.previewHeading} id="preview-heading">
                Hear it first
              </p>
              <p className={styles.sectionNote}>
                Thirty seconds of one teaching, as it is and with the settings above — whether or
                not you have saved them.
              </p>

              <div className={styles.previewForm}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={previewRecordingSelectId}>
                    Teaching
                  </label>
                  <select
                    className={styles.input}
                    id={previewRecordingSelectId}
                    disabled={requestingPreview || recordings === null || recordings.length === 0}
                    value={previewRecordingId}
                    onChange={(event) => setPreviewRecordingId(event.target.value)}
                  >
                    {(recordings ?? []).map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.title} — {formatDay(row.recordedAt)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.fieldTight}>
                  <label className={styles.label} htmlFor={previewStartId}>
                    Start at (seconds, optional)
                  </label>
                  <input
                    className={styles.input}
                    id={previewStartId}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={MAX_PREVIEW_START_SECONDS}
                    step={1}
                    disabled={requestingPreview}
                    value={previewStart}
                    onChange={(event) => setPreviewStart(event.target.value)}
                  />
                </div>
                <button
                  className={styles.action}
                  type="button"
                  disabled={
                    requestingPreview ||
                    previewRecordingId === '' ||
                    (preview !== null && isUnfinishedJobStatus(preview.status))
                  }
                  onClick={() => void requestPreview()}
                >
                  {requestingPreview ? 'Asking…' : 'Render preview'}
                </button>
              </div>

              {previewFailure === null ? null : (
                <p className={styles.failure} role="alert">
                  {previewFailure}
                </p>
              )}

              {preview === null ? null : <PreviewResult preview={preview} />}
            </div>
          </>
        )}
      </section>

      <section className={styles.section} aria-labelledby="processed-heading">
        <div>
          <h2 className={styles.sectionTitle} id="processed-heading">
            Recordings
          </h2>
          <p className={styles.sectionNote}>
            Which version each teaching was processed with. Re-processing makes the rendition again
            under the version in force and changes nothing else — the transcript, the drafts and the
            chapters are left exactly as they are. This updates itself while anything is running.
          </p>
        </div>

        {recordings === null ? (
          listError === null ? <p className={styles.sectionNote}>Loading recordings…</p> : null
        ) : recordings.length === 0 ? (
          <p className={styles.empty}>No recordings yet. Upload one from the Recordings panel.</p>
        ) : (
          <ul className={styles.list}>
            {recordings.map((row) => (
              <li key={row.id} className={styles.listRow} data-recording-id={row.id}>
                <div className={styles.rowIdentity}>
                  <p className={styles.rowName}>{row.title}</p>
                  <p className={styles.rowMeta}>
                    Recorded <time dateTime={row.recordedAt}>{formatDay(row.recordedAt)}</time> ·{' '}
                    <span data-version={row.soundProfileVersion ?? 'none'}>{describeVersion(row)}</span>
                  </p>
                  {row.reprocess === null ? null : (
                    <p className={styles.rowMeta} data-reprocess-status={row.reprocess.status}>
                      Re-process attempt {row.reprocess.attempt}: {REPROCESS_LABEL[row.reprocess.status]}
                      {row.reprocess.error === null ? '' : ` — ${row.reprocess.error}`}
                    </p>
                  )}
                  {rowNotes[row.id] ? (
                    <p className={styles.failure} role="alert">
                      {rowNotes[row.id]}
                    </p>
                  ) : null}
                </div>
                <div className={styles.rowControls}>
                  <button
                    className={styles.action}
                    type="button"
                    disabled={
                      busyRecording !== null ||
                      (row.reprocess !== null && isUnfinishedJobStatus(row.reprocess.status))
                    }
                    onClick={() => void reprocess(row.id)}
                  >
                    {busyRecording === row.id ? 'Queueing…' : 'Re-process'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const REPROCESS_LABEL: Record<PreviewView['status'], string> = {
  pending: 'waiting',
  running: 'running',
  succeeded: 'done',
  failed: 'failed',
};

function Knob({
  knob,
  value,
  disabled,
  onChange,
}: {
  knob: SoundProfileKnob;
  value: number;
  disabled: boolean;
  onChange: (raw: string) => void;
}) {
  const id = useId();
  const { min, max } = SOUND_PROFILE_BOUNDS[knob];
  return (
    <div className={styles.knob}>
      <label className={styles.label} htmlFor={id}>
        {describeKnob(knob)}
      </label>
      <div className={styles.knobControls}>
        <input
          className={styles.slider}
          id={id}
          name={knob}
          type="range"
          min={min}
          max={max}
          step={1}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <output className={styles.knobValue} htmlFor={id} aria-live="off">
          {value}
        </output>
      </div>
      <p className={styles.hint}>{KNOB_HELP[knob]}</p>
    </div>
  );
}

/** The preview as it stands: waiting, failed, or two players side by side. */
function PreviewResult({ preview }: { preview: PreviewView }) {
  if (preview.status === 'failed') {
    return (
      <p className={styles.failure} role="alert" data-preview-status="failed">
        The preview could not be rendered{preview.error === null ? '.' : `: ${preview.error}`}
      </p>
    );
  }
  if (preview.before === null || preview.after === null) {
    return (
      <p className={styles.done} role="status" data-preview-status={preview.status}>
        Rendering {preview.durationSeconds} seconds from {preview.startSeconds} seconds in…
      </p>
    );
  }
  return (
    <div className={styles.players} data-preview-status="succeeded">
      <figure className={styles.player}>
        <figcaption className={styles.playerLabel}>As uploaded</figcaption>
        <audio controls preload="metadata" src={preview.before} className={styles.audio} />
      </figure>
      <figure className={styles.player}>
        <figcaption className={styles.playerLabel}>With these settings</figcaption>
        <audio controls preload="metadata" src={preview.after} className={styles.audio} />
      </figure>
      <p className={styles.hint}>
        From {preview.startSeconds} seconds in, {preview.durationSeconds} seconds long. Noise
        reduction {preview.settings.noiseReductionDb} dB · clarity {preview.settings.voiceClarityDb}{' '}
        dB · {preview.settings.loudnessTargetLufs} LUFS.
      </p>
    </div>
  );
}
