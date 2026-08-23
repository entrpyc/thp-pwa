# Teaching Hub — Implementation plan: notes

_Planned: 2026-08-24_

## Status

14/121 criteria met. Groups complete: none.
_Maintained by implementation — see the checkboxes for detail._

## Background to research

- Postgres stored generated columns and composite foreign keys
- Soft deletion and tombstone rows
- `INSERT … ON CONFLICT` as a concurrency primitive
- Ownership-scoped authorisation (`requiresOwnership`)
- Query-layer privacy conditions versus interface filtering
- Emoji variation selectors and glyph normalisation
- Accessible labelling of non-text controls — emoji and timeline markers
- Overlaying a non-interactive marker layer on `<input type="range">`

---

## Group 1 — Write a note at a moment and read a teaching's notes

**Delivers:** a member can stop at a moment in a teaching, write it down as a private study note or
a public one the group sees, and read every note on that teaching — their own and the group's — in
time order under a Notes tab, narrowed to All, Public or Mine.
**Feature:** active-scope prd 3.1, and active-scope prd 3.2's list (its transport markers are
Group 2).

### Task 1.1 — The `note` table

**Delivers:** a `note` row exists, and the rules a note can never break — one level of reply, a
position on top-level notes only, a public-only reply, a 1,000-character ceiling — are refused by
Postgres rather than by code that remembers to check.
**References:** active-scope architecture § 6.1 `note` — new; active-scope prd 4.1 Note
**Out of scope:** `note_reaction` (Task 4.1) and `note_pin` (Task 6.2); any store function, service
or route.
**Prerequisites:** none.

**Acceptance criteria**

- [x] **1.1.1** A migration creates `note` with every column at active-scope architecture § 6.1 and
  its three indexes — `(recording_id, timestamp_ms, created_at)`, `(parent_id, created_at)` and
  `unique (recording_id, id)` — verified by `packages/db/tests/integration/notes.test.ts`
  - a migration beside the existing ones, applied by the migration runner
  - the indexes are asserted against the catalogue, not just the schema file
- [x] **1.1.2** `visibility` is a Postgres enum generated from a shared `NOTE_VISIBILITIES` tuple and
  stated nowhere else in the codebase — verified by `tests/guards/domain-declarations.test.ts`
  - the tuple is exported from `packages/shared`; the enum is derived from it
- [x] **1.1.3** Deleting a recording deletes its notes, and deleting a user who has written one is
  refused by the database — verified by `packages/db/tests/integration/notes.test.ts`
  - `recording_id` on delete cascade, `author_id` on delete restrict
  - restrict is deliberate: account deletion is meant to fail here until re-attribution exists
- [x] **1.1.4** A top-level row with no `timestamp_ms`, and a reply row carrying one, are each
  refused — verified by `packages/db/tests/integration/notes.test.ts`
  - `check ((parent_id is null) = (timestamp_ms is not null))`
- [x] **1.1.5** An insert whose `parent_id` names a row that is itself a reply is refused by the
  database, not by a lookup inside the transaction — verified by
  `packages/db/tests/integration/notes.test.ts`
  - the `is_reply` / `parent_is_reply` generated-column pair, `unique (id, is_reply)` and the
    composite foreign key back to `note (id, is_reply)`
- [x] **1.1.6** A reply row with `visibility = 'private'` is refused; text longer than 1,000
  characters is refused; and a row carrying both `deleted_at` and text, or neither, is refused —
  verified by `packages/db/tests/integration/notes.test.ts`
  - `check (parent_id is null or visibility = 'public')`, `check (char_length(text) <= 1000)` and
    `check ((text is null) = (deleted_at is not null))`

**Record** — _updated 2026-08-24_

- **Edge cases:** a reply's `recording_id` is not tied to its parent's — a reply filed under a
  different recording is a row the database accepts, and it would appear in the wrong teaching's
  list with no thread above it; Task 3.1's service is where that gets refused
- **Edge cases:** `visibility` is immutable by convention only — nothing at the database stops
  `update note set visibility = 'public'`, so a stray update or a hand at the console would turn a
  private note public with nobody notified
- **Edge cases:** `timestamp_ms` is unbounded — `recording` has no duration, so a note at a
  negative offset or past the end of the teaching stores fine and shows as a note the scrubber can
  never reach
- **Edge cases:** whitespace-only text is accepted — the trim is the service's (1.4.4), so until
  that ships a note written as spaces reads as a blank row in the list
- **Edge cases:** `edited_at` can be set on a tombstone — nothing pairs the two, so a deleted note
  could carry the **edited** indicator
- **Edge cases:** nothing makes a note unique — the same sentence written twice at the same moment
  is two rows and shows twice
- **Edge cases:** a hard `delete` of a top-level note that has replies is refused by the composite
  key — only a hand at the database sees this, because the product's delete is a tombstone
- **Assumptions, major (confirmed):** none — every column, constraint and index is stated in
  active-scope architecture § 6.1, so nothing was left for implementation to settle
- **Assumptions, minor:** constraint and index names follow the house pattern
  (`note_recording_timestamp_idx`, `note_position_on_top_level_only`, …); the migration is tagged
  `0012_notes`; `parent_id` carries the composite foreign key **only** — a second single-column
  key would be the same rule enforced twice
- **Reworked:** none
- **False positives fixed:** 0 — eleven deliberate breaks, each landing on exactly the test that
  names the behaviour and no other
- **Operator steps:** run `npm run migrate` against any database that is not rebuilt from empty —
  the development one at `DATABASE_URL` included. The test suite migrates its own throwaway
  databases and needs nothing
- **Notes:** `MAX_NOTE_LENGTH` and `NOTE_VISIBILITIES` now live in `packages/shared/src/notes.ts`,
  and `NOTE_VISIBILITIES` / `NoteVisibility` are registered in `tools/domain-declarations.ts`;
  Task 1.4 reads the same ceiling. Two existing tests keep an exhaustive inventory of tables and
  enums and were updated to include `note` and `note_visibility` —
  `packages/db/tests/integration/migrations.test.ts` and `.../invitations.test.ts`. `is_reply` and
  `parent_is_reply` are real columns and will land in any `select *`: Task 1.2 should name its
  columns rather than return them

### Task 1.2 — The notes store and the private-note condition

**Delivers:** one module owns every statement against `note`, and it is the only place in the
codebase that decides which notes a given reader may see.
**References:** active-scope architecture § 4.1 Notes store; active-scope prd 3.1.9, 3.2.1
**Out of scope:** the build guard that enforces the single statement (Task 1.3); tombstone handling
(Task 5.2); reactions and pins in the read (Tasks 4.3, 6.4).
**Prerequisites:** none.
**Depends on:** 1.1

**Acceptance criteria**

- [x] **1.2.1** `packages/db/src/notes.ts` creates a note and returns its row, taking an `Executor`
  so a caller can pull the write into a transaction — verified by
  `packages/db/tests/integration/notes.test.ts`
  - the shape `transcripts.ts` and `playback.ts` already take
- [x] **1.2.2** The store reads a recording's notes for a given reader ordered by `timestamp_ms`
  ascending then `created_at` ascending, giving one total order identical across repeated calls —
  verified by `packages/db/tests/integration/notes.test.ts`
  - the order matches the `(recording_id, timestamp_ms, created_at)` index exactly
- [x] **1.2.3** The read returns every public note on the recording plus the reader's own private
  ones, and no other member's private note in any position — verified by
  `packages/db/tests/integration/notes.test.ts`
  - the private-note condition `visibility = 'public' or author_id = :me`, in the query
- [x] **1.2.4** The store states the private-note condition itself rather than taking a pre-filtered
  set, and no statement in it compares `recording.published_at` — the publication gate is
  `visibility.ts`'s — verified by `tests/guards/visibility-boundary.test.ts`
  - the store is handed a recording id the caller has already gated
- [x] **1.2.5** No Drizzle type crosses the package boundary: the module's exports are row types in
  and row types out — verified by `tests/guards/import-boundary.test.ts`

**Record** — _updated 2026-08-24_

- **Edge cases:** the read never asks whether the recording exists — a list for a deleted or
  invented id comes back empty, which a member reads as a teaching nobody has annotated rather than
  as a wrong link
- **Edge cases:** tombstones come back as ordinary rows — once Task 5.1 or a hand at the console
  writes one, the list carries an entry whose text is `null` and the panel renders a blank note.
  Task 5.2 is where that is filtered
- **Edge cases:** `insertNote` checks nothing before writing — a create naming a recording or an
  author that does not exist surfaces as a raw Postgres foreign-key error, not a refusal, until Task
  1.4's service gates it. The same for an impossible shape: the table refuses it and the caller sees
  a constraint violation
- **Edge cases:** the reader id is taken on trust — an unknown or empty reader id reads as "somebody
  who has written nothing" and gets every public note, which is what an unauthenticated read would
  look like if a route ever forgot its session. Only `apiRoute`'s access rule stops that
- **Edge cases:** the read is complete and unpaged — a recording carrying thousands of notes returns
  all of them in one array and the tab takes as long as that takes. Deliberate (active-scope prd
  7.7), and the Performance NFR's 200-note bar is what to re-read when it stops being true
- **Assumptions, major (confirmed):** the read answers **top-level notes only** —
  `where parent_id is null` — so the order is the `(recording_id, timestamp_ms, created_at)` index
  exactly; a reply carries no position and has no place in a list ordered by one. Task 3.1 adds a
  second read for a note's thread
- **Assumptions, major (confirmed):** `NoteRow` carries **every stored column except the two
  generated ones**, `deletedBy` included. The store answers what is stored; § 4.5's wire contract
  is what drops `deletedBy` before a member sees it (3.5.8), so Tasks 5.1 and 5.2 widen nothing
- **Assumptions, minor:** `insertNote` and `listNotesForReader` follow the house `insertX` /
  `listX` naming; the reads name their columns through one `NOTE_COLUMNS` object rather than
  `select *`, which is what Task 1.1's record asked for; no `findNoteById` was written — no
  criterion here needs one and Task 1.4 is where the first caller appears
- **Reworked:** 1.2.2 — the tie-break assertion passed with `asc(note.createdAt)` removed, because
  Postgres happened to return the tied rows in insertion order. Rewritten to plant three notes at
  one moment whose `created_at` order is deliberately not their insertion order, so an
  `order by timestamp_ms` on its own cannot pass it
- **False positives fixed:** 1 — twenty deliberate breaks in all, nineteen caught first time
- **Operator steps:** none
- **Notes:** `insertNote`, `listNotesForReader`, `NewNote` and `NoteRow` are exported from
  `@thp/db`. Task 1.4 reads `MAX_NOTE_LENGTH` from `@thp/shared` and refuses over-long text before
  reaching the store — the table's constraint is the backstop, not the message. Task 3.1's thread
  read must state the private-note condition **in this module**; the guard from Task 1.3 will refuse
  it anywhere else. `tools/import-boundary.ts` gained `checkStoreExportSurface` and a
  `STORE_MODULE_FILES` list — a store module for `note_reaction` or `note_pin` (Tasks 4.1, 6.2)
  must be added to that list or its export surface is unchecked

### Task 1.3 — The note-privacy guard

**Delivers:** the Privacy NFR stops being a claim — a second statement of the private-note condition
anywhere in the codebase fails the build.
**References:** active-scope architecture § 4.2 Note privacy guard; active-scope prd 6 (Privacy)
**Out of scope:** any change to `tools/visibility-boundary.ts` or its test — this ships beside it,
not inside it.
**Prerequisites:** none.
**Depends on:** 1.2

**Acceptance criteria**

- [x] **1.3.1** A predicate over `note.visibility` or `note.author_id` written anywhere outside
  `packages/db/src/notes.ts` fails the guard — verified by `tests/guards/note-privacy.test.ts`
  - `tools/note-privacy.ts`, modelled on `tools/visibility-boundary.ts`, walking the source tree
  - the test plants a violation in a fixture and asserts the guard reports it
  - _(amended at implementation)_ `packages/db/src/schema.ts` is exempt alongside the owning
    module: its `note_reply_is_public` check constraint spells `visibility = 'public'` and decides
    what may be **stored**, never who may read it — the same carve-out
    `tools/visibility-boundary.ts` makes for writing a publication timestamp. The exemption list is
    asserted to be exactly that one file, so widening it is a visible edit
- [x] **1.3.2** The guard fails when `packages/db/src/notes.ts` stops stating the condition, so a pass
  can never mean nothing checks privacy at all — verified by `tests/guards/note-privacy.test.ts`
  - the owning module is asserted positively, not only the absence of violations elsewhere
- [x] **1.3.3** `tools/visibility-boundary.ts` and its test are unchanged, and the recording
  publication guard still passes over every read path that depends on it — verified by
  `tests/guards/visibility-boundary.test.ts`
  - two guards, one concept each

**Record** — _updated 2026-08-24_

- **Edge cases:** the guard reads text, so a predicate assembled through a variable —
  `const column = note.visibility` and then `eq(column, me)` — is not recognised. A second copy of
  the condition written that way ships with a green build
- **Edge cases:** `packages/db/src/schema.ts` is exempt, so a note read query written into the
  schema file would not be reported. Nothing writes queries there today, and the test asserts the
  exemption list is exactly that one file, but the hole is real
- **Edge cases:** the guard walks the four package source trees only — a note query written in
  `scripts/` or in another `tools/` file is invisible to it
- **Edge cases:** comparing visibility **in JavaScript** is deliberately allowed, because the
  All / Public / Mine filter (3.2.3) and the **Private** badge (3.2.2) both do it. So a client that
  filtered a payload it should never have been sent still passes — the API is what makes that
  impossible, and this guard only makes sure the API's rule is written once
- **Edge cases:** a leak that never compares visibility at all is not caught. Task 4.3's reaction
  counts and Task 6.4's pins are the shape to watch: a count assembled from an unfiltered join over
  `note_reaction` reveals that a private note exists without naming either column. Both must read
  through `packages/db/src/notes.ts`
- **Assumptions, major (confirmed):** none
- **Assumptions, minor:** the guard states both halves of the condition as one pattern list and
  reuses it in both directions — the shape that is a violation everywhere else is the shape the
  owning module is required to state, so the two can never drift apart; an assignment
  (`const visibility = 'private'`) is excluded by lookbehind so the composer at Task 1.8 does not
  trip it
- **Reworked:** none
- **False positives fixed:** 0
- **Operator steps:** none
- **Notes:** 1.3.1 was amended to record the `schema.ts` exemption the shipped table forced — see
  the criterion. `tools/visibility-boundary.ts` and `tests/guards/visibility-boundary.test.ts` are
  byte-for-byte unchanged (`git diff` over both is empty), and the publication guard was driven red
  on purpose by removing the condition from `visibility.ts`, so 1.3.3 is a checked property rather
  than an untouched file

### Task 1.4 — Creating a note over the API

**Delivers:** a member with a session can create a note on a recording they may see, and every text,
position and publication rule is enforced by the server whether or not an interface offered it.
**References:** active-scope architecture § 4.3 Notes service, § 4.4 Notes routes (the
`POST /recordings/{id}/notes` row), § 4.5 Wire contract, § 8 Cross-cutting for this scope (the
publication gate); active-scope prd 3.1.4, 3.1.6, 3.1.7, 3.1.8, 3.1.10, 3.1.11, 3.1.12, 3.7
**Out of scope:** `parentId` on the body (Task 3.1); the read route (Task 1.5); any client.
**Prerequisites:** none.
**Depends on:** 1.2

**Acceptance criteria**

- [ ] **1.4.1** `POST /api/v1/recordings/{id}/notes` creates a note for the authenticated member from
  `text`, `visibility` and `timestampMs`, and answers the created note — verified by
  `packages/web/tests/integration/notes.test.ts`
  - the service asks the publication gate, then `authorise`, then the store
  - request and response shapes come from `packages/shared/src/notes.ts`
- [ ] **1.4.2** `note.write` is a policy action granted to both admin and member, so nothing about
  writing a note differs by role — verified by `packages/web/tests/unit/policy.test.ts`
  - one entry in `POLICY_ACTIONS`, one rule in `RULES`
- [ ] **1.4.3** The route is declared through `apiRoute` carrying a stated access rule, so it appears
  in the route sweep and cannot exist without one — verified by
  `packages/web/tests/integration/route-sweep.test.ts`
- [ ] **1.4.4** Text that is empty or whitespace-only after trimming is refused, and text over 1,000
  characters is refused rather than truncated — verified by
  `packages/web/tests/integration/notes.test.ts`
  - the ceiling is one exported constant in `packages/shared/src/notes.ts`, read by the server here
    and by the composer at 1.8.5
- [ ] **1.4.5** A create on an unpublished recording is refused `not_found`, through
  `findVisibleRecording(id, { includeUnpublished: false })` — verified by
  `packages/web/tests/integration/notes.test.ts`
  - the refusal carries active-scope prd 5.1.4's message
- [ ] **1.4.6** A `timestampMs` below zero is refused, and a second note at a position already noted
  on the same recording is an ordinary create — verified by
  `packages/web/tests/integration/notes.test.ts`
  - the server validates `>= 0` and nothing more; nothing stores a recording's duration

**Record**

### Task 1.5 — Reading a recording's notes over the API

**Delivers:** one `GET` answers everything a member may see on a recording, in the order it reads in,
with another member's private note absent from the payload rather than hidden by the client.
**References:** active-scope architecture § 4.4 Notes routes (the `GET /recordings/{id}/notes` row),
§ 7 Key choices (one `GET`, one payload), § 8 Cross-cutting for this scope; active-scope prd 3.2.1,
3.2.8, 3.2.9, 3.2.12
**Out of scope:** replies (Task 3.1), reactions (Task 4.3) and pins (Task 6.4) in the payload;
tombstones (Task 5.2).
**Prerequisites:** none.
**Depends on:** 1.2

**Acceptance criteria**

- [ ] **1.5.1** `GET /api/v1/recordings/{id}/notes` answers the reading member's visible notes in one
  payload, ordered by timestamp ascending and tie-broken by creation time, oldest first —
  verified by `packages/web/tests/integration/notes.test.ts`
  - the order is the store's; the route does not re-sort
- [ ] **1.5.2** Each note carries its id, its position, its author's display name, the time it was
  written, its `editedAt` and its text — verified by
  `packages/web/tests/integration/notes.test.ts`
- [ ] **1.5.3** `note.read` is a policy action granted to admin and member, and the route declares it
  — verified by `packages/web/tests/unit/policy.test.ts`
- [ ] **1.5.4** A read of an unpublished recording is refused `not_found`, never answered with an
  empty list — verified by `packages/web/tests/integration/notes.test.ts`
- [ ] **1.5.5** Another member's private note is absent from the payload for every actor, including an
  admin — verified by `packages/web/tests/integration/notes.test.ts`
  - the absence comes from the store's condition; the route filters nothing
- [ ] **1.5.6** A note written by a deactivated account is returned unchanged, under the same display
  name — verified by `packages/web/tests/integration/notes.test.ts`

**Record**

### Task 1.6 — The Notes tab, the player's notes store, and the list

**Delivers:** the recording page carries a Notes tab, and opening a recording loads its notes into
the player so the list renders — with a failure degrading to a retry rather than a broken page.
**References:** active-scope architecture § 5.1 `PlayerProvider` gains the notes store and the
composer anchor, § 5.3 `RecordingScreen` gains a second tab, § 4.6 Notes panel and composer;
active-scope prd 3.1.6, 3.2.2, 3.2.8, 3.2.10, 3.2.11, 5.2.1, 5.2.2, 5.2.3, 5.2.4, 5.2.6, 5.2.7;
`docs/design referencess png/pages/recording.png`;
`docs/design referencess png/style-guide.md`
**Out of scope:** the filter (Task 1.7), the composer (Task 1.8), transport markers (Task 2.1); the
**edited** indicator (Task 5.1) and the tombstone (Task 5.3).
**Prerequisites:** none.
**Depends on:** 1.5

**Acceptance criteria**

- [ ] **1.6.1** The recording page's tab strip carries a second tab, **Notes**, whose icon and active
  state use `--color-notes`, and opening it closes Transcript — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - the strip is already a `role="tablist"`; single-select, per the reference
  - no new colour token: `--color-notes` and `--color-notes-bg` already exist and nothing uses them
- [ ] **1.6.2** `PlayerProvider` fetches the recording's notes when the recording is opened, clears
  them when a different recording is opened, and discards a late answer belonging to the previous
  recording — verified by `packages/web/tests/integration/notes-screen.test.ts`
  - the same `loadedRef.current?.id !== recording.id` guard the transcript fetch uses
  - fetched on open rather than on tab open, because markers are visible without the tab
- [ ] **1.6.3** A notes fetch never touches the `<audio>` element, the playback grant or the renewal
  ticker, and `open()` keeps its early return for the already-loaded recording so playback
  survives navigation — verified by `packages/web/tests/integration/player-screen.test.ts`
- [ ] **1.6.4** The tab lists note cards in the payload's order, each carrying a pressable timestamp,
  the author's initials monogram and display name, the time it was written and the full
  untruncated text; the member's own private notes carry a **Private** pill in `--color-notes` —
  verified by `packages/web/tests/integration/notes-screen.test.ts`
  - the style guide's standard card; no avatars are rendered
  - private and public notes are interleaved, not separated
- [ ] **1.6.5** Note text that looks like markdown, HTML or a URL renders as the characters it is, and
  line breaks are preserved — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **1.6.6** A recording with no notes the member can see shows **"No notes on this teaching yet.
  Write the first one."**, and a failed load shows **"Couldn't load notes."** with a **Try again**
  control while the recording above still plays — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - a notes failure leaves the store empty; it cannot reach playback

**Record**

### Task 1.7 — The All / Public / Mine filter

**Delivers:** a member reading a long teaching can narrow the list to the group's notes or to their
own, without changing what any other part of the product can reach.
**References:** active-scope prd 3.2.3, 5.2.5, 5.2.6;
`docs/design referencess png/style-guide.md`
**Out of scope:** persisting the choice — the filter is component state and is not remembered across
a reload.
**Prerequisites:** none.
**Depends on:** 1.6

**Acceptance criteria**

- [ ] **1.7.1** A three-state pill row — **All** / **Public** / **Mine** — sits directly under the
  composer in the same tab-pill treatment as the recording tab strip, opening on **All** —
  verified by `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **1.7.2** **Public** narrows the list to public notes, and **Mine** narrows it to the reading
  member's own notes of both visibilities — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **1.7.3** Each state carries its own empty state — **"No notes on this teaching yet. Write the
  first one."**, **"Nobody has shared a note on this teaching yet."** and **"You haven't written a
  note on this teaching yet."** — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - a recording carrying public notes but none of the member's own is not an empty state under **All**
- [ ] **1.7.4** Changing the filter changes what is listed and nothing about what is reachable — the
  player's visible-note set is identical in all three states — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - re-asserted against the rendered markers once Task 2.1 lands

**Record**

### Task 1.8 — The composer

**Delivers:** a member can write a note anchored to the moment they were hearing when the composer
opened, choose whether the group sees it, and get their text back rather than lose it to a failed
save.
**References:** active-scope architecture § 4.6 Notes panel and composer, § 5.1 `PlayerProvider`
gains the notes store and the composer anchor; active-scope prd 3.1.1, 3.1.3, 3.1.4, 3.1.5, 3.1.7,
3.1.8, 3.1.11, 5.1.2, 5.1.3, 5.1.4;
`docs/design referencess png/style-guide.md`
**Out of scope:** the second entry point from the transport menu (Task 2.3); editing an existing note
(Task 5.3).
**Prerequisites:** none.
**Depends on:** 1.4, 1.6

**Acceptance criteria**

- [ ] **1.8.1** The composer is pinned above the list as a `--color-surface-raised` panel showing the
  position the player held **at the instant it opened**, frozen, displayed as `mm:ss` or
  `h:mm:ss` past an hour, and not editable by the author — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - the anchor is held by `PlayerProvider`, not by the panel
  - placeholder **"What landed at this moment?"**
- [ ] **1.8.2** Opening the composer neither pauses nor moves playback, so a note about a moment does
  not drift to a moment thirty seconds later while it is being typed — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **1.8.3** With nothing yet played, the anchor is the position the player currently holds — the
  restored resume position where one exists, and `00:00` where none does — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **1.8.4** The visibility control is a two-state segmented pill opening on **Private**, with one
  dim line switching between **"Only you will see this."** and **"Everyone in the group will see
  this at this moment."**; submitting without touching it creates a private note — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - a labelled two-state control, not a colour difference
- [ ] **1.8.5** The character count appears from 900 characters and not before; over 1,000 it shows in
  the error treatment with submit disabled and **"1,000 characters maximum."**; empty or
  whitespace-only leaves submit disabled with no message — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - the ceiling is the shared constant, not a number typed here
- [ ] **1.8.6** Submitting shows a busy state that cannot be pressed twice and the note appears in the
  list; a failed save keeps the text and shows **"Couldn't save your note. Your text is still
  here — try again."**, and a save refused because the recording was unpublished underneath shows
  **"This teaching isn't available any more, so the note can't be saved."** with the text likewise
  preserved — verified by `packages/web/tests/integration/notes-screen.test.ts`

**Record**

---

## Group 2 — Notes on the transport

**Delivers:** the annotated moments of a teaching are visible as green ticks on the transport
wherever the member is in the app, reachable in one press, and the transport itself becomes a place
to write a note about the moment currently playing.
**Feature:** active-scope prd 3.2's markers (3.2.4–3.2.7) and active-scope prd 3.1.2.

### Task 2.1 — The marker layer on the scrubber

**Delivers:** every note the member can see renders as a tick on the progress track, on every screen
the transport travels to, without breaking scrubbing.
**References:** active-scope architecture § 5.2 `TransportBar` gains markers on the scrubber and a
second toolbar item; active-scope prd 3.2.4, 3.2.6, 3.2.7, 5.7.1, 5.7.2, 5.7.3;
`docs/design referencess png/bottom-navigation/default.png`;
`docs/design referencess png/style-guide.md`
**Out of scope:** what pressing a marker does (Task 2.2); the composer entry point (Task 2.3).
**Prerequisites:** none.
**Depends on:** 1.6

**Acceptance criteria**

- [ ] **2.1.1** Every top-level note the reading member can see renders as a thin vertical tick in
  `--color-notes` on the progress track at its position, behind the fill and the thumb so neither
  is obscured — verified by `packages/web/tests/integration/transport-notes.test.ts`
  - driven from the player's note set, so the list and the ticks are one source
- [ ] **2.1.2** The marker layer takes no pointer events from the slider: scrubbing by pointer and by
  keyboard both still work, and the scrubber is still announced as a slider — verified by
  `packages/web/tests/integration/transport-notes.test.ts`
  - the scrubber stays a real `<input type="range">`; markers are a sibling layer, not children of it
- [ ] **2.1.3** Markers render on the docked transport on every screen it is shown on, not only the
  recording page, and the whole set is replaced when a different recording is loaded — verified by
  `packages/web/tests/integration/transport-notes.test.ts`
- [ ] **2.1.4** Notes closer together than 1% of the recording's duration collapse into a single
  marker — verified by `packages/web/tests/integration/transport-notes.test.ts`
  - computed client-side from the media element, the only source of a duration
- [ ] **2.1.5** Each marker is keyboard-reachable and labelled with its position and what it is —
  **"Note at 12:45"**, or **"3 notes from 12:45"** for a collapsed one — and a recording with no
  visible notes, or whose notes failed to load, renders a plain track rather than stale ticks —
  verified by `packages/web/tests/integration/transport-notes.test.ts`

**Record**

### Task 2.2 — Reaching a noted moment

**Delivers:** pressing a marker, or a note's timestamp, takes the member to that moment in the audio
and to that note in the list — without starting playback they did not ask for.
**References:** active-scope prd 3.2.5, 3.2.6, 5.2.2
**Out of scope:** the markers themselves (Task 2.1).
**Prerequisites:** none.
**Depends on:** 2.1

**Acceptance criteria**

- [ ] **2.2.1** Pressing a marker seeks the audio to that note's position and does **not** start
  playback — verified by `packages/web/tests/integration/transport-notes.test.ts`
  - the same rule the transcript already follows for selecting a line
- [ ] **2.2.2** Pressing a marker opens the Notes tab scrolled to that note, which is briefly
  highlighted so it is findable in a long list — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **2.2.3** Pressing a collapsed marker seeks to the earliest note in it and opens the list at
  that note, with the rest of the collapsed group as the next rows — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **2.2.4** Pressing a note card's timestamp link seeks the audio there without starting playback
  — verified by `packages/web/tests/integration/notes-screen.test.ts`
  - the timestamp is a `--color-primary-strong` link on the card's first row

**Record**

### Task 2.3 — The composer from the transport menu

**Delivers:** a member can write a note about the moment currently playing from any screen in the
app, without navigating back to the teaching.
**References:** active-scope architecture § 5.2 `TransportBar` gains markers on the scrubber and a
second toolbar item, § 4.6 Notes panel and composer; active-scope prd 3.1.2, 5.1.5;
`docs/design referencess png/bottom-navigation/menu-opened.png`
**Out of scope:** a second composer implementation — this mounts the one built at Task 1.8.
**Prerequisites:** none.
**Depends on:** 1.8

**Acceptance criteria**

- [ ] **2.3.1** The transport's `···` toolbar carries a speech-bubble item that opens the composer as
  a sheet over the current screen — verified by
  `packages/web/tests/integration/transport-notes.test.ts`
  - the toolbar holds one item today; this is its second
- [ ] **2.3.2** The sheet shows the loaded recording's title above the frozen timestamp, so which
  teaching is being annotated is unambiguous — verified by
  `packages/web/tests/integration/transport-notes.test.ts`
- [ ] **2.3.3** The sheet anchors to the recording loaded in the transport whatever screen the member
  is on, and produces a note identical to one written from the Notes tab — verified by
  `packages/web/tests/integration/transport-notes.test.ts`
  - both entry points read the same frozen anchor from the player, so they cannot disagree about which
    moment is being annotated

**Record**

---

## Group 3 — Replying to a public note

**Delivers:** a member can reply to any public note on a teaching they can see, and the group reads
the exchange under the note it belongs to — one level deep, always public, never a moment of its own.
**Feature:** active-scope prd 3.3 (3.3.1–3.3.7; its delete-interaction requirements are Group 5).

### Task 3.1 — Replies over the API

**Delivers:** the create route accepts a parent, the read payload carries each note's thread, and
every reply a product rule forbids is refused by the server.
**References:** active-scope architecture § 4.4 Notes routes (the `POST /recordings/{id}/notes` row),
§ 4.3 Notes service, § 6.1 `note` — new, § 8 Cross-cutting for this scope; active-scope prd 3.3.1,
3.3.3, 3.3.4, 3.3.5, 3.3.6
**Out of scope:** replying to a note deleted underneath the member (Task 5.4); reactions on replies
(Task 4.3); any client.
**Prerequisites:** none.
**Depends on:** 1.4, 1.5

**Acceptance criteria**

- [ ] **3.1.1** `POST /api/v1/recordings/{id}/notes` carrying a `parentId` creates a reply with that
  parent and no position, subject to every text rule at 1.4.4 — verified by
  `packages/web/tests/integration/notes.test.ts`
  - one create route, not two: a reply is a note with a parent
- [ ] **3.1.2** A create carrying a `parentId` and `visibility: 'private'` is refused, and a reply is
  stored public in every case — verified by `packages/web/tests/integration/notes.test.ts`
  - the schema check at 1.1.6 is the floor; the service refuses before reaching it
- [ ] **3.1.3** A create whose parent is itself a reply is refused `invalid_input`, rather than
  silently re-pointed at the grandparent — verified by
  `packages/web/tests/integration/notes.test.ts`
- [ ] **3.1.4** A reply to a private note is refused `invalid_input` for every actor, including the
  private note's own author — verified by `packages/web/tests/integration/notes.test.ts`
  - refused by the service, not the schema
- [ ] **3.1.5** A `parentId` naming a note on a different recording than the path's is refused — the
  recording in the path is authoritative — verified by
  `packages/web/tests/integration/notes.test.ts`
- [ ] **3.1.6** The `GET` payload carries each top-level note's replies, ordered by creation time,
  oldest first, and replies do not appear as top-level entries — verified by
  `packages/web/tests/integration/notes.test.ts`
  - the `(parent_id, created_at)` index is the thread order

**Record**

### Task 3.2 — Threads in the notes list

**Delivers:** the group can read and write a conversation under a note, in place, on the card the
note lives on.
**References:** active-scope architecture § 4.6 Notes panel and composer; active-scope prd 3.3.2,
3.3.6, 3.3.7, 5.3.1, 5.3.2;
`docs/design referencess png/style-guide.md`
**Out of scope:** the tombstone (Task 5.3); reactions on replies (Task 4.4); the removed-underneath
message (Task 5.4).
**Prerequisites:** none.
**Depends on:** 3.1

**Acceptance criteria**

- [ ] **3.2.1** A public note card carries a **Reply** text control at its foot, opening an inline
  field with placeholder **"Write a reply"** and a character count on the same rule as 1.8.5 —
  verified by `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **3.2.2** The reply field carries **no** visibility control, and the reply it creates is public
  — verified by `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **3.2.3** Replies render indented one step inside the parent's card, separated by a
  `--color-border` hairline rather than a gap, each carrying author, written time and text and no
  timestamp link — verified by `packages/web/tests/integration/notes-screen.test.ts`
  - a reply has no moment of its own
- [ ] **3.2.4** A note with no replies shows the **Reply** control and no thread area at all — not an
  empty thread — verified by `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **3.2.5** A private note carries no reply affordance, and a reply carries none either — verified
  by `packages/web/tests/integration/notes-screen.test.ts`
  - the API refuses both independently, per 3.1.3 and 3.1.4
- [ ] **3.2.6** A reply produces no marker on the transport — verified by
  `packages/web/tests/integration/transport-notes.test.ts`

**Record**

---

## Group 4 — Reacting to a public note

**Delivers:** a member can respond to a note or a reply with one of six reactions, change their mind
or take it back, and see at a glance how the group responded to a moment.
**Feature:** active-scope prd 3.4 (3.4.10 is Group 5).

### Task 4.1 — The reaction vocabulary and the `note_reaction` table

**Delivers:** the six reactions exist in one named place, and the one-reaction-per-member rule is a
primary key rather than a check somebody has to remember.
**References:** active-scope architecture § 4.5 Wire contract, § 6.2 `note_reaction` — new;
active-scope prd 3.4.1, 3.4.2, 3.4.3, 4.2
**Out of scope:** the routes (Task 4.2) and any interface (Task 4.4).
**Prerequisites:** none.
**Depends on:** 1.1

**Acceptance criteria**

- [ ] **4.1.1** `packages/shared/src/reactions.ts` names exactly the six of active-scope prd 3.4.1 —
  🙏 praying, ❤️ loved, 🔥 convicting, 💡 insight, 👏 encouraged, 😢 moved — each with its
  accessible name, declared once and restated nowhere — verified by
  `tests/guards/domain-declarations.test.ts`
  - its own module, because SOS acknowledgement will import the same 🙏
- [ ] **4.1.2** A migration creates `note_reaction` with primary key `(note_id, user_id)`, both
  foreign keys cascading, and `emoji` as `text` — neither an enum nor a foreign key — verified by
  `packages/db/tests/integration/notes.test.ts`
  - a reaction is a fact about a pairing and is meaningless without either half
- [ ] **4.1.3** The store sets a reaction with `on conflict (note_id, user_id) do update`, so a
  member's second reaction replaces their first rather than adding a row — verified by
  `packages/db/tests/integration/notes.test.ts`
- [ ] **4.1.4** A reaction stored under a glyph the vocabulary no longer offers is still returned and
  still counted, labelled by the glyph itself — verified by
  `packages/db/tests/integration/notes.test.ts`
  - `text` rather than an enum is exactly what makes this true: a member's past response is not
    rewritten by a product decision taken after it

**Record**

### Task 4.2 — Setting, replacing and clearing a reaction

**Delivers:** the two reaction routes, and the concurrency behaviour that makes two members reacting
at once — and one member reacting twice — both come out right.
**References:** active-scope architecture § 4.4 Notes routes (the reaction rows), § 4.3 Notes
service, § 5.5 The policy module gains eight actions; active-scope prd 3.4.3, 3.4.4, 3.4.11, 3.7
**Out of scope:** which notes take a reaction (Task 4.3); the interface (Task 4.4).
**Prerequisites:** none.
**Depends on:** 4.1

**Acceptance criteria**

- [ ] **4.2.1** `PUT /api/v1/notes/{id}/reaction` sets the member's reaction, and a second `PUT`
  carrying a different emoji replaces it rather than adding a second — verified by
  `packages/web/tests/integration/notes.test.ts`
- [ ] **4.2.2** `DELETE /api/v1/notes/{id}/reaction` clears the member's reaction, and clearing when
  none is set succeeds without error — verified by
  `packages/web/tests/integration/notes.test.ts`
- [ ] **4.2.3** `note.react` is a policy action granted to admin and member, and both routes ask it
  through `authorise` inside the handler rather than through a module-load `permits` — verified by
  `packages/web/tests/unit/policy.test.ts`
- [ ] **4.2.4** An emoji outside the vocabulary is refused, and what is stored is the vocabulary's
  exact string, so the `❤` / `❤️` variation-selector split cannot happen — verified by
  `packages/web/tests/integration/notes.test.ts`
  - the service normalises on write, so only the six ever land
- [ ] **4.2.5** Two members reacting at the same moment both succeed with both counts correct, and one
  member reacting twice in rapid succession settles on their last selection rather than recording
  two — verified by `packages/web/tests/integration/notes.test.ts`
  - true by the primary key, not by a read-then-write the interface has to get right

**Record**

### Task 4.3 — What takes a reaction

**Delivers:** the resource-state rules — private notes take none, replies take them on the same terms
as notes — are enforced by the server, and the read payload carries the counts the interface needs.
**References:** active-scope architecture § 4.3 Notes service, § 7 Key choices (one `GET`, one
payload), § 8 Cross-cutting for this scope; active-scope prd 3.4.5, 3.4.7, 3.4.8, 3.4.9, 3.7
**Out of scope:** reacting to a note deleted underneath the member (Task 5.4).
**Prerequisites:** none.
**Depends on:** 4.2, 3.1

**Acceptance criteria**

- [ ] **4.3.1** A reaction to a private note is refused `invalid_input` for every actor, including its
  own author — verified by `packages/web/tests/integration/notes.test.ts`
- [ ] **4.3.2** A reply takes a reaction on exactly the same terms as a top-level note — verified by
  `packages/web/tests/integration/notes.test.ts`
  - a reply is a note with a parent, and the requirement grants the reaction to any public note
- [ ] **4.3.3** A member may react to their own public note — verified by
  `packages/web/tests/integration/notes.test.ts`
- [ ] **4.3.4** The `GET` payload carries, for every note and reply, a count per emoji covering only
  emoji with at least one reaction, plus the reading member's own choice where they have one —
  verified by `packages/web/tests/integration/notes.test.ts`
  - a third statement behind the one `GET`, aggregated rather than joined wide

**Record**

### Task 4.4 — The reaction row and the picker

**Delivers:** the group's response to a moment is readable on the card, and a member can give, change
or take back a reaction in one press — including with a screen reader.
**References:** active-scope architecture § 4.6 Notes panel and composer; active-scope prd 3.4.4,
3.4.5, 3.4.6, 3.4.8, 5.4.1, 5.4.2;
`docs/design referencess png/style-guide.md`
**Out of scope:** the removed-underneath message (Task 5.4).
**Prerequisites:** none.
**Depends on:** 4.3

**Acceptance criteria**

- [ ] **4.4.1** The reaction row sits below the note text showing only emoji with a count, each a
  small pill carrying the emoji, the number and an accessible label naming both —
  **"praying, 3"** — with the reading member's own outlined in `--color-primary-strong` and the
  rest carrying `--color-border` — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - a bare emoji is unreadable to a screen reader
- [ ] **4.4.2** A note with no reactions shows no row at all, only the outlined circular control that
  opens the picker — verified by `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **4.4.3** The picker shows all six in a single row with their names as accessible labels, marks
  the member's current selection, and closes on select — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - marking the selection is what makes 4.4.4's toggle-off discoverable rather than a guess
- [ ] **4.4.4** Selecting the emoji the member has already chosen clears their reaction — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **4.4.5** A private note shows neither a reaction row nor a picker control — verified by
  `packages/web/tests/integration/notes-screen.test.ts`

**Record**

---

## Group 5 — Editing and deleting your own notes

**Delivers:** a member owns what they wrote — they can correct it or take it down at any time, with
no admin involved — while the replies other members wrote under it survive, under a tombstone that
says the note was removed and nothing about who removed it.
**Feature:** active-scope prd 3.5, plus the delete-interaction requirements of active-scope prd 3.3
(3.3.8, 3.3.9, 3.3.10) and active-scope prd 3.4.10.

### Task 5.1 — Editing a note's text

**Delivers:** an author can correct their own note or reply, permanently marked as edited, and nobody
— not another member, not an admin — can rewrite somebody else's words.
**References:** active-scope architecture § 4.4 Notes routes (the `PATCH /notes/{id}` row), § 5.5 The
policy module gains eight actions, § 8 Cross-cutting for this scope; active-scope prd 3.1.5, 3.2.8,
3.5.1, 3.5.3, 3.5.6, 3.7
**Out of scope:** the edit form (Task 5.3); editing a note already deleted (Task 5.4).
**Prerequisites:** none.
**Depends on:** 1.4, 1.5

**Acceptance criteria**

- [ ] **5.1.1** `PATCH /api/v1/notes/{id}` changes an author's own note or reply text and sets
  `edited_at`, with the text rules at 1.4.4 applying unchanged — verified by
  `packages/web/tests/integration/notes.test.ts`
  - no time limit, no admin involvement, no history kept
- [ ] **5.1.2** `note.edit` is a policy action carrying `requiresOwnership`, so a member editing
  another member's note **and an admin editing a note they did not author** are both refused —
  with no `actor.id === note.authorId` comparison written at the route — verified by
  `packages/web/tests/unit/policy.test.ts`
  - moderation is deletion, never rewriting somebody's words
  - the ownership gate denies when no resource is given, so the action cannot be asked in the abstract
- [ ] **5.1.3** A `PATCH` carrying a timestamp or a visibility changes neither — neither field is
  accepted, in either direction — verified by `packages/web/tests/integration/notes.test.ts`
  - visibility is fixed at creation: raising a private note would publish text written in confidence,
    lowering a public one would strand its replies
- [ ] **5.1.4** An edited note carries the **edited** indicator in the list permanently, and the text
  it had before is not returned by the API or shown anywhere — verified by
  `packages/web/tests/integration/notes-screen.test.ts`

**Record**

### Task 5.2 — Deleting a note, and the tombstone

**Delivers:** an author can take down anything they wrote; a note with replies leaves a tombstone so
the conversation under it survives, and a deleted note's text is gone rather than merely hidden.
**References:** active-scope architecture § 4.4 Notes routes (the `DELETE /notes/{id}` row), § 6.1
`note` — new, § 7 Key choices (deletion clears `text` to null), § 4.1 Notes store, § 5.5 The policy
module gains eight actions; active-scope prd 3.3.9, 3.3.10, 3.5.2, 3.5.4, 3.5.5, 3.5.9, 3.7
**Out of scope:** admin deletion of somebody else's note (Task 6.1); the confirmation dialogue
(Task 5.3); clearing a pin on delete (Task 6.3).
**Prerequisites:** none.
**Depends on:** 3.1

**Acceptance criteria**

- [ ] **5.2.1** `DELETE /api/v1/notes/{id}` on an author's own note sets `deleted_at` and `deleted_by`
  and clears `text` to null — verified by `packages/web/tests/integration/notes.test.ts`
  - a soft delete, so the row, the authorship and the thread survive
  - clearing the text is what makes 5.2.4 true by construction rather than by every future query
    remembering
- [ ] **5.2.2** `note.delete` is a policy action carrying `requiresOwnership`, so a member deleting
  another member's note is refused — verified by `packages/web/tests/unit/policy.test.ts`
- [ ] **5.2.3** Deleting a note with no replies removes it from the payload entirely; deleting a note
  **with** replies returns a tombstone that keeps its position and its replies — verified by
  `packages/web/tests/integration/notes.test.ts`
  - the tombstone rule lives in the store: a deleted top-level note is returned only while it still
    has an undeleted reply
- [ ] **5.2.4** A deleted note's text is returned to nobody — not to another member, not to its own
  author, not to an admin — verified by `packages/web/tests/integration/notes.test.ts`
- [ ] **5.2.5** Deleting a reply removes that reply alone, leaving its parent and its sibling replies
  untouched, and a deleted reply is never returned at all — verified by
  `packages/web/tests/integration/notes.test.ts`
- [ ] **5.2.6** Deleting a private note always removes it entirely, since it can have no replies —
  verified by `packages/web/tests/integration/notes.test.ts`

**Record**

### Task 5.3 — Author controls in the list

**Delivers:** a member sees Edit and Delete on what they wrote and nowhere else, deletes only after
confirming, and reads a removed note as a tombstone that says nothing about who removed it.
**References:** active-scope architecture § 4.6 Notes panel and composer; active-scope prd 3.5.2,
3.5.8, 5.3.3, 5.5.1, 5.5.2, 5.5.3;
`docs/design referencess png/style-guide.md`
**Out of scope:** the admin overflow (Task 6.4); acting on an already-removed note (Task 5.4).
**Prerequisites:** none.
**Depends on:** 5.1, 5.2

**Acceptance criteria**

- [ ] **5.3.1** A note or reply the reading member authored carries a `···` overflow opening **Edit**
  and **Delete**; one they did not author carries neither — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - the same outlined circular icon button the transport already uses
  - the API refuses both independently of what is rendered
- [ ] **5.3.2** **Edit** turns the card into the composer with the existing text loaded, the timestamp
  and visibility shown but not editable, and **Save** / **Cancel** — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **5.3.3** **Delete** confirms first with **"Delete this note? This can't be undone."**, or
  **"Delete this note? The replies to it will stay. This can't be undone."** where the note has
  replies, and **Cancel** leaves the note in place — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **5.3.4** A tombstone replaces the author line and text with one dim italic line — **"This note
  was removed."** — keeping the timestamp and the replies, and carrying no reaction row, no reply
  affordance and no indication of who removed it — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - the author of an admin-removed note sees exactly this, like everyone else
- [ ] **5.3.5** Deleting a note with no replies removes its marker from the transport; deleting a note
  **with** replies keeps its marker, so the surviving replies stay reachable from the moment they
  belong to — verified by `packages/web/tests/integration/transport-notes.test.ts`
  - the markers derive from the same note set the list does, so a deleted note cannot vanish from the
    list and leave its tick behind

**Record**

### Task 5.4 — Acting on a note removed underneath you

**Delivers:** a member who acts on a note that was removed while their screen was open is told so
distinctly, keeps whatever they had typed, and sees the list catch up.
**References:** active-scope architecture § 8 Cross-cutting for this scope (the `note_removed` code),
§ 4.3 Notes service; active-scope prd 3.3.8, 3.4.10, 3.5.7, 5.3.4, 5.4.3, 5.5.4
**Out of scope:** any polling or push — the list refreshes on the member's own refused write and on
nothing else.
**Prerequisites:** none.
**Depends on:** 5.2, 5.3, 3.2, 4.4

**Acceptance criteria**

- [ ] **5.4.1** The API answers `note_removed` (409) — the one new error code this scope adds — to an
  edit, a delete, a reply or a reaction aimed at a note already deleted, rather than failing
  silently or resurrecting it — verified by `packages/web/tests/integration/notes.test.ts`
  - distinct from `invalid_input`, because the request was well-formed against an affordance that was
    real when it was rendered
- [ ] **5.4.2** A refused reply shows **"This note was removed while you were writing."**, keeps the
  reply text in the field so it can be copied out, and the list refreshes to show the tombstone —
  verified by `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **5.4.3** A refused reaction shows **"This note was removed."** and the list refreshes; a
  tombstone shows no reactions — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **5.4.4** A refused edit or delete shows **"This note has already been removed."** — verified by
  `packages/web/tests/integration/notes-screen.test.ts`

**Record**

---

## Group 6 — Moderating public notes

**Delivers:** an admin can take down any public note or reply that should not stand — logged against
them — and raise any number of notes above the rest so the group reads them first, all from the note
itself rather than a separate console.
**Feature:** active-scope prd 3.6.

### Task 6.1 — Admin deletion, logged

**Delivers:** an admin can remove any public note they did not write, the removal is on the record
against them, and no admin can touch a private note.
**References:** active-scope architecture § 5.4 The `audit()` helper is promoted to one module,
§ 4.3 Notes service, § 5.5 The policy module gains eight actions, § 7 Key choices (`note.delete`
falling through to `note.moderate`), § 8 Cross-cutting for this scope; active-scope prd 3.6.1, 3.6.2,
3.6.3, 3.6.4, 3.7
**Out of scope:** the admin overflow control (Task 6.4); pinning (Tasks 6.2, 6.3); any audit table —
this is a structured log, per the running convention.
**Prerequisites:** none.
**Depends on:** 5.2

**Acceptance criteria**

- [ ] **6.1.1** The private `audit(actor, action, target)` helper written twice today moves to one
  module imported by `server/recordings/publication.ts` and `server/series/service.ts`, emitting
  byte-identical `actorId`, `actorEmail`, `action` and `target` with the same `recording:` and
  `series:` prefixes — verified by `packages/web/tests/integration/publishing.test.ts`
  - the log shape is read back through `tests/support/log-reader.ts`; a renamed field still logs, so
    this is asserted field by field
- [ ] **6.1.2** `note.moderate` is a policy action granted to admin alone, and `DELETE /notes/{id}`
  falls through to it when the owned `note.delete` denies — with no id comparison and no role read
  at the call site — verified by `packages/web/tests/unit/policy.test.ts`
- [ ] **6.1.3** An admin deleting a public note or reply they did not author succeeds, with the same
  tombstone-or-removal behaviour as an author's own deletion at 5.2.3 — verified by
  `packages/web/tests/integration/notes.test.ts`
- [ ] **6.1.4** That deletion logs `action: 'note.moderate'` and `target: 'note:{id}'` with the acting
  admin and the request's correlation id; an admin deleting their **own** note takes the owned
  path and is not logged as moderation — verified by
  `packages/web/tests/integration/notes.test.ts`
- [ ] **6.1.5** An admin's delete of a private note is refused, and a private note is absent from
  every admin-facing response this scope builds — verified by
  `packages/web/tests/integration/notes.test.ts`
  - the absence is the store's query condition, not a branch in the moderation path

**Record**

### Task 6.2 — Pinning a note

**Delivers:** an admin can raise any number of public notes on a recording so the group reads them
first, and pinning something already pinned is safe rather than an error on a stale screen.
**References:** active-scope architecture § 6.3 `note_pin` — new, § 4.4 Notes routes (the
`PUT /notes/{id}/pin` row), § 4.3 Notes service, § 5.5 The policy module gains eight actions, § 8
Cross-cutting for this scope; active-scope prd 3.6.5, 3.6.6, 3.6.8, 3.6.10, 3.7
**Out of scope:** unpinning (Task 6.3); how pinned notes render (Task 6.4); any `position` or
`sort_order` column — pinned notes read in the list's own order.
**Prerequisites:** none.
**Depends on:** 1.1, 1.5

**Acceptance criteria**

- [ ] **6.2.1** A migration creates `note_pin` keyed by `note_id`, carrying `recording_id`,
  `pinned_by` and `pinned_at`, with a composite foreign key
  `(recording_id, note_id) → note (recording_id, id)` cascading and an index on `(recording_id)` —
  verified by `packages/db/tests/integration/notes.test.ts`
  - the composite key is what stops a pin pointing at a note on a different recording, and stops the
    denormalised `recording_id` drifting from the note's own
  - `note_id` as the primary key is what makes "pinned at most once" a key rather than a check
- [ ] **6.2.2** `PUT /api/v1/notes/{id}/pin` pins a public top-level note; any number may be pinned on
  one recording, and pinning adds to the set rather than replacing anything — verified by
  `packages/web/tests/integration/notes.test.ts`
  - addressed on the note, not the recording — with any number of pins a recording has no single pin
- [ ] **6.2.3** Pinning a note that is already pinned succeeds and changes nothing, rather than being
  refused — verified by `packages/web/tests/integration/notes.test.ts`
  - one `on conflict (note_id) do nothing`, so an admin acting on a stale screen has still got what
    they asked for
- [ ] **6.2.4** `note.pin` is a policy action granted to admin alone; a member's pin is refused —
  verified by `packages/web/tests/unit/policy.test.ts`
- [ ] **6.2.5** Pinning a reply, a private note, or a note on an unpublished recording is each
  refused, and every successful pin is logged through the audit helper with the acting admin and
  the correlation id — verified by `packages/web/tests/integration/notes.test.ts`
  - the two shape refusals are the service's; the publication one is `visibility.ts`'s
  - pinning changes what the whole group reads first, which is why it is audited

**Record**

### Task 6.3 — Unpinning, and pins when a note is deleted

**Delivers:** an admin can lower one raised note without disturbing the rest, and a recording never
shows a pinned tombstone.
**References:** active-scope architecture § 6.3 `note_pin` — new, § 4.4 Notes routes (the
`DELETE /notes/{id}/pin` row), § 4.3 Notes service, § 5.5 The policy module gains eight actions,
§ 7 Key choices (`note.pin` and `note.unpin` as two actions); active-scope prd 3.6.7, 3.6.9, 3.7
**Out of scope:** how the change reads in the interface (Task 6.4).
**Prerequisites:** none.
**Depends on:** 6.2, 5.2

**Acceptance criteria**

- [ ] **6.3.1** `DELETE /api/v1/notes/{id}/pin` unpins one note, leaving every other pin on the
  recording in place; unpinning the last leaves the recording with no pinned notes — verified by
  `packages/web/tests/integration/notes.test.ts`
- [ ] **6.3.2** `note.unpin` is a policy action granted to admin alone — separate from `note.pin`,
  following the `recording.publish` / `unpublish` split — and every unpin is logged through the
  audit helper — verified by `packages/web/tests/unit/policy.test.ts`
- [ ] **6.3.3** Deleting a pinned note clears **that note's** pin in the same transaction as the
  delete and leaves every other pin in place, whether the delete comes from its author or from an
  admin — verified by `packages/web/tests/integration/notes.test.ts`
  - a soft delete never fires a cascade, so the pin clear is a second statement, not a foreign key

**Record**

### Task 6.4 — Pinned notes and the admin overflow in the list

**Delivers:** the group opens a teaching and reads the raised notes first, and an admin acts on any
public note from the note itself.
**References:** active-scope architecture § 4.6 Notes panel and composer; active-scope prd 3.6.3,
3.6.5, 3.6.8, 5.6.1, 5.6.2, 5.6.3;
`docs/design referencess png/style-guide.md`
**Out of scope:** a moderation queue, a report flow, or any admin-console surface — moderation lives
on the note.
**Prerequisites:** none.
**Depends on:** 6.1, 6.2, 6.3

**Acceptance criteria**

- [ ] **6.4.1** Pinned notes render above the list under a dim **"Pinned"** heading, each a
  `--color-surface-raised` card with a `--color-border-strong` outline and a **Pinned** pill,
  ordered by timestamp ascending and tie-broken by creation time — the same total order the list
  itself uses — verified by `packages/web/tests/integration/notes-screen.test.ts`
  - visible to every member who can see the recording, not only to admins
- [ ] **6.4.2** A pinned note is **not** repeated at its position in the chronological list, and its
  transport marker stays at its own position, unchanged — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - every note is read once
- [ ] **6.4.3** A pinned note is otherwise an ordinary card: its timestamp link, its replies and its
  reactions all work in place — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **6.4.4** For an admin, the overflow on any public note additionally offers **Delete** and
  **Pin** — or **Unpin** where it is already pinned — and neither a reply nor a private note
  offers a pin control at all — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
- [ ] **6.4.5** Deleting somebody else's note confirms with **"Delete this member's note? This can't
  be undone, and the removal is logged."**, while pinning and unpinning both act without a prompt,
  moving the note between the pinned group and its chronological position — verified by
  `packages/web/tests/integration/notes-screen.test.ts`
  - neither pin action is destructive and both are one press to undo

**Record**
