import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * **Every call to the object store goes through one module.**
 *
 * The same shape of rule as "the API reaches Postgres through one module" (tools/import-boundary.ts)
 * and "every outbound message goes through one module" (tools/mail-boundary.ts), and it exists for a
 * sharper reason than either. A second import of the S3 SDK is a second door to the bucket — one
 * that does not mint its key server-side, does not bind the grant to a content type, and, above
 * all, **is not constrained by an interface with no delete on it**. The one non-negotiable of this
 * epic (docs/project/prd.md, 3.4.9) is held by the shape of `MediaStore`, and that only means
 * anything while `MediaStore` is the only way to the store.
 *
 * One file is allowed to import the SDK, and it is the adapter. The port sits in front of it and is
 * what the rest of the application calls.
 *
 * **Amended in Story 2 Ticket 03.** The port and its adapter moved out of `packages/web` and into
 * `@thp/media`, because the worker has to read the original in order to transcribe it and cannot
 * import from the web app. Only the two paths below changed — the rule, and everything it holds,
 * is the same one.
 */

export interface MediaBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule: 'no-object-store-sdk';
}

/**
 * The SDKs that speak to an object store directly. `@aws-sdk/*` covers the S3 client and the
 * presigner; the rest are the other ways somebody would reach for a bucket.
 */
const OBJECT_STORE_LIBRARIES = [
  '@aws-sdk/client-s3',
  '@aws-sdk/s3-request-presigner',
  '@aws-sdk/lib-storage',
  'aws-sdk',
  'minio',
  '@google-cloud/storage',
];

/** The one file permitted to build a client, repo-relative and posix. */
export const MEDIA_ADAPTER_FILES: readonly string[] = [
  'packages/media/src/s3-store.ts',
];

/** The port. Read by {@link findDeleteOperations}, which is the other half of this guard. */
export const MEDIA_PORT_FILE = 'packages/media/src/store.ts';

const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

const SOURCE_DIRS: readonly string[] = [
  'packages/media/src',
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

export function checkMediaBoundary(
  repoRoot: string,
  allowedFiles: readonly string[] = MEDIA_ADAPTER_FILES,
  sourceDirs: readonly string[] = SOURCE_DIRS,
): MediaBoundaryViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const violations: MediaBoundaryViolation[] = [];

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
            if (OBJECT_STORE_LIBRARIES.some((name) => isPackage(specifier, name))) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: specifier,
                rule: 'no-object-store-sdk',
              });
            }
          }
        });
    }
  }

  return violations;
}

export function formatMediaBoundaryViolations(
  violations: readonly MediaBoundaryViolation[],
): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}

// ---------------------------------------------------------------------------------------------

/**
 * The members declared inside `interface MediaStore { … }`.
 *
 * Read off the source rather than off a value, because the property being guarded is a property of
 * the **type**: an adapter can only offer what the interface declares, so an interface with no
 * delete on it is what makes "the original is never deleted" unbuildable rather than merely
 * unwritten.
 */
export function portMembers(source: string): string[] {
  const start = source.indexOf('export interface MediaStore {');
  if (start < 0) throw new Error('media/store.ts declares no `export interface MediaStore`');

  let depth = 0;
  let end = -1;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) throw new Error('the MediaStore interface body is not closed');

  const body = source
    .slice(source.indexOf('{', start) + 1, end)
    // Comment bodies name the very words this looks for — the interface documents *why* there is no
    // delete — so they are stripped before the members are read.
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  // **Only the interface's own members.** An operation's argument is an inline object type, and its
  // fields are not members of the port — counting them would let a `deleteAfter` *parameter* fail
  // the guard and, worse, make the guard's own vocabulary depend on how an argument was spelled.
  const members: string[] = [];
  let nesting = 0;
  let statement = '';

  for (const character of body) {
    if (character === '{' || character === '(' || character === '[') nesting += 1;
    else if (character === '}' || character === ')' || character === ']') nesting -= 1;

    if (nesting === 0 && (character === ';' || character === '\n')) {
      const match = /(?:^|\s)(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[(?:]/.exec(statement);
      if (match?.[1] !== undefined) members.push(match[1]);
      statement = '';
      continue;
    }
    if (nesting >= 0) statement += character;
  }

  return members;
}

/** Members of the port whose name says it removes something. Must be empty. */
export function findDeleteOperations(source: string): string[] {
  return portMembers(source).filter((name) => /delete|remove|destroy|purge/i.test(name));
}
