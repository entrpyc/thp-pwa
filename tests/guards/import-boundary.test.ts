import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkClientBoundary,
  checkSingleDatabaseModule,
  checkWorkerBoundary,
  collectClientFiles,
  formatViolations,
} from '../../tools/import-boundary';
import { walkFiles } from '../../tools/fs-walk';

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
    // `@thp/media` became nameable by a client the moment it stopped being a folder inside the
    // server tree (Story 2 Ticket 03) — it holds bucket credentials and mints signed grants.
    expect(rules).toContain('no-server-package');
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

  it('covers the media package, which is no longer inside the web app', () => {
    // The move in Story 2 Ticket 03 took `packages/web/src/server/media` out of every source dir
    // this guard walks. A rule that silently stops covering a package is worse than no rule, so the
    // package is named and asserted to be non-empty.
    expect(walkFiles(resolve(REPO_ROOT, 'packages/media/src')).length).toBeGreaterThan(0);
    expect(formatViolations(checkSingleDatabaseModule(REPO_ROOT, ['packages/media/src']))).toBe('');
  });
});

describe('the worker and the API share a database, not a codebase', () => {
  it('no worker source imports anything from packages/web', () => {
    expect(formatViolations(checkWorkerBoundary(REPO_ROOT))).toBe('');
  });

  it('has worker source to check at all — otherwise the pass above is vacuous', () => {
    // The rule is about a package that exists and does real work, not an empty folder.
    expect(collectWorkerFiles().length).toBeGreaterThan(0);
  });

  it('would report it if one did', () => {
    const violations = checkWorkerBoundary(REPO_ROOT, ['tests/fixtures/leaky-worker']);
    expect(violations.map((violation) => violation.detail)).toContain(
      '@/server/observability/logger',
    );
    expect(formatViolations(violations)).toContain('reaches-web.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });
});

function collectWorkerFiles(): string[] {
  return walkFiles(resolve(REPO_ROOT, 'packages/worker/src'));
}
