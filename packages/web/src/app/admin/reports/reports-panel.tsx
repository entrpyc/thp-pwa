'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  REPORTS_PATH,
  REPORT_REASON_LABEL,
  recordingPagePath,
  reportResolvePath,
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
 * 1. **A row is the note as it reads now**, not as it read when reported — the API answers the
 *    current text, because what the admin is deciding about is what members can read today. A
 *    note already removed (by its author, or by an admin on the teaching) says so, and offers only
 *    Dismiss: there is nothing left to remove.
 * 2. **Remove takes a confirming press; Dismiss does not.** The same line every panel draws: the
 *    direction that destroys something gets the second press. The confirmation says the removal is
 *    logged, as the note menu's does, because it is the same deletion.
 * 3. **One decision closes every report on the note.** The API resolves by note; the row says how
 *    many reports were closed so an admin who saw three rows about one note understands why all
 *    three went.
 * 4. **The list rendered is the list the API answered**, after every action — never a row spliced
 *    out by hand — so two admins working the queue at once each see what the server now holds.
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

/** `Reported by Ana on 5 Sept 2026, 10:12 · note by Ben`. */
export function describeReport(report: ReportView): string {
  return `Reported by ${report.reporterDisplayName} on ${formatWhen(report.createdAt)} · note by ${report.noteAuthorDisplayName}`;
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
            ? `The note was removed and ${reports(payload.closed)} closed. The reporters have been told.`
            : `${reports(payload.closed)} dismissed. The reporters have been told the note stays.`,
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
            Notes members have asked an admin to look at, oldest first. Dismissing leaves the note
            up; removing deletes it the way Delete in the note menu does, and is logged. Either
            closes every open report on that note and tells the people who reported it.
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
            {open.map((report) => (
              <li className={styles.listRow} key={report.id}>
                <div className={styles.rowIdentity}>
                  <p className={styles.rowName}>
                    <span className={styles.chip}>{REPORT_REASON_LABEL[report.reason]}</span>{' '}
                    {report.recordingTitle}
                  </p>
                  {report.noteDeleted ? (
                    <p className={styles.rowMeta}>This note has already been removed.</p>
                  ) : (
                    <blockquote className={styles.noteText}>{report.noteText}</blockquote>
                  )}
                  {report.detail === null ? null : (
                    <p className={styles.rowBody}>“{report.detail}”</p>
                  )}
                  <p className={styles.rowMeta}>
                    {describeReport(report)} ·{' '}
                    <a className={styles.rowLink} href={recordingPagePath(report.recordingId)}>
                      Open the recording
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
                  {report.noteDeleted ? null : (
                    <button
                      className={styles.actionStrong}
                      type="button"
                      aria-label={`Remove the note by ${report.noteAuthorDisplayName}`}
                      disabled={busyId !== null}
                      onClick={() => setConfirmingId(report.id)}
                    >
                      Remove note
                    </button>
                  )}
                </div>

                {confirmingId === report.id ? (
                  <div className={styles.confirm} role="group" aria-label="Confirm removal">
                    <p className={styles.confirmText}>
                      Remove {report.noteAuthorDisplayName}’s note? This can’t be undone, the
                      removal is logged, and every open report on it is closed.
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
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
