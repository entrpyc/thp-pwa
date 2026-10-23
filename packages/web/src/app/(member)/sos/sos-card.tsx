'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  SOS_CARD_PREVIEW_COUNT,
  SOS_NEW_PAGE_PATH,
  SOS_PAGE_PATH,
  SOS_PATH,
  SOS_URGENCIES,
  SOS_URGENCY_LABEL,
  type SosListPayload,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { SignalRow } from './signal-row';
import { UrgencyDot } from './urgency-dot';
import styles from './sos.module.css';

/**
 * **The SOS card on the landing** ([3.16.4](docs/project/prd.md)) — the way into the channel.
 *
 * Four chips say how many signals are open at each colour, the three most urgent are listed as
 * rows, and Raise SOS is one press away — so a member who opens the app in a hard moment is not
 * three screens from asking. The card title opens the board.
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
    <section className={styles.card} aria-label="SOS">
      <div className={styles.boardHead}>
        <h2 className={styles.cardTitle}>
          <Link className={styles.wayIn} href={SOS_PAGE_PATH}>
            SOS
          </Link>
        </h2>
        <Link className={styles.primary} href={SOS_NEW_PAGE_PATH}>
          Raise SOS
        </Link>
      </div>

      {payload === null ? null : (
        <ul className={styles.chips} aria-label="Open signals by urgency">
          {SOS_URGENCIES.map((urgency) => (
            <li className={styles.chip} key={urgency}>
              <UrgencyDot urgency={urgency} />
              <span>{SOS_URGENCY_LABEL[urgency]}</span>
              <span className={styles.chipCount}>{payload.openCounts[urgency]}</span>
            </li>
          ))}
        </ul>
      )}

      {payload === null ? null : preview.length === 0 ? (
        <p className={styles.quiet}>No open signals. Prayer requests from the group appear here.</p>
      ) : (
        <ul className={styles.rows} aria-label="Most urgent open signals">
          {preview.map((signal) => (
            <li className={styles.rowGroup} key={signal.id}>
              <SignalRow signal={signal} />
            </li>
          ))}
        </ul>
      )}

      {open > SOS_CARD_PREVIEW_COUNT ? (
        <Link className={styles.wayIn} href={SOS_PAGE_PATH}>
          All {open} open signals →
        </Link>
      ) : null}
    </section>
  );
}
