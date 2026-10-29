import { idbDelete, idbGet } from './idb';
import { ACTIVE_USER_KEY, OFFLINE_STORES, sessionMetaKey } from './schema';

/**
 * **Forget who was signed in on this device** — the sign-out half of the on-device database
 * (security audit of 28 October 2026, finding 11; `schema.ts` says what stays).
 *
 * Two `meta` facts go: the active-user marker, which is what makes the page answer anything
 * offline at all, and that account's kept session payload — name, role, avatar — which would
 * otherwise sit in IndexedDB for whoever opens the browser's storage next. Downloads, the outbox
 * and the pictures waiting with it stay, keyed under the account, by the operator's standing
 * decision: the member who returns finds their downloads, and nobody else's code path reads them
 * because the marker that names an account is gone.
 *
 * Best effort, like everything about sign-out on the client: a device without IndexedDB, or one
 * that refuses to open it, has nothing of this kind to forget. The caller never waits on a
 * failure here to finish signing out.
 */
export async function forgetActiveAccount(): Promise<void> {
  try {
    const active = await idbGet<{ userId: string | null }>(OFFLINE_STORES.meta, ACTIVE_USER_KEY);
    const userId = active?.userId ?? null;
    if (userId !== null) await idbDelete(OFFLINE_STORES.meta, sessionMetaKey(userId));
    await idbDelete(OFFLINE_STORES.meta, ACTIVE_USER_KEY);
  } catch {
    // No database, or one that will not open: nothing was kept, so nothing is left behind.
  }
}
