import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MEDIA_ADAPTER_FILES,
  MEDIA_PORT_FILE,
  checkMediaBoundary,
  findDeleteOperations,
  formatMediaBoundaryViolations,
  portMembers,
} from '../../tools/media-boundary';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const portSource = readFileSync(resolve(REPO_ROOT, MEDIA_PORT_FILE), 'utf8');

describe('one media store module', () => {
  it('no application source outside the adapter imports an object-store SDK', () => {
    expect(formatMediaBoundaryViolations(checkMediaBoundary(REPO_ROOT))).toBe('');
  });

  it('the file that is allowed to actually contains the import — otherwise this is vacuous', () => {
    // A pass here would otherwise be indistinguishable from "nothing talks to the store at all".
    const [adapterFile] = MEDIA_ADAPTER_FILES;
    expect(adapterFile).toBeDefined();
    const source = readFileSync(resolve(REPO_ROOT, adapterFile ?? ''), 'utf8');
    expect(source).toMatch(/from\s+'@aws-sdk\/client-s3'/);
    expect(source).toMatch(/from\s+'@aws-sdk\/s3-request-presigner'/);
  });

  it('would report a second door', () => {
    const violations = checkMediaBoundary(REPO_ROOT, MEDIA_ADAPTER_FILES, [
      'tests/fixtures/leaky-media',
    ]);
    expect(violations.map((violation) => violation.detail)).toContain('@aws-sdk/client-s3');
    expect(formatMediaBoundaryViolations(violations)).toContain('uploader.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });

  it('reports the adapter too when it is not the exempt one', () => {
    // The exemption is a named path, not a shape — so removing the name is enough to make the real
    // file fail, which is what "one file, deliberately" has to mean.
    const violations = checkMediaBoundary(REPO_ROOT, []);
    expect(violations.map((violation) => violation.file)).toContain(
      'packages/web/src/server/media/s3-store.ts',
    );
  });
});

describe('nothing is ever deleted from the store', () => {
  it('the port declares no delete operation', () => {
    // docs/project/prd.md 3.4.9, and the one non-negotiable of
    // docs/epics/epic-core-listening/architecture.md § Media store. Held by the *type*: an adapter
    // can only offer what the interface declares, so there is nothing for a caller to reach for.
    expect(findDeleteOperations(portSource)).toEqual([]);
  });

  it('reads the interface it claims to — otherwise the assertion above is vacuous', () => {
    const members = portMembers(portSource);
    expect(members).toContain('presignPut');
    expect(members).toContain('head');
    // Two operations, and the guard can see both. If the parse silently returned nothing, the
    // "no delete" assertion above would pass for a port that had one.
    expect(members.length).toBeGreaterThanOrEqual(2);
  });

  it('would report a delete if one were added', () => {
    const withDelete = portSource.replace(
      'head(key: string): Promise<StoredObject | null>;',
      'head(key: string): Promise<StoredObject | null>;\n  deleteObject(key: string): Promise<void>;',
    );
    expect(withDelete).not.toBe(portSource);
    expect(findDeleteOperations(withDelete)).toEqual(['deleteObject']);
  });
});
