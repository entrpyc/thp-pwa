import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { onboardingPagePath } from '@thp/shared';
import { currentActor } from '@/server/auth/current-actor';
import { pendingOnboardingFor } from '@/server/onboarding/completion';
import { analyticsPerson, can } from '@/server/auth/policy';
import { AccountProvider } from '@/client/account/account-context';
import { AnalyticsProvider } from '@/client/observability/analytics-provider';
import { OfflineBanner } from './downloads/offline-banner';
import { OfflineStatus } from './downloads/offline-status';
import { NotificationsProvider } from './notifications-context';
import { PlayerProvider } from './player-context';
import { PushShellListener } from './push-shell-listener';
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

  // An account that has never been through the new-user onboarding is routed into it before the
  // member surface renders — on every launch, not only at sign-in, so closing the tab mid-tour
  // resumes it next visit. A rendering decision like the session check above it: the completion
  // that ends the redirect is recorded by an API route that refuses independently, and
  // `/onboarding` lives outside this layout, so the redirect cannot chase itself.
  const pendingOnboarding = await pendingOnboardingFor(actor.id);
  if (pendingOnboarding !== null) redirect(onboardingPagePath(pendingOnboarding));

  return (
    // Outermost, because the player underneath it reports plays and the pages report views, and
    // the member surface is the only surface that reports anything (observability.md § 6.3). What
    // crosses this line is what the policy module says analytics may know; the e-mail is not in it.
    // The preference crosses with it, off the same row, so the client knows before its first event.
    <AnalyticsProvider person={analyticsPerson(actor)} optedOut={actor.analyticsOptedOut}>
      {/* The account id, for client code that keys device storage by account (the note draft). */}
      <AccountProvider userId={actor.id}>
      <PlayerProvider initialSpeed={actor.preferredPlaybackSpeed}>
        {/*
          Inside the player rather than around it, because it is the smaller thing: the bell and the
          centre read it, and nothing about playback does. It is here rather than in the navigation
          so the centre — a page under this layout — reads the same list the bell counts from.
        */}
        <NotificationsProvider>
          {/* Inside the notifications provider because a push arriving in the open app refreshes
              the bell. Mounts nothing outside a store shell. */}
          <PushShellListener />
          <div className={styles.screen}>
            <div className={styles.shell}>
              <TopNavigation canSeeConsole={can(actor, 'account.list')} />
              {/* The download notices (3.18.16), floating under the bar; also what keys downloads to this account. */}
              <OfflineStatus userId={actor.id} />
              <main className={styles.content}>{children}</main>
            </div>
            {/* The bottom chrome: the transport, and under it the offline and pending-sync banner (3.18.16). */}
            <div className={styles.bottomRegion}>
              <TransportBar />
              <OfflineBanner />
            </div>
          </div>
        </NotificationsProvider>
      </PlayerProvider>
      </AccountProvider>
    </AnalyticsProvider>
  );
}
