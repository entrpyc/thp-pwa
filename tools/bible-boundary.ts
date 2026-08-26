import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * **Every call to a Bible text source goes through one module.**
 *
 * The same shape of rule as "every call to the transcription provider goes through one module"
 * (tools/asr-boundary.ts) and "every call to the generation provider goes through one module"
 * (tools/generate-boundary.ts), and it exists for the reason those do:
 * scope prd 3.3.7 says which translation a deployment publishes is *its* answer
 * rather than a change of code, and scope prd 3.3.5 says a source that is down
 * degrades to citations without text rather than failing anything. Neither survives a second door —
 * one that reads no configuration, has no timeout, and throws where the port promises not to.
 *
 * Two ways to reach a source, and both are checked. **Importing a client library**, which is what
 * the mail and media guards look for; and **naming the source's HTTP shape**, which the ASR guard
 * also has to look for because a plain `GET` needs no dependency — it needs a string. Here the
 * string is not only a host: the base URL is configuration, so what identifies the source in code
 * is *the shape of the document it serves*, and that is what a second door would have to restate.
 */

export interface BibleBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule: 'no-bible-sdk' | 'no-bible-api';
}

/** Client libraries for a Bible text source. The candidates, not only the one in use. */
const BIBLE_LIBRARIES = [
  '@gracious.tech/fetch-client',
  'bible-api',
  'scripture-api-bible',
  'youversion',
  'bible-passage-reference-parser',
];

/**
 * What naming a Bible source looks like in code: a host that is one, or the shape of the document
 * one serves. `.simple.json` is the Free Use Bible API's plain-text chapter format and is the whole
 * of what the adapter knows about the wire — so a second file containing it is a second file that
 * has decided how to talk to the source.
 */
const BIBLE_API_MARKERS = [
  'bible.helloao.org',
  'scripture.api.bible',
  'bible-api.com',
  'api.esv.org',
  'api.biblia.com',
  'bolls.life',
  '.simple.json',
];

/** The one file permitted to name the source, repo-relative and posix. */
export const BIBLE_ADAPTER_FILES: readonly string[] = ['packages/bible/src/free-use.ts'];

/** The port the rest of the application calls instead. */
export const BIBLE_PORT_FILE = 'packages/bible/src/source.ts';

const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

const SOURCE_DIRS: readonly string[] = [
  'packages/bible/src',
  'packages/worker/src',
  'packages/web/src',
  'packages/media/src',
  'packages/shared/src',
  'packages/db/src',
];

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

/**
 * Blank out comment bodies, keeping line numbers intact.
 *
 * A doc comment explaining *why* one file may name the source is documentation, not a second door —
 * and a rule that cannot tell the two apart teaches people to stop writing the explanation. The
 * `[^:]` guard is the same one tools/asr-boundary.ts needs, and for the same reason: a marker worth
 * finding often arrives inside a `https://`.
 */
function withoutComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) => prefix + blank(match.slice(prefix.length)));
}

export function checkBibleBoundary(
  repoRoot: string,
  allowedFiles: readonly string[] = BIBLE_ADAPTER_FILES,
  sourceDirs: readonly string[] = SOURCE_DIRS,
): BibleBoundaryViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const violations: BibleBoundaryViolation[] = [];

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
            if (BIBLE_LIBRARIES.some((name) => isPackage(specifier, name))) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: specifier,
                rule: 'no-bible-sdk',
              });
            }
          }

          for (const marker of BIBLE_API_MARKERS) {
            if (text.includes(marker)) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: marker,
                rule: 'no-bible-api',
              });
            }
          }
        });
    }
  }

  return violations;
}

export function formatBibleBoundaryViolations(
  violations: readonly BibleBoundaryViolation[],
): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}
