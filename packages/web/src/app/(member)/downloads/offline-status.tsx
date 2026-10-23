'use client';

import { useEffect } from 'react';
import { offlineManager } from '@/client/offline/manager';
import { useOffline } from '@/client/offline/hooks';
import styles from './downloads.module.css';

/**
 * **The offline and pending-sync strip** ([3.18.16](docs/project/prd.md)), and the one place the
 * manager learns who is signed in.
 *
 * Mounted once in the member layout with the actor's id, which is what keys every download and
 * every outbox entry on this device to an account (the operator's decision: downloads survive
 * sign-out, scoped to the account). Drawn only while there is something to say — offline, a sync
 * pending or running, a queue transferring, or a notice the member has to see — so the ordinary
 * connected screen is unchanged.
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
  if (!offline.online) {
    lines.push({
      key: 'offline',
      text:
        offline.downloads.length === 0
          ? 'You are offline. Nothing is downloaded on this device yet.'
          : 'You are offline. Showing your downloaded teachings.',
    });
  }
  if (offline.syncing) {
    lines.push({ key: 'syncing', text: 'Syncing what you did offline…' });
  } else if (offline.pending > 0) {
    lines.push({
      key: 'pending',
      text: `${offline.pending} ${offline.pending === 1 ? 'change' : 'changes'} waiting to sync${offline.online ? '' : ' when you are back online'}.`,
    });
  }
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
    <div className={styles.status} role="status" aria-live="polite" aria-label="Offline status">
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
  );
}
