'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AUTH_SESSION_PATH, type SessionPayload, type SessionUser } from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { NameCard } from './name-card';
import { PictureCard } from './picture-card';
import styles from './profile.module.css';

/**
 * **The identity page** — a picture and a name, each saved on its own.
 *
 * Two cards rather than one form, because they are two writes with two different shapes: the name
 * is a `PATCH` of one field, and the picture is the cover's three-step upload with the bytes going
 * straight to the store. A single Save that did both would have to answer "which half failed", and
 * a member who has just typed their name should not lose it because a picture was refused. Each
 * card is its own file — `picture-card.tsx`, `name-card.tsx` — and this is the one thing they
 * share: the session user they both render from and both write back to.
 *
 * What the page renders from is the session user the API answered with, not a prop: every write
 * answers with the whole user, and the page adopts that answer — so what is painted after a save is
 * what the server stored, and never what the client hoped. The heading and the section strip above
 * these cards are the profile layout's, so every section under `/profile` shares them.
 */
export function ProfilePanel() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    void apiFetch<SessionPayload>(AUTH_SESSION_PATH, { credentials: 'include' })
      .then((payload) => setUser(payload.user))
      .catch(() => setLoadFailed(true));
  }, []);

  /*
   * The layout rendered the transport bar and the menu from the actor it read server-side, and
   * the admin console prints the name from the same read. A refresh after a write is what brings
   * those into step with what this screen has just been told.
   */
  function adopt(next: SessionUser): void {
    setUser(next);
    router.refresh();
  }

  return (
    <>
      <p className={styles.pageLead}>The name others see on your notes, and the picture beside it.</p>

      {loadFailed ? (
        <p className={styles.failure} role="alert">
          Could not load your profile. Reload the page to try again.
        </p>
      ) : user === null ? (
        <p className={styles.quiet}>Loading…</p>
      ) : (
        <>
          <PictureCard user={user} onChanged={adopt} />
          <NameCard user={user} onChanged={adopt} />
        </>
      )}
    </>
  );
}
