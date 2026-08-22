# Ticket 03 — Transcription into timestamped segments
_Story: Get a recording transcribed_

> Phase 6 artefact for [implementation plan § Ticket 03](docs/epics/epic-core-listening/implementation-plan.md#L167).
> Sections pulled: [epic prd § In scope → 2](docs/epics/epic-core-listening/prd.md#L52);
> [3.5.1](docs/project/prd.md#L118) (**narrowed — triggers on upload completing, not on processing
> completing**); [3.5.2](docs/project/prd.md#L119); [3.5.7](docs/project/prd.md#L124);
> [3.5.8](docs/project/prd.md#L125);
> [epic architecture § Worker process](docs/epics/epic-core-listening/architecture.md#L139);
> [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The spine*;
> [4.4](docs/project/prd.md#L555);
> [project architecture § Data model](docs/project/architecture.md#L171);
> [project architecture § Key technology choices](docs/project/architecture.md#L209) — the managed-ASR row.
> Carried in because this ticket touches them:
> [epic architecture § Media store](docs/epics/epic-core-listening/architecture.md#L164) and
> [3.4.9](docs/project/prd.md#L108), whose non-negotiable this ticket must not break;
> [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Segment row* and
> *`(recording_id, timestamp_ms)` offset*;
> [epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255) — the ASR-adapter row and the
> correlation-id row; [project architecture § Estimated running costs](docs/project/architecture.md#L343) — the
> transcription line the provider choice is measured against; [§7](docs/project/prd.md#L779) — the
> ministry-vocabulary accuracy risk; [3.21.2.3](docs/project/prd.md#L496) and
> [3.19.4](docs/project/prd.md#L442), which are how a failure here becomes visible in Ticket 04;
> [epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341);
> [02-job-ledger-and-worker-loop.md § Implementation notes](docs/epics/epic-core-listening/stories/get-a-recording-transcribed/02-job-ledger-and-worker-loop.md#L327)
> — the handler contract this ticket is the first real implementation of.

**The timestamped segment is the atom of the whole system.** Notes, highlights, mind maps, search,
cross-references and Flow Tracker all resolve through `(recording_id, timestamp_ms)` in later epics
([project architecture § Data model](docs/project/architecture.md#L171)), so the row shape settled
here is the most consequential schema decision left in this epic. It is settled by matching the
`Segment` type that already exists in `packages/shared` rather than by inventing a second shape, and
it takes **no embedding column** — that is [§3.9](docs/project/prd.md#L189)/[§3.10](docs/project/prd.md#L204)'s
`ALTER TABLE`, and adding it now is deferral quietly stopping being deferral.

Two other things are worth naming before the criteria. **This is the first handler that does real
work**, so Ticket 02's at-least-once contract stops being theoretical: this handler will be re-run on
the same recording, by the startup sweep and by Ticket 04's button, and it has to survive that. And
**the worker cannot currently reach the object store** — the media port lives in `packages/web` and
the import-boundary guard stops the worker importing it. Moving that port is part of this ticket and
is the one piece of structure it changes.

---

## Goal

The `transcribe` handler, doing the work the stub stood in for. It reads the original object, calls
the ASR adapter, and writes a `transcript` row plus `segment` rows carrying `start_ms`, `end_ms`,
`text` and the language it was transcribed in. `provider_meta` records the model, its version and
the spend for that job. A failure — the provider's, or a transcript the provider is not confident in — records the
reason and stops the chain there rather than proceeding to generation on bad input.

- As an admin I want an uploaded recording to end up with a timestamped transcript without my doing
  anything ([3.5.1](docs/project/prd.md#L118) as this epic narrows it,
  [3.5.2](docs/project/prd.md#L119)).
- As an operator I want the transcript to record the language it was transcribed in, so adding a
  second language later is an adapter change rather than a migration and a back-fill
  ([3.5.7](docs/project/prd.md#L124), [4.4](docs/project/prd.md#L555)).
- As an admin I do not want a summary generated from a transcript the machine itself doubted
  ([3.5.8](docs/project/prd.md#L125)).
- As an operator I want the model, the version and what the job cost recorded on the row, so spend is
  measured rather than estimated ([§7](docs/project/prd.md#L779)).

## Out of scope

- **Every surface that shows a transcript.** Nothing renders segments, nothing seeks to one, nothing
  highlights one — [3.5.3](docs/project/prd.md#L120) and [3.5.4](docs/project/prd.md#L121) are Story 5,
  and no member can see anything until Story 3 publishes it. This ticket ships no route and no
  screen.
- **Transcript correction** ([3.5.5](docs/project/prd.md#L122)) and the regeneration offer that
  follows it ([3.5.6](docs/project/prd.md#L123)) — Story 5. `segment` carries `corrected_at` and
  `corrected_by_user_id` because the shared `Segment` type already does; nothing in this ticket
  writes them.
- **The pipeline status view and per-step re-run** — Ticket 04 owns [3.19.4](docs/project/prd.md#L442)
  and [3.21.2.4](docs/project/prd.md#L497). A low-confidence transcript is flagged here by *failing
  the job*, and the screen that makes that legible is the next ticket, not this one.
- **`generate_draft`** and the `review_item` table — Story 3. This ticket only chains into it, which
  Ticket 02 already built.
- **Language detection, and any non-English recording.** English is pinned, so nothing detects and
  nothing branches on what came back. A recording in another language is transcribed badly as English
  — see the assumption, which names that as the accepted cost.
- **Custom vocabulary, keyterm prompting or a ministry glossary.** The provider supports it — and
  because English is pinned, its keyterm feature is available to this configuration rather than
  ruled out by a multilingual model — but a term list is something somebody curates through a
  screen, and there is no screen. The adapter leaves the seam and passes an empty list, which is the
  mitigation [§7](docs/project/prd.md#L779)'s ministry-vocabulary risk gets when somebody decides to
  build it.
- **Speaker diarisation and per-speaker labelling.** Nothing in the PRD asks who is speaking.
- **Word-level timestamps as stored rows.** The provider returns them; a segment is a sentence, and
  the words inside it are not persisted.
- **An embedding column on `segment`, pgvector, and any index over segment text**
  ([epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341)).
- **Automatic retry on a provider error, backoff, and a dead-letter queue.** A failed job stays
  failed until a human re-enqueues the step, exactly as Ticket 02 settled.
- **Audio duration, bitrate, channel count or any inspection of the media** —
  [§3.4](docs/project/prd.md#L94) is deferred whole and `recording` grows no column here.
- **A processed-media pointer, or reading anything other than the original object.**
- **Chunking, splitting or re-encoding the upload before sending it.** The 200 MB ceiling
  ([epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255)) and the chosen
  provider's limits are compatible; a file the provider refuses is a failed job, not a pipeline that
  quietly rewrites the input.
- **A second ASR provider, or provider fallback.** One adapter, one implementation behind it.

## User prerequisites

- **A Deepgram account and a Member-scoped API key**, provided as `ASR_API_KEY`. Signup carries $200
  of credit and needs no card, which is ~775 hours at the monolingual rate — the whole back catalogue
  would likely run inside it. A 90-minute teaching is ~$0.39.
- **One real audio file to transcribe end to end** — a genuine teaching recording rather than a tone,
  because the confidence gate and the sentence segmentation are only meaningfully exercised by
  speech.

## Acceptance criteria

### The `transcript` and `segment` tables

- `transcript` exists with `id`, `recording_id`, `language`, `confidence`, `created_at`, and with no
  other column — verified by a migration test asserting the exact column set, in the shape the
  existing migration tests use.
  - A new numbered SQL migration beside the existing six, and the tables added to the Drizzle schema.
  - `recording_id` is a non-null foreign key to `recording` cascading on delete, and **unique** —
    [4.4](docs/project/prd.md#L555) says one transcript per recording, so the database says it too.
  - `language` is a BCP-47 code — always `en` in this epic, because English is pinned; `confidence`
    is a `real` in `0..1`.
  - **No `text` column.** The segments are the text, and a concatenated copy is a second source of
    truth that Story 5's correction would have to keep in step.
- `segment` exists with `id`, `transcript_id`, `start_ms`, `end_ms`, `text`, `corrected_at`,
  `corrected_by_user_id`, and with no other column — verified by the same migration test.
  - The columns are the fields of the `Segment` type already in `@thp/shared`, matched rather than
    re-invented; a guard test asserts the two agree.
  - `start_ms` and `end_ms` are integers, start inclusive and end exclusive, as the shared type's
    documentation already states.
  - `transcript_id` cascades on delete, so replacing a transcript removes its segments with it.
  - **No embedding column** — [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323)
    names the `ALTER TABLE` that adds one, and it belongs to a later epic.
- Segments of one transcript are readable in playback order — verified by inserting segments out of
  order and asserting the read returns them ascending by `start_ms`.
  - An index on `(transcript_id, start_ms)`, which is also the lookup Story 5's follow-along makes.
- Existing tables are untouched by the migration — verified by asserting the account, recording and
  job column sets are unchanged after it runs.

### The ASR port — one adapter, no vendor in the application

- The application calls transcription through one port with one adapter behind it, and no module
  outside that adapter imports the provider's SDK or reaches its API — verified by a new guard test
  in `tests/guards/`, the same shape as the mail and media boundary guards.
  - A `Transcriber` port taking the audio's location and the language to transcribe in, returning
    segments, an overall confidence and the provider metadata; the Deepgram adapter is the one file
    behind it.
  - Which is the low reversal cost the ASR-adapter row of
    [epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255) is claiming.
- The provider's configuration is read in one module that names every variable and has no defaults —
  verified by unit tests asserting a missing `ASR_API_KEY` fails naming the variable, in the shape
  `media/env.ts` and `mail/env.ts` already use.
- A `fake` transcriber returning a fixed script is selectable by configuration, and it is what the
  suite runs against — verified by the whole handler suite passing with no network access.
  - The same shape as `MAIL_TRANSPORT=capture`: the provider is configuration, so the test double is
    a value of the same setting rather than a mock.
- The adapter maps the provider's response into segments, a language and a confidence, and nothing
  downstream sees the provider's shape — verified by a unit test over a captured real response
  fixture asserting the mapped output.
- A provider error, a refusal and a timeout each surface as a thrown error naming what happened —
  verified by unit tests driving each against a stubbed transport.

### Reading the original — the media port moves

- The media port and its S3 adapter live in a package both the web app and the worker depend on, and
  the S3 SDK is still imported by exactly one file — verified by the existing media-boundary guard,
  updated to the new path, plus the import-boundary guard extended to the moved package.
  - Everything the port already guarantees survives the move, **including that there is no delete on
    it** — [3.4.9](docs/project/prd.md#L108)'s non-negotiable is a fact about that interface.
  - The web app's existing call sites change import path and nothing else.
- The port gains `presignGet`, minting a short-lived signed `GET` for a key — verified by an
  integration test against MinIO asserting the URL fetches the object and that a URL is refused after
  its expiry.
  - Which is also what Story 4 Ticket 02 needs to make playback work, built once.
- The handler passes that signed URL to the provider rather than moving the bytes — verified by an
  integration test asserting the fake transcriber received a URL that resolves to the uploaded
  object.
  - Bytes never pass through the worker, which is the same boundary the presigned `PUT` holds on the
    way in.
- The grant the provider receives expires within a fixed short window — verified by a unit test
  asserting the requested expiry against a named constant.
- The original object is not modified, copied or removed by the handler — verified by asserting the
  object's metadata is unchanged after a transcription runs.

### The `transcribe` handler

- A successful transcription writes one `transcript` row and its `segment` rows for the recording
  named by the job — verified by an integration test running the handler against the fake
  transcriber and asserting the persisted rows.
  - It replaces the stub handler Ticket 02 registered; the `{ "stub": true }` marker goes with it.
- Every segment carries `start_ms`, `end_ms` and `text`, with `end_ms` greater than `start_ms` and
  each segment starting no earlier than the previous one ends — verified by an integration test
  asserting the invariants over a multi-segment fixture.
- The adapter asks for English explicitly and the transcript records `en` — verified by a unit test
  asserting the request carries the pinned language, and an integration test asserting the persisted
  row ([3.5.7](docs/project/prd.md#L124)).
  - Pinned rather than detected, and the column exists anyway so that a second language later is an
    adapter change rather than a migration and a back-fill over every transcript already written.
- The transcript, its segments and the job's outcome are written in one transaction — verified by an
  integration test that forces the segment write to fail and asserts no `transcript` row survives.
  - A partially written transcript is a transcript with a hole in it, and nothing downstream could
    tell the difference.
- **Running the handler twice on the same recording leaves exactly one transcript and one set of
  segments** — verified by an integration test running it twice and asserting the row counts, and by
  a second asserting the second run's text is what persists.
  - The write deletes the recording's existing transcript first and inserts fresh, inside the same
    transaction.
  - This is Ticket 02's at-least-once contract met for the first time by a handler that actually
    writes something.
- `provider_meta` records the model, the model version, the audio duration the provider billed and
  the cost of the job — verified by an integration test asserting the four keys on the succeeded job
  row ([§7](docs/project/prd.md#L779)).
- A provider failure marks the job `failed` with the reason and enqueues no successor — verified by
  an integration test with a failing fake asserting the job row and that no `generate_draft` job
  exists ([3.21.2.3](docs/project/prd.md#L496)).
  - Which is Ticket 02's chain rule doing the work; this handler adds nothing to it but a throw.
- A recording whose object is missing from the store fails naming the key rather than calling the
  provider — verified by an integration test with a `recording` row pointing at nothing.
- Every call is logged as one structured line carrying the job id, the recording, the correlation id
  from the row and the provider's own request id — verified by a log-capture assertion.
  - Which is what completes the API request → job → provider call span
    [epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255) asks for.

### The confidence gate

- A transcript whose overall confidence is below the threshold is **written**, and then the job
  **fails** with a reason naming the confidence and the threshold — verified by an integration test
  with a low-confidence fake asserting both the persisted transcript and the failed job row
  ([3.5.8](docs/project/prd.md#L125)).
  - Written first because the admin has to be able to read it to judge it, and because Story 5's
    correction has nothing to correct otherwise.
- A low-confidence transcript enqueues no `generate_draft` — verified by asserting the job table
  after that run.
  - Which is the whole of "rather than proceeding to downstream generation on bad input".
- The threshold is one named constant, not a scattered literal — verified by a unit test over the
  gate function at, just below and just above it.
- A transcript at or above the threshold succeeds and chains forward — verified by an integration
  test asserting a `pending` `generate_draft` row after a confident run.

### End to end

- Presign → `PUT` → finalise → worker leaves a `recording` with a `transcript`, its segments, a
  language of `en`, and both jobs `succeeded` — verified by an integration test running the real
  loop against MinIO and the fake transcriber.
- The worker imports nothing from `packages/web` — verified by the existing import-boundary guard,
  which already covers the worker package and must still pass after the media port moves.

## User steps

- Run `npm run migrate` against any environment that already has a database.
- Put a real Deepgram key in `ASR_API_KEY` and leave `ASR_PROVIDER=deepgram` in `.env`. The suite
  runs on `fake` and never reads either.
- With the app and the worker both running, upload a genuine teaching recording and confirm in `psql`
  that its `transcript` row reads `en` with a plausible confidence, that its segments read as
  sentences in order, and that `provider_meta` on the `transcribe` job names the model and a cost
  close to $0.258/hr of audio. **This is the first real spend against the account** — check the
  console's usage view agrees with the row.
- Read a dozen segments against the audio and judge the accuracy on names and terminology
  ([§7](docs/project/prd.md#L779)). If it is poor, say so — the keyterm seam is left open for exactly
  that, and filling it is a scope decision rather than a fix.

## Assumptions

### Major (confirmed with the operator)

- **The provider is Deepgram**, Nova-3 pre-recorded **monolingual English**, at $0.0043/min =
  $0.258/hr — which is where
  [project architecture § Estimated running costs](docs/project/architecture.md#L343)'s ~$0.26/hr came from, and
  which the published rate confirms rather than approximates. It returns sentence and word
  timestamps and per-segment and overall confidence in one response. The multilingual model is
  $0.0052/min = $0.312/hr, ~21% over the cost table, and pinning English avoids it.
- **The adapter waits on the call rather than polling a provider-side job.** Deepgram's pre-recorded
  API is synchronous, so `running` in Ticket 04 means the worker is blocked in one HTTPS request.
  Acceptable because concurrency is pinned to 1 and the volume is ~4.3 recordings a month.
- **A segment is one sentence** — roughly 700–900 rows for a 90-minute teaching. Fine enough that
  Story 5's follow-along highlighting tracks properly and a seek lands where the reader expects,
  coarse enough that a corrected segment is a readable unit of text. Words are not persisted.
- **Low confidence writes the transcript and then fails the job**, so it halts the chain and appears
  in Ticket 04's failed column with no second flagging mechanism. The admin's escape hatch is Ticket
  04's per-step re-run of `generate_draft` directly ([3.21.2.4](docs/project/prd.md#L497)) once they
  have read the transcript and judged it usable.
- **The threshold is 0.6.** A first setting, not a measured one; the first real recording is what
  tells us whether it is right.
- **The media port and its S3 adapter move to a package the worker can depend on**, and the port
  gains `presignGet`. The worker hands the provider a short-lived signed URL rather than moving the
  bytes. The trade taken knowingly: a signed URL to a bucket that is never publicly readable is
  briefly held by a third party.
- **Re-running `transcribe` replaces the transcript**, deleting the existing one and its segments.
  The cost is that a re-run discards any corrections Story 5 will let an admin make — stated here
  rather than defended against, because the alternative is versioned transcripts and nothing in this
  epic asks for them.
- **`transcript` has no `text` column.** [4.4](docs/project/prd.md#L555) lists Text; the segments are
  it, and Story 3 concatenates them when it feeds Claude.
- **The language is pinned to English, not detected.** The ministry publishes in English, so
  detection would buy nothing and cost accuracy — the monolingual English model is the more accurate
  one and, at $0.0043/min, the one the cost table is built on. `transcript.language` is still written
  and still reads `en`, which is what keeps [4.4](docs/project/prd.md#L555)'s Language field honest
  and makes a second language an adapter change later.
  - **The accepted cost:** [3.5.7](docs/project/prd.md#L124) asks for the language *detected*, and a
    pinned language records what was configured. A recording in another language is transcribed
    badly as English and still reads `en` — a wrong answer rather than a visible one. Nothing in this
    epic catches that; the low-confidence gate is the only thing likely to.

### Minor

- The signed `GET` handed to the provider expires after 2 hours — long enough for the provider to
  fetch and process a 200 MB file, short enough that a leaked URL is not a standing grant.
- The HTTP call to the provider has a hard timeout of 30 minutes, well past the few minutes a
  90-minute file takes, and a timeout is an ordinary handler failure.
- `confidence` is `real` rather than `numeric`; it is a score to compare against a threshold, not
  money.
- The provider's raw response is not persisted. `provider_meta` carries the four measured facts and
  the provider's request id; the rest is in the log line.
- Segment text is stored as the provider returns it, trimmed of surrounding whitespace and not
  otherwise normalised.
- A transcript with zero segments is a failure, not an empty success — silence is a recording nobody
  wants a summary of.
- `ASR_PROVIDER` selects the adapter and `ASR_FAKE_SCRIPT` points the fake at a fixture, matching the
  `MAIL_TRANSPORT` convention rather than inventing a second one.
- The moved media package is `@thp/media`, a sibling of `@thp/db` and `@thp/shared`, and it is
  server-only by the same import-boundary rule.
- Query construction for `transcript` and `segment` lives in `@thp/db` and takes an `Executor`, like
  every other write since Ticket 02.
- Segments are written with one multi-row insert rather than a loop, so a 900-segment transcript is
  one statement.
- The log vocabulary adds `transcribe.started`, `transcribe.succeeded`, `transcribe.low_confidence`
  and `transcribe.failed`, alongside the `job.*` lines Ticket 02 already emits.

## Edge cases

- **A recording in a language other than English** is transcribed badly as English and its
  transcript still reads `en`. Nothing detects it; the confidence gate is the only thing likely to
  catch it, and if the model is confidently wrong nothing will.
- **Ministry vocabulary — names, places, terminology.** No keyterm list is sent, so unfamiliar words
  come back as whatever sounds nearest. It reads as a transcript with plausible wrong words in it
  rather than as a failure. The seam is in the adapter and empty.
- **A re-run silently discards corrections.** Once Story 5 lets an admin fix a segment, pressing
  Ticket 04's re-run on `transcribe` deletes the whole transcript and writes a fresh one. There is
  no warning and no versioning; the corrections are simply gone.
- **A transcript that is confidently wrong passes the gate.** Confidence measures how sure the model
  is of what it heard, not whether it heard right — a clear recording of an unfamiliar term scores
  high and reads wrong.
- **A low-confidence transcript reads as an ordinary failure** in the ledger. The reason names the
  confidence and the threshold, so an operator has to read the `error` column to tell "the machine
  doubted this" from "the provider refused this". Ticket 04's screen is what makes the difference
  legible.
- **A half-edited `MEDIA_` block fails late and unhelpfully.** The reader has no defaults, but it
  validates nothing beyond presence — credentials that belong to a different store than
  `MEDIA_ENDPOINT` names surface as a browser upload that "failed before it finished", and an
  endpoint URL pasted into `MEDIA_BUCKET` surfaces as a 500 carrying an SDK message about slashes in
  bucket names. Both were hit while validating this ticket. Nothing checks that a bucket name is a
  name.
- **The real provider cannot transcribe anything stored in local MinIO.** Deepgram fetches the audio
  from the signed URL itself, and `http://127.0.0.1:9000` is not routable from its servers — every
  such job fails with `REMOTE_CONTENT_ERROR: URL for media download must be publicly routable`. This
  is the design working, not failing: production is a public R2 endpoint and the same URL works
  unchanged. It means local development runs on `ASR_PROVIDER=fake`, and the real provider is only
  exercisable against a bucket the provider can reach.
- **A provider that answers with an empty transcript for real silence** fails the job saying the
  provider returned no segments. An admin uploading a silent file sees a failed step, not "this
  recording has no speech in it".
- **The signed URL is held by a third party for up to two hours.** If the provider logs URLs, that
  log holds a working grant to the object for that window. The bucket is never publicly readable and
  the grant expires; nothing revokes it early.
- **A file the provider refuses** — a codec it cannot read, a size past its own limit — is a failed
  job carrying the provider's own words. Nothing chunks, splits or re-encodes the upload to get
  round it.
- **A worker killed mid-transcription loses the provider call**, not just the row. The startup sweep
  re-runs the step from the beginning and the account is billed twice for that recording.
- **A transcript is written before the job is marked succeeded**, in a separate transaction. A crash
  in the gap leaves a transcript with the job still `running`; the sweep re-runs the step, the
  transcript is replaced, and the ledger is correct again — but for that window a recording has a
  transcript no succeeded job accounts for.
- **`provider_meta` records what the provider said it billed.** Nothing reconciles it against the
  console; a provider that reports duration wrongly reports spend wrongly, and the row would agree
  with itself.
- **Nothing reads a transcript yet.** No route, no screen, no query outside the tests — the only way
  to see one in this ticket is `psql`.
- **A segment's text is stored as the provider returns it**, trimmed and not otherwise normalised.
  Smart quotes, inconsistent casing after an acronym and the provider's punctuation choices are
  carried through as-is.
- **Two workers would transcribe the same recording twice.** The at-most-one-unfinished-job index
  stops two *jobs*, and the sole-worker assumption is what stops two runs; neither is a lock around
  the provider call. The deployment pins concurrency to 1.

## Implementation notes

### Assumptions — major (confirmed with the operator)

- The ticket's assumptions were all settled at planning and none of them changed under
  implementation. One conflict between two acceptance criteria had to be resolved and is recorded
  under *Other notes* rather than here, because the resolution is forced rather than chosen.

### Assumptions — minor

- The adapter calls Deepgram with `fetch` rather than `@deepgram/sdk`. The call is one `POST` with a
  JSON body naming a URL, and the dependency would buy nothing but a release cadence to track. The
  guard therefore checks for the API **host** as well as for an SDK import — a second door needs no
  dependency, only a string.
- The ASR port lives in `packages/worker/src/asr/`, not in a package of its own. Only the worker
  transcribes; the media port moved because two processes needed it, and this one does not.
- `createHandlers()` replaced the `STUB_HANDLERS` constant. A module-level registry would read the
  environment at import time, so a worker with only drafts to run would refuse to start over an ASR
  key it never uses.
- The Deepgram query is `model=nova-3&language=<lang>&smart_format=true`. Smart formatting is what
  produces the punctuated sentences a segment is; without it the response carries words and nothing
  to group them by.
- Sentence offsets come back in seconds as floats and are rounded to whole milliseconds.
- `provider_meta` carries five keys — the four measured facts plus the provider's request id.
- `TranscriptionError` is one error type for every way a provider call can fail. To the handler an
  HTTP status, a timeout and an unparseable body are the same event: this recording has no
  transcript and the chain stops.
- `findRecordingById` was added to `@thp/db`. A job names a recording and nothing else, so it is the
  worker's first question.
- The `transcript.confidence` range is a check constraint, not only a convention. A provider
  answering outside `0..1` would otherwise pass the gate by accident.
- `segment.corrected_by_user_id` is `on delete set null`, like `invitation.invited_by`: a correction
  is a record of something that happened and should survive the account being removed.
- The two loop tests that ran on the default registry now pass explicit handlers. The default is the
  real registry from this ticket, and `transcribe` in it needs a bucket and a provider that the loop
  suite has nothing to say about.
- `@thp/media` was added to the client import-boundary guard as a new `no-server-package` rule. It
  became nameable by a client the moment it stopped being a folder inside the server tree.

### Other notes

- **Two acceptance criteria conflict, and one resolution is forced.** "The transcript, its segments
  and the job's outcome are written in one transaction" cannot hold alongside "a low-confidence
  transcript is written, and then the job fails" — the second requires the transcript to commit and
  the outcome to be a failure. What is implemented is the atomicity the first criterion's own
  verification names: the transcript and its segments land together or not at all, inside
  `replaceTranscript`, and the job's outcome is `runJob`'s existing transaction as Ticket 02 built
  it. The gap this leaves is one line in Edge cases and is closed by the next sweep.
- **The Deepgram response fixture is hand-built from the documented response shape, not captured
  from a real call.** The mapping is therefore proven against a plausible response rather than a real
  one. If the segments come back empty or the model version is blank on the first real
  transcription, that fixture is the first place to look.
- **The real provider was never exercised end to end, and cannot be from a developer machine.** The
  first attempt failed with `REMOTE_CONTENT_ERROR: URL for media download must be publicly routable`
  — Deepgram fetches the object itself, and the MinIO container is not reachable from the internet.
  Everything up to and including the provider call is proven (the key authenticates, the request is
  well formed, the refusal is recorded correctly and the chain halts); what is unproven is the
  response mapping and the accuracy judgement, and both need a bucket the provider can reach. The
  options are a tunnel in front of MinIO, or pointing the five `MEDIA_` values at the real R2 bucket
  — which is a decision about writing test uploads into a store nothing can delete from, and so the
  operator's.
- **The media port moved to `@thp/media`, a package beside `@thp/db`.** Everything it guaranteed
  survived — the S3 SDK is still imported by exactly one file, and there is still no delete on the
  interface. Both guards follow the new path. `01-upload-to-object-storage.md` says the second media
  pointer attaches at `server/media/store.ts`; it attaches at `packages/media/src/store.ts` now.
- **`presignGet` is built here and Story 4 Ticket 02 should use it rather than build its own.** The
  port takes the expiry as an argument for exactly that reason: two hours is this ticket's number,
  and playback's will be a different one named where its reason lives.
- **`transcript` has no reader.** Story 3 concatenates segments in `start_ms` order for its one call
  to Claude, and Story 5 reads them per-segment; `listSegments` already returns them in that order,
  so neither needs to decide it again.
- **The threshold and the grant window are named constants in `packages/worker/src/transcribe.ts`.**
  When the first real recording says 0.6 is wrong, that is the one edit.
