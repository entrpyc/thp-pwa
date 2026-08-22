import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * **The member visibility condition is written once.**
 *
 * [3.1.2](docs/project/prd.md) and [3.2.2](docs/project/prd.md) between them say that a member sees
 * a teaching when it is published and never otherwise, and that the API is what enforces it. This
 * check makes "written once" a property something can fail on rather than something a reviewer has
 * to notice.
 *
 * The reason it exists is what comes next rather than what exists now. Story 4's library and
 * recording page, Story 5's player and transcript and Story 6's series listing are four more read
 * paths over the same rows, and a rule re-implemented per route is a rule that will be forgotten on
 * the fourth one — the failure being a teaching nobody published becoming readable, which is the
 * one failure this product cannot take back.
 *
 * **What is forbidden is a null *predicate* over a publication timestamp**, which is what a
 * visibility rule is made of: `isNull(...publishedAt)`, `isNotNull(...)`, or the SQL spelling of
 * either. Two things are deliberately not forbidden, because neither decides who may read a row:
 *
 * - **Writing one.** `setRecordingPublication` sets a timestamp; a control that publishes a
 *   teaching is not a rule about who sees it.
 * - **Rendering one.** A console printing *Published* or *Not published* beside a row is reading a
 *   field the API already decided to send it, and the client holds no decision
 *   ([3.1.5](docs/project/prd.md)).
 */

export interface VisibilityBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule: 'no-visibility-predicate';
}

/** The one module permitted to decide it, repo-relative and posix. */
export const VISIBILITY_MODULE_FILES: readonly string[] = ['packages/db/src/visibility.ts'];

/**
 * A null predicate over a publication timestamp, in either spelling this codebase writes queries
 * in — the Drizzle helper and raw SQL.
 */
const PREDICATE_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'isNull/isNotNull over publishedAt', pattern: /\bis(?:Not)?Null\s*\([^)]*[Pp]ublishedAt/ },
  { label: 'published_at is [not] null', pattern: /published_at\s+is\s+(?:not\s+)?null/i },
  { label: 'publishedAt is [not] null', pattern: /\bpublishedAt\}?\s+is\s+(?:not\s+)?null/i },
];

const SOURCE_DIRS: readonly string[] = [
  'packages/db/src',
  'packages/web/src',
  'packages/worker/src',
  'packages/shared/src',
];

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

/** Blank out comment bodies, keeping line numbers. Explaining the rule is not breaking it. */
function withoutComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) => prefix + blank(match.slice(prefix.length)));
}

export function checkVisibilityBoundary(
  repoRoot: string,
  allowedFiles: readonly string[] = VISIBILITY_MODULE_FILES,
  sourceDirs: readonly string[] = SOURCE_DIRS,
): VisibilityBoundaryViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const violations: VisibilityBoundaryViolation[] = [];

  for (const dir of sourceDirs) {
    for (const file of walkFiles(resolve(root, dir))) {
      const relativeFile = toPosix(relative(root, file));
      if (allowed.has(relativeFile)) continue;

      withoutComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((text, index) => {
          for (const { label, pattern } of PREDICATE_PATTERNS) {
            if (pattern.test(text)) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: label,
                rule: 'no-visibility-predicate',
              });
            }
          }
        });
    }
  }

  return violations;
}

export function formatVisibilityBoundaryViolations(
  violations: readonly VisibilityBoundaryViolation[],
): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}
