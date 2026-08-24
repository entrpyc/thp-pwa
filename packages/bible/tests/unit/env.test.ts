import { describe, expect, it } from 'vitest';
import { MOCK_EXTERNAL_VARIABLE } from '@thp/shared/mock';
import {
  BIBLE_SOURCES,
  readBibleBaseUrl,
  readBibleSource,
  readBibleTranslation,
} from '../../src/env';

/**
 * [3.1.3](docs/active-scope/implementation-plan.md) — the translation is configuration, and a run
 * that has not been told which one it publishes refuses to start rather than picking one.
 */
describe('the translation', () => {
  it('is whatever configuration says', () => {
    expect(readBibleTranslation({ BIBLE_TRANSLATION: 'BSB' })).toBe('BSB');
    expect(readBibleTranslation({ BIBLE_TRANSLATION: '  WEB  ' })).toBe('WEB');
  });

  it('refuses a run that names none, rather than defaulting to one', () => {
    // The failure this prevents is silent and permanent: a deployment that meant one translation
    // publishing another, with a verse cache keyed under the wrong name for the rest of its life.
    expect(() => readBibleTranslation({})).toThrow('BIBLE_TRANSLATION');
    expect(() => readBibleTranslation({ BIBLE_TRANSLATION: '   ' })).toThrow('BIBLE_TRANSLATION');
  });

  it('is required with the fake too, because a held verse is held under a translation', () => {
    expect(() => readBibleTranslation({ [MOCK_EXTERNAL_VARIABLE]: 'true' })).toThrow(
      'BIBLE_TRANSLATION',
    );
  });
});

describe('the source', () => {
  it('is the real one unless something says otherwise', () => {
    const [real] = BIBLE_SOURCES;
    expect(readBibleSource({})).toBe(real);
    expect(readBibleSource({ BIBLE_SOURCE: 'fake' })).toBe('fake');
  });

  it('refuses a name it does not recognise', () => {
    expect(() => readBibleSource({ BIBLE_SOURCE: 'esv' })).toThrow('BIBLE_SOURCE');
  });

  it('has no default base URL', () => {
    expect(() => readBibleBaseUrl({})).toThrow('BIBLE_BASE_URL');
    expect(readBibleBaseUrl({ BIBLE_BASE_URL: 'https://example.test/' })).toBe(
      'https://example.test',
    );
  });
});
