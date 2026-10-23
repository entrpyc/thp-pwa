'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  SOS_CARD_PREVIEW_COUNT,
  SOS_NEW_PAGE_PATH,
  SOS_PAGE_PATH,
  SOS_PATH,
  type SosListPayload,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { SignalRow } from './signal-row';
import styles from './sos.module.css';

/**
 * **The SOS card on the landing** ([3.16.4](docs/project/prd.md)) — the way into the channel.
 *
 * The three most urgent open requests are listed as rows, See all carries the open count, and
 * raising one is one press away — so a member who opens the app in a hard moment is not
 * three screens from asking. The title is drawn like the other card titles; the board is reached
 * through the "See all" line above the raise button.
 *
 * Drawn even when nothing is open: an emergency channel that only appears once somebody is in
 * trouble is one nobody knows is there.
 */
export function SosCard() {
  const [payload, setPayload] = useState<SosListPayload | null>(null);

  useEffect(() => {
    void apiFetch<SosListPayload>(SOS_PATH, { credentials: 'include' })
      .then(setPayload)
      .catch(() => setPayload(null));
  }, []);

  const preview = payload?.signals.slice(0, SOS_CARD_PREVIEW_COUNT) ?? [];
  const open = payload?.signals.length ?? 0;

  return (
    <section className={styles.card} aria-label="Prayer requests">
      <h2 className={styles.cardTitle}>Prayer requests</h2>

      {payload === null ? null : preview.length === 0 ? (
        <p className={styles.quiet}>No open prayer requests. Requests from the group appear here.</p>
      ) : (
        <ul className={styles.rows} aria-label="Most urgent open prayer requests">
          {preview.map((signal) => (
            <li className={styles.rowGroup} key={signal.id}>
              <SignalRow signal={signal} />
            </li>
          ))}
        </ul>
      )}

      <Link className={`${styles.cardAction} ${styles.cardActionSecondary}`} href={SOS_PAGE_PATH}>
        See all {open} prayer requests
      </Link>
      <Link className={`${styles.cardAction} ${styles.cardActionPrimary}`} href={SOS_NEW_PAGE_PATH}>
        Raise a prayer request
      </Link>
    </section>
  );
}
