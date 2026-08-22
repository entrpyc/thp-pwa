import { describe, expect, it } from 'vitest';
import { MOCK_EXTERNAL_VARIABLE, isExternalMocked } from '@thp/shared/mock';
import { readAsrProvider } from '../../packages/worker/src/asr/env';
import { readGenerateProvider } from '../../packages/worker/src/generate/env';
import { readTransportName } from '../../packages/web/src/server/mail/env';

/**
 * **One switch, three adapters.**
 *
 * The guard is here rather than beside any one of the three readers because the property is that
 * they agree — a switch that silences ASR and generation but still sends real mail is worse than no
 * switch, since it reads as a guarantee and is not one.
 */

/** Every real provider named at once, which is what a developer's `.env` looks like. */
const REAL = {
  ASR_PROVIDER: 'deepgram',
  GENERATE_PROVIDER: 'minimax',
  MAIL_TRANSPORT: 'smtp',
} as const;

describe('THP_MOCK_EXTERNAL', () => {
  it('puts all three adapters on their fakes at once', () => {
    const env = { ...REAL, [MOCK_EXTERNAL_VARIABLE]: 'true' };

    expect(readAsrProvider(env)).toBe('fake');
    expect(readGenerateProvider(env)).toBe('fake');
    // `capture` rather than `failing`: a mocked environment should still render a readable message.
    expect(readTransportName(env)).toBe('capture');
  });

  it('wins over an explicitly named real provider, which is the whole promise', () => {
    // The three above are already explicit. This asserts the direction of the precedence rather
    // than the values — a switch that loses to a named provider cannot promise "nothing leaves".
    expect(readAsrProvider({ ...REAL, [MOCK_EXTERNAL_VARIABLE]: '1' })).toBe('fake');
    expect(readGenerateProvider({ ...REAL, [MOCK_EXTERNAL_VARIABLE]: '1' })).toBe('fake');
    expect(readTransportName({ ...REAL, [MOCK_EXTERNAL_VARIABLE]: '1' })).toBe('capture');
  });

  it('changes nothing when it is unset — each reader reads its own variable', () => {
    // Without this the test above would pass just as well if the readers always returned a fake.
    expect(readAsrProvider(REAL)).toBe('deepgram');
    expect(readGenerateProvider(REAL)).toBe('minimax');
    expect(readTransportName(REAL)).toBe('smtp');

    expect(readAsrProvider({})).toBe('deepgram');
    expect(readGenerateProvider({})).toBe('minimax');
    expect(readTransportName({})).toBe('smtp');

    expect(readAsrProvider({ ASR_PROVIDER: 'fake' })).toBe('fake');
    expect(readTransportName({ MAIL_TRANSPORT: 'failing' })).toBe('failing');
  });

  it('treats an explicit false as not mocked', () => {
    for (const value of ['false', '0', '']) {
      expect(isExternalMocked({ [MOCK_EXTERNAL_VARIABLE]: value })).toBe(false);
    }
    expect(isExternalMocked({})).toBe(false);
  });

  it('refuses a value it does not recognise rather than quietly meaning false', () => {
    // The failure this prevents is the expensive one: `THP_MOCK_EXTERNAL=yes` silently billing a
    // real transcription.
    const env = { ...REAL, [MOCK_EXTERNAL_VARIABLE]: 'yes' };

    expect(() => isExternalMocked(env)).toThrow(MOCK_EXTERNAL_VARIABLE);
    expect(() => readAsrProvider(env)).toThrow(MOCK_EXTERNAL_VARIABLE);
    expect(() => readGenerateProvider(env)).toThrow(MOCK_EXTERNAL_VARIABLE);
    expect(() => readTransportName(env)).toThrow(MOCK_EXTERNAL_VARIABLE);
  });

  it('accepts the value however it is spelled in a shell', () => {
    expect(isExternalMocked({ [MOCK_EXTERNAL_VARIABLE]: ' TRUE ' })).toBe(true);
  });
});
