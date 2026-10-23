import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * **Every push goes through one module.**
 *
 * The shape of tools/mail-boundary.ts, for the reason it gives: a second import of a push library
 * — or a second hand-rolled call to Apple's or Google's endpoint — is a second door to the outside
 * world, one that skips the preference rule, the dead-subscription removal and the log line. One
 * file is allowed to import the Web Push library, and one each to name the APNs and FCM hosts;
 * the dispatcher sits in front of all three and is what the application calls.
 */

export interface PushBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule: 'no-push-library' | 'no-push-host';
}

const PUSH_LIBRARIES = ['web-push', 'firebase-admin', '@parse/node-apn', 'apn', 'node-pushnotifications'];

/** The provider hosts, so a fetch written around the package is caught as surely as an import. */
const PUSH_HOSTS = ['api.push.apple.com', 'api.sandbox.push.apple.com', 'fcm.googleapis.com'];

/** The files permitted to reach a provider, repo-relative and posix. */
export const PUSH_TRANSPORT_FILES: readonly string[] = [
  'packages/push/src/web-push.ts',
  'packages/push/src/apns.ts',
  'packages/push/src/fcm.ts',
];

const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

const SOURCE_DIRS: readonly string[] = [
  'packages/web/src',
  'packages/worker/src',
  'packages/shared/src',
  'packages/db/src',
  'packages/push/src',
];

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

export function checkPushBoundary(
  repoRoot: string,
  allowedFiles: readonly string[] = PUSH_TRANSPORT_FILES,
  sourceDirs: readonly string[] = SOURCE_DIRS,
): PushBoundaryViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const violations: PushBoundaryViolation[] = [];

  for (const dir of sourceDirs) {
    for (const file of walkFiles(resolve(root, dir))) {
      const relativeFile = toPosix(relative(root, file));
      if (allowed.has(relativeFile)) continue;

      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((text, index) => {
          for (const match of text.matchAll(SPECIFIER_PATTERN)) {
            const specifier = match[1];
            if (specifier === undefined) continue;
            if (PUSH_LIBRARIES.some((name) => isPackage(specifier, name))) {
              violations.push({ file: relativeFile, line: index + 1, detail: specifier, rule: 'no-push-library' });
            }
          }
          for (const host of PUSH_HOSTS) {
            if (text.includes(host)) {
              violations.push({ file: relativeFile, line: index + 1, detail: host, rule: 'no-push-host' });
            }
          }
        });
    }
  }

  return violations;
}

export function formatPushBoundaryViolations(violations: readonly PushBoundaryViolation[]): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}
