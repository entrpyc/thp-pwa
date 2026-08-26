import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { createDatabase, findHeldVerses, runMigrations, saveVerseTexts } from '@thp/db';
import type { DatabaseHandle } from '@thp/db';
import { resolvePassages, type BibleSource, type Passage } from '@thp/bible';
import { checkCitation, type ScriptureCitation } from '@thp/shared';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * **The verse cache, read the way the product reads it**
 * (scope plan 3.2.2).
 *
 * The resolver lives beside the source and the rows live here, so the property worth asserting is
 * the one that spans them: a passage already held is never asked for again, and a passage that is
 * not held is asked for exactly once and then is.
 *
 * Against a real Postgres, because the whole claim is about what a second call finds in the
 * database — a fake store would be asserting the fake.
 */

const TRANSLATION = 'test-translation';

function citation(book: string, chapter: number, verseStart?: number, verseEnd?: number): ScriptureCitation {
  const checked = checkCitation({
    book,
    chapter,
    verseStart: verseStart ?? null,
    verseEnd: verseEnd ?? null,
  });
  if (!checked.ok) throw new Error(checked.problem.message);
  return checked.citation;
}

/** A source that counts what it was asked for, so "never fetched again" is measurable. */
function countingSource(text = 'A verse the source answered with.'): BibleSource & {
  readonly asked: ScriptureCitation[];
} {
  const asked: ScriptureCitation[] = [];
  return {
    name: 'counting',
    asked,
    async readPassage(one: ScriptureCitation): Promise<Passage> {
      asked.push(one);
      const verses = [];
      for (let number = one.verseStart; number <= one.verseEnd; number += 1) {
        verses.push({ number, text: `${text} (${number})` });
      }
      return { verses, requestId: `call-${asked.length}` };
    },
  };
}

describe('verse text is fetched once and held', () => {
  let target: ThrowawayDatabase;
  let handle: DatabaseHandle;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'verse_cache');
    await runMigrations({ url: target.url });
    handle = createDatabase({ url: target.url, max: 2 });
    sql = postgres(target.url, { max: 1, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await handle?.close();
    await target?.drop();
  }, 60_000);

  beforeEach(async () => {
    await sql`delete from verse_text`;
  });

  const resolve = (citations: readonly ScriptureCitation[], source: BibleSource) =>
    resolvePassages(citations, { source, translation: TRANSLATION, executor: handle.db });

  it('fetches a passage nobody holds, and holds it', async () => {
    const source = countingSource();
    const result = await resolve([citation('john', 3, 16, 17)], source);

    expect(source.asked).toHaveLength(1);
    expect(result.fetched).toBe(2);
    expect(result.held).toBe(0);
    expect(result.passages[0]?.verses.map((one) => one.number)).toEqual([16, 17]);

    const rows = await findHeldVerses(TRANSLATION, [{ book: 'john', chapter: 3 }], handle.db);
    expect(rows.map((row) => row.verse)).toEqual([16, 17]);
  });

  it('reads what is already held and calls the source not at all', async () => {
    const first = countingSource();
    await resolve([citation('john', 3, 16, 17)], first);

    // A second resolution of the same passage — the whole of 3.3.2, and the line the running-cost
    // estimate is built on.
    const second = countingSource();
    const result = await resolve([citation('john', 3, 16, 17)], second);

    expect(second.asked).toEqual([]);
    expect(result.fetched).toBe(0);
    expect(result.held).toBe(2);
    expect(result.passages[0]?.verses.map((one) => one.text)).toEqual(
      first.asked.length > 0
        ? ['A verse the source answered with. (16)', 'A verse the source answered with. (17)']
        : [],
    );
  });

  it('serves a second teaching citing the same verse from what the first one fetched', async () => {
    await resolve([citation('romans', 8, 1, 4)], countingSource());

    // A narrower citation of the same chapter: entirely inside what is held, so nothing is asked.
    const later = countingSource();
    const result = await resolve([citation('romans', 8, 2, 3)], later);

    expect(later.asked).toEqual([]);
    expect(result.held).toBe(2);
    expect(result.passages[0]?.verses.map((one) => one.number)).toEqual([2, 3]);
  });

  it('calls the source only for what is missing, and not for what is beside it', async () => {
    await resolve([citation('acts', 2, 1, 2)], countingSource());

    const source = countingSource('Fresh text.');
    const result = await resolve(
      [citation('acts', 2, 1, 2), citation('acts', 2, 1, 4), citation('psalm', 23)],
      source,
    );

    // The first is held in full and is not asked for. The second overlaps it and is, because the
    // source answers a passage rather than a verse. The third is untouched and is.
    expect(source.asked.map((one) => `${one.book} ${one.chapter}`)).toEqual([
      'acts 2',
      'psalm 23',
    ]);
    expect(result.passages[0]?.verses.map((one) => one.number)).toEqual([1, 2]);
    expect(result.passages[1]?.verses.map((one) => one.number)).toEqual([1, 2, 3, 4]);
    expect(result.passages[2]?.verses).toHaveLength(6);
  });

  it('leaves the text that was already held exactly as it was', async () => {
    await resolve([citation('jude', 1, 1, 1)], countingSource('The first answer.'));
    await resolve([citation('jude', 1, 1, 2)], countingSource('A later answer.'));

    const rows = await findHeldVerses(TRANSLATION, [{ book: 'jude', chapter: 1 }], handle.db);
    // Verse 1 keeps what the source said the first time; verse 2 is new and takes the later text.
    expect(rows.find((row) => row.verse === 1)?.text).toContain('The first answer.');
    expect(rows.find((row) => row.verse === 2)?.text).toContain('A later answer.');
  });

  it('answers a passage the source has no text for with no verses, and holds none', async () => {
    const empty: BibleSource = {
      name: 'empty',
      async readPassage(): Promise<Passage> {
        return { verses: [], requestId: null };
      },
    };

    const result = await resolve([citation('obadiah', 1, 1, 1)], empty);

    expect(result.passages[0]?.verses).toEqual([]);
    expect(result.fetched).toBe(0);
    expect(await findHeldVerses(TRANSLATION, [{ book: 'obadiah', chapter: 1 }], handle.db)).toEqual(
      [],
    );
  });

  it('holds a verse under its translation, so another translation is another row', async () => {
    await resolve([citation('titus', 1, 1, 1)], countingSource());
    await saveVerseTexts(
      [{ translation: 'another', book: 'titus', chapter: 1, verse: 1, text: 'Elsewhere.' }],
      handle.db,
    );

    const ours = await findHeldVerses(TRANSLATION, [{ book: 'titus', chapter: 1 }], handle.db);
    const theirs = await findHeldVerses('another', [{ book: 'titus', chapter: 1 }], handle.db);
    expect(ours).toHaveLength(1);
    expect(theirs.map((row) => row.text)).toEqual(['Elsewhere.']);
  });

  it('carries the source’s own identifier for the call it made', async () => {
    const source = countingSource();
    const result = await resolve([citation('philemon', 1, 1, 1)], source);
    expect(result.requestId).toBe('call-1');

    // Nothing was called the second time, so there is no call to identify.
    const again = await resolve([citation('philemon', 1, 1, 1)], countingSource());
    expect(again.requestId).toBeNull();
  });
});
