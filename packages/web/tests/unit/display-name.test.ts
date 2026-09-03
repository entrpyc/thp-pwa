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
 * **The avatar key stops at the server, and this is what keeps it there.**
 *
 * This block used to assert that no avatar existed anywhere — docs/project/prd.md 3.1.12 names one
 * and core-listening scope plan § Ticket 4 deferred it, and a source-level guard was what kept a
 * nullable column "for later" from quietly arriving. The profile screen ended the deferral, and the
 * guard turned into the property that matters once the field is real: **what travels is a signed
 * URL, never the object's name in the bucket.** A payload type with a key in it is a payload type a
 * client will one day paint from directly, and a client that names the key is a client that could
 * build a URL nobody signed. So the wire contract and everything that runs in a browser are asserted
 * never to spell the key, at the source level, rather than left to whoever reviews the next pull
 * request.
 *
 * The server half — the row, the policy actor, the service — is where the key legitimately lives,
 * and `policy.test.ts` pins that `describeActor` is the boundary at which it stops.
 */
describe('the avatar key never reaches the wire or the browser', () => {
  const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

  /** The contract every consumer reads, and the two trees that are shipped to a browser. */
  const CLIENT_SIDE_DIRS = ['packages/shared/src', 'packages/web/src/app', 'packages/web/src/client'];

  /** Written as fragments rather than whole identifiers, so `authorAvatarKey` and `avatar_key` both hit. */
  const FORBIDDEN = [/avatarKey/, /avatar_key/i, /avatars\//];

  it('is named in no contract, page or client module', () => {
    const offenders: string[] = [];

    for (const dir of CLIENT_SIDE_DIRS) {
      for (const file of walkFiles(resolve(REPO_ROOT, dir), ['.ts', '.tsx', '.css'])) {
        // Route handlers live under `app/` but run on the server, and they are where the key is
        // legitimately read out of a body. Everything else under `app/` is a page or a component.
        if (/[\\/]api[\\/]/.test(file)) continue;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            // A comment explaining the rule is not a breach of it. Only code counts. The trailing
            // `\r` is trimmed first: `.` does not match a carriage return, so on a file checked out
            // with CRLF endings the doc-comment pattern would fail to anchor.
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
    const sample = '  readonly avatarKey: string | null;';
    expect(FORBIDDEN.some((pattern) => pattern.test(sample))).toBe(true);
  });
});
