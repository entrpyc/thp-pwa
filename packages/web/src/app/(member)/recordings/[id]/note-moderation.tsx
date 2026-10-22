'use client';

import { useId, useState } from 'react';
import {
  MAX_REPORT_DETAIL_LENGTH,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  REPORT_TAKEN_MESSAGE,
  memberBlockPath,
  noteReportPath,
  type NoteView,
  type ReportNotePayload,
  type ReportNoteRequest,
  type ReportReason,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useRecordingContent } from './recording-content';
import styles from './notes.module.css';

/**
 * **Report and Block, as the note menu offers them** (Apple guideline 1.2, Google Play's UGC
 * policy) — in their own module so the menu's edit is two entries and the Highlights pin another
 * branch is adding beside them meets nothing of ours.
 *
 * Both act on `note.authorId`, which the API answers for exactly this; both call routes that
 * refuse independently of anything drawn here. Neither hides the note on its own: a report is a
 * request to an admin, and the way to stop seeing somebody is Block, which the report's thank-you
 * offers as the next press. Blocking refreshes the list, and the block predicate on the server is
 * what makes the member's notes leave it — nothing here filters a row.
 */

function describeFailure(caught: unknown, fallback: string): string {
  return caught instanceof ApiClientError ? caught.message : fallback;
}

/** `Block Ana?` and the two-sentence consequence, spelled once for the confirmation and the offer. */
function blockConsequence(displayName: string): string {
  return `You and ${displayName} will no longer see each other's notes, replies or reactions, and neither of you can reply or react to the other. You can unblock from Profile › Settings.`;
}

/**
 * The report form: a reason from the shared list, an optional sentence, and Send. On success the
 * same panel becomes the thank-you, with Block offered beside Done — the member who reported
 * somebody is the member most likely to want not to see them, and the control is one press away
 * rather than a second trip to the menu.
 */
export function ReportForm({
  note,
  authorId,
  onDone,
}: {
  note: NoteView;
  authorId: string;
  onDone: () => void;
}) {
  const content = useRecordingContent();
  const legendId = useId();
  const detailId = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  function send(): void {
    if (reason === null || sending) return;
    setSending(true);
    setFailure(null);
    const request: ReportNoteRequest = {
      reason,
      detail: detail.trim() === '' ? null : detail.trim(),
    };
    void apiFetch<ReportNotePayload>(noteReportPath(note.id), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
      .then(() => setSent(true))
      .catch((caught: unknown) => {
        setFailure(describeFailure(caught, 'Could not send the report. Try again.'));
      })
      .finally(() => setSending(false));
  }

  function block(): void {
    if (blocking) return;
    setBlocking(true);
    setFailure(null);
    void apiFetch(memberBlockPath(authorId), { method: 'POST', credentials: 'include' })
      .then(() => {
        onDone();
        content.refreshNotes();
      })
      .catch((caught: unknown) => {
        setBlocking(false);
        setFailure(describeFailure(caught, 'Could not block this member. Try again.'));
      });
  }

  if (sent) {
    return (
      <div className={styles.moderation} role="group" aria-label="Report sent">
        <p className={styles.moderationTitle} role="status">
          {REPORT_TAKEN_MESSAGE}
        </p>
        <p className={styles.confirmText}>
          You will be told what they decide. If you would rather not see {note.authorDisplayName}
          ’s notes meanwhile, you can block them: {blockConsequence(note.authorDisplayName)}
        </p>
        {failure === null ? null : (
          <p className={styles.cardFailure} role="alert">
            {failure}
          </p>
        )}
        <div className={styles.composerActions}>
          <button className={styles.danger} type="button" disabled={blocking} onClick={block}>
            {blocking ? 'Blocking…' : `Block ${note.authorDisplayName}`}
          </button>
          <button className={styles.secondary} type="button" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className={styles.moderation}
      aria-label="Report this note"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <fieldset className={styles.reasonList} aria-describedby={legendId}>
        <legend className={styles.moderationTitle} id={legendId}>
          Why are you reporting this note?
        </legend>
        {REPORT_REASONS.map((one) => (
          <label className={styles.reasonOption} key={one}>
            <input
              type="radio"
              name={`report-reason-${note.id}`}
              value={one}
              checked={reason === one}
              onChange={() => setReason(one)}
            />
            {REPORT_REASON_LABEL[one]}
          </label>
        ))}
      </fieldset>

      <label className={styles.field} htmlFor={detailId}>
        <span className={styles.fieldLabel}>Anything an admin should know (optional)</span>
        <textarea
          className={styles.textArea}
          id={detailId}
          rows={2}
          maxLength={MAX_REPORT_DETAIL_LENGTH}
          value={detail}
          onChange={(event) => setDetail(event.target.value)}
        />
      </label>

      {failure === null ? null : (
        <p className={styles.cardFailure} role="alert">
          {failure}
        </p>
      )}

      <div className={styles.composerActions}>
        <button
          className={styles.primary}
          type="submit"
          disabled={reason === null || sending}
        >
          {sending ? 'Sending…' : 'Send report'}
        </button>
        <button className={styles.secondary} type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The block confirmation: the consequence in words, then Block or Cancel. It names the
 * consequence rather than restating the question, because what a member needs before this press
 * is to know what changes — and that it is undone from settings, so it is not a door that locks.
 */
export function BlockConfirm({
  note,
  authorId,
  onDone,
}: {
  note: NoteView;
  authorId: string;
  onDone: () => void;
}) {
  const content = useRecordingContent();
  const [blocking, setBlocking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  function block(): void {
    if (blocking) return;
    setBlocking(true);
    setFailure(null);
    void apiFetch(memberBlockPath(authorId), { method: 'POST', credentials: 'include' })
      .then(() => {
        onDone();
        content.refreshNotes();
      })
      .catch((caught: unknown) => {
        setBlocking(false);
        setFailure(describeFailure(caught, 'Could not block this member. Try again.'));
      });
  }

  return (
    <div className={styles.moderation} role="group" aria-label="Confirm block">
      <p className={styles.moderationTitle}>Block {note.authorDisplayName}?</p>
      <p className={styles.confirmText}>{blockConsequence(note.authorDisplayName)}</p>
      {failure === null ? null : (
        <p className={styles.cardFailure} role="alert">
          {failure}
        </p>
      )}
      <div className={styles.composerActions}>
        <button className={styles.danger} type="button" disabled={blocking} onClick={block}>
          {blocking ? 'Blocking…' : 'Block'}
        </button>
        <button className={styles.secondary} type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
