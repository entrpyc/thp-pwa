import { describe, expect, it } from 'vitest';
import { MEDIA_VARIABLES, readMediaSettings } from '@thp/media/env';

/**
 * The media configuration reader, held to the same rule as `requireDatabaseUrl` and the mail
 * settings: **no defaults, and a missing value is a startup failure naming the variable.**
 *
 * A default endpoint would be a second place that knows where the store is. A default bucket would
 * be a default place to put somebody's teaching, and getting it wrong would be silent.
 */

const COMPLETE = {
  MEDIA_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  MEDIA_REGION: 'auto',
  MEDIA_BUCKET: 'teachings',
  MEDIA_ACCESS_KEY_ID: 'key-id',
  MEDIA_SECRET_ACCESS_KEY: 'secret',
} as const;

describe('readMediaSettings', () => {
  it('returns the five configured values, trimmed', () => {
    expect(readMediaSettings({ ...COMPLETE, MEDIA_BUCKET: '  teachings  ' })).toEqual({
      endpoint: COMPLETE.MEDIA_ENDPOINT,
      region: 'auto',
      bucket: 'teachings',
      accessKeyId: 'key-id',
      secretAccessKey: 'secret',
    });
  });

  it('fails naming the variable, for each of the five, unset or blank', () => {
    // Every one of them, not a sample: a reader that happens to check four is a deployment that
    // starts and then fails on the first upload.
    expect(MEDIA_VARIABLES).toHaveLength(5);

    for (const name of MEDIA_VARIABLES) {
      for (const bad of [undefined, '', '   ']) {
        const env = { ...COMPLETE, [name]: bad };
        expect(() => readMediaSettings(env), `${name} = ${JSON.stringify(bad)}`).toThrowError(
          new RegExp(`${name} is not set`),
        );
        expect(() => readMediaSettings(env)).toThrowError(/\.env\.example|README/);
      }
    }
  });

  it('defaults nothing — an empty environment names a variable rather than guessing one', () => {
    expect(() => readMediaSettings({})).toThrowError(/MEDIA_ENDPOINT is not set/);
  });
});
