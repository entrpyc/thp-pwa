import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BIBLE_BOOKS, REACTIONS, isReactionEmoji, reactionName } from '@thp/shared';
import {
  DOMAIN_DECLARATIONS,
  checkBookNames,
  checkDomainDeclarations,
  formatDeclarationViolations,
} from '../../tools/domain-declarations';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('domain declarations exist exactly once', () => {
  it('checks a non-empty set of declarations', () => {
    expect(DOMAIN_DECLARATIONS.length).toBeGreaterThan(0);
  });

  it('holds across the repository', () => {
    expect(formatDeclarationViolations(checkDomainDeclarations(REPO_ROOT))).toBe('');
  });

  it('reports a duplicate declaration when one is deliberately introduced', () => {
    const violations = checkDomainDeclarations(REPO_ROOT, DOMAIN_DECLARATIONS, [
      'packages',
      'tools',
      'tests/fixtures/duplicate-domain',
    ]);
    const reasons = new Set(violations.map((violation) => violation.reason));

    expect(reasons).toContain('duplicate-declaration');
    expect(reasons).toContain('restated-members');
    expect(formatDeclarationViolations(violations)).toContain('duplicate-domain/roles.ts');
  });

  /**
   * **The reaction vocabulary** (Task 4.1) — active-scope prd 3.4.1 requires it "defined in one
   * named place", which is what the registry above enforces. What that check cannot say is *what*
   * is in the place, so this does.
   *
   * The names matter as much as the glyphs: a bare emoji is unreadable to a screen reader, so the
   * accessible name travels beside every one of them ([5.4.1](docs/active-scope/prd.md)).
   */
  it('names exactly the six reactions, each with its accessible name', () => {
    expect(REACTIONS.map((one) => `${one.emoji} ${one.name}`)).toEqual([
      '🙏 praying',
      '❤️ loved',
      '🔥 convicting',
      '💡 insight',
      '👏 encouraged',
      '😢 moved',
    ]);
    // The registry watches this exact list, so a second copy anywhere fails the check above.
    expect(
      DOMAIN_DECLARATIONS.find((one) => one.name === 'REACTIONS')?.members,
    ).toEqual(REACTIONS.map((one) => one.emoji));
  });

  it('answers for a glyph that has left the set with the glyph itself', () => {
    // 3.4.2: a member's past response is not rewritten by a product decision taken after it, so a
    // departed emoji is still labelled by *something* rather than announced as nothing.
    expect(reactionName('🙏')).toBe('praying');
    expect(reactionName('🕊')).toBe('🕊');
    expect(isReactionEmoji('🙏')).toBe(true);
    // The variation-selector-free spelling of a glyph that *is* in the set is not in the set —
    // which is the whole reason the service compares against the exact string.
    expect(isReactionEmoji('❤')).toBe(false);
    expect(isReactionEmoji('🕊')).toBe(false);
  });

  /**
   * **The canon** (Task 1.1) — active-scope implementation-plan 1.1.1 asks for the 66 books, their
   * chapter counts and their verse counts declared exactly once, and for the canon file to be the
   * only place in the repository a book name is spelled.
   *
   * The registry above holds the first half. These three hold the second, plus the one thing
   * neither can say: that the table is *right*. The two totals are fixed and public, so a mistyped
   * verse count fails here rather than refusing one real citation forever.
   */
  it('holds the whole canon, and only the canon spells a book', () => {
    expect(BIBLE_BOOKS.length).toBe(66);
    expect(BIBLE_BOOKS.reduce((total, book) => total + book.verses.length, 0)).toBe(1189);
    expect(
      BIBLE_BOOKS.reduce(
        (total, book) => total + book.verses.reduce((sum, verses) => sum + verses, 0),
        0,
      ),
    ).toBe(31102);
    expect(new Set(BIBLE_BOOKS.map((book) => book.id)).size).toBe(66);
    expect(BIBLE_BOOKS.every((book) => book.verses.every((verses) => verses > 0))).toBe(true);

    expect(formatDeclarationViolations(checkBookNames(REPO_ROOT))).toBe('');
  });

  it('reports a book name spelled outside the canon when one is deliberately introduced', () => {
    const violations = checkBookNames(REPO_ROOT, ['tests/fixtures/spelled-book']);

    expect(violations.map((violation) => violation.reason)).toEqual(['book-name-spelled']);
    expect(formatDeclarationViolations(violations)).toContain('spelled-book/offender.ts');
    expect(formatDeclarationViolations(violations)).toContain('John');
  });

  it('reports a missing canonical declaration', () => {
    const violations = checkDomainDeclarations(REPO_ROOT, [
      { name: 'NeverDeclaredAnywhere', canonicalFile: 'packages/shared/src/roles.ts' },
    ]);
    expect(violations.map((violation) => violation.reason)).toEqual([
      'missing-canonical-declaration',
    ]);
  });
});
