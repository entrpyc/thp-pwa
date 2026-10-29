'use client';

import { useId, useState } from 'react';
import {
  MAX_REPORT_DETAIL_LENGTH,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  SOS_REPORT_TAKEN_MESSAGE,
  memberBlockPath,
  sosReportPath,
  type ReportPayload,
  type ReportReason,
  type ReportSosRequest,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from '../sos.module.css';

/**
 * **Report and Block on a prayer request and on its replies** (Apple guideline 1.2, Google Play's
 * UGC policy) — the note menu's two entries (`note-moderation.tsx`), drawn for the SOS channel
 * ([3.16](docs/project/prd.md)), where a request and a reply are posts the whole group reads.
 *
 * The same shape and the same rules: both act on an author the API named, both call routes that
 * refuse independently of anything drawn here, and neither hides anything on its own. A report is
 * a request to an admin; the way to stop seeing somebody is Block, which the report's thank-you
 * offers as the next press. Blocking is followed by whatever the page does when a member is no
 * longer visible to it — the board, for a request's author; a re-read, for a reply's — because
 * the block predicate on the server is what makes their posts leave, and nothing here filters a
 * row.
 *
 * An anonymous request ([3.16.13](docs/project/prd.md)) names nobody, so it can be reported but
 * not blocked: the view offers Block only where the author has an id.
 */

/** What is being reported or blocked: whose post, and which — the request itself, or one reply. */
export interface SosModerationSubject {
  readonly signalId: string;
  /** The reply, or null for the request itself. */
  readonly replyId: string | null;
  readonly authorId: string;
  readonly authorDisplayName: string;
}

function describeFailure(caught: unknown, fallback: string): string {
  return caught instanceof ApiClientError ? caught.message : fallback;
}

/** `Block Ana?` and the consequence, spelled once for the confirmation and the offer. */
function blockConsequence(displayName: string): string {
  return `You and ${displayName} will no longer see each other's prayer requests, replies or notes, and neither of you can reply or react to the other. You can unblock from Profile › Settings.`;
}

/**
 * The report form: a reason from the shared list, an optional sentence, and Send. On success the
 * same panel becomes the thank-you, with Block offered beside Done where there is somebody to
 * block.
 */
export function SosReportForm({
  subject,
  onDone,
  onBlocked,
}: {
  subject: SosModerationSubject;
  onDone: () => void;
  onBlocked: () => void;
}) {
  const legendId = useId();
  const detailId = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const what = subject.replyId === null ? 'prayer request' : 'reply';

  function send(): void {
    if (reason === null || sending) return;
    setSending(true);
    setFailure(null);
    const request: ReportSosRequest = {
      reason,
      detail: detail.trim() === '' ? null : detail.trim(),
      replyId: subject.replyId,
    };
    void apiFetch<ReportPayload>(sosReportPath(subject.signalId), {
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
    void apiFetch(memberBlockPath(subject.authorId), { method: 'POST', credentials: 'include' })
      .then(() => {
        onDone();
        onBlocked();
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
          {SOS_REPORT_TAKEN_MESSAGE}
        </p>
        <p className={styles.confirmText}>
          You will be told what they decide. If you would rather not see{' '}
          {subject.authorDisplayName}’s posts meanwhile, you can block them:{' '}
          {blockConsequence(subject.authorDisplayName)}
        </p>
        {failure === null ? null : (
          <p className={styles.failure} role="alert">
            {failure}
          </p>
        )}
        <div className={styles.actions}>
          <button className={styles.danger} type="button" disabled={blocking} onClick={block}>
            {blocking ? 'Blocking…' : `Block ${subject.authorDisplayName}`}
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
      aria-label={`Report this ${what}`}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <fieldset className={styles.reasonList} aria-describedby={legendId}>
        <legend className={styles.moderationTitle} id={legendId}>
          Why are you reporting this {what}?
        </legend>
        {REPORT_REASONS.map((one) => (
          <label className={styles.reasonOption} key={one}>
            <input
              type="radio"
              name={`sos-report-reason-${subject.replyId ?? subject.signalId}`}
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
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      )}

      <div className={styles.actions}>
        <button className={styles.primary} type="submit" disabled={reason === null || sending}>
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
 * The block confirmation: the consequence in words, then Block or Cancel — the note menu's, for
 * the same reason: what a member needs before this press is to know what changes, and that it is
 * undone from settings.
 */
export function SosBlockConfirm({
  subject,
  onDone,
  onBlocked,
}: {
  subject: SosModerationSubject;
  onDone: () => void;
  onBlocked: () => void;
}) {
  const [blocking, setBlocking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  function block(): void {
    if (blocking) return;
    setBlocking(true);
    setFailure(null);
    void apiFetch(memberBlockPath(subject.authorId), { method: 'POST', credentials: 'include' })
      .then(() => {
        onDone();
        onBlocked();
      })
      .catch((caught: unknown) => {
        setBlocking(false);
        setFailure(describeFailure(caught, 'Could not block this member. Try again.'));
      });
  }

  return (
    <div className={styles.moderation} role="group" aria-label="Confirm block">
      <p className={styles.moderationTitle}>Block {subject.authorDisplayName}?</p>
      <p className={styles.confirmText}>{blockConsequence(subject.authorDisplayName)}</p>
      {failure === null ? null : (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      )}
      <div className={styles.actions}>
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
