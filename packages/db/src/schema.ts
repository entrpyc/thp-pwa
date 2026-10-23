import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import {
  ANNOUNCEMENT_KINDS,
  CROSS_REFERENCE_BASES,
  DEFAULT_PLAYBACK_SPEED,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_SOURCE_KINDS,
  HIGHLIGHT_KINDS,
  JOB_STATUSES,
  JOB_STEPS,
  MAX_ANNOUNCEMENT_BODY_LENGTH,
  MAX_ANNOUNCEMENT_TITLE_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_REPORT_DETAIL_LENGTH,
  MAX_SOUND_PROFILE_NOTE_LENGTH,
  MAX_PUSH_ENDPOINT_LENGTH,
  MAX_TAG_LENGTH,
  NOTE_VISIBILITIES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_KINDS,
  PLAYBACK_SPEEDS,
  PUSH_PLATFORMS,
  REPORT_OUTCOMES,
  REPORT_REASONS,
  REVIEW_KINDS,
  REVIEW_STATUSES,
  ROLES,
  SCRIPTURE_ORIGINS,
  SOUND_PROFILE_BOUNDS,
  SYNC_ENTRY_KINDS,
  SYNC_RESULT_STATUSES,
  UNFINISHED_JOB_STATUSES,
} from '@thp/shared';

/**
 * The Drizzle schema. Server-only by construction: this package is never imported by a client
 * module, and the import-boundary guard fails the build if it ever is.
 *
 * **Tables arrive with the ticket that uses them.** Ticket 1 shipped the migration mechanism and the
 * two domain enums; ticket 2 added `user` and `session`; ticket 3 added `invitation`; ticket 4 added
 * `password_reset`. Story 2 Ticket 01 adds `recording`, Ticket 02 the `job` ledger beneath it, and
 * Ticket 03 `transcript` and `segment`. Story 3 Ticket 01 adds `review_item` and `summary`, and
 * Story 4 Ticket 04 adds `playback_progress`. Story 6 Ticket 01 adds `series` — the last table
 * of this epic, and the only one that is a new entity rather than a column.
 *
 * The enums are **derived** from the shared TypeScript constants rather than restated beside them.
 * That is what keeps "each enum is declared exactly once in the repository" true, and it is
 * enforced by tests/guards/domain-declarations.test.ts.
 *
 * **What happens to a table's rows when an account is deleted is decided once**, in
 * [README.md](./README.md) beside this file — which rows go with the account, which authored
 * content is kept under a placeholder, what the audit log keeps and what happens to storage
 * objects. Every foreign key to `user` below states its `onDelete` to match that text, and a later
 * table follows the convention by reading it and declaring its own clause; the deletion service
 * never has to learn the table's name.
 */
export const userRole = pgEnum('user_role', ROLES);

/**
 * Every step the ledger can hold: the chain, then the standalone steps the sound profile added
 * ([§3.4](docs/project/prd.md)). Derived from `JOB_STEPS` rather than from `PIPELINE_STEPS` because
 * the column holds both, and the chain rule reads the narrower list on its own.
 */
export const pipelineStep = pgEnum('pipeline_step', JOB_STEPS);

export const jobStatus = pgEnum('job_status', JOB_STATUSES);

export const reviewKind = pgEnum('review_kind', REVIEW_KINDS);

export const reviewStatus = pgEnum('review_status', REVIEW_STATUSES);

export const noteVisibility = pgEnum('note_visibility', NOTE_VISIBILITIES);

export const scriptureOrigin = pgEnum('scripture_origin', SCRIPTURE_ORIGINS);

export const notificationKind = pgEnum('notification_kind', NOTIFICATION_KINDS);

/** The four categories a member switches push for, and the three places a push can reach. Both derived. */
export const notificationCategory = pgEnum('notification_category', NOTIFICATION_CATEGORIES);

export const pushPlatform = pgEnum('push_platform', PUSH_PLATFORMS);

export const embeddingSource = pgEnum('embedding_source', EMBEDDING_SOURCE_KINDS);

/** Why a member reported a note, and what an admin did about it. Both derived, never restated. */
export const reportReason = pgEnum('report_reason', REPORT_REASONS);

export const reportOutcome = pgEnum('report_outcome', REPORT_OUTCOMES);

/** Why two moments are linked ([3.9.3](docs/project/prd.md)). Derived, never restated. */
export const crossReferenceBasis = pgEnum('cross_reference_basis', CROSS_REFERENCE_BASES);
export const highlightKind = pgEnum('highlight_kind', HIGHLIGHT_KINDS);

/**
 * An account. Columns arrive with the steps that use them: `deactivated_at` comes with ticket 4
 * (account lifecycle), `preferred_playback_speed` with Story 4 Ticket 03, which is where the
 * speed control that writes it ships, and `avatar_key` with the profile screen — the first surface
 * that could set one, and therefore the first moment docs/project/prd.md 3.1.12's avatar stopped
 * being a nullable column "for later".
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
    /**
     * **The speed this person hears every teaching at** (Story 4 Ticket 03,
     * [3.2.4](docs/project/prd.md)).
     *
     * On the *user*, not on the recording, because the requirement is that a chosen speed persists
     * across recordings — a column per pairing would make "the next teaching plays at 1.5x too"
     * something the client had to remember rather than something the account is.
     *
     * `real` because it is a rate, not money. `NOT NULL DEFAULT 1` because every account that
     * already exists plays at normal speed and nobody should have to be back-filled by hand. The
     * check constraint is the steps themselves, **derived from the shared tuple** rather than
     * restated — so the column cannot hold a rate no control can produce, and another step is one
     * edit there plus one migration. `1.75` was exactly that, in `0017`.
     */
    preferredPlaybackSpeed: real('preferred_playback_speed')
      .notNull()
      .default(DEFAULT_PLAYBACK_SPEED),
    /**
     * **The object key of this person's avatar, or `null`** — the ordinary state
     * ([3.1.12](docs/project/prd.md): optional), and the one every existing account keeps.
     *
     * One nullable pointer and nothing beside it, exactly as `series.artwork_key` is: width,
     * height, byte size and content type are what the store already knows and `head` already
     * answers, and a second copy of them here would be a second copy that could drift. Replacing an
     * avatar writes a new key and leaves the old object where it is — the store has no delete, and
     * the orphan is the accepted price.
     */
    avatarKey: text('avatar_key'),
    /**
     * **Whether this person has turned product analytics off** (Apple guideline 5.1.1(ii): an app
     * that collects usage data offers an easy way to withdraw consent).
     *
     * On the account rather than on the device, so that withdrawing consent on a phone is
     * withdrawing it on the laptop too — a consent that had to be withdrawn once per device would
     * be one the member could never be sure they had withdrawn. `NOT NULL DEFAULT false` because
     * every account that already exists is collected from today and keeps being, and the column
     * names the exception rather than the rule: the row says "opted out", not "consented", so a
     * row written before this column existed reads as what it always was.
     *
     * Read into the session payload beside `preferred_playback_speed`, for the same reason: the
     * client has to know before its first event whether it may send one, and a second request to
     * learn a boolean would be a window in which it already had.
     */
    analyticsOptedOut: boolean('analytics_opted_out').notNull().default(false),
    /**
     * **Set only on a placeholder row** — what is left of an account after its owner deleted it
     * ([3.1.8](docs/project/prd.md), [3.1.10](docs/project/prd.md); README.md beside this file).
     *
     * A deleted account is not an erased row: it is a *fresh* row, carrying a sentinel address, the
     * name "Removed member", a hash nothing verifies against and this timestamp, that the person's
     * public notes were re-pointed at before the real row was deleted. The real row going is what
     * fires every cascade and set-null below exactly as declared, so the schema is the convention
     * rather than a list the service keeps; the placeholder is what keeps a thread's shape
     * (3.1.10) without keeping the person.
     *
     * Nullable, and `null` on every account anybody can sign in to. A placeholder is also
     * deactivated — the check below says so — so the session join, the notification fan-out and
     * the last-admin count all leave it out without being taught about a second state.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /**
     * **Which terms this person agreed to, and when** (Google Play's user-generated-content policy:
     * a member accepts the terms before they post; Apple 1.2 asks for the same in other words).
     *
     * The version is the terms page's "last updated" day as a `YYYY-MM-DD` string — `TERMS_VERSION`
     * in `@thp/shared` — because that is the one thing a member can read on the page they accepted
     * and the one thing that has to change when the terms do. Two columns rather than a boolean:
     * a boolean says "agreed" and cannot say *to what*, so the day the terms change it would have
     * to be reset for everybody, and the row would stop being a record of anything.
     *
     * **Both nullable, and `null` on every account that already exists.** Nothing is back-filled:
     * an account that predates the column, or that came in through an invitation rather than the
     * sign-up form, has not accepted anything and is asked before its next note — which is the
     * honest reading of the row, and the one an app review would want. A null version with a
     * non-null date, or the reverse, is a row that says two things; the check below refuses it.
     */
    termsAcceptedVersion: text('terms_accepted_version'),
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('user_email_lower_unique').on(sql`lower(${table.email})`),
    /** A placeholder cannot be an account somebody signs in to: deleted implies deactivated. */
    check(
      'user_deleted_is_deactivated',
      sql`${table.deletedAt} is null or ${table.deactivatedAt} is not null`,
    ),
    /** An acceptance is a version and a moment together, or nothing. */
    check(
      'user_terms_acceptance_whole',
      sql`(${table.termsAcceptedVersion} is null) = (${table.termsAcceptedAt} is null)`,
    ),
    check(
      'user_preferred_playback_speed_allowed',
      sql`${table.preferredPlaybackSpeed} in (${sql.raw(PLAYBACK_SPEEDS.join(', '))})`,
    ),
  ],
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
 * A request to delete an account, started from outside a session
 * ([3.1.8](docs/project/prd.md); Apple 5.1.1(v) and Google Play both require a way to begin
 * deletion from a public page, for a person who may no longer have the app installed).
 *
 * **`password_reset`'s shape, one table over**, and its own table for the reason that one is not a
 * second life for `invitation`: a reset changes an account and a deletion request ends one, and
 * sharing a table would mean a `kind` column and two sets of rules in one place. The three
 * properties are the same and held the same way — the raw token is never stored, at most one
 * *live* request per account (the partial unique index), and status is derived from the timestamps
 * rather than stored.
 *
 * **No `used_at`.** Completing a request deletes the account row, and this row cascades with it —
 * a request that worked leaves nothing behind, which is the whole point. A request refused at
 * completion (the last active admin) stays live, so the person can promote somebody and press the
 * same link again inside the hour.
 */
export const accountDeletionRequest = pgTable(
  'account_deletion_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Cascades: a request to delete an account that is gone has nothing left to do. */
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token in the emailed link. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('account_deletion_request_token_hash_unique').on(table.tokenHash),
    uniqueIndex('account_deletion_request_live_user_unique')
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

/**
 * A named series of teachings (Story 6 Ticket 01) — the **left-hand end** of the spine
 * core-listening scope tdd § Data model draws as
 * `Series 1—* Recording 1—1 Transcript 1—* Segment`, and the only entity this story adds.
 *
 * **Four columns, and the absences are the design.** No `recording_count` and no `date_range`:
 * docs/project/prd.md 4.3 calls both auto-calculated, and a denormalised count is a second answer
 * to a question one query already answers — the console's count and a member's count of the same
 * series legitimately differ (3.2.2), which a column could not express. No `position`
 * or `sort_order`, because reordering a series is deferred and the order inside one is
 * `recorded_at` and nothing else. No slug, because the id is what every other resource here is
 * addressed by. No podcast or external-publication field — those arrive with distribution
 * (3.3.7, 4.3), which is what drives their real requirements.
 *
 * **The title is not unique.** Nothing in docs/project/prd.md 3.3 makes a title an identifier, and
 * a uniqueness rule nobody asked for is a rule somebody has to discover. The migration test
 * asserts the exact column set rather than trusting this comment.
 */
export const series = pgTable('series', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  /** Optional, and empty is stored as `null` — one representation of "nothing written here". */
  description: text('description'),
  /**
   * **The object key of this series' cover, or none** (scope tdd 2.1).
   *
   * One nullable pointer and nothing beside it. No width, height, byte size, content type or
   * uploaded-at: the bound is enforced before this is written (scope prd 3.1.2, 3.1.4) and the
   * store's own `head` already answers everything those columns would restate. No rendition
   * columns, because there are no renditions — one object serves every surface. No original key,
   * because the file the admin chose is not kept.
   *
   * **Nullable, and that is the ordinary state** (scope prd 3.1.7): most series have no cover and
   * every surface renders without one rather than reserving an empty frame. Replacing a cover
   * rewrites this column and leaves the object the old key named where it is — the store has no
   * delete, so a repoint is the whole of "replace" (scope prd 3.1.5).
   */
  artworkKey: text('artwork_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A recording (Story 2 Ticket 01) — the first row in the spine
 * core-listening scope tdd § Data model draws as
 * `Series 1—* Recording 1—1 Transcript 1—* Segment`.
 *
 * **What is absent is the design.** There is no `duration`, because nothing inspects the media in
 * this epic ([§3.4](docs/project/prd.md) is deferred whole); no `processed_media_key`, because no
 * processed rendition exists and that column is the named seam
 * (core-listening scope tdd § Extension points, "Second media pointer").
 * `series_id` **arrived in Story 6 Ticket 01** — see the column — and it arrived with the routes
 * and the screens that write and read it rather than "for later", which is the whole distinction
 * this paragraph is about. A nullable column added ahead of a use is how deferral quietly stops
 * being deferral, so the migration test asserts the exact column set rather than trusting this
 * comment.
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
    /**
     * **The playback rendition** the `process_audio` step wrote, or `null` while none exists.
     *
     * The second media pointer core-listening scope tdd § Extension points reserved: playback
     * prefers it and falls back to the original, so a recording processed before the step existed
     * still plays. Nullable rather than defaulted, because "no rendition yet" is a fact the grant
     * reads, not a state to disguise.
     */
    playbackMediaKey: text('playback_media_key'),
    /**
     * **Which version of the sound profile produced the rendition** ([3.4.7](docs/project/prd.md)),
     * or `null` — for a recording with no rendition, and for one whose rendition was made before
     * the profile existed. Written beside `playback_media_key` and by the same statement, so the
     * two cannot say different things about the same object.
     *
     * Referencing the version number rather than the row id, because the number is what a person
     * reads on the console and compares with the version in force; `set null` on delete only
     * because no delete route exists and a hand at the database must not take renditions with it.
     */
    soundProfileVersion: integer('sound_profile_version').references(
      () => soundProfile.version,
      { onDelete: 'set null' },
    ),
    title: text('title').notNull(),
    recordedAt: date('recorded_at').notNull(),
    /** `null` until Story 3 Ticket 04 publishes it. Nothing in this ticket writes it. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Generated in Story 3. Nothing in this ticket writes it. */
    description: text('description'),
    /**
     * **The series this recording is in, or none** (Story 6 Ticket 01,
     * docs/project/prd.md 3.3.2 and 3.3.9).
     *
     * A nullable foreign key is the whole of "at most one series": there is no join table, so a
     * recording in two series is not a rule a check enforces but a row the database cannot hold.
     * Nullable because most recordings have no series and 3.3.9 makes that ordinary rather than
     * exceptional. Indexed because every series read filters on it.
     *
     * `on delete set null` rather than cascade: a series is a grouping of recordings, and deleting
     * one must never take teachings with it. **No delete route ships in this story** — 3.3.6 names
     * create, rename, reorder, merge and move and no delete — so this is the behaviour of a hand
     * at the database, which is exactly the hand that most needs it to be safe.
     */
    seriesId: uuid('series_id').references(() => series.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('recording_original_media_key_unique').on(table.originalMediaKey),
    index('recording_series_id_idx').on(table.seriesId),
  ],
);

/**
 * A single run of a single pipeline step for a single recording (Story 2 Ticket 02) — **the ledger
 * and the queue at once**. There is no broker and no second store: the rows the worker dispatches
 * from are the same rows an operator queries and Ticket 04 renders a dashboard out of
 * (project tdd 4.7).
 *
 * **The table is append-only.** A step that is re-run is a *new row*, not a status reset, with
 * `attempt` counting 1, 2, 3 for a `(recording_id, step)` pair — so a failure that was later
 * re-run stays readable, and "what happened to this recording" is a history rather than a snapshot.
 * That is why uniqueness cannot be over the pair itself; see the index below.
 *
 * **`correlation_id` is a column, not an inference.** The worker is a second process with no
 * request behind it, so the id that
 * core-listening scope tdd § Key choices wants spanning API request → job →
 * provider call cannot live in an async-context frame — it has to survive the process boundary, and
 * a column is the only form of that which does. `text` because the API adopts a caller's id when
 * it is usable, and what it adopts is not necessarily a UUID.
 *
 * **`provider_meta` is `jsonb`** because docs/project/prd.md §7 wants spend measured per job and
 * no two providers report model, version and cost in the same shape. It ships empty; the stub
 * handlers of this ticket mark themselves in it, and the handler that has a provider to record
 * fills it in.
 *
 * What is absent is the design. No `updated_at` — `enqueued_at`, `started_at` and
 * `finished_at` are the three transitions and the row has no fourth. No `worker_id`, because
 * concurrency is pinned to 1 and the startup sweep is what recovers an abandoned job. No
 * `scheduled_for`, because docs/project/prd.md 3.21.3 is not in this epic and a job is enqueued to
 * run now. `payload` arrived in Story 3 Ticket 03 and is the one reversal — see the column. The
 * migration test asserts the exact column set rather than trusting this comment.
 */
export const job = pgTable(
  'job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Cascades: a job is a fact about a recording and is meaningless without it. `NOT NULL`
     * because every step in this epic and every deferred one belongs to a recording — a nullable
     * column for a job type nobody has asked for is deferral quietly stopping being deferral.
     */
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    step: pipelineStep('step').notNull(),
    status: jobStatus('status').notNull().default('pending'),
    /** 1 for the first run of this `(recording_id, step)` pair, one higher for each run after. */
    attempt: integer('attempt').notNull(),
    /** The reason a failed job failed, truncated by the writer. The stack trace is in the log. */
    error: text('error'),
    /** The id of the request that caused this job, carried forward when a step chains to the next. */
    correlationId: text('correlation_id').notNull(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    /** Stamped when a worker claims the row. Null while `pending`. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** Stamped when the row reaches `succeeded` or `failed`. Null before that. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** What the handler wants recorded about how it ran. Null at enqueue. */
    providerMeta: jsonb('provider_meta'),
    /**
     * **What this run of the step was asked for** (Story 3 Ticket 03).
     *
     * This column **reverses Ticket 02's explicit "no payload"**, and the reversal is stated here
     * rather than left to be discovered. That decision rested on "a step's input is the recording
     * it names", which stops being true the moment [3.6.9](docs/project/prd.md) steers one *kind*
     * of draft with a sentence: neither the kind nor the sentence has anywhere else to live, and
     * the alternatives — a column per parameter, or a second table keyed by job — are worse
     * versions of `jsonb`.
     *
     * **Null on every chained job**, which is what keeps the chain rule untouched: `runJob`
     * enqueues a successor with no payload, and a handler reading `null` does the whole of its
     * step. Only the regenerate route ever writes one.
     */
    payload: jsonb('payload'),
  },
  (table) => [
    /**
     * **At most one *unfinished* job per `(recording_id, step)`**, enforced at the database.
     *
     * Partial rather than total, because the ledger is append-only: a succeeded or failed row must
     * not block the step being run again, and a total unique index would make re-running
     * impossible. What must never exist twice is the same step *in flight* for the same recording.
     *
     * This is what makes an admin double-clicking Ticket 04's re-run harmless without Ticket 04
     * having to think about it, and what makes "enqueue is a no-op when one is already unfinished"
     * a property of the database rather than of a check-then-insert with a window in it.
     *
     * The predicate is derived from `UNFINISHED_JOB_STATUSES`, so "unfinished" has one definition
     * that the index and the enqueue read the same way.
     */
    uniqueIndex('job_unfinished_step_unique')
      .on(table.recordingId, table.step)
      .where(
        sql`${table.status} in (${sql.raw(
          UNFINISHED_JOB_STATUSES.map((status) => `'${status}'`).join(', '),
        )})`,
      ),
  ],
);

/**
 * What the machine heard (Story 2 Ticket 03) — one row per recording, and the parent of the
 * segments that are the text.
 *
 * **One transcript per recording**, said by the database rather than by the handler that writes it:
 * `recording_id` is unique, so docs/project/prd.md 4.4's one-to-one is a property of the table.
 * Re-running `transcribe` deletes this row and writes a fresh one, which is what makes the handler
 * survive the at-least-once dispatch it runs under.
 *
 * **There is no `text` column.** The segments are the text. A concatenated copy beside them would
 * be a second source of truth that Story 5's per-segment correction would have to keep in step, and
 * the only reader that wants the whole thing — Story 3's one call to Claude — can join the segments
 * in the order they are already indexed by.
 *
 * `language` is a BCP-47 code and always reads `en` in this epic: English is pinned rather than
 * detected (docs/project/prd.md 3.5.7). The column exists anyway, so a second language later is an
 * adapter change rather than a migration and a back-fill over every transcript already written.
 *
 * `confidence` is what the provider says about the whole transcript, and it is `real` rather than
 * `numeric` because it is a score compared against a threshold, not money. The check constraint is
 * the range the gate assumes; a provider that answered outside it would otherwise pass the gate by
 * accident.
 */
export const transcript = pgTable(
  'transcript',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Unique: one recording has at most one transcript, and the database is what says so. */
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    /** BCP-47. `en` throughout this epic — pinned, not detected. */
    language: text('language').notNull(),
    /** The provider's confidence in the whole transcript, 0..1. What the gate reads. */
    confidence: real('confidence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('transcript_recording_unique').on(table.recordingId),
    check('transcript_confidence_range', sql`${table.confidence} between 0 and 1`),
  ],
);

/**
 * A timestamped segment — **the atom of the whole system**
 * (core-listening scope tdd § Extension points).
 *
 * The columns are the fields of the `Segment` type in `@thp/shared`, matched rather than
 * re-invented; tests/guards/segment-shape.test.ts fails the build if the two ever disagree. Notes,
 * highlights, mind maps, search and Flow Tracker all resolve through `(recording_id, timestamp_ms)`
 * in later scopes, and this row is where that pair becomes real.
 *
 * `start_ms` is inclusive and `end_ms` exclusive, as the shared type's documentation already says.
 * Milliseconds as integers, not seconds as floats: a seek lands on an integer or it lands on
 * whatever the last rounding chose.
 *
 * **No embedding column.** [§3.9](docs/project/prd.md)/[§3.10](docs/project/prd.md) enable pgvector
 * and `ALTER TABLE segment ADD embedding` in a later epic; adding it now is deferral quietly
 * stopping being deferral, and the migration test asserts the exact column set rather than trusting
 * this comment.
 *
 * `corrected_at` and `corrected_by_user_id` ship unwritten. They are here because the shared type
 * has them — what a segment *is* includes who corrected it (docs/project/prd.md 3.5.5) — and Story
 * 5 is what fills them in.
 */
export const segment = pgTable(
  'segment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Cascades: replacing a transcript takes its segments with it, which is what a re-run does. */
    transcriptId: uuid('transcript_id')
      .notNull()
      .references(() => transcript.id, { onDelete: 'cascade' }),
    /** Inclusive start offset from the beginning of the recording, in milliseconds. */
    startMs: integer('start_ms').notNull(),
    /** Exclusive end offset from the beginning of the recording, in milliseconds. */
    endMs: integer('end_ms').notNull(),
    text: text('text').notNull(),
    /**
     * The provider's **anonymous speaker index** for this sentence (Story 2 Ticket 04–05).
     *
     * Nullable, and nothing back-fills it: a provider that attributes a sentence to nobody writes
     * null, and every segment written before this column existed keeps null until somebody re-runs
     * `transcribe` for that recording. An integer rather than a label because that is genuinely all
     * the provider answers — `0`, `1`, `2` — and a `text` column here would invite somebody to
     * write a name into it, which is a labelling surface no epic has asked for.
     */
    speaker: integer('speaker'),
    /** Set when a human has corrected the machine output. Story 5; nothing writes it yet. */
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    correctedByUserId: uuid('corrected_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    /**
     * Playback order, and the lookup Story 5's follow-along makes on every tick: "which segment
     * covers this offset". One index answers both, which is why the order is `(transcript, start)`
     * rather than the other way round.
     */
    index('segment_transcript_start_idx').on(table.transcriptId, table.startMs),
  ],
);

/**
 * **The review gate** (Story 3 Ticket 01) — one table for every AI artefact this product will ever
 * generate, not one table per artefact
 * (core-listening scope tdd § Data model).
 *
 * That is the whole design, and it buys one property:
 * project tdd 6.2 asks that "everything waiting on an admin"
 * stay **one query over one column** rather than degrading into a union of six. Scripture
 * references, tags, topics, mind maps and video scripts each add a value to `review_kind` in a
 * later epic and change nothing here — not the queue read, not the form, not a route.
 *
 * `fields` and `provenance` are `jsonb` for the same reason: [4.17.2](docs/project/prd.md) wants
 * accept/edit/discard *per field*, and a column per field per artefact would make that a migration
 * every time a kind arrives. Both kinds in this epic carry exactly one field — `summary` and
 * `description` — and the form is built generically over the objects anyway, because that
 * generality is what kinds 3–6 inherit. `provenance` holds, per field, that it was AI-suggested
 * and whether an admin changed it ([4.17.5](docs/project/prd.md)), plus the model, the model
 * version and the prompt version that produced the row.
 *
 * `recording_id` cascades: a draft about a recording that is gone is not a record of anything.
 * `reviewed_by` **sets null** instead, because a closed item *is* a record of something that
 * happened and it should survive the admin's account being removed — the same split `invitation`
 * already takes between its subject and its author.
 *
 * What is absent is the design. No `updated_at`: `created_at` and `reviewed_at` are the two
 * transitions an item has. No `job_id`, because a draft is about the recording rather than about
 * the run that produced it, and the run is already findable by correlation id. No `superseded_by`,
 * because a regeneration discards the old item and writes a fresh one rather than threading a
 * history nothing reads. The migration test asserts the exact column set rather than trusting this
 * comment.
 */
export const reviewItem = pgTable('review_item', {
  id: uuid('id').primaryKey().defaultRandom(),
  recordingId: uuid('recording_id')
    .notNull()
    .references(() => recording.id, { onDelete: 'cascade' }),
  /** `summary` or `recording_metadata` in this epic. A later artefact is a value, not a table. */
  kind: reviewKind('kind').notNull(),
  /** `draft` is the only open state, and therefore the whole of the Pending Reviews query. */
  status: reviewStatus('status').notNull().default('draft'),
  /** The draft itself, keyed by field name. */
  fields: jsonb('fields').notNull(),
  /** Per field, whether it was AI-suggested and whether an admin changed it. */
  provenance: jsonb('provenance').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Who closed it. Null while it is a draft, and null again if that account is ever deleted. */
  reviewedBy: uuid('reviewed_by').references(() => user.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
});

/**
 * A teaching's approved summary (Story 3 Ticket 01) — **its own table, and its own gate.**
 *
 * Not a column on `recording`, because a summary has a publication state the recording does not
 * share: [3.6.12](docs/project/prd.md) asks an admin to be able to return a published summary to
 * draft *without* taking the teaching down. So a summary is member-visible only when **both**
 * `summary.published_at` and `recording.published_at` are set — two gates, and the description
 * deliberately has only one because it is a column on the recording and rides its state.
 *
 * `published_at` is nullable rather than a status column, the same shape `recording.published_at`
 * and `user.deactivated_at` already take: return-to-draft is one write of `null`, and "published"
 * is a fact about the column rather than a second thing to keep in step with it.
 *
 * **Unique on `recording_id`**, because [4.5](docs/project/prd.md) is one summary per recording and
 * the database is what says so — approving a second draft updates this row rather than growing a
 * history beside it. What the machine proposed stays in the closed `review_item`; nothing here
 * computes the difference between the two.
 */
export const summary = pgTable(
  'summary',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    /** Plain text with line breaks ([3.6.8](docs/project/prd.md)). No markup, no rendering. */
    content: text('content').notNull(),
    /** The second gate. Null means a draft summary exists and no member can read it. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('summary_recording_unique').on(table.recordingId)],
);

/**
 * **Where a member had got to** (Story 4 Ticket 04, [3.2.5](docs/project/prd.md)) — the only
 * member-owned entity in this epic
 * (core-listening scope tdd § Data model, *Member-owned state*).
 *
 * **One row per (person, teaching)**, said by the composite primary key rather than by the code
 * that writes it: the write is an upsert onto that pair, so there is no history to reconcile and
 * "resume where I was" cannot become a question about which of several rows is the right one. That
 * is also what makes the whole thing survive to another device — the row is keyed by the account,
 * not by the browser.
 *
 * **Last-write-wins, plainly.** The architecture line above says "last-write-wins on the furthest
 * position", which is two rules that disagree; taken as *furthest*, a member who scrubs back to
 * re-hear something and then closes the tab is returned to where they had got to rather than where
 * they were listening, which is the opposite of what 3.2.5 promises. This table stores whatever the
 * newest write said. Amending that architecture line is a Phase 4 edit and not this story's work.
 *
 * **Cascades on both sides.** Progress is a fact about a pairing and is meaningless without either
 * half — unlike an invitation, it is not a record of something that happened.
 *
 * What is absent is the design. No `id`, because the pair *is* the identity. No play log —
 * [3.2.7](docs/project/prd.md) is deferred, and a column added "for later" is how deferral quietly
 * stops being deferral. The migration test asserts the exact column set rather than trusting this
 * comment.
 *
 * **Completion arrived with the observability scope** (docs/project/observability.md § 5.3), and
 * it arrived as three columns on this row rather than as a log, because the question it answers —
 * has this member heard this teaching — is a fact about the pairing. `listened_ms` is media time
 * actually heard, accumulated across visits with seeking excluded, so a member who hears half
 * today and the rest tomorrow completes, and one who scrubs to the end does not. `duration_ms` is
 * the length as the member's player last reported it, held here because nothing else in the schema
 * knows it: `recording` deliberately carries no duration. `completed_at` is set once, by the write
 * that first carries the total past 80% of the duration, and never cleared — the column
 * [3.2.8](docs/project/prd.md) reads when completed teachings are drawn apart.
 */
export const playbackProgress = pgTable(
  'playback_progress',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    /** Milliseconds from the start, matching the offsets `segment` already establishes. */
    positionMs: integer('position_ms').notNull(),
    /** When this position was written. What the resume card orders by. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Media time heard, across every visit, seeks excluded. Zero until the first write that carries some. */
    listenedMs: integer('listened_ms').notNull().default(0),
    /** The length as the player last reported it, or `null` until a player has. */
    durationMs: integer('duration_ms'),
    /** When `listened_ms` first reached 80% of `duration_ms`. Set once; never cleared. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.recordingId] })],
);

/**
 * **Which onboardings this account has been through.**
 *
 * A row means "seen, never show it on sign-in again"; its absence means the next sign-in routes
 * into the onboarding. One table for every onboarding the product will ever have rather than a
 * column per onboarding on `user`, so the next onboarding is a shared id plus its slides and no
 * migration.
 *
 * `onboarding_id` is plain text rather than an enum: the set of onboardings is a fact about the
 * client (`ONBOARDING_IDS` in `@thp/shared`, which the API checks against before writing), and an
 * enum here would make retiring an old onboarding a migration on rows nobody reads any more.
 * The composite key is the idempotence: completing twice updates nothing and grows nothing.
 */
export const userOnboarding = pgTable(
  'user_onboarding',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    onboardingId: text('onboarding_id').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.onboardingId] })],
);

/**
 * **A note written at a moment in a teaching** (active-scope architecture § 6.1) — the first
 * member-authored content in the product, and the first table whose rules are worth stating at the
 * database rather than in the code that writes it.
 *
 * Four things a note can never be are refused by Postgres here, not by a service that remembers to
 * check:
 *
 * 1. **A reply to a reply.** One level, and no more (active-scope prd 3.3.4). See the generated
 *    pair below.
 * 2. **A top-level note with no position, or a reply carrying one** (3.3.2) — one check over the
 *    two columns, so the two shapes a note comes in are the only two it can come in.
 * 3. **A private reply** (3.3.3). A thread under a public note is public throughout.
 * 4. **More than {@link MAX_NOTE_LENGTH} characters** — the ceiling derived from the shared
 *    constant the composer counts down from, so a note one end accepts is never one the other
 *    refuses.
 *
 * **A delete is a tombstone, not a missing row** (3.5.9): `deleted_at` set and `text` null, the two
 * together or neither, which is the last check. The row stays so a thread does not lose its shape
 * when the note it hangs off is removed.
 *
 * **`author_id` restricts rather than cascades**, unlike every other member-owned row in this
 * codebase — deliberately, and it is the one deviation worth reading twice.
 * project tdd 3.4 states outright that public notes must not cascade from
 * users, and re-attribution ([3.1.10](docs/project/prd.md)) is unbuilt. Until it exists, deleting an
 * account that has written a note is *meant* to fail: a hand at the database cannot take a group's
 * study notes with one person's account by accident.
 *
 * What is absent is the design. No `updated_at` — `created_at`, `edited_at` and `deleted_at` are the
 * three things that happen to a note. No prior text and no revision table: 3.5.1 says an edit is
 * permanent and keeps no history, so a version column would be building the undo the requirement
 * refuses. No `reaction_count` and no `pinned` flag, because each is a row in its own table rather
 * than a property of this one. No full-text index, because search is unbuilt.
 */
export const note = pgTable(
  'note',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Cascades: a note about a teaching that no longer exists is nothing. */
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    /** Restricts — see the note above. This is the deviation, and it is on purpose. */
    authorId: uuid('author_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /**
     * The note this one replies to, or null. Non-null exactly on replies, and constrained to name a
     * top-level note by the composite foreign key below rather than by a lookup.
     */
    parentId: uuid('parent_id'),
    /**
     * Where in the recording the composer was opened, in milliseconds — matching the offsets
     * `segment` and `playback_progress` already establish. Non-null exactly on top-level notes.
     */
    timestampMs: integer('timestamp_ms'),
    /** Chosen at creation and never written again. */
    visibility: noteVisibility('visibility').notNull(),
    /** Null exactly when the row is a tombstone. */
    text: text('text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null until the first edit; what drives the **edited** indicator. No prior text is kept. */
    editedAt: timestamp('edited_at', { withTimezone: true }),
    /** Presence is what makes a row a tombstone. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /**
     * Who removed it — the author or an admin. Required by 3.6.4's audit line and never returned to
     * a member (3.5.8). Sets null rather than restricting: the note survives, and who deleted it is
     * a detail, not the record.
     */
    deletedBy: uuid('deleted_by').references(() => user.id, { onDelete: 'set null' }),
    /**
     * **Half of how "one level" becomes a row the database cannot hold.**
     *
     * Stored and generated, so nothing writes them and nothing can write them wrong. A reply has
     * `is_reply = true` and `parent_is_reply = false`, and the composite foreign key below demands
     * its parent's `is_reply` be `false` — so a parent that is itself a reply has no matching key.
     * A top-level note has `parent_is_reply` null, and a foreign key with a null column is not
     * enforced at all, which is exactly what should happen to a note with no parent.
     *
     * The cheaper alternative is a parent lookup inside the create transaction. It is correct today
     * and one careless later writer away from not being — the same argument
     * `recording_original_media_key_unique` is already made on.
     */
    isReply: boolean('is_reply').generatedAlwaysAs(sql`parent_id is not null`),
    parentIsReply: boolean('parent_is_reply').generatedAlwaysAs(
      sql`case when parent_id is null then null else false end`,
    ),
  },
  (table) => [
    /** The list's order exactly (3.2.1), so reading a teaching's notes is one index scan. */
    index('note_recording_timestamp_idx').on(
      table.recordingId,
      table.timestampMs,
      table.createdAt,
    ),
    /** The thread's order (3.3.6). */
    index('note_parent_created_idx').on(table.parentId, table.createdAt),
    /** Exists only so `note_pin`'s composite key has something to point at. */
    unique('note_recording_id_unique').on(table.recordingId, table.id),
    /** What the composite foreign key below references. */
    unique('note_id_is_reply_unique').on(table.id, table.isReply),
    foreignKey({
      columns: [table.parentId, table.parentIsReply],
      foreignColumns: [table.id, table.isReply],
      name: 'note_parent_top_level_fk',
    }).onDelete('restrict'),
    /** A top-level note has a position; a reply does not. Both directions, one constraint. */
    check(
      'note_position_on_top_level_only',
      sql`(${table.parentId} is null) = (${table.timestampMs} is not null)`,
    ),
    /** A thread under a public note is public throughout (3.3.3). */
    check(
      'note_reply_is_public',
      sql`${table.parentId} is null or ${table.visibility} = 'public'`,
    ),
    /** The ceiling, derived from the shared constant rather than restated. */
    check(
      'note_text_length',
      sql`char_length(${table.text}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    /** A tombstone has no text, and text means it is not a tombstone. */
    check(
      'note_tombstone_has_no_text',
      sql`(${table.text} is null) = (${table.deletedAt} is not null)`,
    ),
  ],
);

/**
 * **How the group responded to a moment** (active-scope architecture § 6.2) — one row per member
 * per note, and no row for a member who has not chosen.
 *
 * **The primary key is the requirement.** `(note_id, user_id)` *is*
 * scope prd 3.4.3 — one reaction per member — and it is also
 * scope prd 3.4.11: replacing is `on conflict do update` rather than
 * delete-then-insert, and two members reacting in the same instant are two rows that cannot
 * collide. Neither behaviour is code that has to remember.
 *
 * **`emoji` is `text`, deliberately not an enum and deliberately not a foreign key.**
 * scope prd 3.4.2 requires that a reaction stored under a glyph that later leaves
 * the vocabulary still renders and still counts. An enum makes removing a value a migration; a
 * foreign key makes it a cascade — both rewrite a member's past response, which is precisely what
 * that requirement forbids. The column stores the glyph itself, and `reactionName` in
 * `packages/shared/src/reactions.ts` labels a departed one by itself.
 *
 * **Both sides cascade**, unlike `note.author_id`: a reaction is a fact about a pairing and is
 * meaningless without either half — the argument `playback_progress` already makes.
 */
export const noteReaction = pgTable(
  'note_reaction',
  {
    noteId: uuid('note_id')
      .notNull()
      .references(() => note.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The glyph, exactly as the vocabulary spells it. Normalised on write by the service. */
    emoji: text('emoji').notNull(),
    /** Recorded and not displayed in this scope — the row is ordered by count, not by time. */
    reactedAt: timestamp('reacted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.noteId, table.userId] })],
);

/**
 * **A note an admin raised above the rest** (active-scope architecture § 6.3) —
 * scope prd 3.6.5 to 3.6.10.
 *
 * **`note_id` is the whole primary key**, which is what makes "a note is pinned at most once"
 * (scope prd 3.6.10) a key rather than a check somebody has to write. Pinning an
 * already-pinned note is then one `on conflict (note_id) do nothing`, and an admin acting on a
 * stale screen has still got what they asked for (scope prd 3.6.6).
 *
 * **`recording_id` is carried rather than derived**, so "the pins on this recording" is one indexed
 * read instead of a join back through `note`. The composite foreign key is what keeps that honest:
 * `(recording_id, note_id) → note (recording_id, id)` means a pin cannot point at a note on a
 * different recording *and* the denormalised column cannot drift from the note's own.
 *
 * **No `position` and no `sort_order`.** Pinned notes read in the list's own order — timestamp
 * ascending, creation time as tie-break — so the product has one answer to what order notes read
 * in and pinning does not invent a second. There is nothing for an admin to drag.
 *
 * A soft delete never fires a cascade, so scope prd 3.6.9's pin-clear is a second
 * statement inside the delete's transaction rather than a foreign key.
 */
export const notePin = pgTable(
  'note_pin',
  {
    noteId: uuid('note_id').primaryKey(),
    recordingId: uuid('recording_id').notNull(),
    /** The house shape for `invited_by` and `reviewed_by`: the pin survives the account. */
    pinnedBy: uuid('pinned_by').references(() => user.id, { onDelete: 'set null' }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.recordingId, table.noteId],
      foreignColumns: [note.recordingId, note.id],
      name: 'note_pin_note_fk',
    }).onDelete('cascade'),
    /** The read is always "the pins on this recording". */
    index('note_pin_recording_idx').on(table.recordingId),
  ],
);

/**
 * **A teaching's approved scripture references** (Task 1.4) —
 * scope prd 3.2.6, and § 4 *Scripture reference — new*.
 *
 * One row per citation on one recording, written only when an admin approves the list it belongs
 * to. **A row existing is what "approved" means**, which is why there is no status column here:
 * `project prd 4.6`'s *suggested or accepted* is the state of the `review_item` holding the draft
 * (scope prd § 8), and a column repeating it would be a second answer to the same
 * question that somebody would eventually have to reconcile.
 *
 * **The citation is structured, never prose.** `book` is the canon identity `@thp/shared`'s
 * `BIBLE_BOOKS` declares — not the words a model wrote — and the verse range is always present,
 * spanning the chapter when the citation is a whole chapter. Which is what
 * [3.7.6](docs/project/prd.md)'s cross-referencing and [3.7.7](docs/project/prd.md)'s search read
 * later, and the reason this scope's data model is what unblocks them.
 *
 * `origin` and `edited_by_admin` are scope prd 3.2.9's per-reference record: what
 * the machine proposed, what an admin changed, and what they added by hand. Both are written by
 * the approve path; nothing else may set them.
 *
 * **Unique on the passage**, so approving a list holding the same verse twice is impossible at the
 * database rather than only at the validator. Approving a later draft replaces the set
 * (scope prd 3.2.11) rather than appending to it, so there is no version to
 * thread and no `superseded_by`.
 */
export const scriptureReference = pgTable(
  'scripture_reference',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    /** The canon identity, e.g. the identity of the letter to the Romans. Never a model's words. */
    book: text('book').notNull(),
    chapter: integer('chapter').notNull(),
    /** Equal to `verse_end` for a single verse; 1 and the chapter's length for a whole chapter. */
    verseStart: integer('verse_start').notNull(),
    verseEnd: integer('verse_end').notNull(),
    origin: scriptureOrigin('origin').notNull(),
    editedByAdmin: boolean('edited_by_admin').notNull().default(false),
    /**
     * **Where in the recording the passage is cited** ([3.7.10](docs/project/prd.md)), in
     * milliseconds from the start.
     *
     * Nullable, and the null is the design rather than a gap: a reference an admin added by hand
     * (3.7.2) was never placed anywhere, and one the transcript gave no position for has none —
     * both belong to the recording rather than to any chapter, and 3.7.10 says so outright.
     *
     * **Not part of the passage's identity.** The unique index below is over the citation and does
     * not carry this column, because a teaching cites a passage once
     * (scope prd 3.2.5) — citing it at two moments is not two references, and
     * putting the anchor in the key would make it so.
     *
     * **No foreign key to `chapter`, deliberately** (project tdd 3.8). Which chapter a citation
     * falls in is computed from this offset, not stored: a pointer would be stale the moment an
     * admin moved a boundary ([3.22.7](docs/project/prd.md)) and would have to be rewritten by
     * every regeneration, while an offset survives both.
     */
    anchorMs: integer('anchor_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('scripture_reference_passage_unique').on(
      table.recordingId,
      table.book,
      table.chapter,
      table.verseStart,
      table.verseEnd,
    ),
    /** Every read is "the references on this teaching". */
    index('scripture_reference_recording_idx').on(table.recordingId),
    /** An offset into a recording, or nothing. A negative one names no moment of any teaching. */
    check('scripture_reference_anchor_non_negative', sql`${table.anchorMs} >= 0`),
  ],
);

/**
 * **The verse text cache** (scope prd 3.3.1, scope prd 4).
 *
 * One row per verse, per translation. Not a column on `scripture_reference`, and that is the whole
 * design: a verse cited by a second teaching is **the same row**, not a second copy — which is what
 * makes scope prd 3.3.2's "text already held is never fetched again" true across
 * teachings rather than only within one, and what keeps the lookup volume near
 * project tdd 8.2's assumption.
 *
 * **The key is the passage, not an id.** `(translation, book, chapter, verse)` is the primary key
 * because that quadruple *is* the identity of a verse: an id column would let the same verse be
 * held twice under two ids, and nothing could then say which of them a reader gets.
 *
 * No foreign key to `scripture_reference`, deliberately. The cache belongs to the translation, not
 * to any teaching that happens to quote it — a reference removed from a teaching must not take a
 * verse away from the next one to cite it.
 *
 * `fetched_at` is when the source answered. Nothing expires on it yet; it is here because a cache
 * with no answer to "how old is this" cannot be refreshed later without a migration.
 */
export const verseText = pgTable(
  'verse_text',
  {
    /** As `BIBLE_TRANSLATION` names it. Opaque here — the source decides what its ids are. */
    translation: text('translation').notNull(),
    /** The canon identity, the same one a citation carries. Never a model's words. */
    book: text('book').notNull(),
    chapter: integer('chapter').notNull(),
    verse: integer('verse').notNull(),
    /** What the source says the verse says. Plain text; never edited (scope prd 3.3.8). */
    text: text('text').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.translation, table.book, table.chapter, table.verse],
      name: 'verse_text_passage_pk',
    }),
  ],
);
/**
 * **A chapter — a named span of one teaching** ([3.22](docs/project/prd.md),
 * [4.19](docs/project/prd.md)).
 *
 * Two absences are the whole design, and both come straight from project tdd 3.7 and 3.8.
 *
 * **There is no `end_ms`.** A chapter is a start, not a span: it ends where the next one begins,
 * and the last ends at the end of the transcript. [3.22.2](docs/project/prd.md)'s tiling — no gaps,
 * no overlaps — is therefore *unrepresentable-broken* rather than merely validated. There is no
 * state a bug can write that leaves a minute of a teaching in no chapter or in two, no repair job
 * to own, and nothing to drift. A read derives each end from the next row, over a list a handful of
 * rows long.
 *
 * **There is no `position` either**, and that is this schema's one departure from
 * [4.19](docs/project/prd.md)'s field table — taken in order to keep the *claim* 4.19 and project
 * tdd 3.7 both make. Position is "order within the recording", and order is `start_ms` ascending,
 * which is total and stable because the unique index below makes the starts distinct per recording.
 * Storing it as well would mean every split and every merge renumbering every row after the one
 * that changed — turning [3.22.7](docs/project/prd.md)'s shared boundary from "one write to one
 * row" (project tdd 3.7's own words) into a rewrite that must not half-fail. So position is derived
 * on the way out, in `packages/db/src/chapters.ts`, and moving a boundary stays one `UPDATE`.
 *
 * **And there is no `status`.** Chapters sit outside the review gate deliberately
 * ([3.22.6](docs/project/prd.md), project tdd 6.2): a chapter cannot be published or withdrawn
 * independently of the teaching it divides, so the recording's own `published_at` is the gate it
 * passes and a column here would be a second answer to a question 4.2 already answers.
 *
 * `generated_by` is [4.17.5](docs/project/prd.md)'s record — which model, which model version and
 * which prompt version produced the list — as `jsonb`, the same shape `review_item.provenance`
 * takes and for the same reason: it is provenance to read back, never anything to query by.
 *
 * `edited_by_admin` is per row rather than per list, because it is what
 * [3.22.8](docs/project/prd.md)'s confirmation counts: re-running the step discards every title,
 * summary and boundary a human has changed, and naming *how many* means being able to count them.
 */
export const chapter = pgTable(
  'chapter',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Cascades: chapters of a teaching that is gone divide nothing. */
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    /**
     * Inclusive start offset from the beginning of the recording, in milliseconds, and **always the
     * start of a transcript segment** ([3.22.5](docs/project/prd.md)).
     *
     * That last part is the worker's and the edit path's to enforce — a column cannot check it
     * without a join to a table it has no business reaching into. What the column does hold is that
     * two chapters of one teaching cannot start at the same moment, which is what makes the derived
     * order total.
     */
    startMs: integer('start_ms').notNull(),
    title: text('title').notNull(),
    /** One short paragraph, plain text with line breaks ([4.19](docs/project/prd.md)). */
    summary: text('summary').notNull(),
    /** Which model, which model version and which prompt version produced the list. */
    generatedBy: jsonb('generated_by').notNull(),
    /** Whether a human has changed this chapter's title, summary or start. */
    editedByAdmin: boolean('edited_by_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * **One chapter may start at one moment.** This is what makes the derived order — and therefore
     * the derived position — total rather than arbitrary, and it is what refuses a boundary move or
     * a split that would land on a boundary that already exists.
     */
    uniqueIndex('chapter_recording_start_unique').on(table.recordingId, table.startMs),
    /** Every read is "this teaching's chapters, in order", and this index is that read. */
    index('chapter_recording_start_idx').on(table.recordingId, table.startMs),
    /** An offset into a recording. A negative one names no moment of any teaching. */
    check('chapter_start_non_negative', sql`${table.startMs} >= 0`),
  ],
);

/**
 * **A tag** — one name in the shared taxonomy over recordings and series
 * ([4.7](docs/project/prd.md)).
 *
 * A name and nothing beside it. **No provenance columns** — no model, no prompt version, no
 * `edited_by_admin` — because a tag is never AI-suggested ([4.17.1](docs/project/prd.md)): every
 * one is typed by an admin, and a column recording that would record a constant. No `status`
 * either: a tag has no gate of its own and rides the publication of whatever it is on.
 *
 * **The name is the identity, and it is unique.** `Grace` and `grace` are one tag, which is made
 * true by two rules that meet here: the shared `normaliseTagName` lowercases and collapses every
 * name before a write, and the check below refuses any row that did not go through it — so the
 * unique index compares normalised names and a second spelling cannot exist to be compared. The
 * ceiling is the shared `MAX_TAG_LENGTH`, read from the same constant the API refuses on.
 */
export const tag = pgTable(
  'tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lowercase, trimmed, single-spaced — the output of `normaliseTagName` and nothing else. */
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tag_name_unique').on(table.name),
    /** Not blank, and already in the one spelling the product uses. */
    check(
      'tag_name_normalised',
      sql`${table.name} <> '' and ${table.name} = lower(btrim(${table.name}))`,
    ),
    check(
      'tag_name_length',
      sql`char_length(${table.name}) <= ${sql.raw(String(MAX_TAG_LENGTH))}`,
    ),
  ],
);

/**
 * **A tag on a recording.** A join table rather than an array column, because the tag is a row
 * with an identity: renaming it renames it everywhere ([4.7](docs/project/prd.md)) by writing one
 * `tag` row, and deleting it takes it off every recording by cascading through this one.
 *
 * Both cascades are deliberate and both go one way only. A recording deleted at the database
 * takes its applications with it and leaves the tag; a tag deleted from the console takes its
 * applications with it and leaves every recording untouched — **nothing on `recording` is ever
 * written by a tag operation**, which is a property of there being no column there to write.
 *
 * The primary key is the pair, so a tag is on a recording once or not at all. Indexed on the tag
 * for the console's counts and for the cascade.
 */
export const recordingTag = pgTable(
  'recording_tag',
  {
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.recordingId, table.tagId] }),
    index('recording_tag_tag_id_idx').on(table.tagId),
  ],
);

/**
 * **A tag on a series.** The same shape as {@link recordingTag} for the same reasons, and a second
 * table rather than a polymorphic `(kind, owner_id)` pair so that both foreign keys are real ones
 * the database enforces. A series' tags are its own: nothing here is derived from the recordings
 * in it, and nothing in it flows down to them.
 */
export const seriesTag = pgTable(
  'series_tag',
  {
    seriesId: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.seriesId, table.tagId] }),
    index('series_tag_tag_id_idx').on(table.tagId),
  ],
);

/**
 * **Something an admin sent to everybody** ([3.17.9](docs/project/prd.md),
 * [3.17.17](docs/project/prd.md), [3.19.8](docs/project/prd.md)) — the message itself, kept once,
 * with one `notification` row per recipient hanging off it.
 *
 * Its own table rather than the text repeated on every recipient's row, for two reasons the
 * console needs and one the database does: the console lists *past sends* rather than past rows,
 * and prints how many accounts each reached; and a send is one fact with one author and one
 * moment, which a thousand copies of it are not.
 *
 * `kind` is the shared enum restricted to the two an admin composes — a check rather than a
 * second enum, so the vocabulary stays declared once. `onboarding_id` is plain text, exactly as
 * `user_onboarding.onboarding_id` is: which ids are real is a fact about the client, checked by
 * the API before the write. `sent_by` sets null on delete, the house shape for `invited_by` and
 * `pinned_by` — the send survives the account.
 */
export const announcement = pgTable(
  'announcement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: notificationKind('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Where a new-feature notice lands. Present exactly on a new feature. */
    onboardingId: text('onboarding_id'),
    sentBy: uuid('sent_by').references(() => user.id, { onDelete: 'set null' }),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    /** Every active account at the moment of sending — what the fan-out wrote, counted once. */
    recipientCount: integer('recipient_count').notNull().default(0),
  },
  (table) => [
    /** Only the two an admin composes; the other three kinds are raised by the product. */
    check(
      'announcement_kind_composed',
      sql`${table.kind} in (${sql.raw(ANNOUNCEMENT_KINDS.map((one) => `'${one}'`).join(', '))})`,
    ),
    /** A new feature points at an onboarding; an announcement points at nothing. */
    check(
      'announcement_onboarding_on_new_feature',
      sql`(${table.kind} = 'new_feature') = (${table.onboardingId} is not null)`,
    ),
    check(
      'announcement_title_length',
      sql`char_length(${table.title}) between 1 and ${sql.raw(String(MAX_ANNOUNCEMENT_TITLE_LENGTH))}`,
    ),
    check(
      'announcement_body_length',
      sql`char_length(${table.body}) between 1 and ${sql.raw(String(MAX_ANNOUNCEMENT_BODY_LENGTH))}`,
    ),
  ],
);

/**
 * **One event, for one member** ([4.16](docs/project/prd.md)) — what the bell counts and the
 * centre lists.
 *
 * A row per recipient rather than a row per event with a read-set beside it, because the two
 * questions the product asks are both per member: *how many has this person not read*, and *what
 * does this person's list say*. Both are one indexed read here, and neither has to join through
 * the event to find out who it was for.
 *
 * **The text is denormalised on purpose.** A notification says what happened *when it happened*:
 * a reply's excerpt is the words that were written, and it stays those words if the reply is later
 * edited or removed — the member was told a thing, and the row is the record of having been told.
 * `href` is stored for the same reason: where a press lands was decided at the moment of writing,
 * by the service that knew what the event was about.
 *
 * The three source pointers are for **hygiene, not for reading**: a teaching deleted at the
 * database takes its notifications with it, as does a note and an announcement, so no row can
 * outlive the thing it was about. `actor_id` — who caused it — sets null instead, and is what lets
 * a repeated reaction by one person replace its earlier notice rather than stack a second.
 *
 * `read_at` is the whole of the read state. The partial index below is the unread count: one
 * index scan over exactly the rows that are still unread, for a member with a year of history.
 */
export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Cascades: a notification is for somebody, and is nothing without them. */
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: notificationKind('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** A path on the web origin, or null for a notice that is its own content. */
    href: text('href'),
    recordingId: uuid('recording_id').references(() => recording.id, { onDelete: 'cascade' }),
    noteId: uuid('note_id').references(() => note.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => user.id, { onDelete: 'set null' }),
    announcementId: uuid('announcement_id').references(() => announcement.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null while unread. Set once, by the member it is for, and never cleared. */
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (table) => [
    /** The centre's list: this member's rows, newest first. */
    index('notification_user_created_idx').on(table.userId, table.createdAt),
    /** The bell's count: this member's unread rows and nothing else. */
    index('notification_user_unread_idx')
      .on(table.userId)
      .where(sql`${table.readAt} is null`),
  ],
);

/**
 * **One member's push switch for one category** ([3.17.13](docs/project/prd.md),
 * [3.17.14](docs/project/prd.md)) — the gate in front of the second delivery of a notification.
 *
 * **A row says "off"; no row says "on."** The operator chose on-by-default, so the honest shape is
 * a table of exceptions rather than a row per member per category written at registration and
 * back-filled when a category is added. `push_enabled` is still a column rather than the row's
 * existence, so a member turning a category back on is an update the section can read back,
 * and so a later default of "off" for a new category is one line in the reader
 * (`coalesce(push_enabled, <default>)`) rather than a migration over every member.
 *
 * Gates push only. The in-app centre reads `notification` and never this table, which is what
 * makes "the centre receives everything" a property of the schema rather than of a check.
 *
 * Cascades: a fact about the person and nothing else (README.md beside this file).
 */
export const notificationPreference = pgTable(
  'notification_preference',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    category: notificationCategory('category').notNull(),
    pushEnabled: boolean('push_enabled').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.category] })],
);

/**
 * **One device a member can be reached on** ([3.17.1](docs/project/prd.md),
 * [5.2.5](docs/project/prd.md)) — a Web Push endpoint with its two keys, or an APNs or FCM
 * device token, under the account that registered it.
 *
 * **The endpoint is unique across the table, not per member.** A device belongs to whoever signed
 * in on it last: a phone that one member signs out of and another signs into must not go on
 * receiving the first member's replies, so registering an endpoint re-points its row rather than
 * adding a second. Sign-out deletes the row for the same reason, and a provider answering that
 * the device is gone deletes it too — so what is left is only ever an address that was recently
 * known to work.
 *
 * `p256dh` and `auth` are the Web Push encryption keys and exist exactly on a web row: the check
 * says so, because a web row without them would be an address nothing can be encrypted to, and a
 * token row with them would be two keys for nothing.
 *
 * Cascades: a device registration is meaningless without the person (README.md beside this file).
 * Nothing about the device is stored but its address — no user agent, no name.
 */
export const pushSubscription = pgTable(
  'push_subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    platform: pushPlatform('platform').notNull(),
    /** The Web Push endpoint URL, or the device token. */
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh'),
    auth: text('auth'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Moved on every re-registration, so a row that has not been seen for a year is tellable. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('push_subscription_endpoint_idx').on(table.endpoint),
    /** Delivery: every device of each recipient. */
    index('push_subscription_user_idx').on(table.userId),
    check(
      'push_subscription_keys_on_web',
      sql`(${table.platform} = 'web') = (${table.p256dh} is not null and ${table.auth} is not null)`,
    ),
    check(
      'push_subscription_endpoint_length',
      sql`char_length(${table.endpoint}) between 1 and ${sql.raw(String(MAX_PUSH_ENDPOINT_LENGTH))}`,
    ),
  ],
);

/**
 * **A raise of one day's spend ceiling** (docs/project/prd.md, 3.21.2.8 and 3.19.16).
 *
 * Keyed by the UTC day it applies to, so tomorrow has no row and starts back at the configured
 * default with nothing to clean up. Upserted rather than appended: what the pipeline view needs
 * is "what is today's ceiling and who set it", and two admins raising in the same hour should end
 * with the higher number, never with a race.
 *
 * `ceiling_usd` is the whole ceiling for the day, not an increment — the number an admin typed is
 * the number the ledger enforces, which is the only reading that survives being looked at later.
 * The floor (the configured default) and the cap are enforced where the number is accepted, at
 * the API; the check here only refuses what could never be a ceiling at all.
 */
export const spendCeilingRaise = pgTable(
  'spend_ceiling_raise',
  {
    day: date('day').primaryKey(),
    ceilingUsd: numeric('ceiling_usd', { precision: 10, scale: 2 }).notNull(),
    raisedBy: uuid('raised_by').references(() => user.id, { onDelete: 'set null' }),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
    /** Optional, and shown beside the raise so the next admin knows why it was made. */
    reason: text('reason'),
  },
  (table) => [
    check('spend_ceiling_raise_positive', sql`${table.ceilingUsd} > 0`),
    check('spend_ceiling_raise_reason_length', sql`char_length(${table.reason}) <= 200`),
  ],
);

/**
 * **The sound profile, one row per version** ([3.4.5](docs/project/prd.md),
 * [3.4.7](docs/project/prd.md); project tdd 6.8).
 *
 * **Append-only.** Saving the profile inserts the next version and never updates an earlier one,
 * because a recording records the version that processed it and the number on that row has to
 * keep meaning what it meant. There is no `current` flag: the version in force is the highest
 * one, which is a `max` rather than a column two writers could disagree about. `version` is
 * unique so the same number cannot be written twice, and it is what `recording` references.
 *
 * The three knobs are integers with the shared bounds as check constraints, so a value the API
 * did not refuse is refused here — the same double hold the tag length has. The two loudness
 * parameters that are not knobs (true peak, loudness range) are constants in `@thp/shared` and
 * deliberately not columns: a column nothing writes is a column somebody eventually reads as
 * meaningful.
 *
 * The migration seeds version 1 with the shared defaults, so there is never a moment when a
 * recording could be processed under no profile at all.
 */
export const soundProfile = pgTable(
  'sound_profile',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    version: integer('version').notNull().unique(),
    noiseReductionDb: integer('noise_reduction_db').notNull(),
    voiceClarityDb: integer('voice_clarity_db').notNull(),
    loudnessTargetLufs: integer('loudness_target_lufs').notNull(),
    /** Why this version was saved, in a sentence. Shown beside it on the console. */
    note: text('note'),
    /** `null` for the seeded first version, and for an account since removed. */
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('sound_profile_version_positive', sql`${table.version} > 0`),
    check(
      'sound_profile_noise_reduction_range',
      sql`${table.noiseReductionDb} between ${sql.raw(String(SOUND_PROFILE_BOUNDS.noiseReductionDb.min))} and ${sql.raw(String(SOUND_PROFILE_BOUNDS.noiseReductionDb.max))}`,
    ),
    check(
      'sound_profile_voice_clarity_range',
      sql`${table.voiceClarityDb} between ${sql.raw(String(SOUND_PROFILE_BOUNDS.voiceClarityDb.min))} and ${sql.raw(String(SOUND_PROFILE_BOUNDS.voiceClarityDb.max))}`,
    ),
    check(
      'sound_profile_loudness_target_range',
      sql`${table.loudnessTargetLufs} between ${sql.raw(String(SOUND_PROFILE_BOUNDS.loudnessTargetLufs.min))} and ${sql.raw(String(SOUND_PROFILE_BOUNDS.loudnessTargetLufs.max))}`,
    ),
    check(
      'sound_profile_note_length',
      sql`char_length(${table.note}) <= ${sql.raw(String(MAX_SOUND_PROFILE_NOTE_LENGTH))}`,
    ),
  ],
);

/**
 * **Vectors, beside the rows that say who may read them** (project tdd 4.4) — the foundation
 * semantic search ([3.10](docs/project/prd.md)) and cross-referencing
 * ([3.9](docs/project/prd.md)) are built on. Neither feature is here; this is the table both read.
 *
 * One row per **source** — a transcript segment, a chapter, a note, a published summary or a
 * series — named by `(source_kind, source_id)`, which is unique: embedding a source again
 * *replaces* its row rather than adding one, so a corrected line ([3.5.5](docs/project/prd.md))
 * or a retitled chapter ([3.22.7](docs/project/prd.md)) never leaves its old words findable
 * beside its new ones. The source id is **not a foreign key**, because it points at five tables;
 * what keeps the rows honest is `recording_id`, which cascades, and the embed step itself, which
 * removes rows whose source is gone (project tdd 3.3 says the same of cross-references: a cache
 * of other rows, rebuildable, never a source of truth).
 *
 * `text` is the words the vector was computed from, stored so a re-run can tell an unchanged
 * source from a changed one without spending a call, and so a search hit can be shown without a
 * second read. `model` is which model produced the vector: two models' vectors are not
 * comparable, and a search that mixed them would rank nonsense — so a model change is a
 * re-embed, and this column is how the step knows which rows still need one.
 *
 * `owner_user_id` is set on **private notes and nothing else** ([3.12.3](docs/project/prd.md)),
 * and it is the whole of what makes [3.10.9](docs/project/prd.md) a `where` clause: a row with
 * an owner is visible to that member alone. It cascades on the account, because a private note
 * goes with its account ([3.1.9](docs/project/prd.md)) and its vector has to go with the note.
 * Public notes carry no owner here for the same reason `note.author_id` restricts rather than
 * cascades — a public note outlives its author, and so must its vector.
 *
 * `recording_id` is nullable for exactly one kind, `series`, which belongs to no single teaching.
 * The check says so, rather than leaving a null recording as something any kind may have.
 *
 * The vector is `vector(1536)` — the width is `EMBEDDING_DIMENSIONS` and nothing else, so an
 * adapter answering a different width is refused by the column. Its HNSW index under cosine
 * distance is declared below and emitted by drizzle-kit; what drizzle-kit does **not** emit is
 * the `vector` extension the type comes from, which is hand-written at the top of the migration
 * that creates this table.
 */
export const embedding = pgTable(
  'embedding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceKind: embeddingSource('source_kind').notNull(),
    sourceId: uuid('source_id').notNull(),
    /** Cascades: a teaching that is gone has nothing left to find. */
    recordingId: uuid('recording_id').references(() => recording.id, { onDelete: 'cascade' }),
    /** The member a private note belongs to; null on everything a member may share. */
    ownerUserId: uuid('owner_user_id').references(() => user.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** One vector per source: embedding a source again replaces it. */
    uniqueIndex('embedding_source_unique').on(table.sourceKind, table.sourceId),
    /** Every write is "this recording's rows", and this index is that read. */
    index('embedding_recording_idx').on(table.recordingId),
    /**
     * Cosine distance over the vector, HNSW (project tdd 4.4). Cosine because the real model's
     * vectors are unit length and cosine is what its documentation ranks by; HNSW because the
     * table is read far more than written, and an index built once per embed is the cheap side
     * of that trade.
     */
    index('embedding_vector_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    /**
     * **The full-text half of search** (project tdd 4.5), over the same `text` the vector was
     * computed from — so the two arms of a hybrid query read one set of sources and a row found by
     * either is the same row ([3.10.5](docs/project/prd.md)).
     *
     * An expression index rather than a generated `tsvector` column, so the table's shape is what
     * the embed step wrote and nothing else: the step is not taught about full-text, and a reader
     * of the row sees words, not lexemes. GIN because the index is read far more than written, the
     * same trade the HNSW index above makes. `english` is the configuration the search query must
     * spell identically — `search.ts` names it once and the index names it here — because a
     * `to_tsvector` under any other configuration would not use this index and would rank by a
     * different stemming.
     */
    index('embedding_text_search_idx').using(
      'gin',
      sql`to_tsvector('english', ${table.text})`,
    ),
    /** A series has no recording; everything else has exactly one. */
    check(
      'embedding_recording_per_kind',
      sql`(${table.sourceKind} = 'series') = (${table.recordingId} is null)`,
    ),
    /** Only a note can be private, so only a note can have an owner. */
    check(
      'embedding_owner_only_on_note',
      sql`${table.ownerUserId} is null or ${table.sourceKind} = 'note'`,
    ),
  ],
);

/**
 * **One member choosing not to see another** — the block Apple guideline 1.2 and Google Play's
 * UGC policy require of any product with member-written content.
 *
 * **The primary key is the requirement.** `(blocker_id, blocked_id)` is "a pair is blocked at most
 * once", so blocking somebody twice is one `on conflict do nothing` rather than a read-then-write,
 * and the row is also the whole of the fact: there is no `active` flag and no `unblocked_at`,
 * because an unblock is a delete. A block carries no reason and no note — nothing about the
 * blocked member is stored that they did not write themselves.
 *
 * **Directed, and read in both directions.** The row says who pressed the control, which is what
 * the blocked list in profile settings reads and what an unblock deletes. What a block *does* is
 * symmetric — `member-blocks.ts`'s predicate asks "is there a row either way round" — so one row
 * hides each member from the other rather than two rows that could disagree.
 *
 * **Both sides cascade**, like `note_reaction`: a block is a fact about a pairing and is meaningless
 * without either half. A deactivated account is *not* deletion ([3.1.7](docs/project/prd.md)), so
 * a member's blocks survive the other side leaving and still apply to what that account authored.
 *
 * The check refuses a self-block at the database; the service refuses it first with a sentence.
 *
 * `blocked_id` is indexed on its own because the predicate's second half — "has the author
 * blocked the reader" — is looked up by the column the primary key does not lead with.
 */
export const memberBlock = pgTable(
  'member_block',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerId, table.blockedId] }),
    index('member_block_blocked_idx').on(table.blockedId),
    check('member_block_not_self', sql`${table.blockerId} <> ${table.blockedId}`),
  ],
);

/**
 * **A member's report on a public note** — Apple guideline 1.2's "mechanism to report offensive
 * content" and Google Play's UGC policy, as a row an admin reads in the console.
 *
 * **One row per report, not one per note.** Three members reporting the same note are three
 * requests to look, each with its own reason and its own reporter to answer; collapsing them would
 * lose the reasons and leave two reporters unanswered. What *is* collapsed is the decision: an
 * admin resolves a note, and the service closes every open report on it with the same outcome in
 * one statement, because one note cannot be both removed and left up.
 *
 * **`resolved_at` is the whole of the state.** Null is open and the queue; set is closed, with the
 * outcome beside it. No `status` enum to keep in step with the timestamp — the shape `review_item`
 * chose for the same reason, and the partial index below is the queue read exactly.
 *
 * **Deletion follows the README**, column by column. `note_id` cascades: a report about a note the
 * database no longer holds is about nothing (a *tombstoned* note is still a row, so its reports
 * survive and are closed by the resolution, never by the cascade). `reporter_id` and `resolved_by`
 * **set null**: each is a record of something that happened that this person caused — a report
 * made, a decision taken — and the record outlives the account, exactly as `review_item.reviewed_by`
 * does. The console prints "a former member" over a null reporter.
 *
 * No `recording_id`: the note knows its recording, and a second copy here could only disagree.
 * No `detail` ceiling at the database beyond the shared constant, derived as every ceiling is.
 */
export const noteReport = pgTable(
  'note_report',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    noteId: uuid('note_id')
      .notNull()
      .references(() => note.id, { onDelete: 'cascade' }),
    reporterId: uuid('reporter_id').references(() => user.id, { onDelete: 'set null' }),
    reason: reportReason('reason').notNull(),
    /** The reporter's sentence to the admin, or null. Trimmed by the service; empty is stored null. */
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null while open. Set once, with the outcome and who decided, and never cleared. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    outcome: reportOutcome('outcome'),
    resolvedBy: uuid('resolved_by').references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    /** The queue: open reports, oldest first. One index scan for the console. */
    index('note_report_open_idx')
      .on(table.createdAt)
      .where(sql`${table.resolvedAt} is null`),
    /** The resolution: every open report on one note, closed together. */
    index('note_report_note_idx').on(table.noteId),
    /** Closed means an outcome was recorded; open means none was. Both directions, one check. */
    check(
      'note_report_resolution_whole',
      sql`(${table.resolvedAt} is null) = (${table.outcome} is null)`,
    ),
    check(
      'note_report_detail_length',
      sql`char_length(${table.detail}) <= ${sql.raw(String(MAX_REPORT_DETAIL_LENGTH))}`,
    ),
  ],
);

/**
 * **A link from a moment of one teaching to a moment of another** ([3.9](docs/project/prd.md);
 * project tdd 3.3) — the derived edge table over segment pairs, written by the worker's
 * `cross_reference` step and read by the recording page while a member listens.
 *
 * **Directed, and written in both directions.** [3.9.6](docs/project/prd.md) asks that a new
 * teaching link into the library *and* that the library gain links back to it, and the read on a
 * recording page is "the links out of this teaching". So every link the step finds is two rows,
 * one from each side, and a page reads one `where source_recording_id = ?` with no union and no
 * column swap. The price is a table twice the size of the undirected one, and the table is small:
 * three links per chapter per run (`CROSS_REFERENCES_PER_CHAPTER`), both ways.
 *
 * **`computed_for` is which run owns the row.** A run for teaching A writes rows under A's
 * segments and under B's; a later run for A has to replace exactly those and not the rows B's own
 * run wrote under the same segments. Keyed by the recording rather than the job because the ledger
 * is append-only and a re-run is a new job: "A's current links" is a fact about A. The unique
 * index is over the pair *and* the run, so A's run and B's run may both find the same pair — they
 * are two opinions with two scores, deduplicated by the read — while one run writing it twice is
 * refused, which is what makes the step's replace idempotent under at-least-once dispatch.
 *
 * **Every key cascades, and that is most of the lifecycle.** A re-transcription replaces the
 * transcript, which deletes its segments, which takes every link anchored to them on either side
 * — the chain then re-runs this step and writes fresh ones. Deleting a recording takes its rows
 * both ways. What cascades cannot do is **unpublishing** ([3.2.11](docs/project/prd.md)), which
 * deletes nothing: the publication route removes every row touching the recording in the same
 * transaction, and the read gates targets on publication besides, so a link to an unpublished
 * teaching is never shown even in the moment between the two.
 *
 * **No reference to `user`**, so the account-deletion convention in [README.md](./README.md) has
 * nothing to ask of it: a link is a fact about two teachings and about no person.
 *
 * `score` is cosine similarity in `0..1`, a `real` because four significant figures is more than
 * a ranking needs and the table is read far more than its precision is. The two checks refuse the
 * rows no run should write: a link from a teaching to itself, and a row owned by a run for a
 * recording that is on neither end of it.
 */
export const crossReference = pgTable(
  'cross_reference',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceRecordingId: uuid('source_recording_id')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    sourceSegmentId: uuid('source_segment_id')
      .notNull()
      .references(() => segment.id, { onDelete: 'cascade' }),
    targetRecordingId: uuid('target_recording_id')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    targetSegmentId: uuid('target_segment_id')
      .notNull()
      .references(() => segment.id, { onDelete: 'cascade' }),
    /** Cosine similarity, 0..1. The whole of the ranking. */
    score: real('score').notNull(),
    basis: crossReferenceBasis('basis').notNull(),
    /** The recording whose run wrote this row — the unit a re-run replaces. */
    computedFor: uuid('computed_for')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** One run says a pair once. Two runs may both say it; the read keeps the stronger. */
    uniqueIndex('cross_reference_pair_per_run_unique').on(
      table.sourceSegmentId,
      table.targetSegmentId,
      table.computedFor,
    ),
    /** The read: every link out of this teaching. */
    index('cross_reference_source_recording_idx').on(table.sourceRecordingId),
    /** Unpublishing: every row pointing at this teaching, which the source index does not find. */
    index('cross_reference_target_recording_idx').on(table.targetRecordingId),
    /** The replace: every row this teaching's run owns. */
    index('cross_reference_computed_for_idx').on(table.computedFor),
    check('cross_reference_score_range', sql`${table.score} between 0 and 1`),
    check(
      'cross_reference_across_recordings',
      sql`${table.sourceRecordingId} <> ${table.targetRecordingId}`,
    ),
    check(
      'cross_reference_owned_by_an_end',
      sql`${table.computedFor} in (${table.sourceRecordingId}, ${table.targetRecordingId})`,
    ),
  ],
);

/**
 * **One entry in a member's Highlights** ([3.15](docs/project/prd.md); [4.14](docs/project/prd.md)):
 * a whole teaching, one line of it, or a note of the member's own, with the date it was pinned.
 *
 * **One row per target per member**, and the target's shape depends on the kind, so uniqueness
 * is three partial indexes rather than one: a teaching once, a line once by its position, a note
 * once. A whole-teaching pin and a line of the same teaching are two entries, because they are two
 * things a member said ([3.15.1](docs/project/prd.md) and [3.15.2](docs/project/prd.md) are two
 * requirements). The check beneath them is what makes the kind honest: a `segment` row has a
 * position and no note, a `note` row has a note and no position, a `recording` row has neither.
 *
 * **A line is a position, snapped.** The service snaps "this moment" to the start of the transcript
 * line playing there and stores both the position and the line's id. The position is the identity
 * and the thing that opens the player; the id is only how the playlist reads the line's text. It
 * **sets null** when the transcript is replaced — the segments cascade with it — so a re-run takes
 * the description off an entry and never the entry: the moment the member chose is still the
 * moment, whatever the new segmentation calls it.
 *
 * **A note's moment is not stored here.** 4.14 says a note entry has a timestamp, and it does:
 * the note's own, read at answer time. A second copy could only disagree with the first. The
 * composite foreign key beneath is what makes `recording_id` honest on a note entry — it must be
 * the note's recording — and it is why the schema keeps `note_recording_id_unique`.
 *
 * **Deletion follows the README.** `user_id` cascades: a playlist is a fact about the person and
 * nothing else, and 3.1.9 names Highlights among what goes with an account. `recording_id`
 * cascades: a highlight of a teaching the database no longer holds is of nothing. `note_id`
 * cascades — which a *soft* delete never fires, so the notes service removes a tombstoned note's
 * entries itself in the delete's transaction, and the list read leaves tombstones out besides.
 *
 * No `title`, no `description`: the playlist reads them off the teaching and the note at answer
 * time, so a renamed teaching is renamed in the playlist too.
 */
export const highlight = pgTable(
  'highlight',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recording.id, { onDelete: 'cascade' }),
    kind: highlightKind('kind').notNull(),
    /** The moment, in milliseconds — non-null exactly on a `segment` entry. */
    positionMs: integer('position_ms'),
    /**
     * The transcript line the position was snapped to, or null: a teaching with no transcript, a
     * position after its last line, or a line a later run replaced. Never the identity — see above.
     */
    segmentId: uuid('segment_id').references(() => segment.id, { onDelete: 'set null' }),
    /** The member's own note — non-null exactly on a `note` entry. */
    noteId: uuid('note_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** The playlist's order exactly (3.15.6: newest pinned first), one index scan per member. */
    index('highlight_user_created_idx').on(table.userId, table.createdAt),
    /** The three identities, one per kind. */
    uniqueIndex('highlight_recording_unique')
      .on(table.userId, table.recordingId)
      .where(sql`${table.kind} = 'recording'`),
    uniqueIndex('highlight_segment_unique')
      .on(table.userId, table.recordingId, table.positionMs)
      .where(sql`${table.kind} = 'segment'`),
    uniqueIndex('highlight_note_unique')
      .on(table.userId, table.noteId)
      .where(sql`${table.kind} = 'note'`),
    /** A note entry names the note's own recording, and goes with the note. */
    foreignKey({
      columns: [table.recordingId, table.noteId],
      foreignColumns: [note.recordingId, note.id],
      name: 'highlight_note_recording_fk',
    }).onDelete('cascade'),
    /** The kind says what the row holds; both directions, one check. */
    check(
      'highlight_shape',
      sql`(${table.kind} = 'segment') = (${table.positionMs} is not null)
        and (${table.kind} = 'note') = (${table.noteId} is not null)
        and (${table.segmentId} is null or ${table.kind} = 'segment')
        and (${table.positionMs} is null or ${table.positionMs} >= 0)`,
    ),
  ],
);

/**
 * **A receipt for one outbox entry** ([3.18.14](docs/project/prd.md), [3.18.15](docs/project/prd.md);
 * project tdd 5.3) — the one table offline sync needs, and it holds no member content.
 *
 * The outbox is flushed over a connection that was just lost and may be lost again: a phone that
 * sent its entries and never saw the answer sends them again. The client id on each entry (tdd 5.3)
 * is what makes the second flush harmless, and this row is where the server remembers having seen
 * it. The write itself landed where every live write lands — `playback_progress`, `note` — so a
 * receipt is a record that *this flush was handled*, not a second copy of what it wrote. What it
 * keeps beside the id is what a replay has to answer with: the status, the refusal if there was
 * one, and for a note the row it became, so a client that missed the first answer can still swap
 * its pending copy for the real note.
 *
 * Keyed on `(user_id, client_id)` rather than on the client id alone: a client id is minted on a
 * device, and two members' devices are two sources of ids with no reason to agree. A member cannot
 * collide with themselves — one outbox per account per device, and a uuid per entry.
 *
 * `kind`, `status` and `code` are text with a check rather than enums, because they are the wire
 * vocabulary of `@thp/shared`'s offline contract and a retired status is a row nobody reads again —
 * the argument `user_onboarding` makes for its id. The checks still derive from the shared lists,
 * so the column cannot hold a word the contract does not.
 *
 * **Deletion follows the README**: `user_id` cascades — a receipt is a fact about the person's own
 * device and means nothing without them; `note_id` sets null when the note goes, because the
 * receipt outlives a deleted note the way a log line does, and a replay after the deletion answers
 * `applied` with no note, which the client reads as "already handled, nothing to show".
 */
export const syncReceipt = pgTable(
  'sync_receipt',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The id the device minted for the entry; uuid-shaped, checked by the service, stored as text. */
    clientId: text('client_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    /** The API error code the entry was refused with, or null when it was applied. */
    code: text('code'),
    message: text('message'),
    noteId: uuid('note_id').references(() => note.id, { onDelete: 'set null' }),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.clientId] }),
    check(
      'sync_receipt_kind',
      sql`${table.kind} in (${sql.raw(SYNC_ENTRY_KINDS.map((kind) => `'${kind}'`).join(', '))})`,
    ),
    check(
      'sync_receipt_status',
      sql`${table.status} in (${sql.raw(SYNC_RESULT_STATUSES.filter((status) => status !== 'duplicate').map((status) => `'${status}'`).join(', '))})`,
    ),
    /** A refusal names its reason; an application has none. */
    check('sync_receipt_refusal_whole', sql`(${table.status} = 'refused') = (${table.code} is not null)`),
  ],
);
