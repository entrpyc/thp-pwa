import { describe, expect, it } from 'vitest';
import {
  BIBLE_BOOKS,
  checkCitation,
  citationKey,
  citationsEqual,
  compareCitations,
  findBookByName,
  formatCitation,
  isScriptureCitation,
  type ScriptureCitation,
} from '@thp/shared';

/**
 * **The citation value** (Task 1.1) — one set of rules the worker, the API and the client all
 * read, tested where the other shared-contract unit tests live.
 *
 * Nothing here touches a database, a provider or a screen. What is under test is the value itself:
 * what it refuses and why, when two of them are the same passage, what order a list of them comes
 * out in, and how it reads on a page.
 */

/** A citation, spelled out, so a case reads as what it is rather than as four fields. */
function cite(book: string, chapter: number, verseStart: number, verseEnd = verseStart): ScriptureCitation {
  return { book, chapter, verseStart, verseEnd };
}

describe('a book is looked up rather than spelled', () => {
  it('finds a book by its name or its identity, however it is cased', () => {
    expect(findBookByName('Romans')?.id).toBe('romans');
    expect(findBookByName('  romans ')?.id).toBe('romans');
    expect(findBookByName('1 Samuel')?.id).toBe('1-samuel');
    expect(findBookByName('1-samuel')?.id).toBe('1-samuel');
  });

  it('does not guess at a name it cannot place', () => {
    expect(findBookByName('Rom')).toBeNull();
    expect(findBookByName('First Samuel')).toBeNull();
    expect(findBookByName('')).toBeNull();
  });
});

describe('a proposal is refused with what is wrong with it', () => {
  // 1.1.2 — the refusal names the book it did not recognise, so a dropped citation is readable
  // rather than merely counted.
  it('refuses a book outside the canon, naming the book', () => {
    const checked = checkCitation({ book: 'Hezekiah', chapter: 3, verseStart: 1, verseEnd: 2 });

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problem.field).toBe('book');
    expect(checked.problem.message).toContain('Hezekiah');
  });

  // 1.1.3 — which of the two was wrong, because "that citation is invalid" is not something an
  // admin can act on.
  it('refuses a chapter the book does not have, and says it is the chapter', () => {
    const checked = checkCitation({ book: 'Romans', chapter: 17, verseStart: 1, verseEnd: 1 });

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problem.field).toBe('chapter');
    expect(checked.problem.message).toContain('16');
  });

  it('refuses a verse the chapter does not have, and says it is the verse', () => {
    const checked = checkCitation({ book: 'John', chapter: 3, verseStart: 1, verseEnd: 99 });

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problem.field).toBe('verse');
    expect(checked.problem.message).toContain('36');
  });

  it('accepts the last verse of a chapter and refuses the one after it', () => {
    expect(checkCitation({ book: 'John', chapter: 3, verseStart: 36, verseEnd: 36 }).ok).toBe(true);
    expect(checkCitation({ book: 'John', chapter: 3, verseStart: 37, verseEnd: 37 }).ok).toBe(false);
    expect(checkCitation({ book: 'Romans', chapter: 0, verseStart: 1, verseEnd: 1 }).ok).toBe(false);
    expect(checkCitation({ book: 'Romans', chapter: 8, verseStart: 0, verseEnd: 4 }).ok).toBe(false);
  });

  // 1.1.4 — a backwards range is refused; a range of one verse is a verse.
  it('refuses a range that ends before it starts, and accepts one that ends where it starts', () => {
    const backwards = checkCitation({ book: 'Romans', chapter: 8, verseStart: 4, verseEnd: 1 });
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.problem.field).toBe('verse');

    const single = checkCitation({ book: 'Romans', chapter: 8, verseStart: 1, verseEnd: 1 });
    expect(single.ok).toBe(true);
    if (single.ok) expect(single.citation).toEqual(cite('romans', 8, 1, 1));
  });

  it('reads a proposal with no verses as the whole chapter', () => {
    const checked = checkCitation({ book: 'Psalm', chapter: 23 });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.citation).toEqual(cite('psalm', 23, 1, 6));
  });

  it('stores the book as its identity rather than as the words that were written', () => {
    const checked = checkCitation({ book: 'ROMANS', chapter: 8, verseStart: 1, verseEnd: 4 });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.citation.book).toBe('romans');
  });
});

// 1.1.5 — one answer to "the same passage", so a list can be de-duplicated without each caller
// inventing its own.
describe('two citations of the same passage are the same citation', () => {
  it('compares equal on the passage and unequal on any part of it', () => {
    expect(citationsEqual(cite('romans', 8, 1, 4), cite('romans', 8, 1, 4))).toBe(true);
    expect(citationKey(cite('romans', 8, 1, 4))).toBe(citationKey(cite('romans', 8, 1, 4)));

    expect(citationsEqual(cite('romans', 8, 1, 4), cite('romans', 8, 1, 5))).toBe(false);
    expect(citationsEqual(cite('romans', 8, 1, 4), cite('romans', 9, 1, 4))).toBe(false);
    expect(citationsEqual(cite('romans', 8, 1, 4), cite('john', 8, 1, 4))).toBe(false);
  });

  it('de-duplicates a list through the key alone', () => {
    const list = [cite('john', 3, 16), cite('romans', 8, 1, 4), cite('john', 3, 16)];
    const unique = [...new Map(list.map((one) => [citationKey(one), one])).values()];

    expect(unique).toHaveLength(2);
  });
});

// 1.1.6 — canon order, which is not alphabetical order and not the order the machine proposed.
describe('a list of citations sorts into canon order', () => {
  it('orders by book, then chapter, then verse', () => {
    const sorted = [
      cite('romans', 8, 9),
      cite('genesis', 1, 1),
      cite('romans', 8, 1),
      cite('john', 3, 16),
      cite('romans', 3, 23),
      cite('exodus', 20, 3),
    ].sort(compareCitations);

    expect(sorted.map(formatCitation)).toEqual([
      'Genesis 1:1',
      'Exodus 20:3',
      'John 3:16',
      'Romans 3:23',
      'Romans 8:1',
      'Romans 8:9',
    ]);
  });

  it('is the canon’s order rather than the alphabet’s', () => {
    // Alphabetically Exodus precedes Genesis, and Acts precedes every gospel.
    const sorted = [cite('exodus', 1, 1), cite('genesis', 1, 1), cite('acts', 1, 1), cite('john', 1, 1)]
      .sort(compareCitations)
      .map((one) => one.book);

    expect(sorted).toEqual(['genesis', 'exodus', 'john', 'acts']);
  });

  it('orders every book of the canon by the declaration rather than by name', () => {
    const shuffled = [...BIBLE_BOOKS].reverse().map((book) => cite(book.id, 1, 1));

    expect(shuffled.sort(compareCitations).map((one) => one.book)).toEqual(
      BIBLE_BOOKS.map((book) => book.id),
    );
  });
});

// 1.1.7 — one renderer, so the review form and the member's panel cannot drift apart.
describe('a citation renders the way a person says it', () => {
  it('renders a verse, a range and a whole chapter', () => {
    expect(formatCitation(cite('john', 3, 16))).toBe('John 3:16');
    expect(formatCitation(cite('romans', 8, 1, 4))).toBe('Romans 8:1–4');
    expect(formatCitation(cite('psalm', 23, 1, 6))).toBe('Psalm 23');
  });

  it('renders a range that stops one verse short of the chapter as a range', () => {
    expect(formatCitation(cite('psalm', 23, 1, 5))).toBe('Psalm 23:1–5');
  });

  it('renders a numbered book with its number', () => {
    expect(formatCitation(cite('1-john', 4, 8))).toBe('1 John 4:8');
  });
});

describe('what arrives from outside is checked for shape before it is read', () => {
  it('recognises a citation and refuses anything that is not one', () => {
    expect(isScriptureCitation(cite('john', 3, 16))).toBe(true);
    expect(isScriptureCitation({ book: 'john', chapter: 3 })).toBe(false);
    expect(isScriptureCitation({ book: 'john', chapter: '3', verseStart: 16, verseEnd: 16 })).toBe(false);
    expect(isScriptureCitation('John 3:16')).toBe(false);
    expect(isScriptureCitation(null)).toBe(false);
  });
});
