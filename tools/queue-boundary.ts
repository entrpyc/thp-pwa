import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * **The API enqueues through one module.**
 *
 * The same shape of rule as "every outbound message goes through one module"
 * (tools/mail-boundary.ts) and "every call to the object store goes through one module"
 * (tools/media-boundary.ts), and it exists for the reason those do: a second way into the `job`
 * table is a second way to write a row that does not carry the request's correlation id, does not
 * compute `attempt` inside the insert, and does not treat an already-unfinished step as a no-op.
 *
 * The ledger's queries live in `@thp/db` — the import-boundary guard already refuses `drizzle-orm`
 * inside `packages/web`, so a route cannot build its own statement. What remains, and what this
 * guard closes, is a route *calling the ledger's queries directly* instead of going through the
 * port. One file in `packages/web` is allowed to, and it is the queue adapter.
 *
 * **The worker is deliberately not covered.** It claims, runs and completes against `@thp/db`
 * directly; the port exists for the API's dispatch, not for the worker's reads
 * (core-listening scope tdd § Extension points, *Queue port*).
 */

export interface QueueBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule: 'no-ledger-access';
}

/** The one file permitted to call the ledger, repo-relative and posix. */
export const QUEUE_ADAPTER_FILES: readonly string[] = [
  'packages/web/src/server/jobs/postgres-queue.ts',
];

/** The port the rest of `packages/web` calls instead. */
export const QUEUE_PORT_FILE = 'packages/web/src/server/jobs/queue.ts';

/** Where the ledger's queries are declared. The forbidden names are read off it, not retyped. */
export const LEDGER_MODULE_FILE = 'packages/db/src/jobs.ts';

/** The database package, and the subpath that is the ledger module itself. */
const DATABASE_PACKAGE = '@thp/db';

/**
 * The ledger's exported functions, read from its source.
 *
 * **Derived rather than listed**, for the same reason tools/domain-declarations.ts imports its
 * member lists: a hand-maintained list of forbidden names is a list that goes stale the first time
 * a query is added, and it would go stale silently — the guard would keep passing.
 */
export function ledgerFunctions(source: string): string[] {
  return [...source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

/** `import { a, b } from 'x'` — bindings in group 1, specifier in group 2. */
const NAMED_IMPORT_PATTERN = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

/** Any import of a specifier, for the subpath rule. */
const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

const SOURCE_DIRS: readonly string[] = ['packages/web/src'];

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** `{ a, b as c, type D }` -> `['a', 'b', 'D']`. The local alias is not what is being guarded. */
function importedNames(clause: string): string[] {
  return clause
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '')
    .filter((name) => name.length > 0);
}

export function checkQueueBoundary(
  repoRoot: string,
  allowedFiles: readonly string[] = QUEUE_ADAPTER_FILES,
  sourceDirs: readonly string[] = SOURCE_DIRS,
): QueueBoundaryViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const forbidden = new Set(
    ledgerFunctions(readFileSync(resolve(root, LEDGER_MODULE_FILE), 'utf8')),
  );
  const violations: QueueBoundaryViolation[] = [];

  for (const dir of sourceDirs) {
    for (const file of walkFiles(resolve(root, dir))) {
      const relativeFile = toPosix(relative(root, file));
      if (allowed.has(relativeFile)) continue;

      const source = readFileSync(file, 'utf8');

      // A ledger query imported by name, however the import statement is wrapped.
      for (const match of source.matchAll(NAMED_IMPORT_PATTERN)) {
        const [, clause = '', specifier = ''] = match;
        if (specifier !== DATABASE_PACKAGE && !specifier.startsWith(`${DATABASE_PACKAGE}/`)) {
          continue;
        }
        for (const name of importedNames(clause)) {
          if (forbidden.has(name)) {
            violations.push({
              file: relativeFile,
              line: lineOf(source, match.index),
              detail: name,
              rule: 'no-ledger-access',
            });
          }
        }
      }

      // The ledger module and the schema, reached by subpath — a way round the name check.
      for (const match of source.matchAll(SPECIFIER_PATTERN)) {
        const specifier = match[1];
        if (specifier === `${DATABASE_PACKAGE}/jobs` || specifier === `${DATABASE_PACKAGE}/schema`) {
          violations.push({
            file: relativeFile,
            line: lineOf(source, match.index),
            detail: specifier,
            rule: 'no-ledger-access',
          });
        }
      }
    }
  }

  return violations;
}

export function formatQueueBoundaryViolations(
  violations: readonly QueueBoundaryViolation[],
): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}
