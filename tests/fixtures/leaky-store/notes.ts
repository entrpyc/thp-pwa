/**
 * The negative control for `checkStoreExportSurface` in tools/import-boundary.ts. A store module
 * that lets the query builder out through its own public surface, in all three shapes the check
 * refuses — a type imported from `drizzle-orm` by either spelling, a table's inferred row type, and
 * a re-export of the builder itself.
 *
 * This is what `packages/db/src/notes.ts` would look like if "row types in, row types out" were a
 * comment rather than something a build can fail on.
 */
import type { SQL } from 'drizzle-orm';
import { eq, type SQLWrapper } from 'drizzle-orm';

export { and } from 'drizzle-orm';

declare const note: { readonly id: unknown; readonly $inferSelect: unknown };

export type LeakedRow = typeof note.$inferSelect;

export function leakedCondition(id: string): SQL | SQLWrapper {
  return eq(note.id as never, id) as unknown as SQL;
}
