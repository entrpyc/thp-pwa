'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  FLOW_SESSIONS_PATH,
  FLOW_TRACKER_START_PAGE_PATH,
  flowSessionAbandonPath,
  flowSessionPagePath,
  type FlowSessionPayload,
  type FlowSessionSummary,
  type FlowSessionsPayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail } from '../player-context';
import { formatDay, listTitles, plural } from './format';
import styles from './flow-tracker.module.css';

/**
 * **The Flow Tracker's page** ([3.14.10](docs/project/prd.md)).
 *
 * Three states, one card: a session in progress with a *Continue* control and how far it has got;
 * no session, with a *Start* control; and beneath either, the completed sessions by date, each a
 * row that opens its reading list. Starting another while one is in progress is offered here as
 * *Start over*, which asks before abandoning — the one press on this page that loses anything.
 *
 * **It reads what the API answers and decides nothing.** Which session is in progress, which
 * teachings it covers, how many questions it holds and how many gaps a completed one found are
 * the server's words and counts.
 */

const LOAD_FAILED = 'Could not load your Flow Tracker. Reload the page to try again.';

export function FlowHome() {
  useBreadcrumbTrail('Flow Tracker');
  const [sessions, setSessions] = useState<FlowSessionsPayload | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSessions(await apiFetch<FlowSessionsPayload>(FLOW_SESSIONS_PATH, { credentials: 'include' }));
      setFailure(null);
    } catch (caught) {
      setSessions(null);
      setFailure(caught instanceof ApiClientError ? caught.message : LOAD_FAILED);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function abandon(active: FlowSessionSummary): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch<FlowSessionPayload>(flowSessionAbandonPath(active.id), {
        method: 'POST',
        credentials: 'include',
      });
      setConfirming(false);
      await load();
    } catch (caught) {
      setFailure(caught instanceof ApiClientError ? caught.message : LOAD_FAILED);
    } finally {
      setBusy(false);
    }
  }

  const active = sessions?.active ?? null;

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Flow Tracker</h1>
        <p className={styles.pageLead}>
          Examine yourself against the teachings. Pick teachings, reflect on each part, and see how
          well you are living it out rather than keeping it as information. Only you can see this.
        </p>
      </header>

      <section className={styles.card} aria-label="Your session">
        {sessions === null && failure === null ? (
          <p className={styles.quiet} role="status">
            Loading…
          </p>
        ) : null}

        {active !== null ? (
          <>
            <h2 className={styles.cardTitle}>Session in progress</h2>
            <p className={styles.pageLead}>
              {plural(active.teachingCount, 'teaching')}:{' '}
              <strong>{listTitles(active.teachings.map((one) => one.title))}</strong>
            </p>
            <p className={styles.progress}>
              {active.answeredCount} of {plural(active.questionCount, 'question')} answered
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} href={flowSessionPagePath(active.id)}>
                Continue
              </Link>
              {confirming ? null : (
                <button
                  className={styles.secondary}
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  Start over
                </button>
              )}
            </div>
            {confirming ? (
              <div className={styles.failure} role="alertdialog" aria-label="Abandon this session?">
                <p className={styles.pageLead}>
                  Abandon this session? The {plural(active.answeredCount, 'answer')} you have given
                  so far are set aside and will not appear in your past sessions.
                </p>
                <div className={styles.actions}>
                  <button
                    className={styles.primary}
                    type="button"
                    disabled={busy}
                    onClick={() => void abandon(active)}
                  >
                    {busy ? 'Abandoning…' : 'Yes, abandon it'}
                  </button>
                  <button
                    className={styles.secondary}
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                  >
                    Keep going
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {sessions !== null && active === null ? (
          <>
            <h2 className={styles.cardTitle}>Introspection</h2>
            <p className={styles.pageLead}>
              You will pick the teachings to introspect on, then answer one short question about
              each part of the teachings — not whether you remember it, but how well you are living
              it out. There is no score. What you get is a list of the parts you might want to
              focus on.
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} href={FLOW_TRACKER_START_PAGE_PATH}>
                Start
              </Link>
            </div>
          </>
        ) : null}

        {failure === null ? null : <p className={styles.failure}>{failure}</p>}
      </section>

      {sessions !== null && sessions.completed.length > 0 ? (
        <section className={styles.card} aria-label="Past sessions">
          <h2 className={styles.cardTitle}>Past sessions</h2>
          <ol className={styles.rows} aria-label="Completed sessions">
            {sessions.completed.map((one) => (
              <li className={styles.rowGroup} key={one.id}>
                <Link className={styles.sessionRow} href={flowSessionPagePath(one.id)}>
                  <span className={styles.rowText}>
                    <span className={styles.rowTitle}>
                      {one.completedAt === null ? 'Completed' : formatDay(one.completedAt)}
                    </span>
                    <span className={styles.rowMeta}>
                      {listTitles(one.teachings.map((teaching) => teaching.title))} ·{' '}
                      {plural(one.teachingCount, 'teaching')} · {plural(one.gapCount, 'part')} to focus
                      on
                    </span>
                  </span>
                  <span className={styles.rowChevron} aria-hidden="true">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}
