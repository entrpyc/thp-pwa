'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  ACCEPTED_AUDIO_EXTENSIONS,
  ACCEPTED_AUDIO_LABEL,
  MAX_UPLOAD_LABEL,
  RECORDINGS_PATH,
  RECORDING_UPLOADS_PATH,
  SERIES_PATH,
  TAGS_PATH,
  checkChosenFile,
  contentTypeForExtension,
  describeBytes,
  extensionOf,
  isAcceptedAudioExtension,
  recordingPublishPath,
  recordingUnpublishPath,
  type AdminRecordingListPayload,
  type RecordingSummary,
  type SeriesListPayload,
  type SeriesView,
  type TagListPayload,
  type TagView,
  type UploadGrantPayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { RecordingEditor } from './recording-editor';
import { DateField } from '../date-field';
import styles from './recordings.module.css';

/**
 * The upload form and the list of everything uploaded.
 *
 * A client module. It imports no server module, holds no database access, and calls the absolute
 * API origin like every other call the client makes. Three decisions worth stating:
 *
 * 1. **The limits are printed before a file is chosen, not after one is refused.** A 200 MB ceiling
 *    discovered at the end of a twenty-minute upload is a ceiling that wastes twenty minutes, and
 *    core-listening scope tdd § Key choices says so in as many words. The
 *    sentence about WAV and FLAC is there for the same reason: a 90-minute teaching genuinely does
 *    not fit in either, and finding that out by trying is the expensive way.
 * 2. **The browser refuses a bad file the moment it is chosen — no request is made at all.** That
 *    is a convenience, not a decision: the API checks the declared size and type again, and the
 *    store's own metadata is checked a third time at finalisation. The client holds no decision
 *    (docs/project/prd.md, 3.1.5); it just declines to waste the upload.
 * 3. **The bytes never pass through the application.** `PUT` goes straight to the object store on
 *    the presigned URL, and the API learns what arrived by asking the store. That is the whole
 *    reason the upload is three steps rather than one form post.
 *
 * What happens when a step fails is the shape of the flow: a failed `PUT` leaves an object that no
 * recording points at and **no row**, and the form says so with what was typed still in it. Nothing
 * deletes the orphan — there is no delete anywhere in this product's media store.
 */

/** One fixed rendering of a date, so a console read in two places says the same thing. */
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

/** The `accept` attribute, built from the one table of formats rather than from a second list. */
const ACCEPT_ATTRIBUTE = ACCEPTED_AUDIO_EXTENSIONS.map((extension) => `.${extension}`).join(',');

/** What the form is doing, so the button can say it and two presses cannot overlap. */
type Stage = 'idle' | 'granting' | 'uploading' | 'finalising';

const STAGE_LABEL: Record<Stage, string> = {
  idle: 'Upload recording',
  granting: 'Preparing…',
  uploading: 'Uploading…',
  finalising: 'Finishing…',
};

export function RecordingsPanel({ translation }: { translation: string }) {
  /** The recording whose editor is open over the list, if any. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const fileId = useId();
  const titleId = useId();
  const dateId = useId();
  const fileErrorId = useId();

  const fileInput = useRef<HTMLInputElement>(null);
  /** Whether a file is being held over the drop zone, for the zone to say so. */
  const [dragging, setDragging] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [recordedAt, setRecordedAt] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [recordings, setRecordings] = useState<readonly RecordingSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /**
   * Every series, for the picker on each row (Story 6).
   *
   * Fetched once for the panel rather than once per row — there is one list and every row offers
   * the same choices. Empty until it arrives, and a failure leaves the picker offering *No series*
   * alone rather than breaking the list beside it.
   */
  const [series, setSeries] = useState<readonly SeriesView[]>([]);

  const loadRecordings = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<AdminRecordingListPayload>(RECORDINGS_PATH, {
        credentials: 'include',
      });
      // Rendered in the order the API sent, never re-sorted here: the query orders by the date
      // recorded, and a second ordering in the client is a second answer to "what is most recent".
      setRecordings(payload.recordings);
      setListError(null);
    } catch (caught) {
      setRecordings(null);
      setListError(describeFailure(caught));
    }
  }, []);

  useEffect(() => {
    void loadRecordings();
  }, [loadRecordings]);

  useEffect(() => {
    void apiFetch<SeriesListPayload>(SERIES_PATH, { credentials: 'include' })
      .then((payload) => setSeries(payload.series))
      .catch(() => setSeries([]));
  }, []);

  /**
   * Every tag, for type-to-add on each row ([4.7](docs/project/prd.md)).
   *
   * Fetched once for the panel, as the series are, and re-read whenever a row changes: adding a
   * word that was not yet a tag creates one, and the next row's suggestions should know it. A
   * failure leaves the field offering nothing rather than breaking the list beside it — typing
   * still works, because the suggestions were only ever a convenience.
   */
  const [tags, setTags] = useState<readonly TagView[]>([]);
  const loadTags = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<TagListPayload>(TAGS_PATH, { credentials: 'include' });
      setTags(payload.tags);
    } catch {
      setTags([]);
    }
  }, []);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  const onRowChanged = useCallback(async (): Promise<void> => {
    await Promise.all([loadRecordings(), loadTags()]);
  }, [loadRecordings, loadTags]);

  /**
   * The refusal that costs nothing. `checkChosenFile` is the shared rule — the same one the API
   * applies — so the sentence here and the sentence the API would have sent are the same sentence.
   */
  function onChooseFile(event: ChangeEvent<HTMLInputElement>): void {
    acceptFile(event.target.files?.[0] ?? null);
  }

  /**
   * **Drag and drop onto the field.** The dropped file goes through exactly the check the chooser's
   * does, and is also handed to the native input so what the control prints ("No file chosen")
   * agrees with what is about to be sent. The first file only: one upload is one teaching.
   */
  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const dropped = event.dataTransfer.files[0] ?? null;
    if (dropped === null) return;
    if (fileInput.current) {
      try {
        const transfer = new DataTransfer();
        transfer.items.add(dropped);
        fileInput.current.files = transfer.files;
      } catch {
        // A browser without a constructible DataTransfer still gets the file: the submit sends
        // what is in state, not what the input holds.
      }
    }
    acceptFile(dropped);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    // Required, or the browser opens the file instead of dropping it here.
    event.preventDefault();
    if (!busy && !dragging) setDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>): void {
    // Leaving for a child of the zone is not leaving the zone.
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDragging(false);
  }

  function acceptFile(chosen: File | null): void {
    setFailure(null);
    setDone(null);

    if (chosen === null) {
      setFile(null);
      setFileError(null);
      return;
    }

    const complaint = checkChosenFile(chosen.name, chosen.size);
    if (complaint !== null) {
      // The file is dropped here and no request is made. Not disabled, not queued — refused.
      setFile(null);
      setFileError(complaint);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }

    setFile(chosen);
    setFileError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (stage !== 'idle') return;

    setFailure(null);
    setDone(null);

    if (file === null) {
      setFileError(`Choose an audio file — ${ACCEPTED_AUDIO_LABEL}, up to ${MAX_UPLOAD_LABEL}.`);
      return;
    }

    const extension = extensionOf(file.name);
    if (!isAcceptedAudioExtension(extension)) {
      setFileError(`That is not an audio file this accepts. Upload ${ACCEPTED_AUDIO_LABEL}.`);
      return;
    }

    // Derived from the extension rather than read off `file.type`: a browser's idea of the MIME
    // type for these five formats varies by platform, and the `PUT` has to present exactly what the
    // grant was signed for or the store refuses the signature.
    const contentType = contentTypeForExtension(extension);

    try {
      setStage('granting');
      const grant = await apiFetch<UploadGrantPayload>(RECORDING_UPLOADS_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType, size: file.size }),
      });

      setStage('uploading');
      // Straight to the object store. No cookie, no correlation id, no API in the path — this is
      // the request the whole three-step flow exists to keep out of the application.
      const put = await fetch(grant.url, {
        method: 'PUT',
        headers: { 'content-type': grant.contentType },
        body: file,
      });
      if (!put.ok) {
        throw new Error(`the object store refused the upload (${put.status})`);
      }

      setStage('finalising');
      await apiFetch<RecordingSummary>(RECORDINGS_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: grant.key, title, recordedAt }),
      });

      setDone(`${title.trim()} is uploaded.`);
      setTitle('');
      setRecordedAt('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      await loadRecordings();
    } catch (caught) {
      // What was typed stays exactly where it is, and the file stays chosen: being refused should
      // cost the press and nothing else. A failed `PUT` has left no row, so the list below is
      // already correct and is not reloaded.
      setFailure(
        caught instanceof ApiClientError
          ? caught.message
          : 'The upload failed before it finished. Nothing was saved — try it again.',
      );
    } finally {
      setStage('idle');
    }
  }

  const busy = stage !== 'idle';

  // The editor reads the row as the list last loaded it, so a save there is reflected here.
  const editing = recordings?.find((entry) => entry.id === editingId) ?? null;
  const closeEditor = useCallback(() => setEditingId(null), []);

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="upload-heading">
        <div>
          <h2 className={styles.sectionTitle} id="upload-heading">
            Upload a recording
          </h2>
          {/*
            Said before a file is chosen, not after one is refused — the whole point of stating a
            ceiling. The second sentence is the consequence of the ceiling that is otherwise
            discovered at the first WAV export.
          */}
          <p className={styles.sectionNote}>
            Up to {MAX_UPLOAD_LABEL}, as {ACCEPTED_AUDIO_LABEL}. A 90-minute teaching fits as MP3 or
            M4A, but does not fit as WAV or FLAC — export those as MP3 first.
          </p>
        </div>

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={fileId}>
              Audio file
            </label>
            {/*
              The drop zone wraps the native control rather than replacing it: the chooser stays
              the accessible way in, and the zone is the second way — a file dragged from a folder
              lands on the same input, and gets the same answer.
            */}
            <div
              className={dragging ? `${styles.dropZone} ${styles.dropZoneActive}` : styles.dropZone}
              data-dragging={dragging ? 'true' : 'false'}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragEnter={onDragOver}
              onDragLeave={onDragLeave}
            >
              <input
                className={styles.file}
                id={fileId}
                ref={fileInput}
                name="file"
                type="file"
                accept={ACCEPT_ATTRIBUTE}
                disabled={busy}
                onChange={onChooseFile}
                {...(fileError === null ? {} : { 'aria-describedby': fileErrorId })}
              />
              <p className={styles.dropHint} aria-hidden="true">
                {dragging ? 'Drop to choose this file' : 'or drag a file here'}
              </p>
            </div>
            {file === null ? null : (
              <p className={styles.chosen}>
                {file.name} · {describeBytes(file.size)}
              </p>
            )}
            {fileError === null ? null : (
              <p className={styles.error} id={fileErrorId} role="alert">
                {fileError}
              </p>
            )}
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={titleId}>
                Title
              </label>
              <input
                className={styles.input}
                id={titleId}
                name="title"
                type="text"
                autoComplete="off"
                disabled={busy}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            <div className={styles.fieldTight}>
              <label className={styles.label} htmlFor={dateId}>
                Date recorded
              </label>
              <DateField
                id={dateId}
                name="recordedAt"
                label="Date recorded"
                disabled={busy}
                value={recordedAt}
                onChange={setRecordedAt}
              />
            </div>

            <button className={styles.submit} type="submit" disabled={busy}>
              {STAGE_LABEL[stage]}
            </button>
          </div>

          {failure === null ? null : (
            <p className={styles.failure} role="alert">
              {failure}
            </p>
          )}
          {done === null ? null : (
            <p className={styles.done} role="status">
              {done}
            </p>
          )}
        </form>
      </section>

      <section className={styles.section} aria-labelledby="recordings-heading">
        <div>
          <h2 className={styles.sectionTitle} id="recordings-heading">
            Recordings
          </h2>
          <p className={styles.sectionNote}>
            Everything uploaded, most recently recorded first. A teaching is visible to members only once
            it is published here — approving its drafts does not do it.
          </p>
        </div>

        {listError !== null ? (
          <p className={styles.failure} role="alert">
            {listError}
          </p>
        ) : recordings === null ? (
          <p className={styles.sectionNote}>Loading recordings…</p>
        ) : recordings.length === 0 ? (
          <p className={styles.empty}>
            No recordings yet. Upload one above and it will appear here.
          </p>
        ) : (
          <ul className={styles.list}>
            {recordings.map((entry) => (
              <RecordingRow
                key={entry.id}
                entry={entry}
                onChanged={onRowChanged}
                onEdit={() => setEditingId(entry.id)}
              />
            ))}
          </ul>
        )}
      </section>

      {editing === null ? null : (
        <RecordingEditor
          key={editing.id}
          entry={editing}
          series={series}
          tags={tags}
          translation={translation}
          onChanged={onRowChanged}
          onClose={closeEditor}
          onDeleted={async () => {
            setEditingId(null);
            await onRowChanged();
          }}
        />
      )}
    </div>
  );
}

/** What a row is doing, so the two presses on it cannot overlap. */
type RowBusy = 'publish' | 'unpublish' | null;

/**
 * One recording: what it is called, when it was recorded, whether it is live, and two presses —
 * the gate, and the way into everything else.
 *
 * Everything that used to sit on the row — the series picker, the tags, the summary controls, the
 * title-and-date form, the review link, the media key — moved into `recording-editor.tsx`, which
 * *Edit* opens over the list. The row keeps the one press an admin scanning the list reaches for
 * without opening anything: publish, and its confirming inverse.
 *
 * **The chip says live, not published.** "Published" is what the column is called; *live* is what
 * an admin is actually asking about when they scan the list.
 */
function RecordingRow({
  entry,
  onChanged,
  onEdit,
}: {
  entry: RecordingSummary;
  onChanged: () => Promise<void>;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState<RowBusy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const live = entry.publishedAt !== null;

  async function send(what: RowBusy, path: string): Promise<void> {
    if (busy !== null) return;
    setBusy(what);
    setNote(null);
    setConfirming(false);
    try {
      await apiFetch(path, { method: 'POST', credentials: 'include' });
      await onChanged();
    } catch (caught) {
      setNote(describeFailure(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className={styles.listRow}>
      <div className={styles.rowIdentity}>
        <p className={styles.rowName}>{entry.title}</p>
        <p className={styles.rowMeta}>
          Recorded <time dateTime={entry.recordedAt}>{formatDay(entry.recordedAt)}</time>
        </p>
      </div>

      <div className={styles.rowControls}>
        <span className={styles.chip}>{live ? 'Live' : 'Not published'}</span>

        {live ? (
          <button
            className={styles.action}
            type="button"
            disabled={busy !== null}
            onClick={() => setConfirming(true)}
          >
            {busy === 'unpublish' ? 'Taking down…' : 'Unpublish'}
          </button>
        ) : (
          <button
            className={styles.submit}
            type="button"
            disabled={busy !== null}
            onClick={() => void send('publish', recordingPublishPath(entry.id))}
          >
            {busy === 'publish' ? 'Publishing…' : 'Publish'}
          </button>
        )}

        <button
          className={styles.action}
          type="button"
          disabled={busy !== null}
          aria-label={`Edit ${entry.title}`}
          onClick={onEdit}
        >
          Edit
        </button>
      </div>

      {/*
        The confirming press, and only for the direction that takes something away from people who
        may be part-way through it. It says what unpublishing does *not* do, which is the fact an
        admin hesitating over this button actually needs.
      */}
      {confirming ? (
        <div className={styles.confirm}>
          <p className={styles.confirmText}>
            Unpublish “{entry.title}”? Members stop seeing it immediately. Nothing is deleted — the
            summary, the transcript and everything else stay exactly as they are.
          </p>
          <div className={styles.confirmActions}>
            <button
              className={styles.actionStrong}
              type="button"
              disabled={busy !== null}
              onClick={() => void send('unpublish', recordingUnpublishPath(entry.id))}
            >
              Yes, unpublish it
            </button>
            <button className={styles.action} type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {note === null ? null : (
        <p className={styles.rowRefusal} role="alert">
          {note}
        </p>
      )}
    </li>
  );
}
