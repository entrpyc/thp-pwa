import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * **Every event to the analytics tool goes through one adapter per side.**
 *
 * The same shape of rule as tools/asr-boundary.ts, for the same two reasons. Swapping the tool is
 * one file (docs/project/observability.md § 2, § 9: PostHog is replaced by a home-grown events
 * table behind the same adapter). And the privacy rule in § 5.5 is only checkable while the
 * adapter is the only door: the sanitiser lives in it, and a second `posthog.capture` anywhere
 * else would be a send that nothing has looked at.
 *
 * Two ways in, both checked: importing an SDK, and naming the API host in a string.
 */

export interface AnalyticsBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule: 'no-analytics-sdk' | 'no-analytics-api';
}

/** SDKs that speak to a product-analytics tool. The candidates, not only the one in use. */
const ANALYTICS_LIBRARIES = [
  'posthog-js',
  'posthog-node',
  '@posthog/react',
  'mixpanel-browser',
  'mixpanel',
  '@amplitude/analytics-browser',
  '@amplitude/analytics-node',
  '@segment/analytics-next',
  '@segment/analytics-node',
  'analytics-node',
];

/** Hosts that are an analytics tool's API. A literal one of these is a second door. */
const ANALYTICS_API_HOSTS = [
  'i.posthog.com',
  'app.posthog.com',
  'api.mixpanel.com',
  'api2.amplitude.com',
  'api.segment.io',
];

/** The files permitted to name the tool, repo-relative and posix: one for the client, one for the server. */
export const ANALYTICS_ADAPTER_FILES: readonly string[] = [
  'packages/web/src/client/observability/analytics.ts',
  'packages/web/src/server/observability/analytics.ts',
];

/** The vocabulary the rest of the application speaks instead. */
export const ANALYTICS_VOCABULARY_FILE = 'packages/shared/src/observability/analytics.ts';

const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

const SOURCE_DIRS: readonly string[] = [
  'packages/worker/src',
  'packages/web/src',
  'packages/media/src',
  'packages/shared/src',
  'packages/db/src',
  'packages/bible/src',
];

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

/** Blank out comment bodies, keeping line numbers intact — see tools/asr-boundary.ts for why. */
function withoutComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) => prefix + blank(match.slice(prefix.length)));
}

export function checkAnalyticsBoundary(
  repoRoot: string,
  allowedFiles: readonly string[] = ANALYTICS_ADAPTER_FILES,
  sourceDirs: readonly string[] = SOURCE_DIRS,
): AnalyticsBoundaryViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const violations: AnalyticsBoundaryViolation[] = [];

  for (const dir of sourceDirs) {
    for (const file of walkFiles(resolve(root, dir))) {
      const relativeFile = toPosix(relative(root, file));
      if (allowed.has(relativeFile)) continue;

      withoutComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((text, index) => {
          for (const match of text.matchAll(SPECIFIER_PATTERN)) {
            const specifier = match[1];
            if (specifier === undefined) continue;
            if (ANALYTICS_LIBRARIES.some((name) => isPackage(specifier, name))) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: specifier,
                rule: 'no-analytics-sdk',
              });
            }
          }

          for (const host of ANALYTICS_API_HOSTS) {
            if (text.includes(host)) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: host,
                rule: 'no-analytics-api',
              });
            }
          }
        });
    }
  }

  return violations;
}

export function formatAnalyticsBoundaryViolations(
  violations: readonly AnalyticsBoundaryViolation[],
): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}
