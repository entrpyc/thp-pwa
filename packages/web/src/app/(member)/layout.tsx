import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { PlayerProvider } from './player-context';
import { TopNavigation } from './top-navigation';
import { TransportBar } from './transport-bar';
import styles from './member.module.css';

export const dynamic = 'force-dynamic';

/**
 * **The member surface** — the landing, the library and the recording page, under one chrome.
 *
 * A route group rather than a path segment: `/`, `/recordings` and `/recordings/{id}` are the URLs a
 * member sees, and `(member)` exists only so the three share a layout. Sharing it is not cosmetic —
 * the layout is what keeps the `<audio>` element mounted across client-side navigation, which is
 * what makes playback survive going back to the library mid-teaching.
 *
 * **No session means sign-in, on the server, before anything renders.** That is a rendering
 * decision and not an authorisation one: every row these screens show comes from an API route that
 * refuses independently ([3.1.5](docs/project/prd.md)).
 *
 * `can(actor, 'account.list')` decides whether the menu offers the console. It grants nothing —
 * `/admin` gates itself and every route behind it refuses on its own.
 */
export default async function MemberLayout({ children }: { children: ReactNode }) {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');

  return (
    <PlayerProvider initialSpeed={actor.preferredPlaybackSpeed}>
      <div className={styles.screen}>
        <div className={styles.shell}>
          <TopNavigation canSeeConsole={can(actor, 'account.list')} />
          <main className={styles.content}>{children}</main>
        </div>
        <TransportBar />
      </div>
    </PlayerProvider>
  );
}
