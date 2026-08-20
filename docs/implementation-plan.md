# Teaching Hub — Slice 01 implementation plan: core-listening

> Phase 5 artefact. The build order for [slice-prd.md](slice-prd.md#L1) under
> [slice-architecture.md](slice-architecture.md#L1). Each step below is one reviewable unit of
> behaviour — testable on its own, describable in a sentence, and small enough that its whole diff
> fits in your head. Phases 6–8 walk this list one step at a time.

## The arc

Five movements, in dependency order.

1. **Get a person in** (steps 1–5). Nothing in this product is reachable without an authenticated
   session and a server-side role check, so that comes first — skeleton, sessions, invitations,
   account lifecycle, and the admin console that hosts everything after it.
2. **Get a recording in and through the machine** (steps 6–9). Upload straight to object storage,
   a job ledger the dashboard can read, transcription into timestamped segments, then one Claude
   call producing a draft summary and description.
3. **Put a human in front of the machine** (steps 10–12). The review gate — the structure every
   later AI artefact passes through — and the publish decision that is the only route to member
   visibility.
4. **Give the member what they came for** (steps 13–20). Library, player, resume-anywhere,
   follow-along transcript, correction, series.
5. **Put it where people can reach it** (step 21). The host provisioned, both processes supervised,
   TLS, migrations run against production, and backups with a proven restore. The only movement that
   ships no behaviour — and the only one whose position in the order is arguable, for the reasons in
   the step itself.

Steps 1–12 are admin-and-machine only; **no member can see anything until step 12**. That is
deliberate — the publish gate is what makes member visibility a single, testable condition rather
than a rule sprinkled across read paths.

## Standing constraints

These apply to every step and are not restated per step. A step that breaks one is not done.

- **Responsive from one codebase.** Every screen works on phone, tablet and desktop — the
  responsive row of [§5.1](prd.md#L689), per
  [slice-prd.md § In scope → 8](slice-prd.md#L161). No step ships a desktop-only screen. There is no
  separate "make it responsive" step, because there is no point at which it is acceptable not to be.
- **The client holds no authorisation decision.** It hides what a Member cannot do; the API is what
  refuses it ([3.1.5](prd.md#L47),
  [slice-architecture.md § Next.js application — client half](slice-architecture.md#L109)).
- **Every `/api/v1` route requires a session**, with no exceptions
  ([3.1.2](prd.md#L44), [slice-architecture.md § Extension points](slice-architecture.md#L312)).
- **The original upload is never overwritten or deleted** — the one non-negotiable
  ([3.4.9](prd.md#L102), [slice-architecture.md § Media store](slice-architecture.md#L164)).
- **Nothing publishes automatically** ([4.17.3](prd.md#L683)).
- **Correlation id spans API request → job → provider call**, and every gate transition is logged
  with actor, action, target and timestamp
  ([slice-architecture.md § Key choices](slice-architecture.md#L244)).
- **Do not build what is deferred.** Before adding infrastructure, check
  [slice-architecture.md § Deliberately deferred](slice-architecture.md#L330) — no broker, no CDN,
  no pgvector, no service worker, no Capacitor, no Contributor role, no audio processing.

---

## Movement 1 — Get a person in

### Step 1 — Project skeleton and the `/api/v1` boundary
**Delivers:** the repository runs. A TypeScript monorepo with shared domain types, a Next.js App
Router app, a self-hosted Postgres with migrations applied by command, and a versioned `/api/v1` route
handler with a consistent JSON error envelope and a correlation id on every request and log line. A
health route responds; nothing else exists yet.
**References:** [slice-architecture.md § Overview](slice-architecture.md#L7);
[slice-architecture.md § Next.js application — API half](slice-architecture.md#L123);
[slice-architecture.md § Primary datastore](slice-architecture.md#L177);
[slice-architecture.md § Key choices](slice-architecture.md#L244);
[architecture.md § Key technology choices](architecture.md#L209);
[5.2.2](prd.md#L706)
**Notes:** one decision here is hard to walk back — the client must call an absolute API origin over
HTTP with no server-module imports and no database access. That boundary is what makes the Capacitor
build later the same client against the same contract, and it is far cheaper to hold from commit one
than to recover. Postgres still has to be an instance where pgvector is *available* even though it is
not enabled ([slice-architecture.md § Primary datastore](slice-architecture.md#L177)), but
self-hosting turned that from a provider-selection gamble into a package we install, so it is no
longer the second hard-to-reverse choice it used to be.

### Step 2 — Sessions and server-side authorisation
**Delivers:** a person can sign in, and can be refused. `user` with `email`, `password_hash`,
`display_name`, `role` (`admin | member` — **`contributor` deliberately absent from the enum**);
password hashing; an HTTP-only cookie session; sign-in and sign-out; a seeded first admin; and a
single policy module where `(actor, action, resource)` is evaluated, applied to every `/api/v1`
route so unauthenticated requests are refused by construction rather than by review.
**References:** [slice-prd.md § In scope → 1](slice-prd.md#L35);
[3.1.1](prd.md#L43); [3.1.2](prd.md#L44); [3.1.5](prd.md#L47);
[slice-architecture.md § Data model (slice) → Accounts](slice-architecture.md#L193);
[slice-architecture.md § Extension points → Role enum + policy module](slice-architecture.md#L312);
[architecture.md § Cross-cutting concerns](architecture.md#L271)
**Notes:** the single evaluation point is one of the three structures
[slice-prd.md § Rationale](slice-prd.md#L241) names as making this slice throwaway if skipped.
Contributor arriving later is one enum value plus four widened cases *only if* every check goes
through this module.

### Step 3 — Invitations: issue, accept, revoke, resend
**Delivers:** an admin invites an email with a role; the invitee receives a mail, sets a password
and lands signed in. Revoke and resend work before acceptance, resend issuing a fresh token and
revoking the old one. Includes the transactional email adapter.
**References:** [3.1.3](prd.md#L45); [3.1.4](prd.md#L46);
[slice-prd.md § Slice flows → A](slice-prd.md#L210);
[slice-architecture.md § Data model (slice) → Accounts](slice-architecture.md#L193);
[slice-architecture.md § Key choices](slice-architecture.md#L244) — "Two inputs this slice needs
and nothing defines", item 1
**Notes:** [3.1.4](prd.md#L46) says only "a fixed window". The settled value is **7 days**; tokens
are stored hashed.

### Step 4 — Account lifecycle: reset, deactivation, last-admin guard, profile
**Delivers:** a user can recover a forgotten password by email without admin involvement; an admin
can deactivate an account, after which it cannot sign in but its authored content is retained; the
system refuses to remove or demote the last remaining admin; a user has a display name.
**References:** [3.1.6](prd.md#L48); [3.1.7](prd.md#L49); [3.1.11](prd.md#L53);
[3.1.12](prd.md#L54) (display name only — avatar deferred);
[slice-prd.md § In scope → 1](slice-prd.md#L35)
**Notes:** the last-admin invariant is enforced in the API, not the interface
([slice-architecture.md § Next.js application — API half](slice-architecture.md#L123)) — it must
hold against a direct request, not just a greyed-out button.

### Step 5 — Admin console shell and user management
**Delivers:** an Admin-only console at a stable route, refused server-side to Members, with its
first panel: the member list, pending invitations, role assignment and deactivation — the UI over
steps 3 and 4. One flat operator surface; the shell is where every later panel hangs.
**References:** [slice-prd.md § In scope → 7](slice-prd.md#L146);
[3.19.9](prd.md#L437); [3.19.1](prd.md#L429) (flat for now — nothing to gate until Contributor
exists); [slice-prd.md § Slice flows → A](slice-prd.md#L210)

---

## Movement 2 — Get a recording in and through the machine

### Step 6 — Recording upload to object storage
**Delivers:** an admin uploads an audio file with a title and date recorded, and it appears in an
admin recordings list. The browser PUTs straight to object storage on a presigned URL — bytes never
pass through the application — and the API finalises the upload into a `recording` row carrying
`original_media_key`, `title`, `recorded_at`, `published_at` (null) and `description`. Size and
format are checked client-side *before* the presigned PUT is requested, and re-checked server-side
at finalisation.
**References:** [slice-prd.md § In scope → 2](slice-prd.md#L52);
[3.2.1](prd.md#L62) (Admin-only in this slice);
[slice-architecture.md § Media store](slice-architecture.md#L164);
[slice-architecture.md § Data model (slice) → The spine](slice-architecture.md#L193);
[slice-architecture.md § Key choices](slice-architecture.md#L244) — "Two inputs", item 2;
[§6](prd.md#L724) Security
**Notes:** **200 MB ceiling; mp3, m4a/aac, wav, flac.** The upload UI states the limit and the reason
up front rather than rejecting silently — a 90-minute teaching fits as mp3/m4a but not as WAV or
FLAC. `Recording` gets **no processed-media pointer**; adding one is what [§3.4](prd.md#L88) does
later ([slice-architecture.md § Extension points](slice-architecture.md#L312)).

### Step 7 — Job ledger, worker process and transcription
**Delivers:** finalising an upload produces timestamped segments unattended. A `job` table polled
with `FOR UPDATE SKIP LOCKED` by a separate worker process; a `transcribe` handler that reads the
original object, calls the ASR adapter, and writes `transcript` + `segment` rows with `start_ms`,
`end_ms`, `text` and the detected language. A failure records the failing step and reason and stops
the chain there; `provider_meta` records model, version and spend per job.
**References:** [slice-prd.md § In scope → 2](slice-prd.md#L52);
[3.5.1](prd.md#L112) (narrowed — triggers on upload completing, not on processing);
[3.5.2](prd.md#L113); [3.5.7](prd.md#L118); [3.5.8](prd.md#L119);
[3.21.2.1](prd.md#L483); [3.21.2.3](prd.md#L485);
[slice-architecture.md § Worker process](slice-architecture.md#L139);
[slice-architecture.md § Job ledger (in Postgres, not a broker)](slice-architecture.md#L157);
[slice-architecture.md § Data model (slice) → Pipeline state](slice-architecture.md#L193);
[architecture.md § Worker pool](architecture.md#L147)
**Notes:** the largest step in the plan, and the one where the timestamped segment — the atom of the
whole system ([architecture.md § Data model](architecture.md#L171)) — gets its shape. The API
enqueues through a **queue port** it does not look behind, so a broker can drop in later without
touching the ledger or the dashboard. Jobs are idempotent and individually re-runnable, which step 8
depends on.

### Step 8 — Pipeline status panel with per-step re-run
**Delivers:** an admin can see which recordings are transcribing, generating or failed, with the
failure reason, and can re-run any single step for a recording without re-running the chain. One
query over the ledger — no log-reading.
**References:** [3.19.4](prd.md#L432) (minus the processing column — nothing to show there yet);
[3.21.2.4](prd.md#L486); [slice-prd.md § In scope → 7](slice-prd.md#L146);
[slice-architecture.md § Job ledger (in Postgres, not a broker)](slice-architecture.md#L157)

### Step 9 — Draft generation: summary and description
**Delivers:** transcription completing chains into `generate_draft`, which feeds the whole
transcript to Claude in **one** call and writes **two** `review_item` rows — one `summary`, one
`recording_metadata` carrying the suggested description. Each records the model, model version and
prompt version that produced it, and the per-field provenance that it was AI-suggested. Introduces
the `review_item` table: `(id, recording_id, kind, status, fields, provenance, created_at,
reviewed_by, reviewed_at)`, with `status` in `draft | published | discarded`. Nothing is
member-visible.
**References:** [slice-prd.md § In scope → 3](slice-prd.md#L77);
[3.6.1](prd.md#L127); [3.6.2](prd.md#L128); [4.17.1](prd.md#L681) (description only — topics,
tags and scripture references deferred); [4.17.5](prd.md#L685); [3.21.2.2](prd.md#L484);
[slice-architecture.md § Data model (slice) → The review gate](slice-architecture.md#L193);
[slice-architecture.md § Worker process](slice-architecture.md#L139);
[architecture.md § Cross-cutting concerns](architecture.md#L271)
**Notes:** the `kind` column is the only thing in this slice built past its immediate need, and it is
built deliberately — later artefacts must add a **value, not a table**, or the single-query Pending
Reviews degrades into a union of six. Emit a domain event on job completion; nothing subscribes yet
([slice-architecture.md § Extension points](slice-architecture.md#L312)).

---

## Movement 3 — Put a human in front of the machine

### Step 10 — Pending Reviews: review, edit, approve, discard
**Delivers:** a queue — **one query over `review_item.status`** — listing everything awaiting admin
action, plus a review form reachable from the queue and from the recording page as an admin. It
shows the draft in full alongside the recording title, date and word count, and allows per-field
accept, edit or discard. Approve writes through to the canonical entity (`summary.content`,
`recording.description`) and closes the item; discard closes it with no replacement, and the
recording remains publishable.
**References:** [slice-prd.md § In scope → 3](slice-prd.md#L77);
[3.6.4](prd.md#L130); [3.6.5](prd.md#L131); [3.6.6](prd.md#L132); [3.6.7](prd.md#L133);
[3.6.10](prd.md#L136); [4.17.2](prd.md#L682); [4.17.5](prd.md#L685);
[3.19.2](prd.md#L430); [3.19.3](prd.md#L431);
[slice-architecture.md § Data model (slice) → The review gate](slice-architecture.md#L193)
**Notes:** the in-app "ready for review" notification ([3.6.3](prd.md#L129)) is deferred — the queue
is how an admin finds work in this slice.

### Step 11 — Regenerate with a steering prompt
**Delivers:** an admin discards the current draft and triggers a fresh generation pass, optionally
supplying a short prompt to steer it; the new draft returns to the queue for review.
**References:** [3.6.9](prd.md#L135); [slice-prd.md § In scope → 3](slice-prd.md#L77);
[slice-architecture.md § Data model (slice) → The review gate](slice-architecture.md#L193);
[slice-architecture.md § Worker process](slice-architecture.md#L139)
**Notes:** regeneration re-enqueues `generate_draft` for that `kind` with the steering prompt
attached — the same handler, not a second path. The "notified when the new draft is ready" half of
[3.6.9](prd.md#L135) is deferred with [§3.17](prd.md#L361).

### Step 12 — Publish and unpublish
**Delivers:** the gate itself. An admin explicitly publishes a recording, setting `published_at`;
unpublish clears it without deleting the recording or anything attached to it. Member visibility is
enforced server-side on every read path as a single condition. Includes post-publish summary editing
and returning a published summary to draft.
**References:** [slice-prd.md § In scope → 4](slice-prd.md#L100);
[3.2.2](prd.md#L63); [3.2.11](prd.md#L72); [3.6.11](prd.md#L137); [3.6.12](prd.md#L138);
[4.17.3](prd.md#L683);
[slice-architecture.md § Data model (slice) → The spine](slice-architecture.md#L193)
**Notes:** publishing without a review gate is the second of the three things
[slice-prd.md § Rationale](slice-prd.md#L241) names as making this slice throwaway. Emit a domain
event on publish; nothing subscribes yet.

---

## Movement 4 — Give the member what they came for

### Step 13 — Member library and recording page
**Delivers:** a signed-in member sees published teachings, newest by date recorded first, including
those with no series, and can open one to read its title, date, published summary and description.
No audio yet.
**References:** [slice-prd.md § In scope → 4](slice-prd.md#L100);
[3.3.1](prd.md#L78); [3.3.9](prd.md#L86); [3.6.7](prd.md#L133);
[slice-prd.md § Slice flows → C](slice-prd.md#L210)

### Step 14 — Streaming playback and scrubbing
**Delivers:** a member presses play and hears the recording, and can scrub to any position. The API
mints a short-lived signed GET **after** checking the recording is published and the caller is
authenticated; range requests are served by the object store directly, which is what makes scrubbing
work without a CDN. Media is never publicly addressable.
**References:** [slice-prd.md § In scope → 5](slice-prd.md#L117);
[3.2.3](prd.md#L64); [3.2.9](prd.md#L70);
[slice-architecture.md § Media store](slice-architecture.md#L164);
[slice-prd.md § In scope → 8](slice-prd.md#L161); [§6](prd.md#L724) Security
**Notes:** members hear the **raw upload** — [3.4.1](prd.md#L94)'s "processed before available for
playback" deliberately does not hold in this slice
([slice-architecture.md § Divergence from the north star](slice-architecture.md#L283)). Signed-URL
minting is the exact place [§3.4](prd.md#L88) will later prefer a processed rendition and fall back
to the original, so keep it one function.

### Step 15 — Playback speed that persists
**Delivers:** speed control across all six steps — 0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x — with the
chosen speed persisting across recordings for that user, held on `user.preferred_playback_speed`.
**References:** [3.2.4](prd.md#L65); [slice-prd.md § In scope → 5](slice-prd.md#L117);
[slice-architecture.md § Data model (slice) → Accounts](slice-architecture.md#L193)

### Step 16 — Resume position across devices
**Delivers:** the marquee behaviour. A member closes a teaching mid-way on a phone and resumes at
the same second on a laptop the next day. `playback_progress (user_id, recording_id, position_ms,
updated_at)`, primary-keyed on the pair, last-write-wins on the furthest position; state is held
client-side and pushed to a single-position endpoint.
**References:** [3.2.5](prd.md#L66); [slice-prd.md § In scope → 5](slice-prd.md#L117);
[slice-architecture.md § Data model (slice) → Member-owned state](slice-architecture.md#L193);
[slice-architecture.md § Extension points → Client-owned playback state](slice-architecture.md#L312);
[slice-prd.md § Slice flows → C](slice-prd.md#L210)
**Notes:** client-owned-and-pushed is the shape that makes offline ([§3.18](prd.md#L391)) an addition
rather than a rewrite — it is [slice-prd.md § Rationale](slice-prd.md#L241)'s stated check that this
cut is not a dead end. Listening history and the completed marker are **out**; resume position is
the only playback state this slice keeps.

### Step 17 — Follow-along transcript
**Delivers:** the transcript readable on the recording page, highlighting the currently spoken
segment as playback moves, and seeking the audio when a member selects any point in it. The first
place a member touches the segment model, and the proof it works end to end.
**References:** [slice-prd.md § In scope → 6](slice-prd.md#L132);
[3.5.3](prd.md#L114); [3.5.4](prd.md#L115);
[slice-architecture.md § Extension points → `(recording_id, timestamp_ms)` offset](slice-architecture.md#L312)
**Notes:** the `(recording_id, timestamp_ms)` pair resolved here is what later makes "open at the
moment" one behaviour across notes, highlights, mind maps, search and Flow Tracker.

### Step 18 — Transcript correction and the regeneration offer
**Delivers:** an admin corrects segment text on a published recording — recording who corrected it
and when — and is offered regeneration of the summary, which routes through step 11's path. Member
progress and the recording's publication state are untouched throughout.
**References:** [slice-prd.md § In scope → 6](slice-prd.md#L132);
[3.5.5](prd.md#L116) (Admin-only in this slice);
[3.5.6](prd.md#L117) (narrowed to the summary — the other derived artefacts do not exist yet);
[slice-prd.md § Slice flows → D](slice-prd.md#L210)

### Step 19 — Series: create, rename, assign, move
**Delivers:** an admin creates and renames named series carrying a title and description, assigns a
recording to at most one, and moves a recording between series without losing its metadata or member
progress — managed from a dashboard panel.
**References:** [slice-prd.md § In scope → 4](slice-prd.md#L100);
[3.3.2](prd.md#L79); [3.3.6](prd.md#L83) (create/rename/move only — reorder and merge deferred);
[3.19.5](prd.md#L433) (minus artwork upload);
[slice-architecture.md § Data model (slice) → The spine](slice-architecture.md#L193)

### Step 20 — The series view
**Delivers:** the member-facing half. A series page listing its recordings chronologically with the
member's progress shown per recording, and its title, description, date range and count; series
surfaced from the library so a member who fell out of one can find their way back.
**References:** [3.3.4](prd.md#L81); [3.3.5](prd.md#L82) (minus cover artwork);
[slice-prd.md § In scope → 4](slice-prd.md#L100);
[slice-prd.md § Slice flows → C](slice-prd.md#L210)
**Notes:** depends on step 16 — the per-recording progress shown here is the same
`playback_progress` row the player writes, which is why series lands after the player rather than
next to the library.

## Movement 5 — Put it where people can reach it

### Step 21 — Production deployment
**Delivers:** the slice runs on the host it will live on, and survives a reboot. The VPS provisioned;
PostgreSQL 17 with the pgvector package installed and the extension still **unenabled**; the Next.js
app and the worker running as supervised services that start on boot and restart on failure, with
worker concurrency pinned to 1; a reverse proxy terminating TLS on the real domain; secrets held on
the box rather than in the repository; step 1's migration command applied against production by the
same command used in development; and `pgBackRest` archiving a nightly base plus WAL to the object
store, with **a restore proven onto a scratch database** — an unverified backup is not a backup, and
this is the step that proves it rather than the incident that disproves it.
**References:** [architecture.md § Estimated running costs](architecture.md#L343) — the deployment
topology paragraph, which is where worker concurrency 1 comes from;
[slice-architecture.md § Overview](slice-architecture.md#L7);
[slice-architecture.md § Primary datastore](slice-architecture.md#L177);
[01-project-skeleton.md § Assumptions to confirm](steps/01-project-skeleton.md#L99) — items 1 and 9,
both settled to this host; [§6](prd.md#L724) — *Storage* ("nothing expires") is what makes the
restore drill part of the step rather than an afterthought, and *Security* ("media storage is not
publicly addressable") is what the object-store configuration has to hold.
**Notes:** three things worth naming. **This step's position is the one genuinely debatable ordering
in the plan.** It depends on nothing after step 1, and pulling it forward to step 2 would mean every
later step is validated against real infrastructure — with deployment problems arriving one at a time
instead of twenty at once, and step 6's presigned uploads in particular far easier to debug against a
real origin and a real bucket. It sits last because there is no member to serve until step 20 and a
deployment carried through twenty steps of schema churn is real cost. That tradeoff deserves a
decision, not inheritance. Second, this step adds **no CDN and no broker**: signed URLs still point
straight at the object store, and the box runs exactly the two processes the slice already has
([slice-architecture.md § Deliberately deferred](slice-architecture.md#L330)). Third,
`NEXT_PUBLIC_API_ORIGIN` moves from `http://localhost:3000` to the real origin here — the single
value [01-project-skeleton.md](steps/01-project-skeleton.md#L112) assumption 2 exists to keep cheap.

---

## What this plan deliberately does not include

Cross-checked against [slice-architecture.md § Deliberately deferred](slice-architecture.md#L330)
and [slice-prd.md § Still remaining after this slice](slice-prd.md#L171). No step below exists, and
none should be added mid-build without going back to Phase 3:

- Any audio processing step, sound profile, FFmpeg or processed rendition — the whole of
  [§3.4](prd.md#L88).
- A message broker, a CDN, pgvector, a service worker, a manifest, an offline cache, or a Capacitor
  shell.
- The Contributor role — upload, transcript correction, series management and dashboard gating are
  Admin-only for now, by design.
- Notifications, listening history, the completed marker, avatars, series artwork, series reorder and
  merge, tags, scripture references, mind maps, video.
- A generic plugin framework for pipeline steps, or any "reviewable entity" abstraction beyond
  `review_item.kind`.

## Reference spot-check

Every citation above was resolved by locating the line, not guessed. Following a sample:

| Checked | Resolves to | Verdict |
| :---- | :---- | :---- |
| [3.5.2](prd.md#L113) (step 7) | "The transcript is segmented and timestamped…" | correct |
| [4.17.3](prd.md#L683) (step 12) | "Nothing publishes automatically…" | correct |
| [3.19.4](prd.md#L432) (step 8) | "A processing status view showing which recordings are in processing, transcription or generation, and which have failed" | correct — the processing column is the part this slice omits |
| [3.1.11](prd.md#L53) (step 4) | "At least one Admin account must exist at all times…" | correct |
| [3.2.4](prd.md#L65) (step 15) | "Playback speed is adjustable across 0.5x, 0.75x, 1x, 1.25x, 1.5x and 2x, and the chosen speed persists across recordings" | correct — confirms all six steps |
| [slice-architecture.md § Data model (slice)](slice-architecture.md#L193) | the `## Data model (slice)` heading | correct; sub-parts share the heading anchor and are named in the link text |
| [slice-prd.md § In scope → 5](slice-prd.md#L117) (steps 14–16) | `### 5. The player` | correct |

One thing worth flagging rather than leaving to be discovered mid-build: [3.5.1](prd.md#L112) reads
"once audio processing (3.4) completes", and step 7 triggers on **upload** completing instead. That
is [slice-prd.md § In scope → 2](slice-prd.md#L52)'s single deliberate narrowing, not a
mis-reference — but a step-planning session that read [3.5.1](prd.md#L112) alone would get it wrong,
which is why step 7 cites both.
