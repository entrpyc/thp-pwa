/**
 * **The `segment` table and the shared `Segment` type say the same thing.**
 *
 * The timestamped segment is the atom of the whole system: notes, highlights, mind maps, search,
 * cross-references and Flow Tracker all resolve through `(recording_id, timestamp_ms)` in later
 * scopes (project tdd 3.1). The client, the API and the worker agree on
 * one shape for it — `packages/shared/src/segment.ts` — and the table was matched to that type
 * rather than invented beside it. A column the type does not have, or a field the table does not
 * have, is the two quietly becoming two shapes.
 *
 * The table is read as a **value**, from Drizzle, so the check cannot be fooled by how the schema
 * was written. The interface has to be read as **source**, because a TypeScript interface does not
 * exist at runtime — there is nothing else to read it off.
 */

/** `startMs` -> `start_ms`. The convention Drizzle's column names already follow. */
export function toSnakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * The property names declared inside `export interface <name> { … }`.
 *
 * Comments are stripped first: the interface documents what inclusive and exclusive mean, and the
 * words in that prose are not fields.
 */
export function interfaceFields(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`no \`export interface ${name}\` in the source given`);

  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`the ${name} interface body is not closed`);

  const body = source
    .slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  return [...body.matchAll(/(?:^|[;\n])\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[?]?\s*:/g)]
    .map((match) => match[1])
    .filter((field): field is string => field !== undefined);
}
