/**
 * The negative control for tools/bible-boundary.ts. A second door to the Bible text source, both
 * ways it can be opened: a module that is not the adapter reaching for a client library, and one
 * fetching the source's own document by URL with no dependency at all.
 */
import { fetchPassage } from 'scripture-api-bible';

export const leaked = fetchPassage;

export async function alsoLeaked(chapter: number) {
  return fetch(`https://bible.helloao.org/api/BSB/JHN/${chapter}.simple.json`);
}
