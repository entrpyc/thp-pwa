import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkClientBoundary,
  checkSingleDatabaseModule,
  checkStoreExportSurface,
  checkWorkerBoundary,
  collectExportedNames,
  collectClientFiles,
  formatViolations,
  STORE_MODULE_FILES,
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

/**
 * **The worker and the API resolve a passage through the same port**
 * ([3.1.1](docs/active-scope/implementation-plan.md)).
 *
 * The same argument the media port settled and for the same reason: both processes need a verse,
 * neither may import the other, so the port is a package beside them rather than a folder inside
 * one. What this asserts is that the arrangement is actually *used* — a shared package nobody on
 * one side imports is a shared package in name only, and the rule above would pass just as well if
 * the worker had quietly grown a second way to fetch a verse.
 */
describe('one verse source, reached by both processes', () => {
  const names = (dir: string): string[] =>
    walkFiles(resolve(REPO_ROOT, dir)).flatMap((file) => [
      ...readFileSync(file, 'utf8').matchAll(/from\s*['"]([^'"]+)['"]/g),
    ].map((match) => match[1] ?? ''));

  it('is imported by the worker and by the API alike', () => {
    expect(names('packages/worker/src')).toContain('@thp/bible');
    expect(names('packages/web/src')).toContain('@thp/bible');
  });

  it('and neither of them reaches into the other to get it', () => {
    // The worker side is `checkWorkerBoundary` above. This is the other direction: the API does not
    // import the worker's package either, so "the same port" cannot quietly become "the API calls
    // the worker's copy".
    expect(names('packages/web/src')).not.toContain('@thp/worker');
    expect(names('packages/bible/src')).not.toContain('@thp/worker');
    expect(names('packages/bible/src').some((one) => one.startsWith('@/'))).toBe(false);
  });
});

describe('a store module hands out row types, not Drizzle types', () => {
  it('has exports to check at all — otherwise the pass below is vacuous', () => {
    // The rule is about a module with a real public surface, not an empty file that trivially
    // names nothing.
    for (const file of STORE_MODULE_FILES) {
      const names = collectExportedNames(REPO_ROOT, file);
      expect(names, file).toContain('NoteRow');
      expect(names.length, file).toBeGreaterThan(2);
    }
  });

  it('holds for every store module', () => {
    expect(formatViolations(checkStoreExportSurface(REPO_ROOT))).toBe('');
  });

  it('would report each of the three ways the builder gets out', () => {
    const violations = checkStoreExportSurface(REPO_ROOT, ['tests/fixtures/leaky-store/notes.ts']);
    const details = violations.map((violation) => violation.detail);

    expect(details).toContain('imports a type from drizzle-orm');
    expect(details).toContain('names a table inferred row type');
    expect(details).toContain('re-exports drizzle-orm');
    expect(formatViolations(violations)).toContain('leaky-store/notes.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });
});
