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
import { useBreadcrumbTrail, useTransportHidden } from '../../player-context';
import { formatDay, plural } from '../format';
import styles from '../flow-tracker.module.css';

/**
 * **The start screen** ([3.14.2](docs/project/prd.md)): every published teaching, newest first,
 * each a press that picks it — or unpicks it — for the session. One or several. Under the list,
 * what the pick covers — how many teachings and how many questions — then *Start*.
 *
 * **The count is computed here from what the API listed**, because it is a sum over a pick the
 * member has not confirmed yet: the questions of every picked teaching, plus one per bank question
 * of every tag those teachings carry, each tag once ([3.14.3](docs/project/prd.md)).
 *
 * The transport stays out of sight while this screen is up: the screen is a choice about one's own
 * reflection, and a row of playback controls under it is a distraction rather than a tool.
 *
 * A start refused because a session is already in progress says so and offers the way to it rather
 * than a dead end ([3.14.10](docs/project/prd.md)).
 */

const LOAD_FAILED = 'Could not load the teachings. Reload the page to try again.';
const START_FAILED = 'Could not start the session. Check your connection and try again.';

export function StartSession() {
  useBreadcrumbTrail('Start', [{ label: 'Flow Tracker', href: FLOW_TRACKER_PAGE_PATH }]);
  useTransportHidden(true);
  const router = useRouter();
  const [payload, setPayload] = useState<FlowTeachingsPayload | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
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

  function toggle(id: string): void {
    setPicked((before) => {
      const after = new Set(before);
      if (after.has(id)) after.delete(id);
      else after.add(id);
      return after;
    });
  }

  /** What the pick covers: the picked teachings and their questions, each tag's bank once. */
  const covered = useMemo(() => {
    if (payload === null || picked.size === 0) return null;
    const chosen = payload.teachings.filter((one) => picked.has(one.id));
    const tagIds = new Set(chosen.flatMap((one) => one.tagIds));
    let questions = chosen.reduce((sum, one) => sum + one.questionCount, 0);
    for (const tagId of tagIds) questions += payload.tagQuestionCounts[tagId] ?? 0;
    return { teachings: chosen.length, questions };
  }, [payload, picked]);

  async function start(): Promise<void> {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    setFailure(null);
    setInProgress(false);
    const body: StartFlowSessionRequest = { recordingIds: [...picked] };
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
        <h1 className={styles.pageTitle}>Which teachings will you introspect on?</h1>
        <p className={styles.pageLead}>
          Pick one or more. You will be asked about every part of each teaching you pick, and
          nothing else.
        </p>
      </header>

      <section className={styles.card} aria-label="Pick teachings">
        {payload === null && failure === null ? (
          <p className={styles.quiet} role="status">
            Loading…
          </p>
        ) : null}

        {payload !== null && payload.teachings.length === 0 ? (
          <p className={styles.quiet}>There are no teachings to pick from yet.</p>
        ) : null}

        {payload !== null && payload.teachings.length > 0 ? (
          <ol className={styles.rows} aria-label="Teachings, newest first">
            {payload.teachings.map((teaching) => (
              <li className={styles.rowGroup} key={teaching.id}>
                <button
                  className={styles.pick}
                  type="button"
                  aria-pressed={picked.has(teaching.id)}
                  onClick={() => toggle(teaching.id)}
                >
                  <span className={styles.pickMark} aria-hidden="true">
                    {picked.has(teaching.id) ? '✓' : ''}
                  </span>
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

        {payload !== null && payload.teachings.length > 0 ? (
          <div className={styles.startFoot}>
            <p className={styles.progress} role="status">
              {covered === null
                ? 'Pick at least one teaching to see what the session covers.'
                : `${plural(covered.teachings, 'teaching')} · ${plural(covered.questions, 'question')}`}
            </p>
            <button
              className={styles.primary}
              type="button"
              disabled={picked.size === 0 || busy}
              onClick={() => void start()}
            >
              {busy ? 'Starting…' : 'Start'}
            </button>
          </div>
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
