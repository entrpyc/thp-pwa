import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ADMIN_PAGE_PATH } from '@thp/shared';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { SignOutButton } from './sign-out-button';
import styles from './home.module.css';

export const dynamic = 'force-dynamic';

/**
 * The authenticated landing. Step 2 owns getting a person in and out, not what they see once they
 * are in — `pages/dashboard.png` replaces this whole screen in a later step.
 *
 * No session means sign-in, on the server, before anything renders.
 *
 * The console link is here because the console has to be reachable without typing a URL, and every
 * navigation this product will actually have — the top navigation in `top-navigation/` — belongs to
 * a later step and carries no admin entry to extend. So the link is deliberately temporary: it
 * lives on the placeholder and it goes when the placeholder does. It is rendered from the policy
 * module's answer rather than from a role read here, and it grants nothing — `/admin` gates itself
 * server-side, and every route behind it refuses independently.
 */
export default async function Home() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>Signed in as {actor.displayName}</h1>
        <p className={styles.meta}>{actor.email}</p>
        {can(actor, 'account.list') ? (
          <Link className={styles.consoleLink} href={ADMIN_PAGE_PATH}>
            Admin console
          </Link>
        ) : null}
        <SignOutButton />
      </div>
    </main>
  );
}
