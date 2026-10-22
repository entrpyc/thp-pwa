'use client';

import { useParams, usePathname } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AnalyticsPerson } from '@thp/shared';
import { applyAnalyticsPreference, initAnalytics, track } from './analytics';
import { AnalyticsPreferenceContext } from './analytics-preference-context';
import { pageviewProperties, type RouteParams } from './route-pattern';

/**
 * **Mounts analytics for a signed-in member** (docs/project/observability.md § 6.3).
 *
 * In the member layout and nowhere else, so an admin console page sends nothing and the sign-in
 * page sends nothing. The layout already knows the actor server-side; handing in the person the
 * policy module built from it is what makes "identify at sign-in" the same thing as "identify
 * when the member surface mounts", with no second request.
 *
 * **The preference arrives with the person**, read off the same session the layout already has,
 * and is applied in the same effect that starts the SDK — before the page-view effect beneath it
 * runs, because effects in one component run in order. That is the whole of "opted out before any
 * event is sent, including on first paint after sign-in": nothing here asks the API what the
 * member decided, so there is no moment at which the answer is not yet known.
 *
 * The preference is then **state, not a prop**: the settings card changes it through the context
 * this provider publishes, the effect re-applies it, and capturing stops or resumes with no reload.
 * The prop seeds the state and is read once; after a change the server-rendered prop is stale
 * until the next full load, which then carries what the account holds.
 *
 * Page views are reported here, from the router, as the route pattern rather than the URL
 * (`route-pattern.ts`). The dependency is the pathname alone: the parameters for a pathname are
 * fixed, and keying on the params object would report a second view of the same page whenever
 * the router handed over a new object for it.
 */
export function AnalyticsProvider({
  person,
  optedOut: initialOptedOut,
  children,
}: {
  person: AnalyticsPerson;
  /** Whether the account has turned analytics off, as the session says. */
  optedOut: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const params = useParams() as RouteParams;
  const [optedOut, setOptedOut] = useState(initialOptedOut);

  useEffect(() => {
    if (initAnalytics()) applyAnalyticsPreference(person, optedOut);
    // The person is a fresh object on every server render; its account id is what identifies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person.accountId, optedOut]);

  useEffect(() => {
    const properties = pageviewProperties(pathname, params);
    if (properties !== null) track('$pageview', properties);
    // The params for a pathname do not change under it — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const preference = useMemo(() => ({ optedOut, setOptedOut }), [optedOut]);

  return (
    <AnalyticsPreferenceContext.Provider value={preference}>{children}</AnalyticsPreferenceContext.Provider>
  );
}
