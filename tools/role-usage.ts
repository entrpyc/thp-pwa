import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { ROLES } from '@thp/shared';
import { walkFiles } from './fs-walk';

/**
 * **One place decides.**
 *
 * docs/project/architecture.md § Cross-cutting concerns puts every authorisation decision in one policy
 * layer expressed as `(actor, action, resource)`, and docs/epics/epic-core-listening/prd.md § Rationale says missing
 * that makes this epic throwaway. The property is only worth having if it can fail on its own:
 * this check reads application source and reports anything outside the policy module that touches
 * a role at all — reading `.role`, or spelling a role as a string literal.
 *
 * Two files are allowed to, and each for one reason:
 *
 * - `packages/shared/src/roles.ts` **declares** the roles. It is where the literals live.
 * - `packages/web/src/server/auth/policy.ts` is the single evaluation point. It reads `actor.role`,
 *   and it is also where an actor is built and turned into the payload the client renders from, so
 *   that no other module has a reason to reach for the field.
 *
 * Everything else asks the policy module a question instead. That is what makes Contributor "one
 * enum value plus four widened cases" rather than a search of the codebase.
 */

export interface RoleUsageViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: 'reads-role-field' | 'role-literal';
  readonly detail: string;
}

export const ROLE_AWARE_FILES: readonly string[] = [
  'packages/shared/src/roles.ts',
  'packages/web/src/server/auth/policy.ts',
];

/**
 * This file. It derives the patterns it searches for from `ROLES`, so it necessarily contains
 * them — the checker cannot be subject to its own check without reporting itself.
 */
const SELF = 'tools/role-usage.ts';

const APPLICATION_SOURCE: readonly string[] = [
  'packages/shared/src',
  'packages/db/src',
  'packages/web/src',
  'packages/worker/src',
  'tools',
];

const READS_ROLE_FIELD = /\.role\b/;

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function roleLiteralPattern(): RegExp {
  return new RegExp(`['"\`](?:${ROLES.join('|')})['"\`]`);
}

export function checkRoleUsage(
  repoRoot: string,
  allowedFiles: readonly string[] = ROLE_AWARE_FILES,
  sourceDirs: readonly string[] = APPLICATION_SOURCE,
): RoleUsageViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const literal = roleLiteralPattern();
  const violations: RoleUsageViolation[] = [];

  for (const dir of sourceDirs) {
    for (const file of walkFiles(resolve(root, dir))) {
      const relativeFile = toPosix(relative(root, file));
      if (allowed.has(relativeFile) || relativeFile === SELF) continue;

      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((raw, index) => {
          // A comment explaining the rule is not a use of it.
          const code = raw.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
          if (READS_ROLE_FIELD.test(code)) {
            violations.push({
              file: relativeFile,
              line: index + 1,
              rule: 'reads-role-field',
              detail: code.trim(),
            });
          }
          if (literal.test(code)) {
            violations.push({
              file: relativeFile,
              line: index + 1,
              rule: 'role-literal',
              detail: code.trim(),
            });
          }
        });
    }
  }

  return violations;
}

export function formatRoleUsageViolations(violations: readonly RoleUsageViolation[]): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}
