import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ORIGIN_READER_FILES,
  ORIGIN_VARIABLE,
  checkOriginBoundary,
  formatOriginBoundaryViolations,
} from '../../tools/origin-boundary';
import { readAppOrigin } from '../../packages/web/src/server/mail/env';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('one absolute API origin, no same-host fallback', () => {
  it('no source outside the two readers names the variable, and nothing derives an origin from the page', () => {
    expect(formatOriginBoundaryViolations(checkOriginBoundary(REPO_ROOT))).toBe('');
  });

  it('the files that are allowed to actually read it — otherwise this is vacuous', () => {
    // A pass above would otherwise be indistinguishable from "nothing reads the origin at all".
    for (const reader of ORIGIN_READER_FILES) {
      expect(readFileSync(resolve(REPO_ROOT, reader), 'utf8')).toContain(ORIGIN_VARIABLE);
    }
  });

  it('reports the readers too when they are not the exempt ones', () => {
    // The exemption is a named path, not a shape, so removing the name is enough to make the real
    // files fail — which is what "two readers, deliberately" has to mean.
    const reported = checkOriginBoundary(REPO_ROOT, []).map((violation) => violation.file);
    for (const reader of ORIGIN_READER_FILES) {
      expect(reported).toContain(reader);
    }
  });

  it('would report a page-derived origin, however it is spelled', () => {
    const violations = checkOriginBoundary(REPO_ROOT, ORIGIN_READER_FILES, [
      'tests/fixtures/leaky-origin',
    ]);
    const rules = new Set(violations.map((violation) => violation.rule));

    // A third reader is one way in. Working the origin out from the page is the other, and it needs
    // no variable — which is why this guard checks for both.
    expect(rules).toContain('no-second-origin-reader');
    expect(rules).toContain('no-same-host-origin');
    expect(violations.map((violation) => violation.detail)).toContain('location.origin');
    expect(violations.map((violation) => violation.detail)).toContain('location.host');
    expect(formatOriginBoundaryViolations(violations)).toContain('same-host.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });

  it('the mail reader refuses to invent an origin when the variable is missing', () => {
    // The guard above is about who *may* read it; this is about what happens when it is not there,
    // and the answer has to be a refusal, because every silent alternative is a same-host fallback.
    // The client reader's half of this is already covered by packages/web/tests/unit/api-client.test.ts.
    expect(() => readAppOrigin({})).toThrow(ORIGIN_VARIABLE);
    expect(() => readAppOrigin({ [ORIGIN_VARIABLE]: '   ' })).toThrow(ORIGIN_VARIABLE);
  });

  it('strips a trailing slash, so a deployment origin and a development one join paths alike', () => {
    expect(readAppOrigin({ [ORIGIN_VARIABLE]: 'https://thp.indepthwebsolutions.com/' })).toBe(
      'https://thp.indepthwebsolutions.com',
    );
  });
});
