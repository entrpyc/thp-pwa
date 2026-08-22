'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AUTH_SESSION_PATH } from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import styles from './sign-out.module.css';

/**
 * Sign out.
 *
 * `DELETE /api/v1/auth/session` ends the session **server-side** and clears the cookie; the button
 * only asks. `router.replace` then `router.refresh()` drops the rendered authenticated view rather
 * than leaving it in the back/forward cache, which is what makes pressing back after signing out
 * show sign-in instead of a stale screen.
 *
 * It has two homes and therefore no opinion about how it looks: the console header, and the member
 * navigation menu that Story 4 Ticket 01 gave it. `className` is what each of those passes, and the
 * outlined shape here is the fallback for a caller that passes nothing.
 */
export function SignOutButton({ className }: { className?: string | undefined }) {
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
    <button
      className={className ?? styles.signOut}
      type="button"
      onClick={onClick}
      disabled={signingOut}
    >
      {signingOut ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
