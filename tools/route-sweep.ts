import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * The route sweep.
 *
 * "Every `/api/v1` route requires a session" (docs/prd.md, 3.1.2) is only worth stating if
 * something can fail on it. This module **discovers** routes from the filesystem — every
 * `route.ts` under the API tree, every HTTP method it exports — rather than reading a list somebody
 * maintains, because a hand-maintained list re-introduces exactly the review dependency the
 * requirement removes: a route added without a session is also a route nobody remembered to add to
 * the list.
 *
 * The only list involved is the allowlist of routes that are *deliberately* unauthenticated, which
 * the sweep subtracts before asserting that everything left refuses an anonymous caller.
 */

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface DiscoveredRoute {
  readonly method: HttpMethod;
  /** The URL path to probe, with dynamic segments filled in. */
  readonly path: string;
  /** Repo-relative posix path of the `route.ts` that declares it. */
  readonly file: string;
  /** True when the path came from a catch-all, so it stands in for "any unclaimed path". */
  readonly isCatchAll: boolean;
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function routeFiles(dir: string): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeFiles(full));
    else if (entry === 'route.ts' || entry === 'route.tsx') found.push(full);
  }
  return found;
}

/**
 * `export const GET = …`, `export async function POST(…)`, `export { unmatched as PUT }` — all
 * three forms, because missing one would silently shrink the sweep to the routes written in the
 * style we happened to think of.
 */
export function exportedMethods(source: string): HttpMethod[] {
  return HTTP_METHODS.filter((method) => {
    const patterns = [
      new RegExp(String.raw`export\s+(?:const|let|var)\s+${method}\b`),
      new RegExp(String.raw`export\s+(?:async\s+)?function\s+${method}\b`),
      new RegExp(String.raw`export\s*\{[^}]*\bas\s+${method}\b[^}]*\}`, 's'),
      new RegExp(String.raw`export\s*\{[^}]*\b${method}\b[^}]*\}`, 's'),
    ];
    return patterns.some((pattern) => pattern.test(source));
  });
}

/** Every route the app serves under `apiRoot`, as (method, probe path) pairs. */
export function discoverRoutes(appDir: string, apiRoot: string, repoRoot: string): DiscoveredRoute[] {
  const root = resolve(appDir, apiRoot);
  const discovered: DiscoveredRoute[] = [];

  for (const file of routeFiles(root)) {
    const source = readFileSync(file, 'utf8');
    const segments = toPosix(relative(resolve(appDir), file)).split('/').slice(0, -1);

    let isCatchAll = false;
    const parts = segments.map((segment) => {
      if (/^\[\[?\.\.\..+?\]?\]$/.test(segment)) {
        isCatchAll = true;
        // Stands in for any path no route claims — which is itself a case the sweep must cover.
        return 'sweep-unclaimed-path';
      }
      if (/^\[.+\]$/.test(segment)) return 'sweep-probe-value';
      return segment;
    });

    for (const method of exportedMethods(source)) {
      discovered.push({
        method,
        path: `/${parts.join('/')}`,
        file: toPosix(relative(resolve(repoRoot), file)),
        isCatchAll,
      });
    }
  }

  return discovered.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

export interface ProbeResult {
  readonly status: number;
  readonly code: string | null;
  /** False for `HEAD`, which carries no body and therefore cannot carry an error envelope. */
  readonly hasBody: boolean;
}

export interface SweepViolation {
  readonly route: DiscoveredRoute;
  readonly reason: 'answered-anonymously' | 'wrong-refusal-code';
  readonly detail: string;
}

export interface SweepOptions {
  readonly routes: readonly DiscoveredRoute[];
  /** `(method, path)` pairs deliberately outside the rule. Subtracted before anything is asserted. */
  readonly isAllowlisted: (method: string, path: string) => boolean;
  readonly probe: (route: DiscoveredRoute) => Promise<ProbeResult>;
  /** The code an anonymous caller must get. */
  readonly expectedCode: string;
  /** The status that goes with it, for the bodiless `HEAD` case. */
  readonly expectedStatus: number;
}

/**
 * Probe every non-allowlisted route anonymously and report the ones that did not refuse.
 *
 * A route that answers anything other than the unauthenticated envelope is a violation — including
 * `not_found`, because an anonymous caller learning that a path does not exist is an anonymous
 * caller mapping the API.
 */
export async function sweepAnonymousAccess(options: SweepOptions): Promise<SweepViolation[]> {
  const violations: SweepViolation[] = [];

  for (const route of options.routes) {
    if (options.isAllowlisted(route.method, route.path)) continue;
    const result = await options.probe(route);

    if (result.code === options.expectedCode) continue;
    // A HEAD response has no body to read the code out of, so its status is the whole answer.
    if (!result.hasBody && result.status === options.expectedStatus) continue;
    violations.push({
      route,
      reason: result.status < 400 ? 'answered-anonymously' : 'wrong-refusal-code',
      detail: `status ${result.status}, code ${result.code ?? '(none)'}`,
    });
  }

  return violations;
}

export function formatSweepViolations(violations: readonly SweepViolation[]): string {
  return violations
    .map((v) => `${v.route.method} ${v.route.path}  [${v.reason}]  ${v.detail}  (${v.route.file})`)
    .join('\n');
}
