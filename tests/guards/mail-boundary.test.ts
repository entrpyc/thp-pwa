import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAIL_TRANSPORT_FILES,
  checkMailBoundary,
  formatMailBoundaryViolations,
} from '../../tools/mail-boundary';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('one mail module', () => {
  it('no application source outside the transports file imports a mail library', () => {
    expect(formatMailBoundaryViolations(checkMailBoundary(REPO_ROOT))).toBe('');
  });

  it('the file that is allowed to actually contains the import — otherwise this is vacuous', () => {
    // A pass here would otherwise be indistinguishable from "nothing sends mail at all".
    const [transportsFile] = MAIL_TRANSPORT_FILES;
    expect(transportsFile).toBeDefined();
    const source = readFileSync(resolve(REPO_ROOT, transportsFile ?? ''), 'utf8');
    expect(source).toMatch(/from\s+'nodemailer'/);
  });

  it('would report a second door', () => {
    const violations = checkMailBoundary(REPO_ROOT, MAIL_TRANSPORT_FILES, [
      'tests/fixtures/leaky-mail',
    ]);
    expect(violations.map((violation) => violation.detail)).toContain('nodemailer');
    expect(formatMailBoundaryViolations(violations)).toContain('sender.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });

  it('reports the transports file too when it is not the exempt one', () => {
    // The exemption is a named path, not a shape — so removing the name is enough to make the real
    // file fail, which is what "one file, deliberately" has to mean.
    const violations = checkMailBoundary(REPO_ROOT, []);
    expect(violations.map((violation) => violation.file)).toContain(
      'packages/web/src/server/mail/transports.ts',
    );
  });
});
