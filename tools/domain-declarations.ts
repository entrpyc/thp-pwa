import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { PIPELINE_STEPS, ROLES } from '@thp/shared';
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
  { name: 'Segment', canonicalFile: 'packages/shared/src/segment.ts' },
];

export interface DeclarationViolation {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly reason: 'duplicate-declaration' | 'restated-members' | 'missing-canonical-declaration';
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

export function formatDeclarationViolations(violations: readonly DeclarationViolation[]): string {
  return violations
    .map((violation) => `${violation.file}:${violation.line}  [${violation.reason}]  ${violation.name}`)
    .join('\n');
}
