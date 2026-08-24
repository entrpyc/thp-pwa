import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import {
  BIBLE_BOOKS,
  JOB_STATUSES,
  NOTE_VISIBILITIES,
  REACTIONS,
  PIPELINE_STEPS,
  REVIEW_KINDS,
  REVIEW_STATUSES,
  ROLES,
  SCRIPTURE_ORIGINS,
} from '@thp/shared';
import { walkFiles } from './fs-walk';

export interface DomainDeclaration {
  /** The exported identifier, e.g. `ROLES` or `Segment`. */
  readonly name: string;
  /** Repo-relative posix path of the one file allowed to declare it. */
  readonly canonicalFile: string;
  /** Members, when the declaration is an enum. A restated tuple of these is a duplicate. */
  readonly members?: readonly string[];
}

/**
 * The domain vocabulary that must exist once for the whole repository. The database layer derives
 * its `pgEnum`s from these rather than restating the values beside them, which is the only reason
 * this check stays honest once tables arrive.
 *
 * The member lists below are *imported*, not retyped — this registry has to obey the rule it
 * enforces or it would be the first duplicate.
 */
export const DOMAIN_DECLARATIONS: readonly DomainDeclaration[] = [
  { name: 'ROLES', canonicalFile: 'packages/shared/src/roles.ts', members: ROLES },
  { name: 'Role', canonicalFile: 'packages/shared/src/roles.ts' },
  {
    name: 'PIPELINE_STEPS',
    canonicalFile: 'packages/shared/src/pipeline.ts',
    members: PIPELINE_STEPS,
  },
  { name: 'PipelineStep', canonicalFile: 'packages/shared/src/pipeline.ts' },
  {
    name: 'JOB_STATUSES',
    canonicalFile: 'packages/shared/src/jobs.ts',
    members: JOB_STATUSES,
  },
  { name: 'JobStatus', canonicalFile: 'packages/shared/src/jobs.ts' },
  {
    name: 'REVIEW_KINDS',
    canonicalFile: 'packages/shared/src/reviews.ts',
    members: REVIEW_KINDS,
  },
  { name: 'ReviewKind', canonicalFile: 'packages/shared/src/reviews.ts' },
  {
    name: 'REVIEW_STATUSES',
    canonicalFile: 'packages/shared/src/reviews.ts',
    members: REVIEW_STATUSES,
  },
  { name: 'ReviewStatus', canonicalFile: 'packages/shared/src/reviews.ts' },
  {
    name: 'NOTE_VISIBILITIES',
    canonicalFile: 'packages/shared/src/notes.ts',
    members: NOTE_VISIBILITIES,
  },
  { name: 'NoteVisibility', canonicalFile: 'packages/shared/src/notes.ts' },
  {
    name: 'REACTIONS',
    canonicalFile: 'packages/shared/src/reactions.ts',
    // Derived rather than retyped, exactly as every list above is: a literal tuple of the six here
    // would be the first duplicate of the thing this registry exists to keep single.
    members: REACTIONS.map((one) => one.emoji),
  },
  { name: 'Reaction', canonicalFile: 'packages/shared/src/reactions.ts' },
  { name: 'ReactionEmoji', canonicalFile: 'packages/shared/src/reactions.ts' },
  { name: 'Segment', canonicalFile: 'packages/shared/src/segment.ts' },
  {
    name: 'BIBLE_BOOKS',
    canonicalFile: 'packages/shared/src/scripture.ts',
    // Derived rather than retyped, as every list above is. The book *names* are watched separately
    // by `checkBookNames` below, because a book is spelled in prose long before anybody restates
    // the whole tuple.
    members: BIBLE_BOOKS.map((one) => one.id),
  },
  { name: 'BibleBook', canonicalFile: 'packages/shared/src/scripture.ts' },
  { name: 'BookId', canonicalFile: 'packages/shared/src/scripture.ts' },
  {
    name: 'SCRIPTURE_ORIGINS',
    canonicalFile: 'packages/shared/src/scripture.ts',
    members: SCRIPTURE_ORIGINS,
  },
  { name: 'ScriptureOrigin', canonicalFile: 'packages/shared/src/scripture.ts' },
];

export interface DeclarationViolation {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly reason:
    | 'duplicate-declaration'
    | 'restated-members'
    | 'missing-canonical-declaration'
    | 'book-name-spelled';
}

const SEARCH_ROOTS = ['packages', 'tools'];

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function declarationPattern(name: string): RegExp {
  return new RegExp(String.raw`\b(?:const|let|var|enum|type|interface|class)\s+` + name + String.raw`\b`);
}

/**
 * Blank out comments and module statements, keeping the line count intact.
 *
 * Two things that are not declarations and were being read as one:
 *
 * - **An import.** Bringing the canonical vocabulary in is the behaviour this check exists to
 *   encourage; reporting every consumer as a duplicate would punish exactly that.
 * - **Prose.** Naming a declaration in a comment — including in this file's own explanation of the
 *   rule — is not restating it.
 */
function scannableSource(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/[^\n]*/gm, blank)
    .replace(/^[ \t]*(?:import|export)\b[\s\S]*?from\s*['"][^'"]+['"];?/gm, blank);
}

/** Quoted strings inside every array literal on a line, e.g. `['a', 'b']` -> `[['a','b']]`. */
function arrayLiteralMembers(line: string): string[][] {
  return [...line.matchAll(/\[([^\][]*)\]/g)].map((match) =>
    [...(match[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((inner) => inner[1] ?? ''),
  );
}

/**
 * Source-level check: every domain declaration exists in its canonical file and nowhere else, and
 * no other file restates an enum's members as a literal tuple.
 */
export function checkDomainDeclarations(
  repoRoot: string,
  declarations: readonly DomainDeclaration[] = DOMAIN_DECLARATIONS,
  searchRoots: readonly string[] = SEARCH_ROOTS,
): DeclarationViolation[] {
  const root = resolve(repoRoot);
  const files = searchRoots.flatMap((dir) => walkFiles(resolve(root, dir)));
  const violations: DeclarationViolation[] = [];
  const seenCanonical = new Set<string>();

  for (const file of files) {
    const relativeFile = toPosix(relative(root, file));
    const lines = scannableSource(readFileSync(file, 'utf8')).split('\n');

    for (const declaration of declarations) {
      const canonical = relativeFile === declaration.canonicalFile;
      const pattern = declarationPattern(declaration.name);
      const members = declaration.members;

      lines.forEach((text, index) => {
        if (pattern.test(text)) {
          if (canonical) {
            seenCanonical.add(declaration.name);
          } else {
            violations.push({
              file: relativeFile,
              line: index + 1,
              name: declaration.name,
              reason: 'duplicate-declaration',
            });
          }
        }

        if (!canonical && members) {
          const restated = arrayLiteralMembers(text).some((literal) =>
            members.every((member) => literal.includes(member)),
          );
          if (restated) {
            violations.push({
              file: relativeFile,
              line: index + 1,
              name: declaration.name,
              reason: 'restated-members',
            });
          }
        }
      });
    }
  }

  for (const declaration of declarations) {
    if (!seenCanonical.has(declaration.name)) {
      violations.push({
        file: declaration.canonicalFile,
        line: 0,
        name: declaration.name,
        reason: 'missing-canonical-declaration',
      });
    }
  }

  return violations;
}

/** The canonical file, and the one place a book of the Bible may be spelled. */
const CANON_FILE = 'packages/shared/src/scripture.ts';

/** Every quoted string on a line — single, double and backtick. */
function stringLiterals(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(/'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return found;
}

/**
 * **No source file but the canon spells a book of the Bible**
 * ([1.1.1](docs/active-scope/implementation-plan.md)).
 *
 * The stronger half of the rule the registry above enforces. A duplicate *tuple* is the obvious
 * way the canon gets restated; the likely one is a screen writing `John 3:16` into a heading, or a
 * prompt listing the books it will accept — one book at a time, in a string, with nothing that
 * looks like a second declaration anywhere near it. Anything that needs to print a citation calls
 * `formatCitation`, and anything that needs to recognise a name calls `findBookByName`.
 *
 * **Quoted strings only.** A book name is data, and it is as data that it goes wrong; matching
 * bare identifiers as well would mean arguing about `JobRow` and `markAccepted` forever, for
 * nothing.
 *
 * **Tests are exempt**, because a test asserting what `formatCitation` returns has to spell the
 * answer — that is the assertion. What the check protects is `src/`, where the answer is produced.
 */
export function checkBookNames(
  repoRoot: string,
  searchRoots: readonly string[] = SEARCH_ROOTS,
  canonicalFile: string = CANON_FILE,
): DeclarationViolation[] {
  const root = resolve(repoRoot);
  const names = BIBLE_BOOKS.map((book) => ({
    name: book.name,
    pattern: new RegExp(`(^|[^A-Za-z])${book.name}([^A-Za-z]|$)`),
  }));
  const violations: DeclarationViolation[] = [];

  for (const file of searchRoots.flatMap((dir) => walkFiles(resolve(root, dir)))) {
    const relativeFile = toPosix(relative(root, file));
    if (relativeFile === canonicalFile) continue;
    if (/^packages\/[^/]+\/tests\//.test(relativeFile)) continue;

    const lines = scannableSource(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((text, index) => {
      const literals = stringLiterals(text);
      for (const book of names) {
        if (literals.some((literal) => book.pattern.test(literal))) {
          violations.push({
            file: relativeFile,
            line: index + 1,
            name: book.name,
            reason: 'book-name-spelled',
          });
        }
      }
    });
  }

  return violations;
}

export function formatDeclarationViolations(violations: readonly DeclarationViolation[]): string {
  return violations
    .map((violation) => `${violation.file}:${violation.line}  [${violation.reason}]  ${violation.name}`)
    .join('\n');
}
