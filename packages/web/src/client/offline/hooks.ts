'use client';

import { useSyncExternalStore } from 'react';
import { SERVER_SNAPSHOT, offlineManager, type OfflineSnapshot } from './manager';

/**
 * The manager's snapshot, for a component. Always {@link SERVER_SNAPSHOT} on the server and on
 * the first client render, so hydration cannot disagree with the markup — downloads can only
 * appear after the store has been read, which is after mount.
 */
export function useOffline(): OfflineSnapshot {
  return useSyncExternalStore(
    (listener) => offlineManager().subscribe(listener),
    () => offlineManager().getSnapshot(),
    () => SERVER_SNAPSHOT,
  );
}
