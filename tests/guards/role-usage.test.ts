import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROLE_AWARE_FILES,
  checkRoleUsage,
  formatRoleUsageViolations,
} from '../../tools/role-usage';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('all authorisation decisions resolve through one module', () => {
  it('checks a non-empty, deliberately short list of role-aware files', () => {
    // If this list ever grows, the property it protects has already been lost.
    expect(ROLE_AWARE_FILES).toEqual([
      'packages/shared/src/roles.ts',
      'packages/web/src/server/auth/policy.ts',
    ]);
  });

  it('holds across the application source', () => {
    expect(formatRoleUsageViolations(checkRoleUsage(REPO_ROOT))).toBe('');
  });

  it('finds something to check — the policy module really does read the role', () => {
    // Without this, an empty result above could mean "no source reads roles anywhere", which would
    // be a vacuous pass rather than a structural one.
    const violations = checkRoleUsage(REPO_ROOT, [], ['packages/web/src/server/auth']);
    expect(violations.some((v) => v.file.endsWith('policy.ts') && v.rule === 'reads-role-field')).toBe(
      true,
    );
  });

  it('reports a decision made outside the policy module', () => {
    const violations = checkRoleUsage(REPO_ROOT, ROLE_AWARE_FILES, ['tests/fixtures/role-leak']);
    const rules = new Set(violations.map((violation) => violation.rule));

    expect(rules).toContain('reads-role-field');
    expect(rules).toContain('role-literal');
    expect(formatRoleUsageViolations(violations)).toContain('role-leak/gate.ts');
  });
});
