import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PUSH_TRANSPORT_FILES,
  checkPushBoundary,
  formatPushBoundaryViolations,
} from '../../tools/push-boundary';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('one push module', () => {
  it('no application source outside the three senders imports a push library or names a provider host', () => {
    expect(formatPushBoundaryViolations(checkPushBoundary(REPO_ROOT))).toBe('');
  });

  it('the allowed files actually reach a provider — otherwise this is vacuous', () => {
    const sources = PUSH_TRANSPORT_FILES.map((file) => readFileSync(resolve(REPO_ROOT, file), 'utf8'));
    expect(sources[0]).toMatch(/from\s+'web-push'/);
    expect(sources[1]).toContain('api.push.apple.com');
    expect(sources[2]).toContain('fcm.googleapis.com');
  });

  it('reports the senders themselves when they are not the exempt ones', () => {
    const files = checkPushBoundary(REPO_ROOT, []).map((violation) => violation.file);
    for (const file of PUSH_TRANSPORT_FILES) expect(files).toContain(file);
  });
});
