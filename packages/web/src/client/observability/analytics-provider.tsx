'use client';

import { useParams, usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import type { AnalyticsPerson } from '@thp/shared';
import { identifyAnalytics, initAnalytics, track } from './analytics';
import { pageviewProperties, type RouteParams } from './route-pattern';

/**
 * **Mounts analytics for a signed-in member** (docs/project/observability.md § 6.3).
 *
 * In the member layout and nowhere else, so an admin console page sends nothing and the sign-in
 * page sends nothing. The layout already knows the actor server-side; handing in the person the
 * policy module built from it is what makes "identify at sign-in" the same thing as "identify
 * when the member surface mounts", with no second request.
 *
 * Page views are reported here, from the router, as the route pattern rather than the URL
 * (`route-pattern.ts`). The dependency is the pathname alone: the parameters for a pathname are
 * fixed, and keying on the params object would report a second view of the same page whenever
 * the router handed over a new object for it.
 */
export function AnalyticsProvider({
  person,
  children,
}: {
  person: AnalyticsPerson;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const params = useParams() as RouteParams;

  useEffect(() => {
    if (initAnalytics()) identifyAnalytics(person);
    // The person is a fresh object on every server render; its account id is what identifies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person.accountId]);

  useEffect(() => {
    const properties = pageviewProperties(pathname, params);
    if (properties !== null) track('$pageview', properties);
    // The params for a pathname do not change under it — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return <>{children}</>;
}
