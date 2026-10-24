'use client';

import { useEffect } from 'react';
import { offlineManager } from '@/client/offline/manager';
import { useOffline } from '@/client/offline/hooks';
import styles from './downloads.module.css';

/**
 * **The download notices** ([3.18.16](docs/project/prd.md)), and the one place the manager learns
 * who is signed in.
 *
 * Mounted once in the member layout with the actor's id, which is what keys every download and
 * every outbox entry on this device to an account (the operator's decision: downloads survive
 * sign-out, scoped to the account).
 *
 * What it draws **floats directly under the navigation bar** and stays there while the page
 * scrolls, by the operator's decision — it was a strip at the top of the page, and a download
 * started from a long recording page was out of sight the moment the member read on. Two kinds of
 * line, drawn only while there is one to draw: the queue's progress while teachings transfer, and
 * a notice the member has to see and dismiss. Being offline and a sync pending are not said here;
 * `OfflineBanner` says those under the transport at the other edge.
 */
export function OfflineStatus({ userId }: { userId: string }) {
  const offline = useOffline();
  const manager = offlineManager();

  useEffect(() => {
    void manager.activate(userId);
  }, [manager, userId]);

  // Flushing when the app comes back to the foreground: `online` does not fire for a phone that
  // kept its radio but lost the app, and the member is looking at the screen right now.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void manager.flush();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [manager]);

  const lines: { key: string; text: string; dismiss?: () => void }[] = [];
  if (offline.overall.remaining > 0) {
    lines.push({
      key: 'queue',
      text: `Downloading ${offline.overall.remaining} ${offline.overall.remaining === 1 ? 'teaching' : 'teachings'} · ${Math.round(offline.overall.fraction * 100)}%`,
    });
  }
  for (const notice of offline.notices) {
    lines.push({ key: `notice-${notice.id}`, text: notice.text, dismiss: () => manager.dismissNotice(notice.id) });
  }

  if (lines.length === 0) return null;

  return (
    <div className={styles.notices}>
      <div className={styles.status} role="status" aria-live="polite" aria-label="Download status">
        {lines.map((line) => (
          <p className={styles.statusLine} key={line.key}>
            <span>{line.text}</span>
            {line.dismiss === undefined ? null : (
              <button className={styles.dismiss} type="button" onClick={line.dismiss}>
                Dismiss
              </button>
            )}
          </p>
        ))}
      </div>
    </div>
  );
}
