import { readFileSync } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

export interface BoundaryViolation {
  /** Path relative to the directory the check was run against, in posix form. */
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule:
    | 'no-database-package'
    | 'no-database-driver'
    | 'no-server-module'
    | 'no-node-builtin'
    | 'no-hardcoded-api-path';
}

const DATABASE_PACKAGES = ['@thp/db'];
const DATABASE_DRIVERS = ['postgres', 'pg', 'pg-native', 'drizzle-orm', 'drizzle-kit'];

/** `import x from 'y'`, `export * from 'y'`, `import('y')`, `require('y')` — specifier in group 1 or 2. */
const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

/**
 * Blank out comment bodies, keeping line numbers and offsets intact.
 *
 * A doc comment that *names* an API path is documentation, not a hardcoded path, and a rule that
 * cannot tell the two apart teaches people to stop writing the documentation rather than to stop
 * hardcoding the path.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) =>
      prefix + match.slice(prefix.length).replace(/./g, ' '),
    );
}

/**
 * A client module is anything under `src/client/`, plus any file anywhere in the app that opts into
 * the browser with a `'use client'` directive. Scoping it to a folder alone would leave the rule
 * trivially side-steppable.
 */
export function collectClientFiles(srcDir: string): string[] {
  return walkFiles(srcDir).filter((file) => {
    if (toPosix(file).includes('/src/client/')) return true;
    const head = readFileSync(file, 'utf8').slice(0, 200);
    return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(head);
  });
}

/**
 * The import-boundary guard. A client module may not reach a server module, the database package or
 * a database driver, and may not hardcode the API path against the current host — it calls an
 * absolute origin read from configuration.
 *
 * Returns every violation it finds; an empty array is a pass.
 */
export function checkClientBoundary(srcDir: string, files?: readonly string[]): BoundaryViolation[] {
  const root = resolve(srcDir);
  const targets = files ?? collectClientFiles(root);
  const violations: BoundaryViolation[] = [];

  for (const file of targets) {
    const source = withoutComments(readFileSync(file, 'utf8'));
    const relativeFile = toPosix(relative(root, file));
    const lines = source.split('\n');

    lines.forEach((text, index) => {
      const lineNumber = index + 1;

      for (const match of text.matchAll(SPECIFIER_PATTERN)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        const rule = classify(specifier, file, root);
        if (rule) violations.push({ file: relativeFile, line: lineNumber, detail: specifier, rule });
      }

      if (/['"`][^'"`]*\/api\/v1/.test(text) && !text.includes('API_PREFIX')) {
        violations.push({
          file: relativeFile,
          line: lineNumber,
          detail: text.trim(),
          rule: 'no-hardcoded-api-path',
        });
      }
    });
  }

  return violations;
}

function classify(
  specifier: string,
  fromFile: string,
  root: string,
): BoundaryViolation['rule'] | null {
  if (DATABASE_PACKAGES.some((name) => isPackage(specifier, name))) return 'no-database-package';
  if (DATABASE_DRIVERS.some((name) => isPackage(specifier, name))) return 'no-database-driver';
  if (specifier.startsWith('node:')) return 'no-node-builtin';
  if (specifier === '@/server' || specifier.startsWith('@/server/')) return 'no-server-module';

  if (specifier.startsWith('.')) {
    const fromDir = toPosix(fromFile).split('/').slice(0, -1).join('/');
    const resolved = posix.normalize(posix.join(fromDir, specifier));
    const rootPosix = toPosix(root);
    const withinSrc = resolved.startsWith(rootPosix)
      ? resolved.slice(rootPosix.length)
      : resolved;
    if (withinSrc.startsWith('/server/') || withinSrc === '/server') return 'no-server-module';
  }

  return null;
}

/**
 * The API reaches Postgres through **one** module. Anything outside `packages/db` that imports a
 * driver directly has opened a second door — connection pooling, migrations and the health check
 * all stop meaning what they say the moment that happens.
 */
export function checkSingleDatabaseModule(
  repoRoot: string,
  sourceDirs: readonly string[] = ['packages/web/src', 'packages/worker/src', 'packages/shared/src'],
): BoundaryViolation[] {
  const root = resolve(repoRoot);
  const violations: BoundaryViolation[] = [];

  for (const dir of sourceDirs) {
    for (const file of walkFiles(resolve(root, dir))) {
      const relativeFile = toPosix(relative(root, file));
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((text, index) => {
          for (const match of text.matchAll(SPECIFIER_PATTERN)) {
            const specifier = match[1];
            if (specifier === undefined) continue;
            if (DATABASE_DRIVERS.some((name) => isPackage(specifier, name))) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: specifier,
                rule: 'no-database-driver',
              });
            }
          }
        });
    }
  }

  return violations;
}

export function formatViolations(violations: readonly BoundaryViolation[]): string {
  return violations
    .map((violation) => `${violation.file}:${violation.line}  [${violation.rule}]  ${violation.detail}`)
    .join('\n');
}

/**
 * **The worker imports nothing from the API.**
 *
 * The two processes share a database and a vocabulary, and nothing else. A worker that reached into
 * `packages/web` would be a worker that could only run where Next can run, that would pull the
 * request-scoped machinery of a server it is not part of, and that would make "which process does
 * this belong to" a question about imports rather than about folders. What they are allowed to
 * share is `@thp/shared` (the vocabulary and the log shape) and `@thp/db` (the one door to
 * Postgres) — both of which the worker reaches by package name.
 */
export function checkWorkerBoundary(
  repoRoot: string,
  sourceDirs: readonly string[] = ['packages/worker/src'],
): BoundaryViolation[] {
  const root = resolve(repoRoot);
  const violations: BoundaryViolation[] = [];

  for (const dir of sourceDirs) {
    for (const file of walkFiles(resolve(root, dir))) {
      const relativeFile = toPosix(relative(root, file));
      withoutComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((text, index) => {
          for (const match of text.matchAll(SPECIFIER_PATTERN)) {
            const specifier = match[1];
            if (specifier === undefined) continue;
            // `@/…` is the API's own alias; a relative path out of the package reaches the same
            // place by another name; `next` is the framework the worker is not part of.
            const reachesWeb =
              specifier === '@' ||
              specifier.startsWith('@/') ||
              specifier.includes('packages/web') ||
              isPackage(specifier, 'next') ||
              isPackage(specifier, 'react');
            if (reachesWeb) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: specifier,
                rule: 'no-server-module',
              });
            }
          }
        });
    }
  }

  return violations;
}
