import { describe, expect, it } from 'vitest';
import {
  ASR_PROVIDERS,
  ASR_VARIABLES,
  readAsrApiKey,
  readAsrProvider,
  readFakeScriptPath,
} from '../../src/asr';

/**
 * The ASR configuration reader, held to the same rule as `requireDatabaseUrl`, the media settings
 * and the mail settings: **a missing value is a failure naming the variable**, not an authorisation
 * error three frames deep inside somebody else's service.
 *
 * The provider has a default and the key does not, exactly as `MAIL_TRANSPORT` defaults to `smtp`
 * and `MAIL_PASSWORD` does not default at all. A default provider is a decision about which vendor
 * a deployment that says nothing gets; a default key is not a thing.
 */
describe('readAsrApiKey', () => {
  it('returns the configured key, trimmed', () => {
    expect(readAsrApiKey({ ASR_API_KEY: '  a-real-key  ' })).toBe('a-real-key');
  });

  it('fails naming the variable when it is unset or blank', () => {
    for (const bad of [undefined, '', '   ']) {
      expect(() => readAsrApiKey({ ASR_API_KEY: bad }), JSON.stringify(bad)).toThrowError(
        /ASR_API_KEY is not set/,
      );
      expect(() => readAsrApiKey({ ASR_API_KEY: bad })).toThrowError(/\.env\.example/);
    }
  });

  it('defaults nothing — an empty environment names the variable rather than guessing one', () => {
    expect(() => readAsrApiKey({})).toThrowError(/ASR_API_KEY is not set/);
  });
});

describe('readAsrProvider', () => {
  it('is the real one when nothing says otherwise', () => {
    expect(readAsrProvider({})).toBe('deepgram');
  });

  it('accepts each provider it declares, however it was cased or spaced', () => {
    // Every one of them, not a sample: a reader that happens to accept one is a deployment that
    // starts and then fails on the first job.
    for (const provider of ASR_PROVIDERS) {
      expect(readAsrProvider({ ASR_PROVIDER: ` ${provider.toUpperCase()} ` })).toBe(provider);
    }
  });

  it('refuses one it does not know, naming what it would have accepted', () => {
    expect(() => readAsrProvider({ ASR_PROVIDER: 'whisper' })).toThrowError(
      /ASR_PROVIDER is "whisper"/,
    );
    expect(() => readAsrProvider({ ASR_PROVIDER: 'whisper' })).toThrowError(/deepgram, fake/);
  });
});

describe('readFakeScriptPath', () => {
  it('returns the configured path, trimmed', () => {
    expect(readFakeScriptPath({ ASR_FAKE_SCRIPT: ' script.json ' })).toBe('script.json');
  });

  it('fails naming the variable and why it is being read', () => {
    expect(() => readFakeScriptPath({})).toThrowError(/ASR_FAKE_SCRIPT is not set/);
    expect(() => readFakeScriptPath({})).toThrowError(/ASR_PROVIDER is "fake"/);
  });
});

describe('the variables this module reads', () => {
  it('names all three in one place, so a deployment finds the block', () => {
    expect([...ASR_VARIABLES]).toEqual(['ASR_PROVIDER', 'ASR_API_KEY', 'ASR_FAKE_SCRIPT']);
  });
});
