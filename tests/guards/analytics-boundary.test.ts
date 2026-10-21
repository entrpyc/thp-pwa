import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_ADAPTER_FILES,
  ANALYTICS_VOCABULARY_FILE,
  checkAnalyticsBoundary,
  formatAnalyticsBoundaryViolations,
} from '../../tools/analytics-boundary';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * **One analytics adapter per side** (docs/project/observability.md § 5.5, § 6.1) — the same
 * shape as asr-boundary.test.ts, and for the same reason: swapping the tool is one file only while
 * one file is the only place the tool is named, and the privacy sanitiser only guards every event
 * while every event goes through the file it lives in.
 */
describe('one analytics adapter per side', () => {
  it('no application source outside the adapters names an analytics tool', () => {
    expect(formatAnalyticsBoundaryViolations(checkAnalyticsBoundary(REPO_ROOT))).toBe('');
  });

  it('the client adapter actually names one — otherwise this is vacuous', () => {
    const [clientAdapter] = ANALYTICS_ADAPTER_FILES;
    expect(clientAdapter).toBeDefined();
    const source = readFileSync(resolve(REPO_ROOT, clientAdapter ?? ''), 'utf8');
    expect(source).toContain("from 'posthog-js'");
  });

  it('the vocabulary names no tool, which is the whole point of it', () => {
    const vocabulary = readFileSync(resolve(REPO_ROOT, ANALYTICS_VOCABULARY_FILE), 'utf8');
    expect(vocabulary.toLowerCase()).not.toContain('posthog');
  });

  it('would report a second door, opened either way', () => {
    const violations = checkAnalyticsBoundary(REPO_ROOT, ANALYTICS_ADAPTER_FILES, [
      'tests/fixtures/leaky-analytics',
    ]);
    const rules = new Set(violations.map((violation) => violation.rule));

    expect(rules).toContain('no-analytics-sdk');
    expect(rules).toContain('no-analytics-api');
    expect(violations.map((violation) => violation.detail)).toContain('posthog-js');
    expect(formatAnalyticsBoundaryViolations(violations)).toContain('caller.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });

  it('reports the adapter too when it is not the exempt one', () => {
    const violations = checkAnalyticsBoundary(REPO_ROOT, []);
    expect(violations.map((violation) => violation.file)).toContain(
      'packages/web/src/client/observability/analytics.ts',
    );
  });
});
