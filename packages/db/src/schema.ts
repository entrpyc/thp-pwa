import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { JOB_STATUSES, PIPELINE_STEPS, ROLES, UNFINISHED_JOB_STATUSES } from '@thp/shared';

/**
 * The Drizzle schema. Server-only by construction: this package is never imported by a client
 * module, and the import-boundary guard fails the build if it ever is.
 *
 * **Tables arrive with the ticket that uses them.** Ticket 1 shipped the migration mechanism and the
 * two domain enums; ticket 2 added `user` and `session`; ticket 3 added `invitation`; ticket 4 added
 * `password_reset`. Story 2 Ticket 01 adds `recording`, Ticket 02 the `job` ledger beneath it, and
 * Ticket 03 `transcript` and `segment` — `review_item` and the rest are still absent.
 *
 * The enums are **derived** from the shared TypeScript constants rather than restated beside them.
 * That is what keeps "each enum is declared exactly once in the repository" true, and it is
 * enforced by tests/guards/domain-declarations.test.ts.
 */
export const userRole = pgEnum('user_role', ROLES);

export const pipelineStep = pgEnum('pipeline_step', PIPELINE_STEPS);

export const jobStatus = pgEnum('job_status', JOB_STATUSES);

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

/**
 * A single run of a single pipeline step for a single recording (Story 2 Ticket 02) — **the ledger
 * and the queue at once**. There is no broker and no second store: the rows the worker dispatches
 * from are the same rows an operator queries and Ticket 04 renders a dashboard out of
 * (docs/project/architecture.md § Key technology choices, the ledger-is-the-queue row).
 *
 * **The table is append-only.** A step that is re-run is a *new row*, not a status reset, with
 * `attempt` counting 1, 2, 3 for a `(recording_id, step)` pair — so a failure that was later
 * re-run stays readable, and "what happened to this recording" is a history rather than a snapshot.
 * That is why uniqueness cannot be over the pair itself; see the index below.
 *
 * **`correlation_id` is a column, not an inference.** The worker is a second process with no
 * request behind it, so the id that
 * docs/epics/epic-core-listening/architecture.md § Key choices wants spanning API request → job →
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
 * run now. No `payload`, because a step's input is the recording it names. The migration test
 * asserts the exact column set rather than trusting this comment.
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
 * (docs/epics/epic-core-listening/architecture.md § Extension points).
 *
 * The columns are the fields of the `Segment` type in `@thp/shared`, matched rather than
 * re-invented; tests/guards/segment-shape.test.ts fails the build if the two ever disagree. Notes,
 * highlights, mind maps, search and Flow Tracker all resolve through `(recording_id, timestamp_ms)`
 * in later epics, and this row is where that pair becomes real.
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
