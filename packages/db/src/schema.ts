import { sql } from 'drizzle-orm';
import { date, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { PIPELINE_STEPS, ROLES } from '@thp/shared';

/**
 * The Drizzle schema. Server-only by construction: this package is never imported by a client
 * module, and the import-boundary guard fails the build if it ever is.
 *
 * **Tables arrive with the ticket that uses them.** Ticket 1 shipped the migration mechanism and the
 * two domain enums; ticket 2 added `user` and `session`; ticket 3 added `invitation`; ticket 4 added
 * `password_reset`. Story 2 Ticket 01 adds `recording` and nothing else — `job`, `transcript`,
 * `segment`, `review_item` and the rest are still absent.
 *
 * The enums are **derived** from the shared TypeScript constants rather than restated beside them.
 * That is what keeps "each enum is declared exactly once in the repository" true, and it is
 * enforced by tests/guards/domain-declarations.test.ts.
 */
export const userRole = pgEnum('user_role', ROLES);

export const pipelineStep = pgEnum('pipeline_step', PIPELINE_STEPS);

/**
 * An account. Columns arrive with the steps that use them: `deactivated_at` comes with ticket 4
 * (account lifecycle) and `preferred_playback_speed` with ticket 15, so the second is not here yet.
 * Neither is an avatar — docs/project/prd.md 3.1.12's is deferred, and a nullable column "for later" is how
 * deferral quietly stops being deferral.
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
    /**
     * **Deactivation is a timestamp, not a deleted row** (docs/project/prd.md, 3.1.7). The account, its
     * password hash and everything it authored survive intact; what changes is that no session
     * resolves to it and no password signs it in. Nullable, so the inverse — reactivation — is the
     * same write with `null`, and so "active" is a fact about the column rather than a second
     * status somebody has to keep in step with it.
     */
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('user_email_lower_unique').on(sql`lower(${table.email})`)],
);

/**
 * A live sign-in. Sessions are **server-side records**, not signed stateless tokens: the cookie
 * carries an opaque random token and only its SHA-256 hash is stored, so
 *
 * - signing out genuinely ends the session rather than asking the browser to forget it, and
 * - ticket 4's deactivation can end a session that is already open instead of waiting for expiry.
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

/**
 * A pending invitation. **The only way an account comes to exist** other than the seed command
 * (docs/project/prd.md, 3.1.3), which is why the row and the account it becomes share an email column and
 * a role column reading the same `user_role` enum rather than a second copy of it.
 *
 * Three properties this table holds, none of them by convention:
 *
 * 1. **The raw token is never stored.** As with `session`, only its SHA-256 is — so the table
 *    cannot leak a working invitation link however it is read.
 * 2. **At most one *live* invitation per address.** The partial unique index below covers
 *    `lower(email)` only where the row is neither revoked nor accepted, so inviting an address
 *    twice is refused at the database and an admin is pointed at resend instead of quietly
 *    creating a second token. Revoking or accepting frees the address again, which is exactly what
 *    makes resend (revoke the old, issue a new) legal.
 * 3. **Status is derived, never stored.** `expires_at`, `revoked_at` and `accepted_at` are the
 *    facts; pending/expired/revoked/accepted is read off them. A stored status is a second source
 *    of truth that a clock can make wrong.
 *
 * `invited_by` is nullable on delete rather than cascading: the invitation is a record of something
 * that happened, and it should survive the admin's account being removed.
 */
export const invitation = pgTable(
  'invitation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    role: userRole('role').notNull(),
    /** SHA-256 of the token in the emailed link. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('invitation_token_hash_unique').on(table.tokenHash),
    uniqueIndex('invitation_live_email_unique')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.revokedAt} is null and ${table.acceptedAt} is null`),
  ],
);

/**
 * A password reset in flight (docs/project/prd.md, 3.1.6).
 *
 * Its own table rather than a second life for `invitation`, because the two look alike and are not:
 * an invitation is keyed by an *address with no account* and creates one; a reset is keyed by an
 * *existing account* and changes it. Sharing a table would mean a nullable `user_id`, a `kind`
 * column and two sets of rules in one place.
 *
 * The token shape is identical, though, and deliberately so — 32 random bytes, base64url, SHA-256
 * at rest, the same helpers `session` and `invitation` use. Three properties, all held by the
 * database rather than by a caller remembering:
 *
 * 1. **The raw token is never stored.** Only its SHA-256 is, so the table cannot leak a working
 *    reset link however it is read.
 * 2. **At most one *live* reset per account.** The partial unique index covers `user_id` only where
 *    the row is neither used nor revoked, so requesting a second reset while one is outstanding is
 *    refused at the database — which is what makes "revoke the old, issue the new" the only legal
 *    way to re-send, and therefore what makes "exactly one link works" true.
 * 3. **Status is derived, never stored.** `expires_at`, `used_at` and `revoked_at` are the facts;
 *    pending/expired/used/revoked is read off them.
 *
 * `user_id` cascades: a reset is meaningless without the account it resets, and unlike an
 * invitation it is not a record of something that happened to somebody else.
 */
export const passwordReset = pgTable(
  'password_reset',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token in the emailed link. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('password_reset_token_hash_unique').on(table.tokenHash),
    uniqueIndex('password_reset_live_user_unique')
      .on(table.userId)
      .where(sql`${table.usedAt} is null and ${table.revokedAt} is null`),
  ],
);

/**
 * A recording (Story 2 Ticket 01) — the first row in the spine
 * docs/epics/epic-core-listening/architecture.md § Data model draws as
 * `Series 1—* Recording 1—1 Transcript 1—* Segment`.
 *
 * **What is absent is the design.** There is no `duration`, because nothing inspects the media in
 * this epic ([§3.4](docs/project/prd.md) is deferred whole); no `processed_media_key`, because no
 * processed rendition exists and that column is the named seam
 * (docs/epics/epic-core-listening/architecture.md § Extension points, "Second media pointer"); and
 * no `series_id`, because series arrive in Story 6 and a recording with no series is the only kind
 * there is (docs/project/prd.md, 3.3.9). A nullable column added "for later" is how deferral
 * quietly stops being deferral, so the migration test asserts the exact column set rather than
 * trusting this comment.
 *
 * Two columns *are* here and nothing writes them, and they are here for a different reason:
 * `published_at` and `description` are what the row means, not what a later step adds to it.
 * Publishing is a timestamp on the recording (3.2.2, 3.2.11) exactly as deactivation is one on the
 * account, and the description is a field of the recording that Story 3 generates. Both ship
 * nullable and unwritten.
 *
 * `original_media_key` is where the bytes are, and it is **unique** — the same object cannot become
 * two recordings, which is what makes "finalising the same key twice produces exactly one row" a
 * property of the database rather than of a check-then-insert with a window in it. It is a key, not
 * a URL: the bucket is never publicly addressable, and every read is a signed URL minted after an
 * authorisation check.
 *
 * `recorded_at` is a `date`, not a timestamp. docs/project/prd.md 4.2 calls it the date recorded,
 * and it is the list's primary sort key; a time of day nobody supplies is a time of day somebody
 * will one day read as meaningful.
 */
export const recording = pgTable(
  'recording',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Where the original sits in the object store. Never overwritten, never deleted. */
    originalMediaKey: text('original_media_key').notNull(),
    title: text('title').notNull(),
    recordedAt: date('recorded_at').notNull(),
    /** `null` until Story 3 Ticket 04 publishes it. Nothing in this ticket writes it. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Generated in Story 3. Nothing in this ticket writes it. */
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('recording_original_media_key_unique').on(table.originalMediaKey)],
);
