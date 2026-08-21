import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests/fixtures/type-errors');
const require = createRequire(import.meta.url);

// The package does not export `./bin/tsc`, so resolve it through the one subpath it does export.
const TSC = resolve(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

/**
 * Two claims in this step are claims about the **type system**, so they are checked with the type
 * system rather than described in prose:
 *
 * - a route cannot be defined without stating its access, and
 * - a rules table cannot omit a role.
 *
 * Each has a fixture that must compile and a fixture that must not. Running `tsc` costs about as
 * much as a small integration test, which is the honest price of the only check that can prove
 * either one.
 */
const MUST_NOT_COMPILE = ['route-without-access.ts', 'policy-rules-missing-role.ts'] as const;
const MUST_COMPILE = ['route-with-access.ts', 'policy-rules-complete.ts'] as const;

async function typecheckFixtures(): Promise<{ code: number; output: string }> {
  const child = spawn(
    process.execPath,
    [TSC, '--noEmit', '-p', resolve(FIXTURE_DIR, 'tsconfig.json')],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const code: number = await new Promise((done) => child.on('close', (value) => done(value ?? 1)));
  return { code, output };
}

describe('what the compiler refuses', () => {
  let result: { code: number; output: string };

  beforeAll(async () => {
    result = await typecheckFixtures();
  }, 180_000);

  it('fails the fixture project overall', () => {
    expect(result.code, `tsc should have failed:\n${result.output}`).not.toBe(0);
  });

  it.each(MUST_NOT_COMPILE)('refuses %s', (file) => {
    expect(result.output, result.output).toContain(file);
  });

  it.each(MUST_COMPILE)('accepts %s', (file) => {
    // The positive controls must be clean, otherwise the refusals above prove nothing about the
    // property being pinned — only that the fixture project is broken.
    expect(result.output).not.toContain(file);
  });
});
