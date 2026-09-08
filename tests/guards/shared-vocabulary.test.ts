import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkFiles } from '../../tools/fs-walk';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

function importsShared(dir: string): boolean {
  return walkFiles(resolve(REPO_ROOT, dir)).some((file) =>
    /from\s+['"]@thp\/shared/.test(readFileSync(file, 'utf8')),
  );
}

describe('the shared package is the vocabulary all three consumers read', () => {
  it.each([
    ['client', 'packages/web/src/client'],
    ['API', 'packages/web/src/server'],
    ['worker', 'packages/worker/src'],
    ['database layer', 'packages/db/src'],
  ])('%s imports @thp/shared', (_label, dir) => {
    expect(importsShared(dir)).toBe(true);
  });

  it('the database schema derives its enums rather than restating them', () => {
    const schema = readFileSync(resolve(REPO_ROOT, 'packages/db/src/schema.ts'), 'utf8');
    expect(schema).toMatch(/pgEnum\(\s*'user_role',\s*ROLES\s*\)/);
    // `JOB_STEPS` rather than `PIPELINE_STEPS`: the column holds the standalone steps too, and
    // the list it derives from is the one that says so.
    expect(schema).toMatch(/pgEnum\(\s*'pipeline_step',\s*JOB_STEPS\s*\)/);
  });
});
