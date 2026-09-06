import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEND_CEILING_USD_PER_DAY,
  readSpendCeilingUsdPerDay,
  requireDatabaseUrl,
} from '@thp/db/env';

describe('readSpendCeilingUsdPerDay', () => {
  it('defaults to pocket money — a few teachings, not a month', () => {
    expect(readSpendCeilingUsdPerDay({})).toBe(DEFAULT_SPEND_CEILING_USD_PER_DAY);
    expect(readSpendCeilingUsdPerDay({ SPEND_CEILING_USD_PER_DAY: '  ' })).toBe(
      DEFAULT_SPEND_CEILING_USD_PER_DAY,
    );
    expect(DEFAULT_SPEND_CEILING_USD_PER_DAY).toBeGreaterThan(0);
    expect(DEFAULT_SPEND_CEILING_USD_PER_DAY).toBeLessThanOrEqual(5);
  });

  it('reads a whole or decimal amount', () => {
    expect(readSpendCeilingUsdPerDay({ SPEND_CEILING_USD_PER_DAY: '10' })).toBe(10);
    expect(readSpendCeilingUsdPerDay({ SPEND_CEILING_USD_PER_DAY: '0.5' })).toBe(0.5);
  });

  it.each(['0', '-2', 'free', 'NaN', 'Infinity'])(
    'refuses "%s", naming the variable',
    (raw) => {
      expect(() => readSpendCeilingUsdPerDay({ SPEND_CEILING_USD_PER_DAY: raw })).toThrowError(
        /SPEND_CEILING_USD_PER_DAY/,
      );
    },
  );
});

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
