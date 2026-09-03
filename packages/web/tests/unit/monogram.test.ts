import { describe, expect, it } from 'vitest';
import { monogramFor } from '@thp/shared';

/**
 * **The initials a circle holds for a person with no picture** (docs/project/prd.md 3.1.12).
 *
 * One helper in `@thp/shared`, read by the note card and the profile screen alike, so the two
 * cannot disagree about which letters a person is.
 */
describe('a monogram is the first and last initial', () => {
  it('reads two initials off a two-word name, and the outer two off a longer one', () => {
    expect(monogramFor('Ada Lovelace')).toBe('AL');
    expect(monogramFor('Ada Byron King')).toBe('AK');
  });

  it('reads one initial off a one-word name rather than doubling it', () => {
    expect(monogramFor('Ada')).toBe('A');
  });

  it('upper-cases, trims, and survives internal whitespace', () => {
    expect(monogramFor('  ada   lovelace ')).toBe('AL');
  });

  it('answers a question mark for a name that is somehow blank', () => {
    expect(monogramFor('   ')).toBe('?');
  });
});
