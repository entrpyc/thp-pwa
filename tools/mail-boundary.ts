import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * **Every outbound message goes through one module.**
 *
 * The same shape of rule as "the API reaches Postgres through one module" (see
 * tools/import-boundary.ts), and it exists for the same reason. A second import of a mail library
 * is a second door to the outside world — one that does not log what it sent, does not turn a
 * delivery failure into a retryable refusal, and does not use the single configured sender address.
 *
 * One file is allowed to import the library, and it is the transports module. The mailer sits in
 * front of it and is what the rest of the application calls.
 */

export interface MailBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule: 'no-mail-library';
}

const MAIL_LIBRARIES = ['nodemailer', 'resend', '@sendgrid/mail', 'postmark', 'mailgun.js'];

/** The one file permitted to build a transport, repo-relative and posix. */
export const MAIL_TRANSPORT_FILES: readonly string[] = [
  'packages/web/src/server/mail/transports.ts',
];

const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

const SOURCE_DIRS: readonly string[] = [
  'packages/web/src',
  'packages/worker/src',
  'packages/shared/src',
  'packages/db/src',
];

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

export function checkMailBoundary(
  repoRoot: string,
  allowedFiles: readonly string[] = MAIL_TRANSPORT_FILES,
  sourceDirs: readonly string[] = SOURCE_DIRS,
): MailBoundaryViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const violations: MailBoundaryViolation[] = [];

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
            if (MAIL_LIBRARIES.some((name) => isPackage(specifier, name))) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: specifier,
                rule: 'no-mail-library',
              });
            }
          }
        });
    }
  }

  return violations;
}

export function formatMailBoundaryViolations(
  violations: readonly MailBoundaryViolation[],
): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}
