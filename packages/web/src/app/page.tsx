import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { SignOutButton } from './sign-out-button';
import styles from './home.module.css';

export const dynamic = 'force-dynamic';

/**
 * The authenticated landing. Step 2 owns getting a person in and out, not what they see once they
 * are in — `pages/dashboard.png` replaces this whole screen in a later step.
 *
 * No session means sign-in, on the server, before anything renders.
 */
export default async function Home() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>Signed in as {actor.displayName}</h1>
        <p className={styles.meta}>{actor.email}</p>
        <SignOutButton />
      </div>
    </main>
  );
}
