import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_DISPLAY_NAME_LENGTH, checkDisplayName } from '@thp/shared';
import { walkFiles } from '../../../../tools/fs-walk';

describe('the display-name rules', () => {
  it('accepts a name somebody would actually have', () => {
    expect(checkDisplayName('Ada Lovelace')).toBeNull();
    expect(checkDisplayName('王小明')).toBeNull();
    expect(checkDisplayName("O'Neill-Smith")).toBeNull();
  });

  it.each([
    ['nothing at all', ''],
    ['only spaces', '     '],
    ['only a tab', '\t'],
    ['one character over the ceiling', 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)],
  ])('refuses %s, with a reason', (_label, name) => {
    const reason = checkDisplayName(name);
    expect(reason).not.toBeNull();
    expect((reason ?? '').length).toBeGreaterThan(0);
  });

  it('measures the trimmed name, so padding cannot push a real name over the ceiling', () => {
    expect(checkDisplayName(`   ${'x'.repeat(MAX_DISPLAY_NAME_LENGTH)}   `)).toBeNull();
  });
});

/**
 * **The avatar is deferred, and this is what keeps it deferred.**
 *
 * docs/project/prd.md 3.1.12 names an avatar and docs/epics/epic-core-listening/implementation-plan.md § Ticket 4 defers it. A nullable
 * column, an optional payload field or a placeholder component "for later" is how deferral quietly
 * stops being deferral — six months on, half the product assumes the field exists and removing it is
 * a migration. So the absence is asserted at the source level, across the schema, the wire contract
 * and the screens at once, rather than left to whoever reviews the next pull request.
 *
 * The schema half is checked again against a migrated database in the db package's accounts suite;
 * this is the half that catches a payload type or a component before either reaches a migration.
 */
describe('no avatar exists anywhere', () => {
  const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

  const SOURCE_DIRS = [
    'packages/shared/src',
    'packages/db/src',
    'packages/web/src',
    'packages/worker/src',
  ];

  /** Written as fragments rather than whole identifiers, so `avatarUrl` and `avatar_key` both hit. */
  const FORBIDDEN = [/\bavatar/i, /\bgravatar/i, /profilePicture/i, /profile_picture/i];

  it('names one in no source file, in any casing or spelling', () => {
    const offenders: string[] = [];

    for (const dir of SOURCE_DIRS) {
      for (const file of walkFiles(resolve(REPO_ROOT, dir), ['.ts', '.tsx', '.css'])) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            // A comment saying the avatar is deferred is not an avatar. Only code counts. The
            // trailing `\r` is trimmed first: `.` does not match a carriage return, so on a file
            // checked out with CRLF endings the doc-comment pattern would fail to anchor and every
            // explanation of the deferral would read as a violation of it.
            const code = line
              .replace(/\r$/, '')
              .replace(/\/\/.*$/, '')
              .replace(/^\s*\*.*$/, '');
            if (FORBIDDEN.some((pattern) => pattern.test(code))) {
              offenders.push(`${file}:${index + 1}  ${code.trim()}`);
            }
          });
      }
    }

    expect(offenders.join('\n')).toBe('');
  });

  it('would report one if it appeared', () => {
    // The check above is only worth having if it can fail — the same patterns, run against what an
    // innocent-looking first step actually looks like.
    const sample = '  readonly avatarUrl: string | null;';
    expect(FORBIDDEN.some((pattern) => pattern.test(sample))).toBe(true);
  });
});
