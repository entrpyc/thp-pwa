import { describe, expect, it } from 'vitest';
import { checkCitation, type ScriptureCitation } from '@thp/shared';
import { buildBibleSource } from '../../src/index';
import { fakeBibleSource } from '../../src/fake';
import { freeUseBibleSource, type HttpTransport } from '../../src/free-use';

/**
 * **The port, and the one adapter behind it** ([3.1.1](docs/active-scope/implementation-plan.md),
 * [3.1.5](docs/active-scope/implementation-plan.md)).
 *
 * Every case here drives the adapter through an injected transport, so the suite reaches no source
 * — which is the same property `THP_MOCK_EXTERNAL` gives a running process, held here by
 * construction rather than by configuration.
 */

function citation(input: {
  book: string;
  chapter: number;
  verseStart?: number;
  verseEnd?: number;
}): ScriptureCitation {
  const checked = checkCitation({
    book: input.book,
    chapter: input.chapter,
    verseStart: input.verseStart ?? null,
    verseEnd: input.verseEnd ?? null,
  });
  if (!checked.ok) throw new Error(checked.problem.message);
  return checked.citation;
}

/** A chapter as the source answers with it, in the shape the adapter has to read. */
function chapterBody(verses: readonly { number: number; text: string }[]): string {
  return JSON.stringify({
    chapter: {
      number: 3,
      content: [
        { type: 'heading', text: 'A heading the passage is not' },
        ...verses.map((one) => ({ type: 'verse', number: one.number, text: one.text })),
        { type: 'line_break' },
      ],
    },
  });
}

function transportReturning(
  body: string,
  init: { ok?: boolean; status?: number; requestId?: string | null } = {},
): { transport: HttpTransport; urls: string[] } {
  const urls: string[] = [];
  const transport: HttpTransport = async (url) => {
    urls.push(url);
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'x-amz-cf-id' ? (init.requestId ?? null) : null) },
      text: async () => body,
    };
  };
  return { transport, urls };
}

const OPTIONS = { baseUrl: 'https://source.test', translation: 'BSB' };

describe('the real source, behind the port', () => {
  it('answers a citation with the verses of it, in verse order', async () => {
    const { transport, urls } = transportReturning(
      chapterBody([
        { number: 1, text: 'The first verse.' },
        { number: 2, text: 'The second verse.' },
        { number: 3, text: 'The third verse.' },
      ]),
      { requestId: 'call-abc' },
    );
    const source = freeUseBibleSource({ ...OPTIONS, transport });

    const passage = await source.readPassage(citation({ book: 'john', chapter: 3, verseStart: 2, verseEnd: 3 }));

    expect(passage.verses).toEqual([
      { number: 2, text: 'The second verse.' },
      { number: 3, text: 'The third verse.' },
    ]);
    // The source's own identifier for the call, which is what 3.2.5 records on the job.
    expect(passage.requestId).toBe('call-abc');
    // One call per chapter, at the translation and the chapter the citation names.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('BSB');
    expect(urls[0]).toContain('/3');
  });

  it('takes only the verses the citation asked for, out of a whole chapter', async () => {
    const { transport } = transportReturning(
      chapterBody([
        { number: 1, text: 'One.' },
        { number: 2, text: 'Two.' },
        { number: 3, text: 'Three.' },
      ]),
    );
    const source = freeUseBibleSource({ ...OPTIONS, transport });

    const passage = await source.readPassage(citation({ book: 'john', chapter: 3, verseStart: 2, verseEnd: 2 }));
    expect(passage.verses).toEqual([{ number: 2, text: 'Two.' }]);
  });

  // 3.1.5 — three ways of having nothing, one answer.
  it('answers with no text when the source refuses', async () => {
    const { transport } = transportReturning('nope', { ok: false, status: 500 });
    const source = freeUseBibleSource({ ...OPTIONS, transport });

    const passage = await source.readPassage(citation({ book: 'john', chapter: 3 }));
    expect(passage.verses).toEqual([]);
  });

  it('answers with no text when the call throws or times out', async () => {
    const failing: HttpTransport = async () => {
      throw new Error('socket hang up');
    };
    const source = freeUseBibleSource({ ...OPTIONS, transport: failing });

    await expect(source.readPassage(citation({ book: 'john', chapter: 3 }))).resolves.toEqual({
      verses: [],
      requestId: null,
    });
  });

  it('answers with no text when the body is not what the source promised', async () => {
    const { transport } = transportReturning('<!doctype html><html></html>');
    const source = freeUseBibleSource({ ...OPTIONS, transport });

    const passage = await source.readPassage(citation({ book: 'john', chapter: 3 }));
    expect(passage.verses).toEqual([]);
  });

  it('answers with no text when the chapter holds none of the verses asked for', async () => {
    const { transport } = transportReturning(chapterBody([{ number: 1, text: 'One.' }]));
    const source = freeUseBibleSource({ ...OPTIONS, transport });

    const passage = await source.readPassage(citation({ book: 'john', chapter: 3, verseStart: 9, verseEnd: 9 }));
    expect(passage.verses).toEqual([]);
  });

  it('knows a code for every book of the canon, so no citation is unaskable', async () => {
    // Without this, a book the mapping happens to miss would degrade to "no text" forever and look
    // exactly like a source that was down.
    const { transport, urls } = transportReturning(chapterBody([{ number: 1, text: 'One.' }]));
    const source = freeUseBibleSource({ ...OPTIONS, transport });

    const { BIBLE_BOOKS } = await import('@thp/shared');
    for (const book of BIBLE_BOOKS) {
      await source.readPassage(citation({ book: book.id, chapter: 1, verseStart: 1, verseEnd: 1 }));
    }
    expect(urls).toHaveLength(BIBLE_BOOKS.length);
    expect(new Set(urls).size).toBe(BIBLE_BOOKS.length);
  });
});

describe('the fake, which reaches nothing', () => {
  it('answers every verse of the range with text that says what it is', async () => {
    const source = fakeBibleSource();
    const passage = await source.readPassage(citation({ book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4 }));

    expect(passage.verses.map((one) => one.number)).toEqual([1, 2, 3, 4]);
    expect(passage.verses.every((one) => one.text.trim() !== '')).toBe(true);
    // No source was called, so there is no call to identify.
    expect(passage.requestId).toBeNull();
  });
});

describe('which one a process gets', () => {
  it('is the fake whenever the switch is on, whatever else is named', () => {
    expect(
      buildBibleSource({ THP_MOCK_EXTERNAL: 'true', BIBLE_SOURCE: 'free-use', BIBLE_TRANSLATION: 'BSB' }).name,
    ).toBe('fake');
  });

  it('is the real one otherwise', () => {
    expect(
      buildBibleSource({
        BIBLE_SOURCE: 'free-use',
        BIBLE_BASE_URL: 'https://source.test',
        BIBLE_TRANSLATION: 'BSB',
      }).name,
    ).toBe('free-use');
  });
});
