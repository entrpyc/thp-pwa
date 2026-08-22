/**
 * The negative control for tools/visibility-boundary.ts. A second implementation of the member
 * visibility condition, in both spellings this codebase writes queries in — the Drizzle helper and
 * raw SQL. This is the shape a fourth read path would take if somebody wrote its own rule instead
 * of asking the one module that owns it.
 */
import { isNotNull, sql } from 'drizzle-orm';

declare const recording: { readonly publishedAt: unknown; readonly id: unknown };

export const secondRule = isNotNull(recording.publishedAt);

export const thirdRule = sql`select id from recording where published_at is not null`;
