import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VISIBILITY_MODULE_FILES,
  checkVisibilityBoundary,
  formatVisibilityBoundaryViolations,
} from '../../tools/visibility-boundary';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('the member visibility condition is written once', () => {
  it('holds across the repository', () => {
    expect(formatVisibilityBoundaryViolations(checkVisibilityBoundary(REPO_ROOT))).toBe('');
  });

  it('the module that owns it actually states it — otherwise this is vacuous', () => {
    // A pass above would otherwise be indistinguishable from "nothing checks publication at all",
    // which is the failure this guard exists to make impossible.
    const [ownerFile] = VISIBILITY_MODULE_FILES;
    expect(ownerFile).toBeDefined();
    const source = readFileSync(resolve(REPO_ROOT, ownerFile ?? ''), 'utf8');
    expect(source).toContain('isNotNull(recording.publishedAt)');
    // And the summary's second gate, which is the half a fourth read path is most likely to miss.
    expect(source).toContain('is not null');
  });

  it('would report a second implementation, in either spelling', () => {
    const violations = checkVisibilityBoundary(REPO_ROOT, VISIBILITY_MODULE_FILES, [
      'tests/fixtures/leaky-visibility',
    ]);

    expect(violations.map((violation) => violation.rule)).toContain('no-visibility-predicate');
    // Both spellings: the Drizzle helper, and the raw SQL a hand-written query would use.
    expect(violations.map((violation) => violation.detail)).toContain(
      'isNull/isNotNull over publishedAt',
    );
    expect(violations.map((violation) => violation.detail)).toContain(
      'published_at is [not] null',
    );
    expect(formatVisibilityBoundaryViolations(violations)).toContain('caller.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });

  it('reports the owning module too when it is not the exempt one', () => {
    // The exemption is a named path, not a shape — so removing the name is enough to make the real
    // file fail, which is what "one place, deliberately" has to mean.
    const violations = checkVisibilityBoundary(REPO_ROOT, []);
    expect(violations.map((violation) => violation.file)).toContain('packages/db/src/visibility.ts');
  });
});
