'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  REPORTS_PATH,
  REPORT_REASON_LABEL,
  SOS_URGENCY_LABEL,
  recordingPagePath,
  reportResolvePath,
  sosPagePath,
  type ReportListPayload,
  type ReportOutcome,
  type ReportView,
  type ResolveReportPayload,
  type ResolveReportRequest,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './reports.module.css';

/**
 * The queue of open reports, and the two things an admin can do to each.
 *
 * A client module: it imports no server module, holds no database access, and calls the absolute
 * API origin like every other call the client makes. Four decisions worth stating:
 *
 * 1. **A row is the content as it reads now**, not as it read when reported — the API answers the
 *    current text, because what the admin is deciding about is what members can read today. A
 *    note already removed (by its author, or by an admin on the teaching), or a reply on a prayer
 *    request already removed, says so and offers only Dismiss: there is nothing left to remove.
 * 2. **Remove takes a confirming press; Dismiss does not.** The same line every panel draws: the
 *    direction that destroys something gets the second press. The confirmation says the removal is
 *    logged, as the note menu's does, because it is the same deletion.
 * 3. **One decision closes every report on the same thing.** The API resolves by subject; the row
 *    says how many reports were closed so an admin who saw three rows about one note understands
 *    why all three went.
 * 4. **The list rendered is the list the API answered**, after every action — never a row spliced
 *    out by hand — so two admins working the queue at once each see what the server now holds.
 *
 * Three kinds of content reach the queue — a note, a prayer request, a reply on a prayer request
 * ([3.16](docs/project/prd.md)) — and the row reads each in its own words: what it is, where it
 * is, and what Remove would remove. {@link subjectOf} is the one place those words are chosen.
 */

const WHEN = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatWhen(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : WHEN.format(parsed);
}

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

/** What one report is about, in the words the row prints — chosen once for the three kinds. */
interface Subject {
  /** `note`, `reply`, `prayer request` — the noun every sentence on the row uses. */
  readonly noun: string;
  /** The line beside the reason chip: the teaching's title, or the request's urgency. */
  readonly where: string;
  readonly text: string;
  readonly deleted: boolean;
  readonly authorDisplayName: string;
  readonly href: string;
  readonly hrefLabel: string;
}

function subjectOf(report: ReportView): Subject {
  if (report.kind === 'note') {
    return {
      noun: 'note',
      where: report.recordingTitle,
      text: report.noteText,
      deleted: report.noteDeleted,
      authorDisplayName: report.noteAuthorDisplayName,
      href: recordingPagePath(report.recordingId),
      hrefLabel: 'Open the recording',
    };
  }
  return {
    noun: report.kind === 'sos_reply' ? 'reply' : 'prayer request',
    where:
      report.kind === 'sos_reply'
        ? `Reply on a ${SOS_URGENCY_LABEL[report.urgency].toLowerCase()} prayer request`
        : `${SOS_URGENCY_LABEL[report.urgency]} prayer request`,
    text: report.text,
    deleted: report.deleted,
    authorDisplayName: report.authorDisplayName,
    href: sosPagePath(report.signalId),
    hrefLabel: 'Open the prayer request',
  };
}

/** `Reported by Ana on 5 Sept 2026, 10:12 · note by Ben`. */
export function describeReport(report: ReportView): string {
  const subject = subjectOf(report);
  return `Reported by ${report.reporterDisplayName} on ${formatWhen(report.createdAt)} · ${subject.noun} by ${subject.authorDisplayName}`;
}

/** `3 reports` / `1 report` — what a resolution says it closed. */
function reports(count: number): string {
  return `${count} report${count === 1 ? '' : 's'}`;
}

export function ReportsPanel() {
  const [open, setOpen] = useState<readonly ReportView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<ReportListPayload>(REPORTS_PATH, { credentials: 'include' });
      // Rendered in the order the API sent — oldest first, a queue — and never re-sorted here.
      setOpen(payload.reports);
      setListError(null);
    } catch (caught) {
      setOpen(null);
      setListError(describeFailure(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(report: ReportView, outcome: ReportOutcome): Promise<void> {
    if (busyId !== null) return;
    setBusyId(report.id);
    setFailure(null);
    setDone(null);
    const { noun } = subjectOf(report);
    const request: ResolveReportRequest = { outcome };
    try {
      const payload = await apiFetch<ResolveReportPayload>(reportResolvePath(report.id), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      setOpen(payload.reports);
      setConfirmingId(null);
      setDone(
        payload.closed === 0
          ? 'That report had already been resolved by another admin.'
          : payload.outcome === 'removed'
            ? `The ${noun} was removed and ${reports(payload.closed)} closed. The reporters have been told.`
            : `${reports(payload.closed)} dismissed. The reporters have been told the ${noun} stays.`,
      );
    } catch (caught) {
      setFailure(describeFailure(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="reports-heading">
        <div>
          <h2 className={styles.sectionTitle} id="reports-heading">
            Reports
          </h2>
          <p className={styles.sectionNote}>
            Notes, prayer requests and replies members have asked an admin to look at, oldest
            first. Dismissing leaves it up; removing deletes it the way Delete or Remove on the
            page does, and is logged. Either closes every open report on it and tells the people
            who reported it.
          </p>
        </div>

        {done === null ? null : (
          <p className={styles.done} role="status">
            {done}
          </p>
        )}
        {failure === null ? null : (
          <p className={styles.failure} role="alert">
            {failure}
          </p>
        )}

        {listError !== null ? (
          <p className={styles.failure} role="alert">
            {listError}
          </p>
        ) : open === null ? (
          <p className={styles.sectionNote}>Loading…</p>
        ) : open.length === 0 ? (
          <p className={styles.empty}>Nothing to review. New reports will appear here.</p>
        ) : (
          <ul className={styles.list} aria-label="Open reports">
            {open.map((report) => {
              const subject = subjectOf(report);
              return (
                <li className={styles.listRow} key={report.id}>
                  <div className={styles.rowIdentity}>
                    <p className={styles.rowName}>
                      <span className={styles.chip}>{REPORT_REASON_LABEL[report.reason]}</span>{' '}
                      {subject.where}
                    </p>
                    {subject.deleted ? (
                      <p className={styles.rowMeta}>This {subject.noun} has already been removed.</p>
                    ) : (
                      <blockquote className={styles.noteText}>{subject.text}</blockquote>
                    )}
                    {report.detail === null ? null : (
                      <p className={styles.rowBody}>“{report.detail}”</p>
                    )}
                    <p className={styles.rowMeta}>
                      {describeReport(report)} ·{' '}
                      <a className={styles.rowLink} href={subject.href}>
                        {subject.hrefLabel}
                      </a>
                    </p>
                  </div>

                  <div className={styles.rowControls}>
                    <button
                      className={styles.action}
                      type="button"
                      aria-label={`Dismiss the report by ${report.reporterDisplayName}`}
                      disabled={busyId !== null}
                      onClick={() => void resolve(report, 'dismissed')}
                    >
                      {busyId === report.id ? 'Working…' : 'Dismiss'}
                    </button>
                    {subject.deleted ? null : (
                      <button
                        className={styles.actionStrong}
                        type="button"
                        aria-label={`Remove the ${subject.noun} by ${subject.authorDisplayName}`}
                        disabled={busyId !== null}
                        onClick={() => setConfirmingId(report.id)}
                      >
                        Remove {subject.noun}
                      </button>
                    )}
                  </div>

                  {confirmingId === report.id ? (
                    <div className={styles.confirm} role="group" aria-label="Confirm removal">
                      <p className={styles.confirmText}>
                        Remove {subject.authorDisplayName}’s {subject.noun}? This can’t be undone,
                        the removal is logged, and every open report on it is closed.
                        {report.kind === 'sos_signal'
                          ? ' Its replies and everybody’s Praying go with it.'
                          : ''}
                      </p>
                      <div className={styles.confirmActions}>
                        <button
                          className={styles.actionStrong}
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void resolve(report, 'removed')}
                        >
                          {busyId === report.id ? 'Removing…' : 'Yes, remove it'}
                        </button>
                        <button
                          className={styles.action}
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => setConfirmingId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
