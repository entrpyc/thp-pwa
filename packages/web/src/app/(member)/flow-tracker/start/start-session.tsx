'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  FLOW_SESSIONS_PATH,
  FLOW_TEACHINGS_PATH,
  FLOW_TRACKER_PAGE_PATH,
  flowSessionPagePath,
  type FlowSessionPayload,
  type FlowTeachingsPayload,
  type StartFlowSessionRequest,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail } from '../../player-context';
import { formatDay, plural } from '../format';
import styles from '../flow-tracker.module.css';

/**
 * **The start screen** ([3.14.2](docs/project/prd.md)): every published teaching, newest first,
 * each a press that picks it as the point of divergence. Above the list, what the pick covers —
 * how many teachings from there to the latest, and how many questions — and *Start*.
 *
 * **The count is computed here from what the API listed**, because it is a sum over a pick the
 * member has not made yet: the questions of every teaching at or above the picked one, plus one
 * per bank question of every tag those teachings carry, each tag once ([3.14.3](docs/project/prd.md)).
 *
 * A start refused because a session is already in progress says so and offers the way to it rather
 * than a dead end ([3.14.10](docs/project/prd.md)).
 */

const LOAD_FAILED = 'Could not load the teachings. Reload the page to try again.';
const START_FAILED = 'Could not start the session. Check your connection and try again.';

export function StartSession() {
  useBreadcrumbTrail('Start', [{ label: 'Flow Tracker', href: FLOW_TRACKER_PAGE_PATH }]);
  const router = useRouter();
  const [payload, setPayload] = useState<FlowTeachingsPayload | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [inProgress, setInProgress] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiFetch<FlowTeachingsPayload>(FLOW_TEACHINGS_PATH, { credentials: 'include' })
      .then((answer) => {
        setPayload(answer);
        setFailure(null);
      })
      .catch((caught: unknown) => {
        setPayload(null);
        setFailure(caught instanceof ApiClientError ? caught.message : LOAD_FAILED);
      });
  }, []);

  /** What the pick covers: the teachings from the top of the list down to it, and their questions. */
  const covered = useMemo(() => {
    if (payload === null || picked === null) return null;
    const at = payload.teachings.findIndex((one) => one.id === picked);
    if (at < 0) return null;
    const range = payload.teachings.slice(0, at + 1);
    const tagIds = new Set(range.flatMap((one) => one.tagIds));
    let questions = range.reduce((sum, one) => sum + one.questionCount, 0);
    for (const tagId of tagIds) questions += payload.tagQuestionCounts[tagId] ?? 0;
    return { teachings: range.length, questions };
  }, [payload, picked]);

  async function start(): Promise<void> {
    if (picked === null || busy) return;
    setBusy(true);
    setFailure(null);
    setInProgress(false);
    const body: StartFlowSessionRequest = { divergenceRecordingId: picked };
    try {
      const answer = await apiFetch<FlowSessionPayload>(FLOW_SESSIONS_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      router.push(flowSessionPagePath(answer.session.id));
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'flow_session_in_progress') {
        setInProgress(true);
      } else {
        setFailure(caught instanceof ApiClientError ? caught.message : START_FAILED);
      }
      setBusy(false);
    }
  }

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Where do you want to start from?</h1>
        <p className={styles.pageLead}>
          Pick a teaching to examine yourself from. You will be asked about every part of the
          teaching from the latest one back to it.
        </p>
      </header>

      <section className={styles.card} aria-label="Pick a teaching">
        {payload === null && failure === null ? (
          <p className={styles.quiet} role="status">
            Loading…
          </p>
        ) : null}

        {payload !== null && payload.teachings.length === 0 ? (
          <p className={styles.quiet}>There are no teachings to start from yet.</p>
        ) : null}

        {payload !== null && payload.teachings.length > 0 ? (
          <div className={styles.startFoot}>
            <p className={styles.progress} role="status">
              {covered === null
                ? 'Pick a teaching to see what the session covers.'
                : `${plural(covered.teachings, 'teaching')} · ${plural(covered.questions, 'question')}`}
            </p>
            <button
              className={styles.primary}
              type="button"
              disabled={picked === null || busy}
              onClick={() => void start()}
            >
              {busy ? 'Starting…' : 'Start'}
            </button>
          </div>
        ) : null}

        {payload !== null && payload.teachings.length > 0 ? (
          <ol className={styles.rows} aria-label="Teachings, newest first">
            {payload.teachings.map((teaching) => (
              <li className={styles.rowGroup} key={teaching.id}>
                <button
                  className={styles.pick}
                  type="button"
                  aria-pressed={picked === teaching.id}
                  onClick={() => setPicked(teaching.id)}
                >
                  {teaching.series?.artworkUrl == null ? null : (
                    <img className={styles.rowCover} src={teaching.series.artworkUrl} alt="" />
                  )}
                  <span className={styles.rowText}>
                    <span className={styles.rowTitle}>{teaching.title}</span>
                    <span className={styles.rowMeta}>
                      {teaching.series === null ? '' : `${teaching.series.title} · `}
                      {formatDay(teaching.recordedAt)}
                      {teaching.questionCount === 0 ? ' · no questions yet' : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        ) : null}

        {inProgress ? (
          <p className={styles.failure} role="alert">
            You already have a session in progress.{' '}
            <Link className={styles.textLink} href={FLOW_TRACKER_PAGE_PATH}>
              Continue it, or abandon it first.
            </Link>
          </p>
        ) : null}
        {failure === null ? null : (
          <p className={styles.failure} role="alert">
            {failure}
          </p>
        )}
      </section>
    </>
  );
}
