import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * **The client calls one absolute origin, read in one place, with no same-host fallback.**
 *
 * The same shape of rule as tools/import-boundary.ts and tools/asr-boundary.ts, and it holds the
 * property docs/project/prd.md 5.2.2 needs from this epic: a packaged build is *the same client
 * against the same contract*, and it cannot be if any part of the client can work out its API base
 * from the page it was served by. A Capacitor build is served from `capacitor://` or a local file,
 * and `location.origin` there is not an API.
 *
 * The rule has been true since the first ticket of the epic and was never enforced, because until
 * there was a real deployment there was nothing for a same-host assumption to break — development
 * serves the UI and the API from one Next process, so a fallback would have worked perfectly and
 * silently. Story 7 is where that stops being true, which is why the guard lands here rather than
 * with the code it guards.
 *
 * Two ways in, so two rules. A second module reading the variable is one — it duplicates the
 * "no default" decision, and the next person only fixes one copy. Deriving the origin from the
 * browser's location is the other, and it needs no variable at all.
 */

export interface OriginBoundaryViolation {
  /** Path relative to the directory the check was run against, in posix form. */
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule: 'no-second-origin-reader' | 'no-same-host-origin';
}

/** The environment variable the whole rule is about. */
export const ORIGIN_VARIABLE = 'NEXT_PUBLIC_API_ORIGIN';

/**
 * The two files permitted to read it, repo-relative and posix.
 *
 * `client/config.ts` is the client's one reader. `server/mail/env.ts` is the second, because an
 * invitation link needs an origin and must not build one from the request's `Host` header — the
 * comment there explains why that header is not usable. Two readers of one variable is the
 * deliberate maximum; a third is what this rule refuses.
 */
export const ORIGIN_READER_FILES = [
  'packages/web/src/client/config.ts',
  'packages/web/src/server/mail/env.ts',
];

/**
 * Ways to ask the browser where it was served from.
 *
 * `location.origin` is the obvious one; `location.host`, `location.hostname` and `document.baseURI`
 * are what a person reaches for once the obvious one is blocked. `location.search` and
 * `location.pathname` are deliberately absent — reading the current URL's query is ordinary client
 * work and says nothing about an API base.
 */
const SAME_HOST_SOURCES = [
  'location.origin',
  'location.host',
  'location.hostname',
  'document.baseURI',
];

/** Application source only. Tests legitimately set the variable and assert on it. */
const SOURCE_DIRS: readonly string[] = [
  'packages/web/src',
  'packages/worker/src',
  'packages/media/src',
  'packages/shared/src',
  'packages/db/src',
];

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

/**
 * Blank out comment bodies, keeping line numbers and offsets intact.
 *
 * The same helper the other boundary tools carry, and for the same reason: the modules this rule
 * covers *document* the variable in prose at length, and a rule that cannot tell documentation from
 * a read teaches people to delete the documentation.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) =>
      prefix + match.slice(prefix.length).replace(/./g, ' '),
    );
}

/**
 * Every violation of both rules.
 *
 * `allowedFiles` and `sourceDirs` are parameters rather than constants read directly, so a test can
 * drive the check with the exemption removed and against a fixture — a guard that cannot be made to
 * fail is not evidence of anything.
 */
export function checkOriginBoundary(
  repoRoot: string,
  allowedFiles: readonly string[] = ORIGIN_READER_FILES,
  sourceDirs: readonly string[] = SOURCE_DIRS,
): OriginBoundaryViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const violations: OriginBoundaryViolation[] = [];

  for (const dir of sourceDirs) {
    for (const file of walkFiles(resolve(root, dir))) {
      const relativeFile = toPosix(relative(root, file));

      withoutComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((text, index) => {
          if (!allowed.has(relativeFile) && text.includes(ORIGIN_VARIABLE)) {
            violations.push({
              file: relativeFile,
              line: index + 1,
              detail: ORIGIN_VARIABLE,
              rule: 'no-second-origin-reader',
            });
          }

          // Unlike the reader rule, this one has no exemption: the two permitted readers have no
          // more business deriving an origin from the page than anything else does.
          for (const source of SAME_HOST_SOURCES) {
            if (text.includes(source)) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: source,
                rule: 'no-same-host-origin',
              });
            }
          }
        });
    }
  }

  return violations;
}

export function formatOriginBoundaryViolations(
  violations: readonly OriginBoundaryViolation[],
): string {
  return violations
    .map(
      (violation) => `${violation.file}:${violation.line} — ${violation.rule} (${violation.detail})`,
    )
    .join('\n');
}
