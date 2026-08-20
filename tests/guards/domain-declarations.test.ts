import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_DECLARATIONS,
  checkDomainDeclarations,
  formatDeclarationViolations,
} from '../../tools/domain-declarations';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('domain declarations exist exactly once', () => {
  it('checks a non-empty set of declarations', () => {
    expect(DOMAIN_DECLARATIONS.length).toBeGreaterThan(0);
  });

  it('holds across the repository', () => {
    expect(formatDeclarationViolations(checkDomainDeclarations(REPO_ROOT))).toBe('');
  });

  it('reports a duplicate declaration when one is deliberately introduced', () => {
    const violations = checkDomainDeclarations(REPO_ROOT, DOMAIN_DECLARATIONS, [
      'packages',
      'tools',
      'tests/fixtures/duplicate-domain',
    ]);
    const reasons = new Set(violations.map((violation) => violation.reason));

    expect(reasons).toContain('duplicate-declaration');
    expect(reasons).toContain('restated-members');
    expect(formatDeclarationViolations(violations)).toContain('duplicate-domain/roles.ts');
  });

  it('reports a missing canonical declaration', () => {
    const violations = checkDomainDeclarations(REPO_ROOT, [
      { name: 'NeverDeclaredAnywhere', canonicalFile: 'packages/shared/src/roles.ts' },
    ]);
    expect(violations.map((violation) => violation.reason)).toEqual([
      'missing-canonical-declaration',
    ]);
  });
});
