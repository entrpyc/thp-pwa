# Ticket 04–05 — Pipeline status, per-step re-run, and speaker labels
_Story: Get a recording transcribed_

> Phase 6 artefact for [implementation plan § Ticket 04](docs/epics/epic-core-listening/implementation-plan.md#L194)
> and [implementation plan § Ticket 05](docs/epics/epic-core-listening/implementation-plan.md#L206), **planned and
> built as one ticket at the operator's instruction.** The plan cuts them apart; this doc puts them
> back together, and the cost of that is stated below rather than discovered at review.
>
> Sections pulled, Ticket 04: [3.19.4](docs/project/prd.md#L432) (minus the processing column —
> nothing to show there yet); [3.21.2.4](docs/project/prd.md#L486);
> [epic prd § In scope → 7](docs/epics/epic-core-listening/prd.md#L146);
> [epic prd § Epic flows → B](docs/epics/epic-core-listening/prd.md#L210);
> [epic architecture § Job ledger (in Postgres, not a broker)](docs/epics/epic-core-listening/architecture.md#L157).
> Ticket 05:
> [03-transcription-into-timestamped-segments.md § Out of scope](docs/epics/epic-core-listening/stories/get-a-recording-transcribed/03-transcription-into-timestamped-segments.md#L88)
> — the line this reverses; [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323)
> — *Segment row*; [epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255) — the
> ASR-adapter row; [4.4](docs/project/prd.md#L539);
> [project architecture § Data model](docs/project/architecture.md#L171); [§7](docs/project/prd.md#L742).
> Carried in because this ticket touches them: [3.21.2.3](docs/project/prd.md#L485) and
> [3.5.8](docs/project/prd.md#L119), which are the failures this screen exists to make legible;
> [3.19.1](docs/project/prd.md#L429) and [3.19.2](docs/project/prd.md#L430), the panels this one sits
> beside; [3.5.5](docs/project/prd.md#L116), whose corrections a re-run discards;
> [implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L48);
> [implementation plan § Design references](docs/epics/epic-core-listening/implementation-plan.md#L81) — the
> admin-screen carve-out; [project architecture § Estimated running costs](docs/project/architecture.md#L343)
> — the transcription line the diarised rate is measured against;
> [epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341);
> [02-job-ledger-and-worker-loop.md § Implementation notes](docs/epics/epic-core-listening/stories/get-a-recording-transcribed/02-job-ledger-and-worker-loop.md#L327)
> — the append-only ledger and the partial unique index this screen reads and this re-run relies on;
> [03-transcription-into-timestamped-segments.md § Assumptions](docs/epics/epic-core-listening/stories/get-a-recording-transcribed/03-transcription-into-timestamped-segments.md#L264)
> — the synchronous-adapter decision, which is what `running` means on this screen.

**This is the ticket that makes the story validatable.** Until it lands, "the pipeline works" is a
claim about rows in a table nobody can see: a failed `transcribe` halts the chain
([3.21.2.3](docs/project/prd.md#L485)) and a low-confidence transcript fails its job on purpose
([3.5.8](docs/project/prd.md#L119)), and neither is visible anywhere. [3.19.4](docs/project/prd.md#L432)
asks for one query over the ledger, not for log-reading, and
[epic architecture § Job ledger](docs/epics/epic-core-listening/architecture.md#L157) is explicit that the
ledger being *queryable pipeline state* is half of why it is in Postgres at all.

**Three things worth naming before the criteria.**

**One diff, two tickets.** The plan cuts these apart because they touch nothing in common — one is an
admin read surface over the ledger, the other widens a cross-package contract, a table and the
provider call. Merged at the operator's instruction, the review cost is that the screen and the
schema change land together and a doubt about either blocks both. Nothing else about either half
changes; they are kept in separate criteria groups below so the halves can still be read apart.

**No PRD requirement stands behind the speaker half.** The word "speaker" appears nowhere in
[docs/project/prd.md](docs/project/prd.md#L1), the project architecture, the epic PRD or the epic
architecture. It was added mid-build at the operator's instruction and Phase 3 was not revisited,
which is a deliberate exception to
[implementation plan § What this plan deliberately does not include](docs/epics/epic-core-listening/implementation-plan.md#L510).
Amending [4.4](docs/project/prd.md#L539) is a Phase 3 edit and is out of scope here; until somebody
makes it, the next person reading the PRD against the schema finds a column the product never asked
for.

**Diarisation returns indices, not people.** The provider answers `0`, `1`, `2`. Nothing turns those
into names, nothing renders them, and no screen changes — so on its own the column has no reader.
That gap is the main risk this half carries, and it is accepted rather than solved.

---

## Goal

An admin can see which recordings are transcribing, which have finished, and which have failed and
why, and can re-run any single step of a recording without re-running the chain from the start —
one query over the job ledger, no log-reading. And a transcript records who was speaking, segment by
segment, as the provider's anonymous speaker index.

- As an admin I want to see what the pipeline is doing to every recording, so a failure is something
  I read rather than something I discover ([3.19.4](docs/project/prd.md#L432),
  [epic prd § Epic flows → B](docs/epics/epic-core-listening/prd.md#L210)).
- As an admin I want to know *why* a step failed, in the same place I see that it failed
  ([3.21.2.3](docs/project/prd.md#L485)).
- As an admin I want to re-run one step without re-running the whole pipeline — including running
  `generate_draft` on a transcript that failed the confidence gate but that I have read and judged
  usable ([3.21.2.4](docs/project/prd.md#L486), [3.5.8](docs/project/prd.md#L119)).
- As an operator I want the transcript to carry which speaker the provider heard for each segment, so
  the data exists before any surface that would read it ([4.4](docs/project/prd.md#L539) as this
  ticket widens it).

## Out of scope

- **The processing column.** [3.19.4](docs/project/prd.md#L432) names processing, transcription and
  generation; [§3.4](docs/project/prd.md#L88) is deferred whole, so there are two steps and the screen
  shows two. It reads `PIPELINE_STEPS`, so `process_audio` arriving is a column the screen grows on
  its own ([epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Pipeline
  step chain*).
- **Pending Reviews** ([3.19.2](docs/project/prd.md#L430)) and the `review_item` table — Story 3. A
  succeeded `generate_draft` produces nothing to review yet, and this screen says so rather than
  implying otherwise.
- **Per-role gating of the console** ([3.19.1](docs/project/prd.md#L429)). The Contributor role is
  deferred, so there is one flat operator surface behind an admin check, exactly as the two existing
  panels are.
- **Naming a speaker, editing a speaker, or rendering one.** No screen shows the column, no payload
  carries it, and there is no labelling surface anywhere in this epic. `0` and `1` stay `0` and `1`.
- **Back-filling speakers onto transcripts already written.** Re-running `transcribe` replaces a
  transcript wholesale, so an existing recording gains speakers only when somebody re-runs it — and
  doing so discards any corrections Story 5 will let an admin make
  ([3.5.5](docs/project/prd.md#L116)). No migration writes into existing segment rows.
- **Amending [4.4](docs/project/prd.md#L539) or adding a feature requirement for speaker
  attribution.** A Phase 3 edit, named in the preamble, not made here.
- **Automatic retry, backoff and a dead-letter queue.** A failed job stays failed until a human
  presses the button; the button is the whole of the recovery story, exactly as Ticket 02 settled.
- **Cancelling or stopping a running job.** Nothing can interrupt a claimed job, which is why
  `JOB_STATUSES` has no `cancelled` — the screen offers no control that pretends otherwise.
- **A job history view.** The ledger is append-only and holds every attempt; the screen shows the
  latest attempt of each step and nothing older. `attempt` is displayed, so a re-run is visible as a
  number going up.
- **Live updates by any mechanism other than the browser asking again.** No websocket, no
  server-sent events, no broker
  ([epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341)).
- **Progress within a step.** A `transcribe` job is one blocking HTTPS call with no progress to
  report; `running` is the whole of what is known.
- **Pagination, filtering, sorting controls or search over the pipeline list.** There are five
  recordings.
- **Replacing the audio on an existing recording** ([3.2.10](docs/project/prd.md#L71)) — the epic PRD
  names per-step re-run as what covers failure recovery in the meantime.
- **Word-level speaker attribution, or a second ASR provider.** A segment is a sentence and it has
  one speaker; the words inside it are still not persisted.

## User prerequisites

- **Confirm the diarised rate on Deepgram's current pricing page** before implementation starts. The
  cost table is built on $0.0043/min monolingual Nova-3 pre-recorded
  ([project architecture § Estimated running costs](docs/project/architecture.md#L343)); if diarisation
  adds to that, [§7](docs/project/prd.md#L742)'s measured spend and that table both change, and that
  is a scope decision rather than something to absorb here.
- **A real multi-voice recording** — a genuine teaching with at least one question from the room. The
  likely accuracy failure on this material is over-segmentation of one long teaching voice into
  several speakers, and a fixture cannot show that. The ticket is not validated without it.
- The app and the worker both running, with `ASR_PROVIDER=deepgram` and a real `ASR_API_KEY`, as
  Ticket 03 already established.

## Acceptance criteria

### The pipeline status read

- Every recording's per-step pipeline state is readable in one query — verified by an integration
  test in `packages/db` inserting recordings with jobs in each status and asserting the returned
  shape.
  - A new `packages/db/src/pipeline.ts` holding the read, beside the ledger's write queries rather
    than inside them.
  - **Deliberately not behind the queue port.**
    [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) says a broker
    arriving leaves "the ledger and the dashboard query untouched", so the dashboard query is not a
    dispatch concern; `packages/web/src/server/jobs/queue.ts` keeps wrapping the enqueue half only.
  - Because `tools/queue-boundary.ts` derives its forbidden names from the exports of
    `packages/db/src/jobs.ts`, a read in a separate module is reachable from a web service without
    widening the guard — verified by the existing queue-boundary guard still passing.
- The state of a step is **the latest attempt of that step**, not an aggregate over its history —
  verified by a test running a step to failure, re-enqueuing it, and asserting the read reports the
  new attempt.
  - The ledger is append-only, so "the status of `transcribe` for this recording" is the row with
    the highest `attempt` for the pair.
- A step that has never been enqueued reads as *not started* rather than being absent — verified by a
  test asserting a freshly finalised recording reports `transcribe` waiting and `generate_draft` not
  started.
  - The step list comes from `PIPELINE_STEPS`, so the answer has one entry per step of the chain
    however long the chain becomes.
- A recording with no jobs at all still appears — verified by a test inserting a recording row
  directly and asserting it is returned with every step not started.
- The read returns each step's status, attempt, failure reason, and the enqueued, started and
  finished times — verified by asserting each field against known rows.
- Recordings come back newest `recorded_at` first, matching the recordings list — verified by a test
  asserting the order, and by the client not re-sorting.

### The `/admin/pipeline` panel

- A third panel exists at `/admin/pipeline`, reachable from the console's panel list — verified by a
  Playwright integration test in the shape `recordings-screen.test.ts` uses, asserting the link and
  the landing.
  - One entry in `PANELS` in `packages/web/src/app/admin/console-shell.tsx`, which is all "a third
    panel is one entry" ever had to mean.
  - **No design reference exists for any admin screen** — composed from
    [style-guide.md](docs/design%20referencess%20png/style-guide.md) and the token layer, the same
    carve-out the two existing panels took, with `pipeline.module.css` composing from
    `admin.module.css` so the three cannot drift.
- Each recording shows one cell per pipeline step, carrying that step's status — verified by a
  Playwright test seeding recordings in each state and asserting the rendered text.
- A failed step shows **the reason, in the row** — verified by a Playwright test failing a job with a
  known message and asserting that message is on screen.
  - Read from `job.error`, which Ticket 02 caps at 2000 characters; the full text is in the log line
    under the same correlation id.
- A succeeded `generate_draft` reads as **not built yet**, not as done — verified by a test asserting
  a job whose `provider_meta` carries the stub marker renders differently from a real success.
  - The marker `packages/worker/src/handlers.ts` leaves is exactly so this difference is a query
    rather than invisible; the key moves to `@thp/shared` so the worker that writes it and the screen
    that reads it state it once.
- The panel works on phone, tablet and desktop — verified by the Playwright test running its
  assertions at the three viewports the existing screen tests already use.
- A member who navigates to `/admin/pipeline` is redirected, and `GET /api/v1/pipeline` refuses a
  member independently — verified by an API test asserting `forbidden` for a member session and an
  anonymous request, and a Playwright test asserting the redirect.
  - The page gate decides what to render and authorises nothing, exactly as the two existing panels.

### Refreshing while work is in flight

- The panel re-reads while any step on screen is pending or running — verified by a Playwright test
  counting requests to `GET /api/v1/pipeline` over a fixed window with a running job seeded.
- It **stops** once nothing on screen is in flight — verified by the same test asserting the request
  count stops rising after the seeded jobs reach a terminal status.
  - A console left open on a finished pipeline should not query forever; the poll is a consequence of
    there being work, not a property of the screen being open.
- The interval is one named constant — verified by a unit test asserting the value, so changing it is
  one edit.

### Per-step re-run

- An admin can re-run any single step of any recording — verified by an API integration test
  asserting a job row is enqueued for the named pair.
  - `POST /api/v1/recordings/{id}/rerun` with the step in the body, enqueued through the existing
    queue port so the row carries the request's correlation id and computes `attempt` inside the
    insert.
  - A new `pipeline.rerun` policy action beside `pipeline.read`, admin-only — the same split the
    recording, invitation and account actions already take.
- **Re-running a step has no precondition on the steps before it** — verified by a test re-running
  `generate_draft` for a recording whose `transcribe` job failed, and asserting it is enqueued.
  - This is [3.5.8](docs/project/prd.md#L119)'s escape hatch working as Ticket 03 designed it: the
    admin reads a low-confidence transcript, judges it usable, and runs generation directly.
- **Re-running a step re-runs what follows it, on success** — verified by an integration test running
  the real loop after a `transcribe` re-run and asserting `generate_draft` is enqueued behind it.
  - The chain rule Ticket 02 built, unchanged. [3.21.2.4](docs/project/prd.md#L486)'s "without
    re-running the whole pipeline" is satisfied by being able to start anywhere, not by severing the
    chain — a fresh transcript makes the existing draft wrong.
- **Pressing re-run twice is harmless** — verified by a test issuing two re-runs for the same pair and
  asserting one unfinished job exists and both calls answered with it.
  - The partial unique index refuses the second row and `enqueueJob` returns the first; the API does
    not invent a conflict the database already resolved.
- A re-run for an unknown recording answers `not_found`, and for a value that is not a pipeline step
  answers `invalid_input` — verified by API tests asserting each code.
- The re-run is logged with actor, action, target and timestamp — verified by a test reading the log
  sink in the shape the existing gate-transition tests use
  ([implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L48)).
- The screen reflects the re-run without a manual reload — verified by a Playwright test pressing the
  control and asserting the step's status and attempt change.

### Speaker labels on segments

- `segment` carries a nullable integer `speaker` and no other new column — verified by the existing
  migration test asserting the exact column set.
  - A new numbered SQL migration beside the existing six; **nothing writes into existing rows.**
  - Nullable because a sentence the provider attributes to nobody is a real answer, not a defect.
- The shared `Segment` type carries `speaker` and the table still matches it exactly — verified by
  `tests/guards/segment-shape.test.ts`, whose field list grows to eight and whose counterexample
  field is changed, because it currently uses `speakerLabel` as the name the table does not have.
  - The type, the table and the migration change together — that type is what the client and the API
    agree on, not an internal detail of the worker.
- A segment written with a speaker reads back with it, and one written without reads back null —
  verified by an integration test over `replaceTranscript` and `listSegments`.
- No API payload and no screen carries the column — verified by asserting the recording payload's
  shape is unchanged, and by there being no route that serves a segment.

### Diarisation in the ASR adapter

- The adapter asks the provider for diarisation — verified by a unit test asserting the request the
  adapter builds carries the parameter, in the shape the existing language and model assertions use.
- Each mapped segment carries the speaker the provider heard for it, as an index — verified by a unit
  test over a captured diarised response fixture asserting the mapped output.
  - The provider attributes at paragraph level and a segment is a sentence, so a sentence takes its
    paragraph's speaker; everything vendor-shaped still stops at the adapter.
- A response with no speaker information maps to segments with a null speaker rather than failing —
  verified by a unit test over the existing non-diarised fixture, which must still map.
- The `Transcriber` port carries the speaker alongside the offsets and the text — verified by the
  type-check and by the fake transcriber's script accepting one.
  - The fake's script gains an optional speaker per segment, so the suite can drive both answers
    without a provider.
- The handler persists what the port returned — verified by an integration test running the handler
  against a diarised fake script and asserting the persisted rows.
- The success log line reports the number of distinct speakers alongside the number of segments —
  verified by a test reading the log sink.
  - The named risk on this material is over-segmentation of one teaching voice; a count is what makes
    that visible without reading nine hundred rows.

### End to end

- Upload → transcribe → generate_draft leaves a recording whose `/admin/pipeline` row reads succeeded
  for both steps, with `generate_draft` marked not built yet, and whose segments carry speakers —
  verified by an integration test running the real loop against MinIO and a diarised fake script.
- A failed `transcribe` shows on the panel with its reason, and a re-run from the panel returns the
  recording to pending — verified by an integration test driving the failure, the screen and the
  re-run in one pass.
- Every new `/api/v1` route requires a session — verified by the existing route-sweep test, which
  must still pass with **no new entry on the unauthenticated allowlist**.

## User steps

- Run `npm run migrate` against any environment that already has a database.
- Confirm on Deepgram's pricing page that diarisation does not change the pre-recorded rate. If it
  does, stop and say so — [project architecture § Estimated running costs](docs/project/architecture.md#L343)
  is wrong and that is a scope decision.
- With the app and the worker both running, upload a genuine multi-voice teaching, watch
  `/admin/pipeline` while it transcribes, and confirm the row moves from pending through running to
  succeeded without a manual reload.
- **Read a diarised transcript against the audio.** Query the segments in `psql` and check that the
  teacher is one speaker index throughout rather than several, and that a question from the room is a
  different index. Over-segmentation here is the expected failure and it is a judgement only a person
  listening can make.
- Fail a step deliberately — stop the worker mid-job and restart it, or point `ASR_API_KEY` at a bad
  key for one upload — and confirm the panel names the reason, then press re-run and confirm the step
  starts again.
- Confirm `provider_meta` on the `transcribe` job still reports a cost close to $0.258 an hour of
  audio. A number above that means diarisation is billed and the cost table needs revisiting.

## Assumptions

### Major (confirmed with the operator)

- **Pipeline status is a third console panel at `/admin/pipeline`**, one row per recording showing
  the latest attempt of each step — status, timing, and the failure reason when there is one.
- **The status read is not behind the queue port.** It lives in a new `packages/db/src/pipeline.ts`
  called directly by a web service module, because the epic architecture says a broker swap leaves
  the dashboard query untouched. The re-run action still goes through the port's `enqueue`.
- **The chain rule stands on a re-run.** Re-running `generate_draft` runs only that step; re-running
  `transcribe` re-runs `generate_draft` behind it on success, because a fresh transcript makes the
  existing draft wrong. The cost is that a `transcribe` re-run spends ASR again, and that a re-run
  discards any corrections Story 5 will let an admin make.
- **The panel polls while work is in flight and stops when it is not**, rather than offering a manual
  refresh button. Polling blocks nothing: the browser's `fetch` is asynchronous, the API poll is one
  indexed query, and the worker is a separate process the poll cannot reach. The one genuinely
  blocking call in the system is the adapter's synchronous provider request, which is what `running`
  on this screen means.
- **A succeeded `generate_draft` renders as not built yet** while the handler is a stub, read from
  the `provider_meta` marker Ticket 02 left for exactly this.
- **`segment.speaker` is a nullable integer holding the provider's anonymous index**, and the shared
  `Segment` type widens to match. Nothing reads it, no payload carries it, no screen changes.
- **Diarisation does not change the pre-recorded rate**, so
  [project architecture § Estimated running costs](docs/project/architecture.md#L343) stands unchanged —
  confirmed by the operator against the provider's pricing page before implementation.
- **There is no back-fill.** Recordings already transcribed gain speakers only when somebody re-runs
  them.

### Minor

- The re-run route is `POST /api/v1/recordings/{id}/rerun` with the step in the body, so
  `process_audio` arriving later needs no new path.
- Two new policy actions, `pipeline.read` and `pipeline.rerun`, both admin-only, following the split
  the recording, invitation and account actions already take.
- The re-run answers with the enqueued job, and answers with the existing one when a job for that pair
  is already unfinished — a no-op rather than a conflict, because the database already resolved it.
- The stub marker's key moves to `@thp/shared` so the worker that writes it and the panel that reads
  it state it once; the constant itself stays in the worker.
- The poll interval is 5 seconds, a first setting rather than a measured one.
- The panel's step cells are generated from `PIPELINE_STEPS`, so a new step is a column nobody edits
  the screen to add.
- The panel orders recordings by `recorded_at` descending, matching the recordings list, so the
  console has one answer to "what is most recent".
- Timing is shown as the enqueued, started and finished timestamps the ledger already holds; no
  duration is computed.
- `pipeline.module.css` composes from `admin.module.css` rather than restating it.
- The fake transcriber's script takes an optional speaker per segment; a script without one produces
  null speakers, which is what the existing fixtures already do.
- Diarisation is requested unconditionally rather than behind a setting — a knob with one caller is a
  knob nobody needs.
- The log vocabulary adds a re-run line beside the `job.*` lines Ticket 02 emits, and the transcribe
  success line gains a distinct-speaker count.


## Edge cases

- **Nothing turns a speaker index into a person.** `0` and `1` are written and never rendered, so
  the column has no reader in this epic — an operator who wants to know who spoke reads the indices
  out of `psql` against the audio.
- **Over-segmentation of one teaching voice is invisible except in the log line.** The success line
  reports how many distinct speakers were heard; a teaching split into six is a number an operator
  has to notice, and nothing warns on it.
- **A recording transcribed before this ticket has null speakers until somebody re-runs it.** There
  is no back-fill, and the panel gives no sign that a transcript predates the column.
- **A `transcribe` re-run silently discards Story 5's corrections.** The confirming press says the
  transcript is replaced; it does not know whether anything has been corrected, because nothing
  writes `corrected_at` yet.
- **Two admins on the panel at once can both press re-run.** The second press is a no-op returning
  the first one's job, so nobody sees a conflict — and nobody sees that somebody else did it either.
- **The panel polls only while work is in flight, so a job enqueued by somebody else after the
  screen settles is never noticed.** The console sits on a finished pipeline until it is reloaded.
- **A recording deleted mid-poll disappears from the row list without explanation.** Nothing deletes
  a recording in this epic, so this is only reachable by hand in `psql`.
- **A failure longer than 2000 characters is truncated on the row**, with no sign in the panel that
  it was — the whole text is in the log line under the same correlation id.
- **The panel has no pagination, filter, sort or search.** At a few hundred recordings it becomes a
  very long page; there are five.
- **Every poll is a full read of every recording.** One indexed query at this size, and nothing
  caps it as the table grows.
- **A step whose handler is missing fails naming the step, and the panel shows that as an ordinary
  failure.** An operator cannot tell "the provider refused" from "this worker does not know this
  step" without reading the reason.
- **A re-run enqueued while the worker is stopped sits `pending` forever and the panel says
  `Waiting`.** There is nothing on the screen that reports whether a worker is running at all.
- **A provider that answers with more speakers than the audio has is persisted as answered.** There
  is no ceiling on the index and no sanity check against the number of segments.
- **A job whose recording was finalised but never enqueued reads as every step not started**, which
  is correct and indistinguishable on screen from a recording uploaded one second ago.

## Implementation notes

### Assumptions — major (confirmed with the operator)

- **Re-running `transcribe` takes a confirming press that names the recording; `generate_draft`
  does not.** The step that spends the provider again and replaces the transcript gets the second
  press, exactly as ending an account's access does; the harmless one stays a single tap, which is
  also what keeps [3.5.8](docs/project/prd.md#L119)'s escape hatch one press. Which steps confirm is
  a `Record<PipelineStep, boolean>` in the panel, so a new step is a compiler error until somebody
  says whether re-running it destroys something.

### Assumptions — minor

- The read is one statement: a left join from `recording` onto a `distinct on (recording_id, step)`
  of the ledger ordered by descending `attempt`. Left, so a recording with no jobs still appears.
- A step that has never been enqueued is `not_started` on the wire — a sentinel deliberately outside
  `JOB_STATUSES`, because no row ever holds it.
- `provider_meta` does not cross the wire. The service answers the one question the screen asks of
  it as a `stub` boolean, using the shared key; the raw column stays behind the API.
- The re-run answers `200` with the job that is now waiting, rather than `201` or `202` — the same
  answer whether the row was inserted or was already there.
- The panel keeps one interval for its lifetime and asks itself on each tick whether anything is
  still in flight, rather than re-scheduling on every answer, which would restart the clock on every
  poll.
- Timestamps on the panel carry the time of day (the recordings list shows dates only), because
  these are read against each other rather than as a calendar date.
- "Not built yet" replaces the status word for a succeeded stub rather than sitting beside it, so a
  row cannot read `Succeeded` and `Not built yet` at once.
- The re-run route validates the recording exists before enqueuing, so an unknown id answers
  `not_found` rather than failing on the foreign key.
- The new migration is tagged `0007_segment_speaker` rather than left with drizzle-kit's generated
  name, matching every migration before it.

### Other notes

- **The panel's poll-stop test settles every unfinished job in the ledger before it asserts.** The
  suite shares one database and the panel shows *every* recording, so "nothing on screen is in
  flight" genuinely means nothing in the ledger is; without that the panel never settles and the
  assertion cannot hold. It is one statement, commented in place, and it runs after the files that
  seed their own work.
- **The segment-shape guard's counterexample changed from `speakerLabel` to `embedding`.** A
  counterexample the table now actually has would have made that assertion pass for the wrong
  reason; `embedding` is the column
  [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) defers
  to a later epic, and therefore the field most likely to be added by mistake.
- **A diarised Deepgram response fixture was captured beside the existing one rather than replacing
  it.** "A response with no speaker information still maps" needs a response with no speaker
  information in it, and that is the shape every recording transcribed before this ticket was
  answered with.
- **The fake transcriber's script segments are now their own type**, `FakeScriptSegment`, with an
  optional speaker — the port's `TranscribedSegment` requires the field, and every existing fixture
  omits it.
- **`packages/db/src/pipeline.ts` is reachable from a web service without widening
  `tools/queue-boundary.ts`**, because that guard derives its forbidden names from the exports of
  `jobs.ts`. That was the plan's claim and it held with no edit to the guard.
- **The `provider_meta` stub key is in `@thp/shared`; the marker stays in the worker.** The worker
  builds `STUB_PROVIDER_META` from the shared key, and a unit test asserts the marker the worker
  writes is the one the shared predicate recognises — so the two cannot drift.
- **Nothing about [4.4](docs/project/prd.md#L539) was amended.** As the preamble said, that is a
  Phase 3 edit: the next person reading the PRD against the schema still finds a `speaker` column
  the product never asked for.
