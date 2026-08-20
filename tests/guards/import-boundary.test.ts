import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkClientBoundary,
  checkSingleDatabaseModule,
  collectClientFiles,
  formatViolations,
} from '../../tools/import-boundary';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const WEB_SRC = resolve(REPO_ROOT, 'packages/web/src');
const FIXTURE_SRC = resolve(REPO_ROOT, 'tests/fixtures/bad-client/src');

describe('client/API import boundary', () => {
  it('finds client modules to check at all', () => {
    // Without this, an empty result below would be a vacuous pass.
    expect(collectClientFiles(WEB_SRC).length).toBeGreaterThan(0);
  });

  it('holds across the real client', () => {
    const violations = checkClientBoundary(WEB_SRC);
    expect(formatViolations(violations)).toBe('');
  });

  it('reports every kind of violation when one is deliberately introduced', () => {
    const violations = checkClientBoundary(FIXTURE_SRC);
    const rules = new Set(violations.map((violation) => violation.rule));

    expect(rules).toContain('no-database-package');
    expect(rules).toContain('no-database-driver');
    expect(rules).toContain('no-server-module');
    expect(rules).toContain('no-node-builtin');
    expect(rules).toContain('no-hardcoded-api-path');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });

  it('names the offending file and specifier so the failure is actionable', () => {
    const report = formatViolations(checkClientBoundary(FIXTURE_SRC));
    expect(report).toContain('client/leaky.ts');
    expect(report).toContain('@thp/db');
  });
});

describe('one database module', () => {
  it('no application source outside packages/db imports a driver directly', () => {
    expect(formatViolations(checkSingleDatabaseModule(REPO_ROOT))).toBe('');
  });

  it('would report it if one did', () => {
    const violations = checkSingleDatabaseModule(REPO_ROOT, ['tests/fixtures/bad-client/src']);
    expect(violations.map((violation) => violation.detail)).toContain('postgres');
  });
});
