import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEDGER_MODULE_FILE,
  QUEUE_ADAPTER_FILES,
  QUEUE_PORT_FILE,
  checkQueueBoundary,
  formatQueueBoundaryViolations,
  ledgerFunctions,
} from '../../tools/queue-boundary';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('one queue module', () => {
  it('no source in packages/web outside the adapter reaches the job ledger', () => {
    expect(formatQueueBoundaryViolations(checkQueueBoundary(REPO_ROOT))).toBe('');
  });

  it('the file that is allowed to actually contains the import — otherwise this is vacuous', () => {
    // A pass here would otherwise be indistinguishable from "nothing enqueues at all".
    const [adapterFile] = QUEUE_ADAPTER_FILES;
    expect(adapterFile).toBeDefined();
    const source = readFileSync(resolve(REPO_ROOT, adapterFile ?? ''), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\benqueueJob\b[^}]*\}\s*from\s*'@thp\/db'/);
  });

  it('reads the ledger it claims to — otherwise every name is permitted', () => {
    // The forbidden names are derived from the ledger's source. If that parse silently returned
    // nothing, the check above would pass for a package that reached the table from everywhere.
    const names = ledgerFunctions(readFileSync(resolve(REPO_ROOT, LEDGER_MODULE_FILE), 'utf8'));
    expect(names).toContain('enqueueJob');
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  it('would report a second door', () => {
    const violations = checkQueueBoundary(REPO_ROOT, QUEUE_ADAPTER_FILES, [
      'tests/fixtures/leaky-queue',
    ]);
    expect(violations.map((violation) => violation.detail)).toContain('enqueueJob');
    expect(formatQueueBoundaryViolations(violations)).toContain('enqueuer.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });

  it('reports the adapter too when it is not the exempt one', () => {
    // The exemption is a named path, not a shape — so removing the name is enough to make the real
    // file fail, which is what "one file, deliberately" has to mean.
    const violations = checkQueueBoundary(REPO_ROOT, []);
    expect(violations.map((violation) => violation.file)).toContain(
      'packages/web/src/server/jobs/postgres-queue.ts',
    );
  });

  it('the port the rest of the application calls exists and declares only the enqueue half', () => {
    const source = readFileSync(resolve(REPO_ROOT, QUEUE_PORT_FILE), 'utf8');
    expect(source).toMatch(/export interface Queue \{/);
    // The worker claims, runs and completes against `@thp/db` directly. A claim on this interface
    // would be a second half with exactly one caller, and that caller is in another package.
    expect(source).not.toMatch(/\bclaim[A-Za-z]*\s*\(/);
  });
});
