# Teaching Hub — Epic plan: core-listening

> Phase 5 artefact, rewritten. The build order for the **remaining** work in
> [epic prd](docs/epics/epic-core-listening/prd.md#L1) under
> [epic architecture](docs/epics/epic-core-listening/architecture.md#L1). Each ticket below is one reviewable unit of
> behaviour — testable on its own, describable in a sentence, small enough that its whole diff fits
> in your head. Phases 6–8 walk this list one ticket at a time, validating at each story boundary.

## Where this picks up

**The first story, Get a person in, is built.** Accounts, sessions, the policy module, invitations, account
lifecycle and the admin console shell all run; its five ticket docs live in
[stories/get-a-person-in/](docs/epics/epic-core-listening/stories/get-a-person-in/) and its plan entry is kept in
[implementation-plan-old.md](docs/epics/epic-core-listening/implementation-plan-old.md) as the record of what was
planned there. This document replaces the rest of that plan and does not restate it.

Six stories remain, in dependency order. They cover the same ground as the old plan's stories 2–5,
re-cut so each one ends in something the operator can actually exercise, and so the two tickets the
old plan itself flagged as oversized — the ledger-plus-worker-plus-transcription ticket, and the single
production-deployment ticket — are split into reviewable pieces.

2. **Get a recording transcribed** — upload straight to object storage, a job ledger the dashboard can
   read, a worker that claims work, transcription into timestamped segments, and the status panel that
   makes the pipeline legible.
3. **Review and publish a teaching** — one Claude call producing a draft summary and description, the
   review gate every later AI artefact passes through, regeneration, and the publish decision that is
   the only route to member visibility.
4. **Listen to a teaching** — the library, the recording page, streaming with scrubbing, persistent
   speed, and resume-anywhere.
5. **Follow the transcript while it plays** — the follow-along transcript, and admin correction with
   the regeneration offer.
6. **Organise teachings into series** — admin series management, and the member-facing series view.
7. **Run it in production** — the host, the two supervised processes, TLS, production migrations, and
   backups with a proven restore.

**No member can see anything until Story 3's last ticket.** That is deliberate: the publish gate is
what makes member visibility a single, testable condition rather than a rule sprinkled across read
paths. Stories 2–3 are admin-and-machine only.

**The one ordering worth arguing** is Story 7. It depends on nothing after the account story and
could run first, which would mean every later ticket is validated against real infrastructure and
deployment problems arrive one at a time instead of nineteen at once. It sits last because there is no
member to serve until Story 6, and a deployment carried through eighteen tickets of schema churn is
real cost. Note that the **object store is provisioned for real in Story 2 Ticket 01 regardless** —
presigned uploads cannot be faked convincingly — so the part of deployment the build actually needs
early is not waiting for Story 7.

## Standing constraints

These apply to every ticket and are not restated per ticket. A ticket that breaks one is not done.

- **Responsive from one codebase.** Every screen works on phone, tablet and desktop — the responsive
  row of [§5.1](docs/project/prd.md#L689), per
  [epic prd § In scope → 8](docs/epics/epic-core-listening/prd.md#L161). There is no separate "make it responsive"
  ticket, because there is no point at which it is acceptable not to be.
- **The client holds no authorisation decision.** It hides what a Member cannot do; the API is what
  refuses it ([3.1.5](docs/project/prd.md#L47),
  [epic architecture § Next.js application — client half](docs/epics/epic-core-listening/architecture.md#L109)).
- **Every `/api/v1` route requires a session**, with no exception carrying content
  ([3.1.2](docs/project/prd.md#L44),
  [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323)). The exception list is an
  **enumerated allowlist in the route wrapper**, shipped in the previous story with a test asserting
  every route *not* on it refuses an anonymous request. It currently holds four entries — health,
  sign-in, invitation accept, password reset. **No ticket in this plan adds a fifth**; if one appears
  to need one, that is a scope decision, not an implementation detail.
- **The original upload is never overwritten or deleted** — the one non-negotiable
  ([3.4.9](docs/project/prd.md#L102), [epic architecture § Media store](docs/epics/epic-core-listening/architecture.md#L164)).
- **Nothing publishes automatically** ([4.17.3](docs/project/prd.md#L683)). Workers produce drafts only
  ([3.21.2.2](docs/project/prd.md#L484)).
- **Media is never publicly addressable.** Every read is a short-lived signed URL minted after an
  authorisation check ([§6](docs/project/prd.md#L724) Security).
- **Correlation id spans API request → job → provider call**, and every gate transition is logged with
  actor, action, target and timestamp
  ([epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255)).
- **Every screen is built from its design reference** (CLAUDE.md § Designing pages) — see the table
  below, which also names what each reference shows that this epic does not ship.
- **Do not build what is deferred.** Before adding infrastructure, check
  [epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341) — no broker, no CDN,
  no pgvector, no service worker, no Capacitor, no Contributor role, no audio processing.

## Design references

The references are drawn **ahead of this epic** — most show features that are deferred. Take the
layout, chrome and tokens; ship only what this epic has data for. Reading the reference is mandatory
before markup; the third column is what to leave out of it.

| Screen | Reference | Ticket | Shown in the reference but **not** in this epic |
| :---- | :---- | :---- | :---- |
| Member landing | `pages/dashboard.png` | Story 4 Ticket 01 | the *My notes* card — [§3.12](docs/project/prd.md#L257) is deferred |
| Recording page | `pages/recording.png` | Story 4 Ticket 01 | the chapter list and `Chapter` tab, the `Scripture`, `Notes` and `Mindmap` tabs, the download control, the hero artwork. Only the `Transcript` tab has data, and it lands in Story 5 Ticket 01 |
| Player transport | `bottom-navigation/default.png` | Story 4 Tickets 02–03 | — the bar is in scope whole, including the speed control |
| Current-segment caption | `bottom-navigation/subtitles.png` | Story 5 Ticket 01 | — |
| Now playing | `pages/player.png` | Story 4 Ticket 02 | the scripture-reference list, the artwork |
| Series listing | `pages/series-listing.png` | Story 6 Ticket 02 | the cover-artwork thumbnails — artwork is deferred ([epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100)) |
| Series page | `pages/series-inner.png` | Story 6 Ticket 02 | hero artwork, download, the `Scripture` / `Notes` / `Mindmap` tabs |
| Top navigation | `top-navigation/default.png`, `top-navigation/menu-opened.png` | Story 4 Ticket 01 | search (`top-navigation/search.png`) is [§3.10](docs/project/prd.md#L194), deferred; the *All chapters* destination has no model in this epic |
| Every admin screen | **none exists** | Stories 2, 3, 6 | — compose from [style-guide.md](docs/design%20referencess%20png/style-guide.md) and the token layer, the carve-out the previous story's tickets already took. `pages/chapter.png` describes nothing in this epic |

## Background to research

What the remaining work leans on that the account story did not already put in front of you. Its
ground — the monorepo, Next.js App Router, Drizzle migrations, Vitest against a real Postgres, cookie
sessions, password hashing, the transactional mail adapter — is not repeated here.

- **S3-compatible object storage and presigned URLs** — a bucket that is never publicly readable, written by the browser with a presigned `PUT` and read with a short-lived presigned `GET`. **Needed for:** Story 2 Ticket 01, Story 4 Ticket 02. **Understand:** what a presigned URL actually authorises and for how long, why the bucket's CORS policy is what makes a browser `PUT` possible at all, and what the zero-egress tier buys against the CDN we are deliberately not building. **Depth:** judge — the storage choice carries *Moderate* reversal cost in [project architecture § Key technology choices](docs/project/architecture.md#L209), and the bucket's public-access posture is a security property rather than a preference. **Source:** the Cloudflare R2 documentation on presigned URLs and CORS, or the AWS S3 documentation on the same — the API is the same shape.
- **`SELECT … FOR UPDATE SKIP LOCKED` as a job queue** — the dispatch mechanism for the whole pipeline, chosen over a broker. **Needed for:** Story 2 Ticket 02. **Understand:** how a row is claimed, what happens to a claimed job when the worker dies mid-run, and why this gives *at-least-once* rather than exactly-once delivery — which is the reason every job handler must be idempotent. **Depth:** judge — it is the correctness core of the pipeline and the reason [3.21.2.4](docs/project/prd.md#L486)'s per-step re-run is safe. **Source:** the PostgreSQL documentation on `SELECT … FOR UPDATE` and row locking; search for "SKIP LOCKED job queue Postgres" for the pattern write-ups.
- **Managed ASR with segment timestamps** — the transcription provider behind the `transcribe` adapter. **Needed for:** Story 2 Ticket 03. **Understand:** what the provider returns per segment (start, end, confidence, detected language), how it is billed per audio-hour against the ~$0.26/hr the cost table assumes, and how long a 90-minute file takes — that last number decides whether the adapter waits on a call or polls a provider-side job. **Depth:** judge — the provider is **not yet chosen**, and accuracy on ministry-specific vocabulary is named as a real risk in [§7](docs/project/prd.md#L742). **Source:** the pricing and API reference pages of the candidates — Deepgram, AssemblyAI, OpenAI's Whisper API — compared on timestamp granularity directly.
- **The Anthropic Messages API for long-context generation** — one call over a whole 90-minute transcript producing both artefacts. **Needed for:** Story 3 Tickets 01 and 03. **Understand:** how input tokens are counted and priced for an ~80k-token transcript, how to get structured output back reliably, and what "model version" and "prompt version" mean as things recorded per output ([4.17.5](docs/project/prd.md#L685)). **Depth:** judge — one call for both artefacts is a cost decision and a quality decision at once. **Source:** the Anthropic API documentation — the Messages API reference, the pricing page, and the structured-output / tool-use guide.
- **`HTMLMediaElement` in the browser** — the `<audio>` element the player is built on. **Needed for:** Story 4 Tickets 02–04, Story 5 Ticket 01. **Understand:** `currentTime`, `playbackRate`, and how often `timeupdate` actually fires — the last decides whether transcript highlighting and progress saving are driven by the event or by a timer. **Depth:** recognize. **Source:** the MDN page on HTMLMediaElement.
- **HTTP range requests** — how scrubbing works without a CDN. **Needed for:** Story 4 Ticket 02. **Understand:** that the browser asks the object store for byte ranges directly and the API is never in the audio path, and what that implies for a signed URL that expires mid-listen. **Depth:** recognize. **Source:** the MDN page on HTTP range requests.
- **Linux service supervision and a TLS-terminating reverse proxy** — how the two processes stay running and how the domain gets a certificate. **Needed for:** Story 7 Tickets 01–02. **Understand:** what "restarts on failure and starts on boot" is actually configured by, and where certificate renewal happens without anyone remembering to do it. **Depth:** recognize. **Source:** the systemd service unit documentation, and the Caddy documentation on automatic HTTPS — or certbot's, if nginx is chosen.
- **`pgBackRest`** — nightly base backup plus WAL archive to the object store. **Needed for:** Story 7 Ticket 03. **Understand:** the difference between a base backup and continuous WAL archiving, what point-in-time recovery gives you, and why a restore that has never been performed is not a backup. **Depth:** judge — this is the operational cost the self-hosted-Postgres decision bought, and the one item in the epic where being wrong is discovered by an incident. **Source:** the pgBackRest user guide.

---

## Story — Get a recording transcribed

**Delivers:** an admin uploads an audio file with a title and a date, and with no further action the
recording ends up with a timestamped transcript in the detected language, each segment attributed to
the speaker the provider heard. If any step fails, the admin sees which one, why, and can re-run just
that step. Nothing is member-visible.
**Feature:** [epic prd § In scope → 2](docs/epics/epic-core-listening/prd.md#L52). **Ticket 05 has no
feature behind it** — speaker attribution was added mid-build at the operator's instruction and
appears nowhere in the PRD; see that ticket's notes.

### Ticket 01 — Upload to object storage
**Delivers:** an admin uploads an audio file with a title and date recorded, and it appears in an admin
recordings list. The browser `PUT`s straight to object storage on a presigned URL — bytes never pass
through the application — and the API finalises the upload into a `recording` row carrying
`original_media_key`, `title`, `recorded_at`, `published_at` (null) and `description`. Size and format
are checked client-side *before* the presigned URL is requested, and re-checked server-side at
finalisation.
**References:** [epic prd § In scope → 2](docs/epics/epic-core-listening/prd.md#L52);
[3.2.1](docs/project/prd.md#L62) (Admin-only in this epic);
[epic architecture § Media store](docs/epics/epic-core-listening/architecture.md#L164);
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The spine*;
[epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255) — "Two inputs this epic needs and
nothing defines", item 2; [§6](docs/project/prd.md#L724) Security;
[4.2](docs/project/prd.md#L513);
[project architecture § Key technology choices](docs/project/architecture.md#L209) — the object-storage row
**Notes:** two things here are awkward to walk back. **The bucket's access posture** — never publicly
readable, reached only through signed URLs in both directions — is a property the rest of the epic
assumes and which is invisible from inside the application. And **the limits are settled, not open**:
200 MB ceiling, mp3 / m4a / aac / wav / flac. A 90-minute teaching fits as mp3 or m4a but **not** as
WAV or FLAC, so the upload UI states the limit and the reason up front rather than rejecting silently.
`recording` gets **no processed-media pointer** — adding one is what [§3.4](docs/project/prd.md#L88) does later.

### Ticket 02 — Job ledger and worker loop
**Delivers:** work enqueued by the API is picked up and run by a separate process. The `job` table
(`recording_id`, `step`, `status`, `attempt`, `error`, `enqueued_at`, `started_at`, `finished_at`,
`provider_meta`); a worker that claims rows with `FOR UPDATE SKIP LOCKED`, runs the handler registered
for that step, and records success or failure with the reason; a queue port the API enqueues through
without looking behind it; and the chain rule that a step enqueues its successor only on success.
Finalising an upload enqueues `transcribe`. No handler does real work yet — this ticket is the dispatch
mechanism and its failure behaviour, proven with a test handler.
**References:** [epic architecture § Worker process](docs/epics/epic-core-listening/architecture.md#L139);
[epic architecture § Job ledger (in Postgres, not a broker)](docs/epics/epic-core-listening/architecture.md#L157);
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *Pipeline state*;
[epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Pipeline step chain* and
*Queue port*; [3.21.2.1](docs/project/prd.md#L483); [3.21.2.3](docs/project/prd.md#L485);
[project architecture § Worker pool](docs/project/architecture.md#L147);
[project architecture § Key technology choices](docs/project/architecture.md#L209) — the ledger-is-the-queue row
**Notes:** the split from Ticket 03 is the point of this ticket. Dispatch, idempotency and crash
recovery are one set of questions; calling a transcription provider is another, and the old plan put
both in one ticket and called it "the largest in the plan". Claiming is **at-least-once** — a worker
that dies mid-job leaves a row that must be safely re-runnable — so every handler this epic and every
later epic writes is idempotent by contract, and that contract is set here. Worker concurrency is
pinned to 1 ([project architecture § Estimated running costs](docs/project/architecture.md#L343)).

### Ticket 03 — Transcription into timestamped segments
**Delivers:** the `transcribe` handler. It reads the original object, calls the ASR adapter, and writes
a `transcript` row plus `segment` rows carrying `start_ms`, `end_ms`, `text` and the detected language.
`provider_meta` records model, version and spend for the job. A failure records the failing step and
its reason and stops the chain there rather than proceeding on bad input.
**References:** [epic prd § In scope → 2](docs/epics/epic-core-listening/prd.md#L52);
[3.5.1](docs/project/prd.md#L112) (**narrowed — triggers on upload completing, not on processing completing**);
[3.5.2](docs/project/prd.md#L113); [3.5.7](docs/project/prd.md#L118); [3.5.8](docs/project/prd.md#L119);
[epic architecture § Worker process](docs/epics/epic-core-listening/architecture.md#L139);
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The spine*;
[4.4](docs/project/prd.md#L539);
[project architecture § Data model](docs/project/architecture.md#L171);
[project architecture § Key technology choices](docs/project/architecture.md#L209) — the managed-ASR row
**Notes:** the timestamped segment is **the atom of the whole system** — notes, highlights, mind maps,
search and Flow Tracker all resolve through `(recording_id, timestamp_ms)` later — so the shape settled
here is the most consequential schema decision left in the epic. The `Segment` type already exists in
`packages/shared`; the table matches it rather than inventing a second shape, and takes **no embedding
column**. Two things this ticket must settle that nothing upstream defines: **which ASR provider**, and
**whether the adapter waits on the call or polls a provider-side job** — the second changes what a
"running" job means in Ticket 04. Cite [3.5.1](docs/project/prd.md#L112) *and*
[epic prd § In scope → 2](docs/epics/epic-core-listening/prd.md#L52) together when planning: read alone,
[3.5.1](docs/project/prd.md#L112) says transcription waits for audio processing, and this epic deliberately
does not.

### Ticket 04 — Pipeline status and per-step re-run
**Delivers:** an admin can see which recordings are transcribing, which have finished, and which have
failed with the reason, and can re-run any single step for a recording without re-running the chain.
One query over the ledger — no log-reading.
**References:** [3.19.4](docs/project/prd.md#L432) (minus the processing column — nothing to show there yet);
[3.21.2.4](docs/project/prd.md#L486); [epic prd § In scope → 7](docs/epics/epic-core-listening/prd.md#L146);
[epic prd § Epic flows → B](docs/epics/epic-core-listening/prd.md#L210);
[epic architecture § Job ledger (in Postgres, not a broker)](docs/epics/epic-core-listening/architecture.md#L157)
**Notes:** this is the ticket that makes the story validatable — without it, "the pipeline works" is a
claim about rows nobody can see. It hangs off the admin console shell and has no design reference;
compose from the style guide.

### Ticket 05 — Speaker labels on segments
**Delivers:** a transcript records who was speaking, segment by segment. The ASR adapter asks the
provider for diarisation, the `Transcriber` port carries a speaker per segment alongside the offsets
and the text, and `segment` grows the column to hold it. **Speakers are the provider's anonymous
indices — 0, 1, 2 — not people.** Nothing names them, nothing renders them, and no screen changes;
what this ticket delivers is the data and the contract that carries it.
**References:**
[03-transcription-into-timestamped-segments.md § Out of scope](docs/epics/epic-core-listening/stories/get-a-recording-transcribed/03-transcription-into-timestamped-segments.md#L88)
— the line this ticket reverses, and the reason it is worth reading first;
[epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Segment row*, the seam
this attaches to; [epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255) — the
ASR-adapter row, whose low reversal cost is what makes this a query parameter rather than a project;
[4.4](docs/project/prd.md#L539) — the Transcript entity this widens;
[project architecture § Data model](docs/project/architecture.md#L171);
[§7](docs/project/prd.md#L742) — the spend line, because diarisation may change the per-minute rate
**Notes:** **no PRD requirement stands behind this ticket.** The word "speaker" appears nowhere in
[docs/project/prd.md](docs/project/prd.md#L1), the project architecture, the epic PRD or the epic
architecture; it was added mid-build at the operator's instruction, and Phase 3 was not revisited.
That is a deliberate exception to the rule stated in *What this plan deliberately does not include*,
recorded here rather than left to be rediscovered. If speaker labels are to survive the epic,
[4.4](docs/project/prd.md#L539) and a feature requirement should be amended to say so — otherwise the
next person to read the PRD against the schema finds a column the product never asked for.

Three things this ticket must settle. **It widens the shared contract:** `segment`'s columns are
locked to the `Segment` type in `@thp/shared` by `tests/guards/segment-shape.test.ts`, so the type,
the table and the migration change together — and that type is what the client and the API agree on,
not an internal detail of the worker. **Diarisation returns indices, not names**, so on its own the
column has no reader; turning "speaker 1" into a person is a labelling surface that this ticket does
not include and nothing else in the epic provides, and that gap is the main risk it carries. **The
rate must be confirmed before building** — [§7](docs/project/prd.md#L742) measures spend per job, and
a diarised minute that costs more than a plain one changes the cost table.

Two facts about the data. There is **no back-fill**: re-running `transcribe` replaces a transcript
wholesale, so recordings already transcribed gain speakers only when somebody re-runs them, and doing
so discards any corrections Story 5 has let an admin make. And the likely accuracy failure on this
material is **over-segmentation** — one teacher, a long single voice, occasional questions from the
room — so the ticket is only validated by reading a real diarised transcript, not by a fixture.
---

## Story — Review and publish a teaching

**Delivers:** an admin opens a queue of drafts the machine produced, reads a summary and a suggested
description, accepts, edits or regenerates them field by field, and publishes the recording — which is
the only thing that makes it visible to a member.
**Feature:** [epic prd § In scope → 3](docs/epics/epic-core-listening/prd.md#L77), plus the publish half of
[epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100)

### Ticket 01 — Draft generation: summary and description
**Delivers:** transcription completing chains into `generate_draft`, which feeds the whole transcript to
Claude in **one** call and writes **two** `review_item` rows — one `summary`, one `recording_metadata`
carrying the suggested description. Introduces `review_item (id, recording_id, kind, status, fields,
provenance, created_at, reviewed_by, reviewed_at)` with `status` in `draft | published | discarded`.
Each row records the model, model version and prompt version that produced it, and the per-field
provenance that it was AI-suggested. Nothing is member-visible.
**References:** [epic prd § In scope → 3](docs/epics/epic-core-listening/prd.md#L77);
[3.6.1](docs/project/prd.md#L127); [3.6.2](docs/project/prd.md#L128);
[4.17.1](docs/project/prd.md#L681) (**description only** — topics, tags and scripture references deferred);
[4.17.5](docs/project/prd.md#L685); [3.21.2.2](docs/project/prd.md#L484);
[4.5](docs/project/prd.md#L549);
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The review gate*;
[epic architecture § Worker process](docs/epics/epic-core-listening/architecture.md#L139);
[epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Review-gate `kind`* and
*Domain events*
**Notes:** `review_item.kind` is **the only structure in this epic built past its immediate need**, and
it is built deliberately: later artefacts — scripture references, tags, mind maps, video scripts — must
add a *value, not a table*, or the single-query Pending Reviews degrades into a union of six. Emit a
domain event on job completion; nothing subscribes yet.

### Ticket 02 — Pending Reviews queue and review form
**Delivers:** a queue — **one query over `review_item.status`** — listing everything awaiting admin
action, plus a review form reachable from the queue and from the recording page as an admin. The form
shows the draft in full alongside the recording title, date and word count, and allows per-field
accept, edit or discard. Approving writes through to the canonical entity (`summary.content`,
`recording.description`) and closes the item; discarding closes it with no replacement, and the
recording remains publishable.
**References:** [epic prd § In scope → 3](docs/epics/epic-core-listening/prd.md#L77);
[3.6.4](docs/project/prd.md#L130); [3.6.5](docs/project/prd.md#L131); [3.6.6](docs/project/prd.md#L132);
[3.6.7](docs/project/prd.md#L133); [3.6.10](docs/project/prd.md#L136);
[4.17.2](docs/project/prd.md#L682); [4.17.5](docs/project/prd.md#L685);
[3.19.2](docs/project/prd.md#L430); [3.19.3](docs/project/prd.md#L431);
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The review gate*
**Notes:** the in-app "ready for review" notification ([3.6.3](docs/project/prd.md#L129)) is deferred — the
queue is how an admin finds work in this epic. Keep the queue a single query over one column; that
property is the entire reason the previous ticket built one table with a `kind`.

### Ticket 03 — Regenerate with a steering prompt
**Delivers:** an admin discards the current draft and triggers a fresh generation pass, optionally
supplying a short prompt to steer it; the new draft returns to the queue for review.
**References:** [3.6.9](docs/project/prd.md#L135); [epic prd § In scope → 3](docs/epics/epic-core-listening/prd.md#L77);
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The review gate*;
[epic architecture § Worker process](docs/epics/epic-core-listening/architecture.md#L139)
**Notes:** regeneration re-enqueues `generate_draft` for that `kind` with the steering prompt attached —
the same handler, not a second path. The "notified when the new draft is ready" half of
[3.6.9](docs/project/prd.md#L135) is deferred with [§3.17](docs/project/prd.md#L361). Story 5 Ticket 02 calls this
same path, so it is built once, here.

### Ticket 04 — Publish and unpublish
**Delivers:** the gate itself. An admin explicitly publishes a recording, setting `published_at`;
unpublish clears it without deleting the recording or anything attached to it. Member visibility is
enforced server-side on every read path as a single condition. Includes editing a summary after publish
and returning a published summary to draft.
**References:** [epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100);
[3.2.2](docs/project/prd.md#L63); [3.2.11](docs/project/prd.md#L72); [3.6.11](docs/project/prd.md#L137);
[3.6.12](docs/project/prd.md#L138); [4.17.3](docs/project/prd.md#L683);
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The spine*;
[epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Domain events*
**Notes:** publishing without a review gate is one of three things
[epic prd § Rationale](docs/epics/epic-core-listening/prd.md#L241) names as making this epic throwaway. **Write the
visibility condition once, in one place** — every read path added in the next three stories inherits it,
and a rule re-implemented per route is a rule that will be forgotten on the fourth one. Emit a domain
event on publish; nothing subscribes yet. This story validates from the admin side only: there is no
member surface until the next story, so the check is that the API grants and refuses correctly.

---

## Story — Listen to a teaching

**Delivers:** a member signs in, browses published teachings newest first, opens one, reads its summary,
presses play, scrubs, and sets a speed that sticks — then closes it mid-way on a phone and resumes at
the same second on a laptop the next day.
**Feature:** [epic prd § In scope → 5](docs/epics/epic-core-listening/prd.md#L117), plus the browsing half of
[epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100)

### Ticket 01 — Member library and recording page
**Delivers:** a signed-in member sees published teachings, newest by date recorded first, including
those with no series, and can open one to read its title, date, published summary and description. The
top navigation and the member landing surface arrive with it. No audio yet.
**References:** [epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100);
[3.3.1](docs/project/prd.md#L78); [3.3.9](docs/project/prd.md#L86); [3.6.7](docs/project/prd.md#L133);
[epic prd § Epic flows → C](docs/epics/epic-core-listening/prd.md#L210);
[epic architecture § Next.js application — client half](docs/epics/epic-core-listening/architecture.md#L109);
`pages/dashboard.png`, `pages/recording.png`, `top-navigation/default.png`,
`top-navigation/menu-opened.png` — read alongside the third column of **Design references** above
**Notes:** the references carry far more than this epic ships — chapters, notes, mind maps, scripture,
downloads and search all appear in them and none exist. This is the ticket where that gap is settled
once: what the chrome looks like with those destinations absent, and how a tab strip that will grow to
five tabs looks holding one. Getting it wrong is a rewrite of every member screen after it.

### Ticket 02 — Streaming playback and scrubbing
**Delivers:** a member presses play and hears the recording, and can scrub to any position. The API
mints a short-lived signed `GET` **after** checking the recording is published and the caller is
authenticated; range requests are served by the object store directly, which is what makes scrubbing
work without a CDN. The player transport bar arrives with it.
**References:** [epic prd § In scope → 5](docs/epics/epic-core-listening/prd.md#L117);
[3.2.3](docs/project/prd.md#L64); [3.2.9](docs/project/prd.md#L70);
[epic architecture § Media store](docs/epics/epic-core-listening/architecture.md#L164);
[epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Second media pointer*;
[§6](docs/project/prd.md#L724) Security;
`bottom-navigation/default.png`, `pages/player.png`
**Notes:** members hear the **raw upload** — [3.4.1](docs/project/prd.md#L94)'s "processed before available for
playback" deliberately does not hold in this epic
([epic architecture § Divergence from the north star](docs/epics/epic-core-listening/architecture.md#L294)). Signed-URL
minting is the exact place [§3.4](docs/project/prd.md#L88) will later prefer a processed rendition and fall back
to the original, so keep it **one function**. Decide what happens when a signed URL expires mid-listen:
a 90-minute teaching outlasts any sensible URL lifetime.

### Ticket 03 — Playback speed that persists
**Delivers:** speed control across all six steps — 0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x — with the chosen
speed persisting across recordings for that user, held on `user.preferred_playback_speed`.
**References:** [3.2.4](docs/project/prd.md#L65); [epic prd § In scope → 5](docs/epics/epic-core-listening/prd.md#L117);
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *Accounts*;
`bottom-navigation/default.png` — the speed control at the right of the bar

### Ticket 04 — Resume position across devices
**Delivers:** the marquee behaviour. A member closes a teaching mid-way on a phone and resumes at the
same second on a laptop the next day. `playback_progress (user_id, recording_id, position_ms,
updated_at)`, primary-keyed on the pair, last-write-wins on the furthest position; state is held
client-side and pushed to a single-position endpoint.
**References:** [3.2.5](docs/project/prd.md#L66); [epic prd § In scope → 5](docs/epics/epic-core-listening/prd.md#L117);
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *Member-owned state*;
[epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Client-owned playback
state*; [epic prd § Epic flows → C](docs/epics/epic-core-listening/prd.md#L210);
`pages/dashboard.png` — the *Resume recording* card
**Notes:** client-owned-and-pushed is the shape that makes offline ([§3.18](docs/project/prd.md#L391)) an addition
rather than a rewrite — it is [epic prd § Rationale](docs/epics/epic-core-listening/prd.md#L241)'s stated check that
this cut is not a dead end, so the endpoint takes a position, not a stream of events. Listening history
and the completed marker are **out**; resume position is the only playback state this epic keeps.

---

## Story — Follow the transcript while it plays

**Delivers:** a member reads along as the teaching plays, with the current segment highlighted, and taps
any line to jump the audio there — and when a name comes out wrong, an admin fixes the text and is
offered a regenerated summary.
**Feature:** [epic prd § In scope → 6](docs/epics/epic-core-listening/prd.md#L132)

### Ticket 01 — Follow-along transcript
**Delivers:** the transcript readable on the recording page, highlighting the currently spoken segment
as playback moves, and seeking the audio when a member selects any point in it. The first place a
member touches the segment model, and the proof it works end to end.
**References:** [epic prd § In scope → 6](docs/epics/epic-core-listening/prd.md#L132);
[3.5.3](docs/project/prd.md#L114); [3.5.4](docs/project/prd.md#L115);
[epic prd § Epic flows → C](docs/epics/epic-core-listening/prd.md#L210);
[epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) —
*`(recording_id, timestamp_ms)` offset*;
`bottom-navigation/subtitles.png`, the `Transcript` tab in `pages/recording.png`
**Notes:** the `(recording_id, timestamp_ms)` pair resolved here is what later makes "open at the
moment" one behaviour across notes, highlights, mind maps, search and Flow Tracker — so resolve it in
one place rather than inline in the player.

### Ticket 02 — Transcript correction and the regeneration offer
**Delivers:** an admin corrects segment text on a published recording — recording who corrected it and
when — and is offered regeneration of the summary, which routes through the previous story's
regeneration path. Member progress and the recording's publication state are untouched throughout.
**References:** [epic prd § In scope → 6](docs/epics/epic-core-listening/prd.md#L132);
[3.5.5](docs/project/prd.md#L116) (**Admin-only in this epic** — the Contributor half is deferred);
[3.5.6](docs/project/prd.md#L117) (**narrowed to the summary** — the other derived artefacts do not exist yet);
[epic prd § Epic flows → D](docs/epics/epic-core-listening/prd.md#L210);
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The spine*, the
corrected-by fields on `segment`

---

## Story — Organise teachings into series

**Delivers:** an admin groups recordings into named series and moves them between series; a member who
fell out of a series opens it, sees every teaching in it in order with their own progress on each, and
picks up where they stopped.
**Feature:** the series half of [epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100)

### Ticket 01 — Series management for admins
**Delivers:** an admin creates and renames named series carrying a title and description, assigns a
recording to at most one, and moves a recording between series without losing its metadata or member
progress — managed from a dashboard panel.
**References:** [epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100);
[3.3.2](docs/project/prd.md#L79);
[3.3.6](docs/project/prd.md#L83) (**create / rename / move only** — reorder, merge and the Contributor half
deferred); [3.19.5](docs/project/prd.md#L433) (minus artwork upload);
[4.3](docs/project/prd.md#L528);
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The spine*
**Notes:** "without losing member progress" is the acceptance criterion with teeth — progress is keyed
on `(user_id, recording_id)` and must be untouched by a series move, which is worth asserting in a test
rather than assuming from the schema.

### Ticket 02 — The member series view
**Delivers:** the member-facing half. A series page listing its recordings chronologically with the
member's progress shown per recording, and its title, description, date range and count; series
surfaced from the library so a member who fell out of one can find their way back.
**References:** [3.3.4](docs/project/prd.md#L81); [3.3.5](docs/project/prd.md#L82) (minus cover artwork);
[epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100);
[epic prd § Epic flows → C](docs/epics/epic-core-listening/prd.md#L210);
`pages/series-listing.png`, `pages/series-inner.png`
**Notes:** depends on the player story — the per-recording progress shown here is the same
`playback_progress` row the player writes, which is why series lands after the player rather than next
to the library. Both references show cover artwork, which this epic does not ship; the row layout has
to hold without it.

---

## Story — Run it in production

**Delivers:** the epic runs on the host it will live on, at its real domain, over TLS, and survives a
reboot — with a database backup that has been restored at least once. The only story that ships no
member-visible behaviour.
**Feature:** [epic prd § In scope → 8](docs/epics/epic-core-listening/prd.md#L161), under the deployment topology in
[project architecture § Estimated running costs](docs/project/architecture.md#L343)

### Ticket 01 — The host, Postgres and TLS
**Delivers:** a provisioned VPS reachable at the real domain over HTTPS. PostgreSQL 17 with the pgvector
package installed and the extension still **unenabled**; a reverse proxy terminating TLS with automatic
certificate renewal; secrets held on the box rather than in the repository. Nothing of the application
is deployed yet — this ticket ends with the platform answering.
**References:** [project architecture § Estimated running costs](docs/project/architecture.md#L343) — the deployment
topology paragraph; [epic architecture § Overview](docs/epics/epic-core-listening/architecture.md#L7);
[epic architecture § Primary datastore](docs/epics/epic-core-listening/architecture.md#L177);
[01-project-skeleton.md § Assumptions to confirm](docs/epics/epic-core-listening/stories/get-a-person-in/01-project-skeleton.md#L99)
— item 1, settled to this host; [§6](docs/project/prd.md#L724) Security
**Notes:** pgvector must be **installed and available but not enabled** — the single-datastore decision
is marked *expensive to reverse* in
[project architecture § Key technology choices](docs/project/architecture.md#L209) precisely because vectors and ACL
data share a database, and this is where that stays true. No CDN and no broker are added here: the box
runs exactly the two processes the epic already has.

### Ticket 02 — App and worker as supervised services
**Delivers:** the Next.js app and the worker running as supervised services that start on boot and
restart on failure, with worker concurrency pinned to 1; the migration command applied against
production by the same command used in development; and `NEXT_PUBLIC_API_ORIGIN` moved from
`http://localhost:3000` to the real origin. A reboot brings everything back with no manual step.
**References:** [project architecture § Estimated running costs](docs/project/architecture.md#L343) — where worker
concurrency 1 comes from; [epic architecture § Worker process](docs/epics/epic-core-listening/architecture.md#L139);
[epic architecture § Next.js application — API half](docs/epics/epic-core-listening/architecture.md#L123);
[01-project-skeleton.md § Assumptions to confirm](docs/epics/epic-core-listening/stories/get-a-person-in/01-project-skeleton.md#L99)
— item 2, the API origin; [5.2.2](docs/project/prd.md#L706)
**Notes:** `NEXT_PUBLIC_API_ORIGIN` changing to one real value is the whole payoff of the
absolute-origin rule held since the first ticket of the epic. If anything in the client turns out to
assume same-host, this is where it surfaces — and fixing it here rather than in the Capacitor epic is
the cheap version.

### Ticket 03 — Backups with a proven restore
**Delivers:** `pgBackRest` archiving a nightly base backup plus WAL to the object store, **and a restore
performed onto a scratch database** with the result verified. An unverified backup is not a backup;
this is the ticket that proves it rather than the incident that disproves it.
**References:** [epic architecture § Primary datastore](docs/epics/epic-core-listening/architecture.md#L177);
[project architecture § Key technology choices](docs/project/architecture.md#L209) — the single-datastore row, where
backups are named as the cost of self-hosting;
[project architecture § Estimated running costs](docs/project/architecture.md#L343) — the *Database backups* row;
[§6](docs/project/prd.md#L724) — *Storage*, "nothing expires"
**Notes:** the restore drill is part of the acceptance criteria, not a follow-up. The backup target is
the same object store that holds the media, which is worth checking against the media bucket's access
posture — they should not be the same bucket under the same credentials.

---

## What this plan deliberately does not include

Cross-checked against [epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341)
and [epic prd § Still remaining after this epic](docs/epics/epic-core-listening/prd.md#L171). No ticket above builds
any of these, and none should be added mid-build without going back to Phase 3:

- Any audio processing step, sound profile, FFmpeg or processed rendition — the whole of
  [§3.4](docs/project/prd.md#L88).
- A message broker, a CDN, pgvector enabled, embeddings, a service worker, a manifest, an offline cache,
  or a Capacitor shell.
- The Contributor role — upload, transcript correction, series management and dashboard gating are
  Admin-only for now, by design.
- Notifications, listening history, the completed marker, avatars, series artwork, series reorder and
  merge, tags, scripture references, mind maps, chapters, notes, search, downloads, video.
- A generic plugin framework for pipeline steps, or any "reviewable entity" abstraction beyond
  `review_item.kind`.
- Any fifth entry on the unauthenticated-route allowlist.

## Reference spot-check

Every citation above was resolved by locating the line with `grep -n`, not guessed. Following a sample:

| Checked | Resolves to | Verdict |
| :---- | :---- | :---- |
| [3.5.2](docs/project/prd.md#L113) (Story 2 Ticket 03) | "The transcript is segmented and timestamped…" | correct |
| [3.21.2.4](docs/project/prd.md#L486) (Story 2 Ticket 04) | re-running an individual step without re-running the pipeline | correct |
| [4.17.5](docs/project/prd.md#L685) (Story 3 Ticket 01) | the per-field AI-suggested / admin-changed provenance requirement | correct |
| [3.6.12](docs/project/prd.md#L138) (Story 3 Ticket 04) | returning a published summary to draft | correct |
| [3.2.4](docs/project/prd.md#L65) (Story 4 Ticket 03) | "…0.5x, 0.75x, 1x, 1.25x, 1.5x and 2x, and the chosen speed persists across recordings" | correct — confirms all six steps |
| [3.3.5](docs/project/prd.md#L82) (Story 6 Ticket 02) | series title, description, date range and count | correct — cover artwork is the part this epic omits |
| [epic prd § In scope → 5](docs/epics/epic-core-listening/prd.md#L117) (Story 4) | `### 5. The player` | correct |
| [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) | the `## Data model (epic)` heading | correct; sub-parts share the heading anchor and are named in the link text |
| [project architecture § Estimated running costs](docs/project/architecture.md#L343) (Story 7) | the deployment-topology paragraph and cost table | correct — worker concurrency 1 is stated there |

**One trap worth naming rather than leaving to be discovered mid-build.**
[3.5.1](docs/project/prd.md#L112) reads "once audio processing (3.4) completes", and Story 2 Ticket 03 triggers on
**upload** completing instead. That is
[epic prd § In scope → 2](docs/epics/epic-core-listening/prd.md#L52)'s single deliberate narrowing, not a
mis-reference — but a ticket-planning session that read [3.5.1](docs/project/prd.md#L112) alone would get it
wrong, which is why that ticket cites both.

---

## Summary

The epic's running record of what the system now does. Four subsections accumulate, one story at a
time; *Features still remaining* is rewritten in place each time, because it states current scope
rather than history.

### What was created

- **Get a person in** — an operator can invite somebody, they can accept and sign in, and an admin
  can end or restore their access from a console. Delivered before this Summary existed; its record
  is [Where this picks up](docs/epics/epic-core-listening/implementation-plan.md#L9) and its five
  ticket docs in
  [stories/get-a-person-in/](docs/epics/epic-core-listening/stories/get-a-person-in/), and it has not
  been validated through this phase. Its plan entry is **not** in the working tree — the
  `implementation-plan-old.md` that line 14 cites was deleted in `e5d6ab1`; it is recoverable with
  `git show ae3d1b3:docs/epics/epic-core-listening/implementation-plan-old.md`.
- **Get a recording transcribed** — an admin uploads an audio file with a title and a date and does
  nothing else: the bytes go straight from the browser to object storage, a job appears in the
  ledger, a separate worker process claims it, and the recording ends up with a timestamped
  transcript whose segments carry the provider's anonymous speaker index. `/admin/pipeline` shows
  every recording's steps, names the reason a step failed, and re-runs any single step on a press.
  Nothing is member-visible.

### Architectural decisions

- **The ledger is the queue.** `job` rows claimed with `FOR UPDATE SKIP LOCKED`, no broker — which
  makes enqueue transactional with the write that caused it, and makes
  [3.19.4](docs/project/prd.md#L432)'s dashboard one indexed query rather than log-reading. The price
  is at-least-once delivery, so **every handler is idempotent by contract**, this epic and every
  later one. (Get a recording transcribed, Ticket 02)
- **A handler returns provider metadata rather than `void`.** Failure is still a throw and still the
  only way to fail; success carries the evidence — model, version, billed duration, cost, request id
  — into `job.provider_meta`, which is how [§7](docs/project/prd.md#L742)'s spend is measured rather
  than estimated. (Ticket 02, widened in Ticket 03)
- **`@thp/db` grew an `Executor` and `withTransaction`** so `enqueueJob` is the same function whether
  the API's adapter calls it alone, the chain rule calls it inside the transaction marking a step
  succeeded, or finalising an upload calls it inside the transaction writing the recording. A second
  enqueue path would be a second idea of what `attempt` means. (Ticket 02)
- **Recovery is a startup sweep plus a human button — nothing retries on its own.** No backoff, no
  dead-letter. The sweep reclaims what a dead worker left `running`; everything else waits for
  [3.21.2.4](docs/project/prd.md#L486)'s re-run. This is why the sweep assumes a **single worker
  process**, and why deployment pins concurrency to 1. (Tickets 02 and 04–05)
- **The provider is handed a location, never bytes.** The worker mints a two-hour signed `GET` and
  the ASR provider fetches the object itself — the same boundary the presigned `PUT` holds inbound.
  The consequence is that **a provider can only transcribe from a bucket it can reach over the
  internet**, which local MinIO is not. (Ticket 03)
- **English is pinned, not detected.** The monolingual model is the more accurate one and the one the
  cost table is built on. `transcript.language` is still written and reads `en`. Diverges from
  [3.5.7](docs/project/prd.md#L118) — see below. (Ticket 03)
- **Low confidence writes the transcript and then fails the job.** [3.5.8](docs/project/prd.md#L119)'s
  flag is a failed ledger row, so the escape hatch is re-running `generate_draft` on a transcript a
  human has read and judged usable. Two acceptance criteria conflicted here and the resolution is
  forced: the transcript and its segments are atomic together, the job's outcome is a separate
  transaction. (Ticket 03)
- **The status read is not behind the queue port.** `packages/db/src/pipeline.ts` is called directly
  by a web service module, because a broker swap should leave the dashboard query untouched. The
  re-run action still goes through the port's `enqueue`. (Ticket 04–05)
- **Re-running `transcribe` re-runs `generate_draft` behind it; the chain rule stands on a re-run.**
  A fresh transcript makes an existing draft wrong. The cost is ASR spent again and any transcript
  correction discarded, so that step alone takes a confirming press. (Ticket 04–05)
- **`segment.speaker` is the provider's anonymous index, nullable.** Diarisation is requested
  unconditionally; nothing names, renders or reads it. No PRD requirement stands behind it — see
  below. (Ticket 04–05)

### Divergences from the project docs

- **The transcript's language is pinned to English, not detected.** Diverges from
  [3.5.7](docs/project/prd.md#L118) and the *Language — Auto-detected* row of
  [4.4](docs/project/prd.md#L539) — **deliberate**: the monolingual model is more accurate and is what
  [project architecture § Estimated running costs](docs/project/architecture.md#L343) prices. Back in
  line by amending 3.5.7 and 4.4 to say English-only for now, or by moving to a multilingual model and
  re-pricing. The story's own **Delivers** line still reads "in the detected language" and is
  currently wrong.
- **`segment` carries a `speaker` column no requirement asks for.** The word "speaker" appears
  nowhere in [docs/project/prd.md](docs/project/prd.md#L1), the project architecture, the epic PRD or
  the epic architecture — **deliberate**, added mid-build at the operator's instruction without
  revisiting Phase 3. Back in line by amending [4.4](docs/project/prd.md#L539) and adding a feature
  requirement under [3.5](docs/project/prd.md#L106), or by dropping the column.
- **Transcription triggers on upload completing, not on audio processing completing.** Narrows
  [3.5.1](docs/project/prd.md#L112) — **deliberate**, and the single narrowing
  [epic prd § In scope → 2](docs/epics/epic-core-listening/prd.md#L52) already declares. Back in line
  when [§3.4](docs/project/prd.md#L88) ships and `process_audio` is inserted ahead of `transcribe` in
  `PIPELINE_STEPS`.

### Features implemented

- **[partial]** [3.1 Accounts & access](docs/project/prd.md#L31) — works: invitation, acceptance,
  sign-in, sessions, the policy module, deactivate and reactivate; missing: the Contributor role, and
  the validation of that story through this phase. Tracked in
  [stories/get-a-person-in/](docs/epics/epic-core-listening/stories/get-a-person-in/).
- **[partial]** [3.5 Transcription](docs/project/prd.md#L106) — works: every upload is transcribed
  automatically into timestamped segments ([3.5.2](docs/project/prd.md#L113)), a confidence failure
  flags rather than proceeds ([3.5.8](docs/project/prd.md#L119)), and the transcript records a
  language column; missing: language *detection* ([3.5.7](docs/project/prd.md#L118), pinned to
  English above), and every reader — the member transcript view and seek-to-segment
  ([3.5.3](docs/project/prd.md#L114), [3.5.4](docs/project/prd.md#L115)), admin correction
  ([3.5.5](docs/project/prd.md#L116)) and the regeneration offer
  ([3.5.6](docs/project/prd.md#L117)). Tracked in
  [Story — Follow the transcript while it plays](docs/epics/epic-core-listening/implementation-plan.md#L386).
- **[partial]** [3.19 Admin dashboard](docs/project/prd.md#L423) — works: the console shell, the
  accounts and recordings panels, and `/admin/pipeline`'s per-step status, failure reason and
  per-step re-run ([3.19.4](docs/project/prd.md#L432), [3.21.2.4](docs/project/prd.md#L486)); missing:
  the processing column (nothing to show — [§3.4](docs/project/prd.md#L88) is deferred whole), Pending
  Reviews ([3.19.2](docs/project/prd.md#L430)) and per-role gating
  ([3.19.1](docs/project/prd.md#L429)). Tracked in
  [Story — Review and publish a teaching](docs/epics/epic-core-listening/implementation-plan.md#L245).
- **[partial]** [3.2 Audio recordings & playback](docs/project/prd.md#L56) — works: upload with title
  and date recorded, straight to object storage, and an admin recordings list; missing: everything
  about playback, and any member-visible recording at all. Tracked in
  [Story — Listen to a teaching](docs/epics/epic-core-listening/implementation-plan.md#L321).
- **[partial]** [3.21 Content pipeline](docs/project/prd.md#L459) — works: the step chain, the ledger,
  a step halting the chain on failure ([3.21.2.3](docs/project/prd.md#L485)) and per-step re-run
  ([3.21.2.4](docs/project/prd.md#L486)); missing: the `generate_draft` handler behind the chain's
  second step, which is still a stub writing `{ "stub": true }`. Tracked in
  [Story — Review and publish a teaching](docs/epics/epic-core-listening/implementation-plan.md#L245).

### Features still remaining

What [docs/project/prd.md](docs/project/prd.md#L1) describes and the project does not have, including
the missing halves above.

- The Contributor role, across upload, transcript correction, series management and dashboard gating
  ([3.1](docs/project/prd.md#L31)).
- Streaming playback, scrubbing, speed and resume ([3.2](docs/project/prd.md#L56)).
- Series and content organisation ([3.3](docs/project/prd.md#L74)).
- Audio processing and quality, whole — no sound profile, no FFmpeg, no processed rendition
  ([3.4](docs/project/prd.md#L88)).
- Language detection, the member transcript view, seek-to-segment, correction and the regeneration
  offer ([3.5](docs/project/prd.md#L106)).
- AI summaries and descriptions, the review gate and publish ([3.6](docs/project/prd.md#L121)).
- Scripture references ([3.7](docs/project/prd.md#L140)), mind maps
  ([3.8](docs/project/prd.md#L154)), cross-referencing ([3.9](docs/project/prd.md#L179)), semantic
  search ([3.10](docs/project/prd.md#L194)), AI video ([3.11](docs/project/prd.md#L212)).
- Timestamp notes ([3.12](docs/project/prd.md#L257)), questionnaires
  ([3.13](docs/project/prd.md#L281)), flow tracker ([3.14](docs/project/prd.md#L300)), highlights
  ([3.15](docs/project/prd.md#L318)), SOS signal ([3.16](docs/project/prd.md#L334)).
- Notifications ([3.17](docs/project/prd.md#L361)), offline support and downloads
  ([3.18](docs/project/prd.md#L391)), external distribution ([3.20](docs/project/prd.md#L442)).
- Pending Reviews and per-role gating on the dashboard ([3.19](docs/project/prd.md#L423)).
- Back-catalogue bulk processing ([3.21](docs/project/prd.md#L459)).
- Running in production at all — host, TLS, supervised services, backups
  ([§5](docs/project/prd.md#L687), [§6](docs/project/prd.md#L724)).
