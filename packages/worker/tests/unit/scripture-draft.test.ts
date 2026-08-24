import { describe, expect, it } from 'vitest';
import { formatCitation } from '@thp/shared';
import { readProposedCitations, resolveProposedCitations } from '../../src/scripture-draft';

/**
 * **What the machine proposed, turned into what an admin reviews** (Task 1.3).
 *
 * The two things that happen between a model's answer and a draft: what cannot be a citation is
 * dropped and counted, and what is the same citation twice becomes one. Both exist so the review is
 * spent on judgement rather than on deleting things that cannot exist.
 */

describe('a proposal that cannot be a citation is dropped, and counted', () => {
  // 1.3.3 — the count is what makes a prompt going wrong visible, rather than drafts quietly
  // getting shorter.
  it('drops a book outside the canon and records that it did', () => {
    const draft = resolveProposedCitations([
      { book: 'Romans', chapter: 8, verseStart: 1, verseEnd: 4 },
      { book: 'Hezekiah', chapter: 3, verseStart: 1, verseEnd: 2 },
      { book: 'The Gospel of Thomas', chapter: 1, verseStart: 1, verseEnd: 1 },
    ]);

    expect(draft.citations.map(formatCitation)).toEqual(['Romans 8:1–4']);
    expect(draft.dropped).toBe(2);
  });

  it('drops numbers the book does not have, and counts them the same way', () => {
    const draft = resolveProposedCitations([
      { book: 'Romans', chapter: 51, verseStart: 1, verseEnd: 1 },
      { book: 'John', chapter: 3, verseStart: 1, verseEnd: 99 },
      { book: 'John', chapter: 3, verseStart: 20, verseEnd: 16 },
      { book: 'John', chapter: 3, verseStart: 16, verseEnd: 16 },
    ]);

    expect(draft.citations.map(formatCitation)).toEqual(['John 3:16']);
    expect(draft.dropped).toBe(3);
  });

  it('drops nothing and counts nothing when every proposal is real', () => {
    const draft = resolveProposedCitations([{ book: 'John', chapter: 3, verseStart: 16, verseEnd: 16 }]);

    expect(draft.dropped).toBe(0);
    expect(draft.duplicates).toBe(0);
    expect(draft.citations).toHaveLength(1);
  });
});

// 1.3.4 — the same passage proposed twice is one entry, so an admin is not asked to delete a
// repeat the machine made.
describe('the same passage twice collapses to one entry', () => {
  it('keeps one entry however the duplicate was spelled', () => {
    const draft = resolveProposedCitations([
      { book: 'Romans', chapter: 8, verseStart: 1, verseEnd: 4 },
      { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4 },
      { book: 'ROMANS', chapter: 8, verseStart: 1, verseEnd: 4 },
    ]);

    expect(draft.citations.map(formatCitation)).toEqual(['Romans 8:1–4']);
    expect(draft.duplicates).toBe(2);
  });

  it('does not collapse two different ranges in the same chapter', () => {
    const draft = resolveProposedCitations([
      { book: 'Romans', chapter: 8, verseStart: 1, verseEnd: 4 },
      { book: 'Romans', chapter: 8, verseStart: 1, verseEnd: 5 },
    ]);

    expect(draft.citations).toHaveLength(2);
    expect(draft.duplicates).toBe(0);
  });

  it('reads a whole chapter and its full verse range as the same passage', () => {
    const draft = resolveProposedCitations([
      { book: 'Psalm', chapter: 23 },
      { book: 'Psalm', chapter: 23, verseStart: 1, verseEnd: 6 },
    ]);

    expect(draft.citations.map(formatCitation)).toEqual(['Psalm 23']);
    expect(draft.duplicates).toBe(1);
  });
});

describe('the list an admin opens is in canon order', () => {
  it('orders the survivors by the canon rather than by what the model proposed', () => {
    const draft = resolveProposedCitations([
      { book: 'Revelation', chapter: 1, verseStart: 8, verseEnd: 8 },
      { book: 'Genesis', chapter: 1, verseStart: 1, verseEnd: 1 },
      { book: 'John', chapter: 1, verseStart: 1, verseEnd: 1 },
    ]);

    expect(draft.citations.map(formatCitation)).toEqual([
      'Genesis 1:1',
      'John 1:1',
      'Revelation 1:8',
    ]);
  });
});

describe('what the port handed over is read without being trusted', () => {
  it('reads entries missing a book or a chapter as proposals that will be dropped', () => {
    const proposed = readProposedCitations([
      { chapter: 8, verseStart: 1, verseEnd: 4 },
      { book: 'Romans', verseStart: 1 },
      { book: 'Romans', chapter: '8' },
      null,
      { book: 'Romans', chapter: 8, verseStart: 1, verseEnd: 4 },
    ]);

    expect(proposed).toHaveLength(5);
    const draft = resolveProposedCitations(proposed);
    expect(draft.citations.map(formatCitation)).toEqual(['Romans 8:1–4']);
    expect(draft.dropped).toBe(4);
  });

  it('reads anything that is not a list as no proposals at all', () => {
    expect(readProposedCitations('Romans 8:1-4')).toEqual([]);
    expect(readProposedCitations(undefined)).toEqual([]);
  });
});
