import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { PIPELINE_STEPS, ROLES } from '@thp/shared';

/**
 * The Drizzle schema. Server-only by construction: this package is never imported by a client
 * module, and the import-boundary guard fails the build if it ever is.
 *
 * **Tables arrive with the step that uses them.** Step 1 shipped the migration mechanism and the
 * two domain enums; step 2 adds `user` and `session` and nothing else. `recording`, `job`,
 * `review_item` and the rest are still absent.
 *
 * The enums are **derived** from the shared TypeScript constants rather than restated beside them.
 * That is what keeps "each enum is declared exactly once in the repository" true, and it is
 * enforced by tests/guards/domain-declarations.test.ts.
 */
export const userRole = pgEnum('user_role', ROLES);

export const pipelineStep = pgEnum('pipeline_step', PIPELINE_STEPS);

/**
 * An account. Columns arrive with the steps that use them: `deactivated_at` comes with step 4
 * (account lifecycle) and `preferred_playback_speed` with step 15, so neither is here yet.
 *
 * `email` is stored normalised (trimmed, lowercased) by the application, and uniqueness is
 * enforced on `lower(email)` by the index below — at the database, so two accounts differing only
 * in case are impossible however the row was written.
 */
export const user = pgTable(
  'user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    role: userRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_email_lower_unique').on(sql`lower(${table.email})`)],
);

/**
 * A live sign-in. Sessions are **server-side records**, not signed stateless tokens: the cookie
 * carries an opaque random token and only its SHA-256 hash is stored, so
 *
 * - signing out genuinely ends the session rather than asking the browser to forget it, and
 * - step 4's deactivation can end a session that is already open instead of waiting for expiry.
 *
 * A stateless token makes both unbuildable without a revocation list, which is this table with
 * extra steps.
 */
export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** SHA-256 of the cookie value. The raw token is never stored, so the table cannot leak one. */
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('session_token_hash_unique').on(table.tokenHash)],
);
