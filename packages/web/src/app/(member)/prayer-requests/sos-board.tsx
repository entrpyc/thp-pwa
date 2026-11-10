'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  SOS_NEW_PAGE_PATH,
  SOS_PATH,
  SOS_STATUSES,
  SOS_STATUS_PARAM,
  type SosListPayload,
  type SosStatus,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail } from '../player-context';
import { SignalRow } from './signal-row';
import styles from './sos.module.css';

/**
 * **The SOS board** ([3.16.4](docs/project/prd.md), [3.16.10](docs/project/prd.md)) — every open
 * signal, most urgent and most recent first, and behind a second tab every signal that has been
 * resolved, kept rather than deleted.
 *
 * Two tabs and one list rather than two lists: a member comes here for what is open now, and the
 * resolved ones are a record to look back on, not a second feed. Each tab is its own read — the
 * API answers one status at a time. The four counts by colour are the home card's; here the list
 * speaks for itself, and the way to raise one is a full-width button between the tabs and it.
 */

const STATUS_LABEL: Record<SosStatus, string> = { open: 'Open', resolved: 'Resolved' };

export function SosBoard() {
  useBreadcrumbTrail('Prayer requests');
  const [status, setStatus] = useState<SosStatus>('open');
  const [payload, setPayload] = useState<SosListPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stale = false;
    setFailed(false);
    void apiFetch<SosListPayload>(`${SOS_PATH}?${SOS_STATUS_PARAM}=${status}`, {
      credentials: 'include',
    })
      .then((answer) => {
        if (!stale) setPayload(answer);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [status]);

  const listed = payload !== null && payload.status === status ? payload.signals : null;

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Prayer requests</h1>
        <p className={styles.pageLead}>
          A prayer emergency channel. Anyone can reach the whole group, and the group can respond.
        </p>
      </header>

      <div className={styles.tabs} role="tablist" aria-label="Prayer requests">
        {SOS_STATUSES.map((one) => (
          <button
            key={one}
            className={styles.tab}
            type="button"
            role="tab"
            aria-selected={status === one}
            onClick={() => setStatus(one)}
          >
            {STATUS_LABEL[one]}
          </button>
        ))}
      </div>

      <Link className={`${styles.cardAction} ${styles.cardActionPrimary}`} href={SOS_NEW_PAGE_PATH}>
        Raise a prayer request
      </Link>

      {failed && listed === null ? (
        <p className={styles.failure} role="alert">
          Could not load the prayer requests. Reload the page to try again.
        </p>
      ) : listed === null ? (
        <p className={styles.quiet}>Loading…</p>
      ) : listed.length === 0 ? (
        <p className={styles.quiet}>
          {status === 'open'
            ? 'No open prayer requests. When somebody raises one, it will be listed here.'
            : 'Nothing has been resolved yet.'}
        </p>
      ) : (
        <ul className={styles.rows} aria-label={`${STATUS_LABEL[status]} prayer requests`}>
          {listed.map((signal) => (
            <li className={styles.rowGroup} key={signal.id}>
              <SignalRow signal={signal} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
