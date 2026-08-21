# Ticket 02 — Job ledger and worker loop
_Story: Get a recording transcribed_

> Phase 6 artefact for [implementation plan § Ticket 02](docs/epics/epic-core-listening/implementation-plan.md#L145).
> Sections pulled: [epic architecture § Worker process](docs/epics/epic-core-listening/architecture.md#L139);
> [epic architecture § Job ledger (in Postgres, not a broker)](docs/epics/epic-core-listening/architecture.md#L157);
> [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *Pipeline state*;
> [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Pipeline step chain*
> and *Queue port*; [3.21.2.1](docs/project/prd.md#L483); [3.21.2.3](docs/project/prd.md#L485);
> [project architecture § Worker pool](docs/project/architecture.md#L147);
> [project architecture § Key technology choices](docs/project/architecture.md#L209) — the ledger-is-the-queue row.
> Carried in because this ticket touches them:
> [epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255) — the correlation-id row and
> the `SKIP LOCKED` row; [project architecture § Estimated running costs](docs/project/architecture.md#L343) — where
> worker concurrency 1 comes from; [project architecture § Cross-cutting concerns](docs/project/architecture.md#L271);
> [3.21.2.4](docs/project/prd.md#L486) and [3.19.4](docs/project/prd.md#L432), which Ticket 04 reads this table for;
> [epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341);
> [01-upload-to-object-storage.md § Implementation notes](docs/epics/epic-core-listening/stories/get-a-recording-transcribed/01-upload-to-object-storage.md#L288)
> — its last line, which names the edge this ticket connects.

**This ticket is dispatch, not work.** No audio is read, no provider is called, nothing is
transcribed. What ships is the mechanism every later step in this epic and every step in every later
epic runs on — and three of its properties are settled here and awkward to revisit: **claiming is
at-least-once**, so a handler that is not idempotent is a bug rather than a preference; **a step
enqueues its successor only on success**, so a failure genuinely halts a recording's pipeline
([3.21.2.3](docs/project/prd.md#L485)); and **the ledger is the queue**, so the rows the worker dispatches
from are the same rows Ticket 04 renders a dashboard out of. There is no second store and no broker
([project architecture § Key technology choices](docs/project/architecture.md#L209)).

The other thing worth naming up front: **the worker is a second process against the same database**,
and it is the first thing in this repository that runs without a request behind it. That is why the
correlation id travels on the row rather than in an async-context frame, and why "which request
caused this job" is a column rather than an inference.

---

## Goal

Work enqueued by the API is picked up and run by a separate process, and what happened to it is a row
anyone can query. The `job` table, a worker that claims rows with `FOR UPDATE SKIP LOCKED` and runs
the handler registered for that step, the queue port the API enqueues through, and the chain rule
that a step enqueues its successor only on success. Finalising an upload enqueues `transcribe`.

- As an admin I want an upload to start the pipeline on its own, so nobody has to trigger anything by
  hand ([3.21.2.1](docs/project/prd.md#L483)).
- As an operator I want a job that failed to say which step failed and why, in a row rather than in a
  log file, so the pipeline's state is something I can query.
- As an operator I want a worker that was killed mid-job to recover on its own when it comes back,
  rather than leaving a recording stuck forever.

## Out of scope

- **Any real handler work** — Ticket 03 writes `transcribe`, Story 3 writes `generate_draft`. Both
  steps register **stub handlers that do nothing and succeed**; see the criteria and the assumption
  that names what that costs.
- **Every admin-visible surface over the ledger** — Ticket 04 owns the pipeline status view
  ([3.19.4](docs/project/prd.md#L432)) and the per-step re-run ([3.21.2.4](docs/project/prd.md#L486)). This ticket
  ships no route, no screen and no policy action over `job`. The table is written by the API, read by
  the worker, and read by nothing else yet.
- **Automatic retry, backoff, and a dead-letter queue.** A failure is terminal until a human
  re-enqueues the step — which is what [3.21.2.3](docs/project/prd.md#L485) asks for and what Ticket 04 gives a
  button. The one automatic re-enqueue here is the startup sweep, and that is crash recovery, not
  retry.
- **`LISTEN`/`NOTIFY`, or any wake-on-enqueue.** The worker polls. Seconds of dispatch latency are
  invisible at ~4.3 recordings a month
  ([epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255)).
- **Redis, BullMQ, `pg-boss` or any queue library**
  ([epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341)). The queue port is
  the seam they arrive behind; nothing in this ticket anticipates them further.
- **Concurrency above 1, a worker pool, per-step concurrency, and job priority.** One process, one job
  at a time ([project architecture § Estimated running costs](docs/project/architecture.md#L343)).
- **Scheduled or delayed jobs, cron, and back-catalogue batching** — [3.21.3](docs/project/prd.md#L490) is not
  in this epic. A job is enqueued to run now.
- **Process supervision, restart-on-failure, start-on-boot** — Story 7 Ticket 02. This ticket's worker
  is started by hand with `npm run worker`.
- **Domain-event emission at job completion.**
  [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) names it as a seam;
  nothing in this epic subscribes, and Story 3's publish path is where it lands.
- **`provider_meta` content.** The column ships and stub handlers mark themselves in it; model,
  version and spend arrive with the handler that has a provider to record ([§7](docs/project/prd.md#L742)).
- **`transcript`, `segment` and `review_item` tables** — Ticket 03 and Story 3.
- **Cancelling a running job**, and a `cancelled` status. There is no way to stop a job once claimed.

## User prerequisites

- None. Postgres and Docker are already prerequisites of this story, and nothing outside the
  application is added.

## Acceptance criteria

### The `job` table

- `job` exists with `id`, `recording_id`, `step`, `status`, `attempt`, `error`, `correlation_id`,
  `enqueued_at`, `started_at`, `finished_at` and `provider_meta`, and with no other column — verified
  by a migration test asserting the exact column set, in the shape the existing migration tests use.
  - A new numbered SQL migration beside the existing five, and the table added to the Drizzle schema.
  - `recording_id` is a non-null foreign key to `recording`; `step` is the existing `pipeline_step`
    enum; `started_at`, `finished_at`, `error` and `provider_meta` are nullable and empty at enqueue.
  - `provider_meta` is `jsonb`, because [§7](docs/project/prd.md#L742) wants spend measured per job and what a
    provider reports is not the same shape for two providers.
- `status` is a `job_status` Postgres enum with exactly `pending`, `running`, `succeeded` and
  `failed`, derived from a single `JOB_STATUSES` constant in `@thp/shared` — verified by the existing
  domain-declarations guard, which already fails a second declaration of an enum.
- Existing tables are untouched by the migration — verified by asserting the account and recording
  column sets are unchanged after it runs.
- A recording can have at most one **unfinished** job per step — verified by asserting a second
  `pending` job for the same `(recording_id, step)` is refused at the database, while a second job for
  a pair whose earlier one is `succeeded` is accepted.
  - A partial unique index over `(recording_id, step)` where status is `pending` or `running`.
  - This is what makes an admin double-clicking Ticket 04's re-run harmless without Ticket 04 having
    to think about it.

### The queue port — what the API enqueues through

- The API enqueues through one module, and nothing in `packages/web` touches the `job` table directly
  — verified by a new guard test in `tests/guards/`, the same shape as the mail and media boundary
  guards.
  - One `Queue` port with a Postgres adapter behind it, matching the seam
    [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) names; query
    construction stays in `@thp/db`, as the import-boundary guard already requires.
- Enqueuing writes a `pending` row carrying the step, the recording and the calling request's
  correlation id — verified by an integration test asserting the persisted row's fields.
- `attempt` is 1 for the first job of a `(recording_id, step)` pair, and one higher than the highest
  previous attempt for each one after — verified by enqueuing, failing and re-enqueuing the same step
  and asserting `1` then `2`.
  - Computed inside the insert rather than read-then-written, so no two enqueues can agree on a
    number.
- Enqueuing a step that already has an unfinished job for that recording is a no-op returning the
  existing job rather than an error — verified by enqueuing twice and asserting one row and the same
  id both times.

### Claiming — `FOR UPDATE SKIP LOCKED`

- The worker claims the oldest `pending` job, sets it `running` and stamps `started_at` — verified by
  an integration test over three jobs asserting claim order is `enqueued_at` ascending.
- A job another transaction holds a lock on is **skipped, not waited for** — verified by an
  integration test that opens a transaction locking the only pending row and asserts a concurrent
  claim returns nothing instead of blocking.
  - `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, which is the claim
    and the state change in one statement.
- Two claims running at once never return the same job — verified by an integration test issuing
  concurrent claims against a queue of known size and asserting the returned ids are distinct and
  cover the queue exactly once.
- An empty queue returns nothing and is not an error — verified by claiming against no rows.

### Running a job — the handler registry

- A step's handler is looked up in a registry the worker is constructed with, so a test can supply its
  own — verified by the behavioural tests below driving the loop with a fake handler rather than with
  a real step.
- A handler that returns marks the job `succeeded`, stamps `finished_at` and leaves `error` null —
  verified by running a fake handler that succeeds and asserting the row.
- A handler that throws marks the job `failed`, stamps `finished_at`, records the reason in `error`
  and **does not rethrow** — verified by running a fake handler that throws and asserting the row and
  that the loop is still polling afterwards.
  - The reason is the error's message truncated to a fixed cap, so a provider's stack trace cannot
    bloat the row.
- A step with no handler registered marks the job `failed` naming the step — verified by claiming a
  job for a step the registry does not know.
- Both `transcribe` and `generate_draft` register **stub handlers** that do no work, succeed and
  record `{ "stub": true }` in `provider_meta` — verified by asserting a real upload's chain reaches
  `generate_draft` succeeded with both rows carrying the marker.
  - The marker is what keeps the ledger honest about the difference between "this step ran" and "this
    step exists yet"; Ticket 03 replaces the `transcribe` stub and the marker goes with it.
- Every claim, outcome and failure is logged as one structured line carrying the job id, the step, the
  recording and the job's correlation id — verified by a log-capture assertion, as the existing
  refusal tests do.
  - The structured logger moves to a `@thp/shared` subpath so the worker and the API emit the same
    shape; the API's module re-exports it and its call sites are unchanged.

### The chain rule

- A step that succeeds enqueues the next step in `PIPELINE_STEPS`, in the same transaction that marks
  it succeeded — verified by an integration test asserting a `pending` `generate_draft` row exists
  after `transcribe` succeeds, and by a second that forces the enqueue to fail and asserts neither
  change landed.
- A step that fails enqueues nothing — verified by failing `transcribe` and asserting no
  `generate_draft` row exists ([3.21.2.3](docs/project/prd.md#L485)).
- The last step in the list enqueues nothing and is not an error — verified by succeeding
  `generate_draft` and asserting the queue is empty.
- A successful step whose successor already has an unfinished job enqueues nothing rather than failing
  — verified by pre-enqueuing `generate_draft` and then succeeding `transcribe`.
- The successor is read from the ordered step list and from nowhere else — verified by a test driving
  the chain from a reordered list and asserting the successor follows that list.
  - Which is the whole of the *Pipeline step chain* seam: [§3.4](docs/project/prd.md#L88) inserting
    `process_audio` before `transcribe` is an edit to one array.

### Crash recovery — the startup sweep

- On start, the worker marks every `running` job `failed` with a reason naming a worker restart, and
  enqueues a fresh attempt of that step — verified by an integration test that seeds a `running` row,
  starts the loop, and asserts the old row is failed and a new `pending` row exists with `attempt`
  incremented.
- The sweep logs one line per reclaimed job, and one line naming that it assumes it is the only worker
  — verified by a log-capture assertion.
  - The assumption is load-bearing: a second worker process would reclaim the first's in-flight jobs
    at boot. Concurrency is pinned to 1 and the deployment runs one worker
    ([project architecture § Estimated running costs](docs/project/architecture.md#L343)); the log line is what makes
    that visible to whoever eventually breaks it.
- A worker killed mid-job and restarted runs that step's handler a second time — verified by an
  integration test that interrupts a handler, restarts the loop and asserts the handler ran twice.
  - This is the at-least-once property stated as a test rather than as prose, and it is the reason
    every handler in this epic and every later epic must be idempotent.

### The worker process

- `npm run worker` starts a process that polls, runs what it finds, and keeps running when the queue
  is empty — verified by an integration test driving the loop against a real database, asserting it
  survives an empty poll and picks up a job enqueued afterwards.
- One job runs at a time — verified by an integration test with two jobs and a handler that records
  overlap, asserting no two runs overlap.
- `SIGTERM` and `SIGINT` stop claiming, let the job in flight finish, and exit 0 — verified by an
  integration test signalling mid-job and asserting the job reached a terminal status before exit.
- The worker fails at startup naming the variable when `DATABASE_URL` is absent — verified by the
  existing env reader's unit tests, which the worker now shares.
- The worker imports nothing from `packages/web` — verified by extending the import-boundary guard to
  the worker package.

### Finalising an upload enqueues `transcribe`

- Finalising an upload writes the `recording` row **and** its `pending` `transcribe` job in one
  transaction — verified by an integration test asserting both exist, and by a second that forces the
  enqueue to fail and asserts **no recording row was written**.
  - Which is the failure class the ledger-is-the-queue choice exists to remove: there is no state in
    which a recording exists and its first job does not.
- The job carries the finalise request's correlation id — verified by finalising with a known
  correlation id and asserting it on the row and in the worker's log lines for that job.
- A refused finalisation enqueues nothing — verified by replaying Ticket 01's refusal cases and
  asserting the job table is empty.
- Presign → `PUT` → finalise → worker leaves `transcribe` and `generate_draft` both `succeeded` —
  verified by an end-to-end integration test running the real loop against MinIO.

## User steps

- Run `npm run migrate` against any environment that already has a database.
- Start the worker beside the app — `npm run worker` in a second terminal — and upload a recording
  through the admin console. Nothing on screen changes; confirm in `psql` that the recording's two
  jobs went `pending` → `running` → `succeeded`, both carrying `"stub": true`.
- Kill the worker mid-job without letting it drain, restart it, and confirm the abandoned job was
  reclaimed and re-run.

## Assumptions

### Major (confirmed with the operator)

- **The ledger is append-only: every run of a step is its own row**, `attempt` counting 1, 2, 3 for a
  `(recording_id, step)` pair, so a failure that was later re-run is still readable. Ticket 04's
  dashboard therefore reads the latest row per step rather than a plain select.
- **Crash recovery is a startup sweep**: at boot every `running` row is by definition abandoned, so it
  is failed and re-enqueued. Correct only while exactly one worker process runs, which the deployment
  pins; the sweep logs that it assumes it.
- **A step that succeeds always chains forward**, including when a human re-ran it, so a re-run
  `transcribe` also regenerates the draft. [3.21.2.4](docs/project/prd.md#L486) is satisfied by not restarting
  from step 1, and the `job` columns stay as
  [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) names them.
- **`transcribe` and `generate_draft` ship as stub handlers that succeed**, so the chain runs green end
  to end today. The cost is that the ledger reports a recording as fully processed when it has no
  transcript and no draft; `provider_meta: { "stub": true }` is what keeps that queryable rather than
  invisible, and Ticket 03 removes the first of the two.
- **`job` carries a `correlation_id` column**, one more than
  [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) lists. Its
  [§ Key choices](docs/epics/epic-core-listening/architecture.md#L255) row asks for a correlation id spanning API
  request → job → provider call, and a column is the only form of that which survives the process
  boundary.
- **No automatic retry.** A failed job stays failed until a human re-enqueues the step in Ticket 04 —
  [3.21.2.3](docs/project/prd.md#L485)'s halt-and-flag, not a retry policy.

### Minor

- The worker polls every 2 seconds, as a constant in code rather than an environment variable; the
  loop takes the interval as an argument so tests can drive it fast.
- Claim order is `enqueued_at` ascending with `id` as the tiebreak, for the same reason
  `listRecordings` breaks its tie: two rows written in the same millisecond would otherwise come back
  in planner order.
- `error` holds the thrown error's message truncated to 2000 characters. There is no stack trace on
  the row; the log line has it.
- The structured logger and its correlation store move to a `@thp/shared` subpath so both processes
  emit one shape. It is not re-exported from the package index, so no client module can pull
  `node:async_hooks` in — and the client-boundary guard already fails that if one tries.
- Ledger query construction (`enqueueJob`, `claimNextJob`, `completeJob`, `failJob`, `sweepRunning`)
  lives in `@thp/db`, and the queue port in `packages/web` wraps only the enqueue half — the port
  exists for the API's dispatch, not for the worker's reads, so the worker is not behind it.
- The handler signature takes the job row and returns `void`; a handler reports failure by throwing,
  so there is exactly one way to fail.
- `recording_id` is `NOT NULL`. Every job in this epic and in the deferred steps belongs to a
  recording, and a nullable column for a job type nobody has asked for is deferral quietly stopping
  being deferral.
- The end-to-end criterion runs the loop for a bounded number of polls rather than starting the real
  process, so the suite has nothing to kill.

## Edge cases

What the implementation does **not** cover. None of these is a defect against the criteria; each is a
line somebody will otherwise discover the hard way.

- **A ledger failure mid-job leaves the row `running` until the next restart.** `runJob` does not
  swallow a failure to *write* the outcome — the transaction rolls back and the job stays claimed.
  The loop logs `worker.run.failed` and keeps polling, but the sweep only runs at boot, so that row
  is recovered when the worker is next restarted and not before. Chosen over exiting the process,
  because nothing restarts it in this epic (Story 7 Ticket 02) and a worker that dies on a transient
  database blip stops processing everybody's uploads.
- **A persistent database failure makes the loop spin.** It logs one error per poll rather than
  backing off or stopping. Visible on purpose; noisy on purpose.
- **`enqueueJob` can throw on a race it cannot resolve.** If the unfinished job that refused the
  insert *finishes* between the insert and the read-back, the step is genuinely un-enqueued and the
  caller must retry. Stated at the throw rather than papered over.
- **The sweep assumes one worker process.** A second worker booting reclaims the first's in-flight
  jobs — an in-flight job and an abandoned one are the same row. Logged at every boot.
- **Nothing stops a claimed job.** No cancellation and no `cancelled` status; `SIGTERM` waits for the
  job in flight rather than interrupting it. A handler that hangs hangs the shutdown.
- **No retry, no backoff, no dead-letter.** A failed job stays failed until a human re-enqueues the
  step, which is Ticket 04's button. The startup sweep is the one automatic re-enqueue.
- **A re-enqueued job goes to the back of the queue.** Claim order is `enqueued_at` ascending and
  there is no priority, so a re-run waits behind everything already waiting.
- **`error` is truncated to 2000 characters and the stack is only in the log.** The log is not
  queryable from the application; an operator needs the process's output to see more than the reason.
- **`provider_meta` is not validated.** A handler can write any JSON, and nothing reads it yet.
- **The stub handlers make the ledger say a recording is fully processed when it has no transcript
  and no draft.** `{ "stub": true }` is the only thing distinguishing that from real work.
- **The signal path is not driven by a real OS signal in the suite.** `installSignalHandlers` takes an
  injectable registrar and the tests drive that; a real signal emitted inside the runner would hit
  vitest's own handlers, and Windows cannot deliver one to a child process gracefully at all. The
  behaviour the criterion is about — stop claiming, finish the job in flight — is driven for real.
- **The end-to-end test runs the loop in-process**, bounded by a deadline and then stopped, rather
  than starting `npm run worker`. That command was exercised by hand against a scratch database.

## Implementation notes

- **A handler returns provider metadata rather than `void`.** The minor assumption said the signature
  takes the job row and returns nothing; recording `{ "stub": true }` needs a channel, and Ticket 03's
  handler will have a model and a spend to report. Returning the evidence is the smallest one, and it
  leaves "failure is a throw, and it is the only way to fail" untouched.
- **`@thp/db` grew an `Executor`** — a pool, a transaction, or a handle wrapping the pool — plus
  `withTransaction`. It exists so `enqueueJob` is the *same function* whether the API's queue adapter
  calls it alone, the chain rule calls it inside the transaction that marks a step succeeded, or
  finalising an upload calls it inside the transaction that writes the recording. A second enqueue
  path would be a second idea of what `attempt` means. `insertRecording` and `listRecordings` moved to
  the same convention; every existing call site passing a handle still compiles.
- **The queue port's `enqueue` takes an optional executor**, and that is the one place the port admits
  what is behind it. Deliberate: transactional enqueue is the entire reason
  [project architecture § Key technology choices](docs/project/architecture.md#L209) made the ledger
  the queue. A broker adapter could not honour it, and that is the conversation to have when one
  arrives rather than a detail to have hidden in advance.
- **`setQueue` is a test seam**, the same shape as `setLogSink`. "The recording row is rolled back
  when the enqueue fails" is a property of the finalise transaction, and the only honest way to drive
  it is an enqueue that refuses — which the real queue cannot be asked to do.
- **The logger and the correlation store moved to `@thp/shared/observability/*`** and are deliberately
  absent from the package index, so reaching them means naming the subpath and no client module can
  pull `node:async_hooks` in. The API's two modules are now re-exports and every call site is
  unchanged.
- **Both ends of the chain read the ordered list.** `FIRST_PIPELINE_STEP` is what finalising an upload
  enqueues and `nextPipelineStep` is what a succeeded step enqueues, so
  [§3.4](docs/project/prd.md#L88) inserting `process_audio` is an edit to one array and to nothing
  near the upload code.
- **The correlation id is read from the ambient store by the queue port**, not threaded through
  `finaliseUpload`'s signature — the same store the logger reads, so a job and the request that caused
  it are one query apart. The worker enters it from the row before running a handler, which is what
  makes every line a job emits quotable against the upload.
- **The domain-declarations guard caught two test files** restating the two step names as a literal
  tuple. Both now derive from `PIPELINE_STEPS`, which is what the guard is for.
- **The migration suite's before-and-after had to be pinned by tag.** It counted back from the end of
  the journal, so this ticket's migration silently re-pointed the `recording` comparison at itself.
  `journalCountBefore('<tag>')` now names the migration each comparison is about.
- **Log vocabulary added:** `job.claimed`, `job.succeeded`, `job.failed`, `worker.started`,
  `worker.stopped`, `worker.signal`, `worker.claim.failed`, `worker.run.failed`,
  `worker.sweep.start`, `worker.sweep.reclaimed`, `worker.sweep.finished`. Every job line carries the
  job id, the step, the recording and the job's correlation id.
- **Claiming was built out of order.** It was skipped in the run through the criteria and then turned
  out to be a hard prerequisite of the worker process — a loop that "polls and runs what it finds" is
  claiming plus running — so it was built alongside the worker rather than stubbed.

## Manual validation

- [ ] `npm run migrate` against a database that already has the first five migrations, and confirm in
      `psql` that `job` exists with the eleven columns and that `\d job` shows
      `job_unfinished_step_unique` as a partial index.
- [ ] Start the app (`npm run dev`) and the worker (`npm run worker`) in two terminals. The worker
      logs `worker.sweep.start` naming its single-worker assumption, then `worker.started`.
- [ ] Upload a recording through the admin console. Nothing on screen changes.
- [ ] In the worker's terminal, watch `job.claimed` → `job.succeeded` twice, all four lines under the
      same `correlationId` as the upload's `recording.create` line in the app's output.
- [ ] In `psql`: `select step, status, attempt, provider_meta from job where recording_id = '…'` shows
      `transcribe` and `generate_draft`, both `succeeded`, both `{"stub": true}`.
- [ ] Stop the worker with Ctrl-C while idle and confirm it exits without complaint.
- [ ] Upload again with the worker **stopped**, confirm the `transcribe` job sits `pending`, then
      start the worker and watch it pick the job up within a couple of seconds.
- [ ] Kill the worker mid-job without letting it drain (close the terminal, or `taskkill /F`), leaving
      a `running` row behind, then restart it: `worker.sweep.reclaimed` names the old job, the old row
      is `failed` saying the worker restarted, and a new row with `attempt` 2 runs to `succeeded`.
