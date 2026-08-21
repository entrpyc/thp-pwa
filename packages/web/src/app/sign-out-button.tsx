'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AUTH_SESSION_PATH } from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import styles from './home.module.css';

/**
 * Sign out.
 *
 * `DELETE /api/v1/auth/session` ends the session **server-side** and clears the cookie; the button
 * only asks. `router.replace` then `router.refresh()` drops the rendered authenticated view rather
 * than leaving it in the back/forward cache, which is what makes pressing back after signing out
 * show sign-in instead of a stale screen.
 */
export function SignOutButton() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function onClick(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await apiFetch(AUTH_SESSION_PATH, { method: 'DELETE', credentials: 'include' });
    } finally {
      router.replace('/sign-in');
      router.refresh();
    }
  }

  return (
    <button className={styles.signOut} type="button" onClick={onClick} disabled={signingOut}>
      {signingOut ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
