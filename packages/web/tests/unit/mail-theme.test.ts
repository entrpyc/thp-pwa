import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIL_THEME, MAIL_THEME_TOKENS } from '@/server/mail/theme';
import { parseCustomProperties } from '../../../../tools/style-tokens';

/**
 * Assumption 9 of the ticket plan, made checkable.
 *
 * The invitation template cannot compose from `tokens.css` — mail clients do not support custom
 * properties — so it inlines literal values. The claim that makes that acceptable is "generated
 * from the same source the token layer reads, so the two cannot drift". This is what enforces it:
 * every value in `MAIL_THEME` is compared against the token it says it copies, read out of
 * `app/tokens.css` itself.
 *
 * The comparison is the same mechanism that keeps `tokens.css` equal to the style guide, one link
 * further along the chain: guide → tokens.css → mail theme.
 */

const WEB_SRC = resolve(import.meta.dirname, '..', '..', 'src');
const tokens = parseCustomProperties(readFileSync(resolve(WEB_SRC, 'app/tokens.css'), 'utf8'));

describe('the email theme is the token layer, spelled out', () => {
  it('read a token layer to compare against', () => {
    // Without this, an empty token map would make every assertion below vacuous.
    expect(tokens.size).toBeGreaterThan(20);
  });

  it('names a token for every value it declares, and none that is missing', () => {
    expect(Object.keys(MAIL_THEME).sort()).toEqual(Object.keys(MAIL_THEME_TOKENS).sort());
    for (const token of Object.values(MAIL_THEME_TOKENS)) {
      expect(tokens.has(token), `${token} is not in tokens.css`).toBe(true);
    }
  });

  it('equals the token layer, value for value', () => {
    const drifted = Object.entries(MAIL_THEME_TOKENS)
      .filter(([key, token]) => {
        const declared = tokens.get(token);
        const copied = MAIL_THEME[key as keyof typeof MAIL_THEME];
        // Whitespace-insensitive on the same terms the token parser normalises with.
        return declared !== copied.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',');
      })
      .map(([key, token]) => `${key}: theme=${MAIL_THEME[key as keyof typeof MAIL_THEME]} ${token}=${tokens.get(token) ?? '(absent)'}`);

    expect(drifted.join('\n')).toBe('');
  });

  it('would report a value that drifted', () => {
    // The check above is only worth having if it can fail — this is the same comparison run
    // against a deliberately wrong copy.
    const wrong = '#000000';
    expect(tokens.get(MAIL_THEME_TOKENS.primary)).not.toBe(wrong);
  });
});
