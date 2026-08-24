import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BIBLE_ADAPTER_FILES,
  BIBLE_PORT_FILE,
  checkBibleBoundary,
  formatBibleBoundaryViolations,
} from '../../tools/bible-boundary';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * [3.1.2](docs/active-scope/implementation-plan.md) — nothing outside the adapter names the source
 * or its HTTP shape, and a module that does fails the build.
 */
describe('one Bible source module', () => {
  it('no application source outside the adapter names a Bible source', () => {
    expect(formatBibleBoundaryViolations(checkBibleBoundary(REPO_ROOT))).toBe('');
  });

  it('the file that is allowed to actually names one — otherwise this is vacuous', () => {
    // A pass above would otherwise be indistinguishable from "nothing fetches a verse at all".
    const [adapterFile] = BIBLE_ADAPTER_FILES;
    expect(adapterFile).toBeDefined();
    const source = readFileSync(resolve(REPO_ROOT, adapterFile ?? ''), 'utf8');
    expect(source).toContain('.simple.json');
  });

  it('the port names no source, which is the whole point of it', () => {
    const port = readFileSync(resolve(REPO_ROOT, BIBLE_PORT_FILE), 'utf8');
    expect(port).not.toContain('.simple.json');
    expect(port.toLowerCase()).not.toContain('helloao');
  });

  it('would report a second door, opened either way', () => {
    const violations = checkBibleBoundary(REPO_ROOT, BIBLE_ADAPTER_FILES, [
      'tests/fixtures/leaky-bible',
    ]);
    const rules = new Set(violations.map((violation) => violation.rule));

    // A client library is one way in. A bare `fetch` at the source's own document is the other, and
    // it needs no dependency — which is why this guard checks for a string as well as an import.
    expect(rules).toContain('no-bible-sdk');
    expect(rules).toContain('no-bible-api');
    expect(violations.map((violation) => violation.detail)).toContain('scripture-api-bible');
    expect(formatBibleBoundaryViolations(violations)).toContain('caller.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });

  it('reports the adapter too when it is not the exempt one', () => {
    // The exemption is a named path, not a shape — so removing the name is enough to make the real
    // file fail, which is what "one file, deliberately" has to mean.
    const violations = checkBibleBoundary(REPO_ROOT, []);
    expect(violations.map((violation) => violation.file)).toContain(
      'packages/bible/src/free-use.ts',
    );
  });
});
