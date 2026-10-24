import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_REQUEST,
  MEANING_LABELS,
  SEARCHABLE_KINDS,
  SEARCH_BLEND_STOPS,
  SEARCH_DEFAULT_BLEND,
  SEARCH_DEFAULT_PER_TEACHING,
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  SEARCH_PAGE_SIZE,
  SEARCH_RESULT_LIMIT,
  SIMILARITY_GOOD_MATCH,
  SIMILARITY_STRONG_MATCH,
  meaningLabel,
  readSearchRequest,
  searchPagePath,
  searchPath,
  splitMarkedPassage,
} from '../../src/search';

/**
 * **A search's address, read and written** ([3.10](docs/project/prd.md)): every control has a
 * default that is left out of the address, a spelling the reader accepts, and a spelling it
 * refuses with a sentence rather than ignores.
 */

function read(query: string) {
  return readSearchRequest(new URLSearchParams(query));
}

function accepted(query: string) {
  const check = read(query);
  if (!check.ok) throw new Error(`refused: ${check.problem}`);
  return check.request;
}

describe('the query', () => {
  it('is trimmed and its whitespace collapsed, and an empty one is refused before anything is spent', () => {
    expect(accepted('q=%20the%20%20vine%20').query).toBe('the vine');
    expect(read('q=%20%20')).toMatchObject({ ok: false, problem: 'Type something to search for.' });
    expect(read('')).toMatchObject({ ok: false });
  });

  it('is at most the length limit', () => {
    expect(read(`q=${'a'.repeat(201)}`)).toMatchObject({ ok: false });
    expect(accepted(`q=${'a'.repeat(200)}`).query).toHaveLength(200);
  });

  it('defaults every control when the address names none', () => {
    expect(accepted('q=vine')).toEqual({ ...DEFAULT_SEARCH_REQUEST, query: 'vine' });
    expect(DEFAULT_SEARCH_REQUEST).toEqual({
      kinds: SEARCHABLE_KINDS,
      blend: SEARCH_DEFAULT_BLEND,
      perTeaching: SEARCH_DEFAULT_PER_TEACHING,
      offset: 0,
    });
  });
});

describe('content type', () => {
  it('reads a subset in the canonical order, deduplicated', () => {
    expect(accepted('q=vine&kinds=note,chapter,note').kinds).toEqual(['chapter', 'note']);
  });

  it('treats nothing ticked, and everything ticked, as every kind', () => {
    expect(accepted('q=vine&kinds=').kinds).toEqual(SEARCHABLE_KINDS);
    expect(accepted(`q=vine&kinds=${SEARCHABLE_KINDS.join(',')}`).kinds).toEqual(SEARCHABLE_KINDS);
  });

  it('refuses a kind a search does not know', () => {
    expect(read('q=vine&kinds=chapter,series')).toMatchObject({
      ok: false,
      problem: 'The content types are not ones a search knows.',
    });
    expect(read('q=vine&kinds=everything')).toMatchObject({ ok: false });
  });
});

describe('the words/meaning slider', () => {
  it('accepts each of the five stops', () => {
    for (const stop of SEARCH_BLEND_STOPS) {
      expect(accepted(`q=vine&mix=${stop}`).blend).toBe(stop);
    }
    expect(SEARCH_BLEND_STOPS).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('refuses a value between stops, or one that is not a number', () => {
    expect(read('q=vine&mix=0.6')).toMatchObject({ ok: false });
    expect(read('q=vine&mix=meaning')).toMatchObject({ ok: false });
    expect(read('q=vine&mix=2')).toMatchObject({ ok: false });
  });
});

describe('per teaching', () => {
  it('reads one, three and all', () => {
    expect(accepted('q=vine&per=1').perTeaching).toBe(1);
    expect(accepted('q=vine&per=3').perTeaching).toBe(3);
    expect(accepted('q=vine&per=all').perTeaching).toBeNull();
  });

  it('refuses anything else', () => {
    expect(read('q=vine&per=2')).toMatchObject({ ok: false });
    expect(read('q=vine&per=every')).toMatchObject({ ok: false });
  });
});

describe('the page offset', () => {
  it('reads a multiple of the page size under the result limit', () => {
    expect(accepted('q=vine&offset=10').offset).toBe(10);
    expect(accepted(`q=vine&offset=${SEARCH_RESULT_LIMIT - SEARCH_PAGE_SIZE}`).offset).toBe(40);
    expect(accepted('q=vine&offset=0').offset).toBe(0);
  });

  it('refuses a negative, fractional, off-page or out-of-reach offset', () => {
    expect(read('q=vine&offset=-10')).toMatchObject({ ok: false });
    expect(read('q=vine&offset=5')).toMatchObject({ ok: false });
    expect(read('q=vine&offset=2.5')).toMatchObject({ ok: false });
    expect(read(`q=vine&offset=${SEARCH_RESULT_LIMIT}`)).toMatchObject({ ok: false });
    expect(read('q=vine&offset=ten')).toMatchObject({ ok: false });
  });
});

describe('writing the address', () => {
  it('leaves every default out, so a link says only what the member changed', () => {
    expect(searchPagePath({ query: 'the vine' })).toBe('/search?q=the+vine');
    expect(searchPagePath({ query: 'vine', ...DEFAULT_SEARCH_REQUEST })).toBe('/search?q=vine');
    expect(searchPath({ query: 'vine' })).toBe('/search?q=vine');
  });

  it('writes a changed control in the spelling the reader accepts', () => {
    const address = searchPagePath({
      query: 'vine',
      kinds: ['note', 'chapter'],
      blend: 1,
      perTeaching: null,
      offset: 20,
    });
    expect(address).toBe('/search?q=vine&kinds=chapter%2Cnote&mix=1&per=all&offset=20');
    const back = accepted(address.slice('/search?'.length));
    expect(back).toEqual({ query: 'vine', kinds: ['chapter', 'note'], blend: 1, perTeaching: null, offset: 20 });
    expect(searchPagePath({ query: 'vine', perTeaching: 1 })).toBe('/search?q=vine&per=1');
  });
});

describe('how a match is explained', () => {
  it('buckets a meaning hit by its similarity at the two thresholds, inclusive at the top', () => {
    expect(meaningLabel(0.9)).toBe(MEANING_LABELS.strong);
    expect(meaningLabel(SIMILARITY_STRONG_MATCH)).toBe(MEANING_LABELS.strong);
    expect(meaningLabel(SIMILARITY_STRONG_MATCH - 0.001)).toBe(MEANING_LABELS.good);
    expect(meaningLabel(SIMILARITY_GOOD_MATCH)).toBe(MEANING_LABELS.good);
    expect(meaningLabel(SIMILARITY_GOOD_MATCH - 0.001)).toBe(MEANING_LABELS.related);
    expect(meaningLabel(0)).toBe(MEANING_LABELS.related);
    expect(SIMILARITY_STRONG_MATCH).toBe(0.55);
    expect(SIMILARITY_GOOD_MATCH).toBe(0.4);
  });

  it('splits a marked passage into runs, and reads an unpaired marker as text', () => {
    const marked = `Turn to ${SEARCH_MARK_START}Romans${SEARCH_MARK_END} ${SEARCH_MARK_START}8${SEARCH_MARK_END} today.`;
    expect(splitMarkedPassage(marked)).toEqual([
      { text: 'Turn to ', matched: false },
      { text: 'Romans', matched: true },
      { text: ' ', matched: false },
      { text: '8', matched: true },
      { text: ' today.', matched: false },
    ]);
    expect(splitMarkedPassage('nothing marked')).toEqual([{ text: 'nothing marked', matched: false }]);
    expect(splitMarkedPassage(`odd ${SEARCH_MARK_START}start`)).toEqual([
      { text: `odd ${SEARCH_MARK_START}start`, matched: false },
    ]);
    expect(splitMarkedPassage('')).toEqual([]);
  });
});
