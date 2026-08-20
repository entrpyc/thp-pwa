import { describe, expect, it } from 'vitest';
import { requireDatabaseUrl } from '@thp/db/env';

describe('requireDatabaseUrl', () => {
  it('returns the configured url', () => {
    expect(requireDatabaseUrl({ DATABASE_URL: 'postgres://a:b@h:5432/d' })).toBe(
      'postgres://a:b@h:5432/d',
    );
  });

  it('fails with one actionable sentence when unset or blank', () => {
    for (const env of [{}, { DATABASE_URL: '' }, { DATABASE_URL: '   ' }]) {
      expect(() => requireDatabaseUrl(env)).toThrowError(/DATABASE_URL is not set/);
      expect(() => requireDatabaseUrl(env)).toThrowError(/\.env\.example|README/);
    }
  });
});
