import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  DEFAULT_PLAYBACK_SPEED,
  JOB_STATUSES,
  MAX_NOTE_LENGTH,
  NOTE_VISIBILITIES,
  PIPELINE_STEPS,
  PLAYBACK_SPEEDS,
  REVIEW_KINDS,
  REVIEW_STATUSES,
  ROLES,
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
 */
export const userRole = pgEnum('user_role', ROLES);

export const pipelineStep = pgEnum('pipeline_step', PIPELINE_STEPS);

export const jobStatus = pgEnum('job_status', JOB_STATUSES);

export const reviewKind = pgEnum('review_kind', REVIEW_KINDS);

export const reviewStatus = pgEnum('review_status', REVIEW_STATUSES);

export const noteVisibility = pgEnum('note_visibility', NOTE_VISIBILITIES);

/**
 * An account. Columns arrive with the steps that use them: `deactivated_at` comes with ticket 4
 * (account lifecycle) and `preferred_playback_speed` with Story 4 Ticket 03, which is where the
 * speed control that writes it ships. There is still no avatar — docs/project/prd.md 3.1.12's is
 * deferred, and a nullable column "for later" is how deferral quietly stops being deferral.
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
     * check constraint is the six steps, **derived from the shared tuple** rather than restated —
     * so the column cannot hold a rate no control can produce, and a seventh step is one edit
     * there plus one migration.
     */
    preferredPlaybackSpeed: real('preferred_playback_speed')
      .notNull()
      .default(DEFAULT_PLAYBACK_SPEED),
  },
  (table) => [
    uniqueIndex('user_email_lower_unique').on(sql`lower(${table.email})`),
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
 * A named series of teachings (Story 6 Ticket 01) — the **left-hand end** of the spine
 * docs/epics/epic-core-listening/architecture.md § Data model draws as
 * `Series 1—* Recording 1—1 Transcript 1—* Segment`, and the only entity this story adds.
 *
 * **Four columns, and the absences are the design.** No `recording_count` and no `date_range`:
 * docs/project/prd.md 4.3 calls both auto-calculated, and a denormalised count is a second answer
 * to a question one query already answers — the console's count and a member's count of the same
 * series legitimately differ (3.2.2), which a column could not express. No `artwork_key`, because
 * 3.3.3 is deferred and both design references draw covers this epic does not ship. No `position`
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A recording (Story 2 Ticket 01) — the first row in the spine
 * docs/epics/epic-core-listening/architecture.md § Data model draws as
 * `Series 1—* Recording 1—1 Transcript 1—* Segment`.
 *
 * **What is absent is the design.** There is no `duration`, because nothing inspects the media in
 * this epic ([§3.4](docs/project/prd.md) is deferred whole); no `processed_media_key`, because no
 * processed rendition exists and that column is the named seam
 * (docs/epics/epic-core-listening/architecture.md § Extension points, "Second media pointer").
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

/**
 * **The review gate** (Story 3 Ticket 01) — one table for every AI artefact this product will ever
 * generate, not one table per artefact
 * (docs/epics/epic-core-listening/architecture.md § Data model (epic)).
 *
 * That is the whole design, and it buys one property:
 * docs/project/architecture.md § Cross-cutting concerns asks that "everything waiting on an admin"
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
 * (docs/epics/epic-core-listening/architecture.md § Data model (epic), *Member-owned state*).
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
 * What is absent is the design. No `id`, because the pair *is* the identity. No `completed_at` and
 * no play log — [3.2.7](docs/project/prd.md) and [3.2.8](docs/project/prd.md) are deferred, and a
 * column added "for later" is how deferral quietly stops being deferral. No `duration`, because
 * nothing in this epic inspects the media and the player learns the total from the element. The
 * migration test asserts the exact column set rather than trusting this comment.
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
  },
  (table) => [primaryKey({ columns: [table.userId, table.recordingId] })],
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
 * docs/project/architecture.md § Data model states outright that public notes must not cascade from
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
