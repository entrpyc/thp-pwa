import { describe, expect, it } from 'vitest';
import {
  REVIEW_FIELD,
  REVIEW_FIELD_SHAPES,
  REVIEW_KINDS,
  REVIEW_KIND_LABEL,
  type ReviewFieldValue,
  type ReviewItemView,
} from '@thp/shared';

/**
 * **The review contract, once scripture is in it** (Task 1.2).
 *
 * The one thing this file is for: the field-per-kind map widened from *a name* to *a name and a
 * shape*, and **the two text kinds did not change**. Everything downstream of that map — the
 * generator, the approve path, the form — reads the shape rather than the kind, so a fourth
 * artefact is a value here rather than a branch somewhere else.
 */

describe('every kind says what field it carries and what shape that field is', () => {
  it('answers for every kind, with no kind left to a fallback', () => {
    for (const kind of REVIEW_KINDS) {
      const field = REVIEW_FIELD[kind];
      expect(field.name, `${kind} must name a field`).not.toBe('');
      expect(REVIEW_FIELD_SHAPES, `${kind} must be a shape that exists`).toContain(field.shape);
      expect(REVIEW_KIND_LABEL[kind], `${kind} must be named on screen`).not.toBe('');
    }
  });

  it('gives each kind a field name of its own, so two kinds cannot collide in one row', () => {
    const names = REVIEW_KINDS.map((kind) => REVIEW_FIELD[kind].name);
    expect(new Set(names).size).toBe(names.length);
  });

  // 1.2.2 — the two existing kinds keep their single text field, unchanged in name and in shape.
  it('leaves the two text kinds exactly as they were', () => {
    expect(REVIEW_FIELD.summary).toEqual({ name: 'summary', shape: 'text' });
    expect(REVIEW_FIELD.recording_metadata).toEqual({ name: 'description', shape: 'text' });
  });

  it('declares scripture as the one list-shaped kind', () => {
    expect(REVIEW_FIELD.scripture.shape).toBe('list');
    expect(
      REVIEW_KINDS.filter((kind) => REVIEW_FIELD[kind].shape === 'list'),
    ).toEqual(['scripture']);
  });
});

describe('a field value is one of the shapes a kind may declare', () => {
  /**
   * A reader that asks the *shape* rather than the kind — which is the whole point of the widening,
   * written out as the code a caller would write.
   */
  function render(kind: (typeof REVIEW_KINDS)[number], value: ReviewFieldValue): string {
    return REVIEW_FIELD[kind].shape === 'list'
      ? `${(value as readonly unknown[]).length} entries`
      : `${(value as string).length} characters`;
  }

  it('reads a text draft and a list draft through the same one branch', () => {
    expect(render('summary', 'four')).toBe('4 characters');
    expect(render('recording_metadata', 'four')).toBe('4 characters');
    expect(
      render('scripture', [{ book: 'john', chapter: 3, verseStart: 16, verseEnd: 16, anchorMs: null }]),
    ).toBe('1 entries');
  });

  it('lets one item carry a list where another carries a paragraph', () => {
    // The `fields` map on the wire is keyed by field name and holds whatever shape that field is,
    // which is what keeps one queue and one payload type over kinds that are not alike.
    const view: Pick<ReviewItemView, 'fields'> = {
      fields: { citations: [{ book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4, anchorMs: null }] },
    };
    expect(Array.isArray(view.fields['citations'])).toBe(true);

    const text: Pick<ReviewItemView, 'fields'> = { fields: { summary: 'A paragraph.' } };
    expect(typeof text.fields['summary']).toBe('string');
  });
});
