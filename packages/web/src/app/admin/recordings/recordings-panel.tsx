'use client';

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  ACCEPTED_AUDIO_EXTENSIONS,
  ACCEPTED_AUDIO_LABEL,
  ADMIN_REVIEWS_PAGE_PATH,
  MAX_UPLOAD_LABEL,
  RECORDINGS_PATH,
  RECORDING_UPLOADS_PATH,
  REVIEW_RECORDING_PARAM,
  checkChosenFile,
  contentTypeForExtension,
  describeBytes,
  extensionOf,
  isAcceptedAudioExtension,
  recordingPublishPath,
  recordingSummaryPath,
  recordingSummaryUnpublishPath,
  recordingUnpublishPath,
  type AdminRecordingListPayload,
  type RecordingSummary,
  type UploadGrantPayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './recordings.module.css';

/**
 * The upload form and the list of everything uploaded.
 *
 * A client module. It imports no server module, holds no database access, and calls the absolute
 * API origin like every other call the client makes. Three decisions worth stating:
 *
 * 1. **The limits are printed before a file is chosen, not after one is refused.** A 200 MB ceiling
 *    discovered at the end of a twenty-minute upload is a ceiling that wastes twenty minutes, and
 *    docs/epics/epic-core-listening/architecture.md § Key choices says so in as many words. The
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

export function RecordingsPanel() {
  const fileId = useId();
  const titleId = useId();
  const dateId = useId();
  const fileErrorId = useId();

  const fileInput = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [recordedAt, setRecordedAt] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [recordings, setRecordings] = useState<readonly RecordingSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

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

  /**
   * The refusal that costs nothing. `checkChosenFile` is the shared rule — the same one the API
   * applies — so the sentence here and the sentence the API would have sent are the same sentence.
   */
  function onChooseFile(event: ChangeEvent<HTMLInputElement>): void {
    setFailure(null);
    setDone(null);
    const chosen = event.target.files?.[0] ?? null;

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
              <input
                className={styles.input}
                id={dateId}
                name="recordedAt"
                type="date"
                disabled={busy}
                value={recordedAt}
                onChange={(event) => setRecordedAt(event.target.value)}
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
              <RecordingRow key={entry.id} entry={entry} onChanged={loadRecordings} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** What a row is doing, so the buttons can say it and two presses cannot overlap. */
type RowBusy = 'publish' | 'unpublish' | 'summary' | 'summaryDown' | null;

/**
 * One recording, and everything an admin does to it after the pipeline has finished.
 *
 * **The row is where publication lives** (Story 3 Ticket 04). No per-recording admin page exists —
 * docs/project/prd.md 3.6.4's "from the recording page" is served by the Review link below, because
 * the recording page itself is Story 4 — so this row carries the whole of it: whether the teaching
 * is live, the press that changes that, the summary's own gate, and the way into the queue.
 *
 * Three things worth stating:
 *
 * 1. **Unpublish takes a confirming press and publish does not.** The same line every other panel
 *    draws: taking a teaching away from people who may be part-way through it is the direction that
 *    costs something.
 * 2. **The summary controls only appear when there is one.** A recording whose draft was discarded
 *    has no summary, is still publishable (3.6.10), and should not be offered a control that would
 *    answer `not_found`.
 * 3. **The chip says live, not published.** "Published" is what the column is called; *live* is
 *    what an admin is actually asking about when they scan the list.
 */
function RecordingRow({
  entry,
  onChanged,
}: {
  entry: RecordingSummary;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<RowBusy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.summary ?? '');

  const live = entry.publishedAt !== null;
  // The payload only ever carries a summary that is published *and* on a published recording, so
  // this is the honest question the row can ask: is there one a member can read right now.
  const summaryVisible = entry.summary !== null;

  async function send(what: RowBusy, path: string, init: RequestInit): Promise<void> {
    if (busy !== null) return;
    setBusy(what);
    setNote(null);
    setConfirming(false);
    try {
      await apiFetch(path, { credentials: 'include', ...init });
      setEditing(false);
      await onChanged();
    } catch (caught) {
      // Refused: the press cost nothing else, and what was typed stays where it is.
      setNote(describeFailure(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Four of the five controls are a bare `POST` to a named sub-resource and carry no body. */
  const POST = { method: 'POST' as const };

  return (
    <li className={styles.listRow}>
      <div className={styles.rowIdentity}>
        <p className={styles.rowName}>{entry.title}</p>
        <p className={styles.rowMeta}>
          Recorded <time dateTime={entry.recordedAt}>{formatDay(entry.recordedAt)}</time>
        </p>
        {/* The key, because the one property the suite cannot prove against the real
            bucket is proven by an operator pasting this into a browser. */}
        <p className={styles.rowKey}>{entry.originalMediaKey}</p>
      </div>

      <div className={styles.rowControls}>
        <span className={styles.chip}>{live ? 'Live' : 'Not published'}</span>

        {/*
          Into the queue, filtered to this recording — 3.6.4's second entry point, and the reason no
          per-recording admin page had to exist for it.
        */}
        <a
          className={styles.action}
          href={`${ADMIN_REVIEWS_PAGE_PATH}?${REVIEW_RECORDING_PARAM}=${entry.id}`}
        >
          Review drafts
        </a>

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
            onClick={() => void send('publish', recordingPublishPath(entry.id), POST)}
          >
            {busy === 'publish' ? 'Publishing…' : 'Publish'}
          </button>
        )}

        {summaryVisible ? (
          <>
            <button
              className={styles.action}
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setDraft(entry.summary ?? '');
                setEditing(!editing);
              }}
            >
              {editing ? 'Cancel edit' : 'Edit summary'}
            </button>
            <button
              className={styles.action}
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void send('summaryDown', recordingSummaryUnpublishPath(entry.id), POST)
              }
            >
              {busy === 'summaryDown' ? 'Taking down…' : 'Summary to draft'}
            </button>
          </>
        ) : null}
      </div>

      {editing ? (
        <div className={styles.summaryEditor}>
          <label className={styles.label} htmlFor={`summary-${entry.id}`}>
            Summary
          </label>
          <textarea
            className={styles.textarea}
            id={`summary-${entry.id}`}
            name="content"
            rows={10}
            disabled={busy !== null}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            className={styles.submit}
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void send('summary', recordingSummaryPath(entry.id), {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ content: draft }),
              })
            }
          >
            {busy === 'summary' ? 'Saving…' : 'Save summary'}
          </button>
        </div>
      ) : null}

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
              onClick={() => void send('unpublish', recordingUnpublishPath(entry.id), POST)}
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
