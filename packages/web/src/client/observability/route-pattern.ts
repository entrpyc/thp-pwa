import { ANALYTICS_ROUTES, type AnalyticsProperties, type AnalyticsRoute } from '@thp/shared';

/**
 * **A page view names the page, never the URL** (docs/project/observability.md § 5.2, § 5.5).
 *
 * The app router hands a client component the pathname with the ids in it and, separately, the
 * route parameters by name. Putting the names back where the values are gives the pattern the
 * page file has — `/recordings/[id]/chapters/[chapterId]` — which is what "how often is the
 * recording page visited" needs and all a URL may carry. The id a page is about travels beside
 * it as its own property, so "how often is *this* recording's page visited" is the same event
 * with a breakdown.
 */

export type RouteParams = Readonly<Record<string, string | readonly string[] | undefined>>;

export function routePattern(pathname: string, params: RouteParams): string {
  const byValue = new Map<string, string>();
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string' && value !== '') byValue.set(value, `[${name}]`);
  }
  const segments = pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => byValue.get(decodeURIComponent(segment)) ?? segment);
  return `/${segments.join('/')}`;
}

export function isAnalyticsRoute(pattern: string): pattern is AnalyticsRoute {
  return (ANALYTICS_ROUTES as readonly string[]).includes(pattern);
}

/**
 * The `$pageview` properties for a navigation, or `null` for a page the vocabulary does not name
 * — which sends nothing, rather than a view of an unnamed page.
 */
export function pageviewProperties(
  pathname: string,
  params: RouteParams,
): AnalyticsProperties<'$pageview'> | null {
  const route = routePattern(pathname, params);
  if (!isAnalyticsRoute(route)) return null;
  const id = typeof params['id'] === 'string' ? params['id'] : null;
  return {
    route,
    recording_id: route.startsWith('/recordings/[id]') ? id : null,
    series_id: route === '/series/[id]' ? id : null,
  };
}
