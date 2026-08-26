# Teaching Hub — TDD

The technical decisions document: the **how** of the project, standing alongside `docs/project/prd.md`
and `docs/project/diagram.svg` as the single source of truth over the codebase. Every scope refines
what is here rather than contradicting it, and a difference between a decision below and the code is
an open decision for the operator, not a fact about the product.

Decisions are numbered by section and cited by number. Anything marked **expensive to reverse** is a
choice that should be departed from deliberately, never by drift.

## Overview

Teaching Hub is one TypeScript codebase deployed as three runtime roles — a client, an API and a
feed, and a worker pool — over a shared Postgres and an object store. The client is a React PWA that
is also packaged, unchanged, into the two app stores; it holds its own copy of downloaded media and
of any writes made while offline. The API owns every piece of member state and every access-control
decision, and is the only thing that writes to the database. The workers own the entire asynchronous
pipeline: an uploaded recording is cleaned, transcribed, fanned out into summary, tags, scripture
references and mind map, embedded segment by segment, and cross-referenced against the existing
library — all as drafts that wait behind an admin review gate.

Drawn: `docs/project/diagram.svg`.

## 1. Structural decisions

- **1.1 Three runtime roles, one codebase.** Client, API and feed, and worker pool are three
  processes built from one TypeScript repository. The split is by what may block: anything that can
  take longer than a second belongs to the workers, and nothing in a request path waits on a model.
  **Expensive to reverse.**

- **1.2 The timestamped transcript segment is the atom of the system.** Search results,
  cross-references, mind-map nodes, video scripts, Flow Tracker recommendations and note anchors are
  all the same thing viewed differently — a `(recording, start_ms, end_ms)` tuple with text and an
  embedding attached. That is why there is one vector index rather than a search subsystem and a
  separate recommendation subsystem, and why project prd 3.9 is correctly described as
  infrastructure rather than as a feature. **Expensive to reverse.**

- **1.3 Everything expensive is a discrete, individually re-runnable job.** Audio processing, ASR,
  LLM calls, embedding, video rendering and external publishing are each a job in a ledger, so
  project prd 3.21.2.4 — re-run one step without re-running the pipeline — is a property of the
  design rather than a feature bolted onto it.

- **1.4 The one unauthenticated surface is a component, not a route.** The feed service carries the
  podcast RSS at project prd 5.3.1 and the shared mind map at project prd 3.8.13, and it is separate
  from the API precisely so that "everything requires auth" (project prd 3.1.2) stays true of the
  API by construction and the exceptions live in one auditable place.

## 2. Components & responsibilities

- **2.1 Client — PWA shell.** Owns rendering, the player, the offline cache and the outbox.
  Delivered three ways from one build (project prd 5.2.2): a browser PWA, an iOS App Store build, a
  Play build.
  - *Owns:* playback UI and speed/position state locally, the download queue and progress
    (project prd 3.18.7–3.18.9), the offline write outbox (project prd 3.18.14–3.18.15), optimistic UI.
  - *Does not own:* any authorisation decision. The client hides what a role cannot do; the API is
    what actually refuses it (project prd 3.1.5).
  - The **Capacitor shell** contributes exactly three things the browser cannot reliably give us:
    native background audio with lock-screen transport (project prd 3.2.6), APNs/FCM push in a store
    build (project prd 5.2.5), and a filesystem for downloads the OS will not evict under storage
    pressure (project prd 3.18). It contains no product logic.

- **2.2 API service.** The single writer to Postgres and the single place access control is decided.
  - *Owns:* authentication and sessions, role enforcement, all member state (progress, notes,
    questionnaire responses, Flow Tracker sessions, Highlights, notification preferences), the
    publish/review gate (project prd 4.17.3), signed-URL minting for media, search query execution,
    the offline sync endpoint, and notification fan-out.
  - *Does not own:* any long-running work. Anything that could take more than a second is enqueued.
  - Exposed as a versioned JSON HTTP API — project prd 6.10 is what makes the store builds, the
    browser PWA and the admin console the same client against the same contract.

- **2.3 Feed service.** A deliberately tiny, unauthenticated read-only surface, per 1.4. Serves the
  per-series podcast RSS feed and signed audio enclosures for project prd 5.3.1, and the single
  shared-mind-map route at project prd 3.8.13.

- **2.4 Worker pool.** Executes every pipeline step as an independent, idempotent, retryable job
  against a job ledger in Postgres.
  - *Owns:* audio processing, transcription, the derived-artefact fan-out, embedding and
    cross-reference computation, video rendering, external publishing, back-catalogue batches.
  - *Does not own:* the decision to publish. Workers only ever produce drafts (project prd 3.21.2.2).
  - Each step is separately addressable so an admin can re-run one without the pipeline
    (project prd 3.21.2.4), and a failure halts that recording's chain and raises a flag rather than
    continuing on bad input (project prd 3.21.2.3, project prd 3.5.8).

- **2.5 Media store.** Object storage holding original uploads (project prd 3.4.9), processed
  renditions, generated video and artwork. Never publicly addressable; every read is a short-lived
  signed URL issued by the API after an authorisation check (project prd 6.6).

- **2.6 Primary datastore.** Postgres holds relational state, transcript segments and their
  embeddings in the same database via pgvector. See 4.4 for why these are not two systems.

## 3. Data model

Conceptual only — project prd 4 already defines the fields; this is how the entities relate.

- **3.1 The spine.** `Series 1—* Recording 1—1 Transcript 1—* Segment`. A recording belongs to at
  most one series (project prd 3.3.2) and can exist without one (project prd 3.3.9). Every `Segment`
  carries `start_ms`, `end_ms`, text and an embedding vector. `Recording` carries two media
  pointers, original and processed (project prd 4.2), plus a `PipelineRun` with per-step status.

- **3.2 Derived artefacts** all hang off the recording and all carry a `status` of draft/published
  plus provenance — which model produced it and whether an admin changed it (project prd 4.17.5):
  `Summary` (one per recording), `ScriptureReference` (structured book/chapter/verse, never free
  text — project prd 3.7.3), `Tag` applied through a shared taxonomy across recordings and videos
  (project prd 4.7), `MindMap`, and `Video` with a parent recording.

- **3.3 Cross-references** are a derived edge table over segment pairs — `(segment_a, segment_b,
  score, basis)` where basis is embedding similarity, shared tag, or shared scripture citation
  (project prd 3.9.3). It is a cache of the vector index, not a source of truth, and can be dropped
  and rebuilt.

- **3.4 Member-owned state** is a separate cluster, all keyed by user and all subject to the privacy
  rule: `PlaybackProgress`, `ListeningHistory`, `Note` (with `visibility`, an optional `parent_note`
  one level deep, reactions, and any number of admin pins per recording — project prd 3.12.15),
  `QuestionnaireResponse`, `FlowTrackerSession`, `HighlightEntry`, `PersonalMindMap`,
  `NotificationPreference`. Account deletion removes this cluster and re-attributes only public
  notes to a placeholder (project prd 3.1.9–3.1.10) — which means **public notes must not be
  foreign-keyed to users with `ON DELETE CASCADE`**. That is a schema decision the PRD forces.

- **3.5 Community state.** `SosSignal` with acknowledgements and replies, and `Notification` rows
  fanned out per recipient.

- **3.6 One offset shape, six features.** `Highlight`, `Note`, `CrossReference`, `SearchResult`,
  `MindMapNode` and `FlowTrackerRecommendation` all ultimately resolve to a recording plus an
  offset. Modelling that offset consistently — a nullable `(recording_id, timestamp_ms)` pair on
  each — is what lets "open at the moment" work identically from six different places
  (project prd 3.9.5, 3.10.7, 3.14.7, 3.15.7, 3.12.12, 3.8.4). **Expensive to reverse.**

## 4. Key technology choices

| #    | Choice | Why | Reversal cost |
| :--- | :---- | :---- | :---- |
| 4.1 | **TypeScript end to end, monorepo** | One language across client, API and workers means the domain types — segment, pipeline status, role — are defined once and shared, which is what keeps the API-first contract in project prd 6.10 honest instead of hand-maintained. | Low early, high later |
| 4.2 | **React PWA (Next.js App Router) as the only UI codebase** | project prd 5.2.2 is explicit that a feature never exists in one delivery route and not another. One codebase is the mechanism, not a preference. | **Expensive to reverse** |
| 4.3 | **Capacitor for store packaging** | Wraps the same web build, and specifically buys the three capabilities the PRD flags as risky: iOS push in a store build, reliable background audio, and non-evictable download storage. The alternative — pure web PWA — leaves project prd 3.17.1 and 3.18.6 exposed to Safari's limits, which is what makes 5.8 a browser-route decision rather than a product-wide one. | Moderate |
| 4.4 | **PostgreSQL + pgvector as the single datastore, embeddings at 1536 dimensions** | The decisive constraint is project prd 3.10.9: search must return published content *plus the searching member's own private notes and personal mind maps*, and never anyone else's. A separate vector service means either replicating the permission model into it or post-filtering results, which breaks top-k. Keeping vectors in the same database as the ACL data makes that a `WHERE` clause, and it is why project prd 3.10 needs no search infrastructure beyond this. Dimension is 1536 — the model's native output, no truncation step, best retrieval quality. The cost is named and accepted in 7.3: at roughly 200k–250k segments the HNSW index stops fitting in the launch host's page cache, and the dedicated-core swap in 8.1 arrives earlier than the cost table assumes. Self-hosted on the application host rather than managed; the operational cost of that is backups, and they are a `pgBackRest` archive to the object store. | **Expensive to reverse** |
| 4.5 | **Hybrid search: pgvector ANN + Postgres full-text, fused** | project prd 3.10.2 wants meaning; project prd 3.10.5 wants an exact scripture citation to work. Those are different retrieval modes and one index does not serve both well. Fusing two rankings from one database is cheaper than running two systems. | Low |
| 4.6 | **Object storage with zero-egress pricing (R2 or equivalent), CDN in front** | Storage is permanent and unbounded by requirement (project prd 6.4), and audio streaming is the highest-volume path in the product. Egress-priced storage makes the one thing members do most the thing that scales worst. | Moderate |
| 4.7 | **The job ledger *is* the queue — `SKIP LOCKED` polling, no broker** | project prd 3.21.2.4 requires re-running one step of a pipeline, and project prd 3.19.4 requires showing an admin exactly where each recording sits. Both need pipeline state to be queryable data, not queue internals — so the ledger lives in Postgres, and once it does, a separate broker is carrying almost nothing. Polling the ledger directly rather than adopting a queue library keeps one job store instead of two: `pg-boss` and its equivalents bring their own schema, which would leave the dispatcher's state and the state project prd 3.19.4 reads as different tables. At this cadence — roughly fifty jobs a month — `SELECT … FOR UPDATE SKIP LOCKED` has four orders of magnitude of headroom, and enqueue becomes transactional with the ledger write, which removes the dispatched-but-unrecorded failure class outright. Redis returns behind the same queue port when dispatch latency or fan-out concurrency actually demands it, not before. | Low |
| 4.8 | **FFmpeg for the sound profile** (`afftdn` denoise → clarity EQ/compression → `loudnorm` two-pass to a fixed LUFS target) | project prd 3.4.5 asks for one named profile applied library-wide, and project prd 3.4.6 asks to preview it before saving. A parameterised FFmpeg filter chain stored as a versioned row gives both, and re-processing is just re-running it. Loudness normalisation to a broadcast target also satisfies project prd 3.4.10 — podcast platforms expect it. | Low |
| 4.9 | **Managed ASR with segment timestamps, behind an adapter** | project prd 3.5.2 is the hinge of the product and project prd 7.2.7 names accuracy on ministry-specific vocabulary as a real risk. An adapter interface means the provider can be swapped, or a custom-vocabulary provider adopted, without touching anything downstream. Deepgram Nova-3 fills it today (project prd 7.3.1), handed a short-lived signed location to fetch from rather than the bytes. | Low — deliberately |
| 4.10 | **One language model behind an adapter for all text generation** | Summary, description, tags, scripture identification, mind-map extraction and video script segmentation are one capability used six ways (project prd 3.6, 3.7.1, 3.8.1, 3.11.3.1, 4.17.1). Long context matters: a 90-minute transcript is fed whole rather than chunked, which is what keeps a summary faithful to the teaching. Structured output is taken as a forced tool call, and a model that answers in prose instead fails the step visibly rather than writing something nobody asked for. The provider is configuration, not architecture — MiniMax M3 over its Anthropic-compatible endpoint today (project prd 7.3.1), and the deferral in project prd 7.5.1 is cheap for exactly this reason. | Low |
| 4.11 | **Template-based video rendering (Remotion-style) + TTS, with a generative backend behind the same interface** | project prd 3.11.2.1 describes presets as detailed descriptions of a visual treatment, and project prd 3.11.2.3 wants consistency across the catalogue — both of which argue for deterministic templates over per-generation model output. project prd 7.2.3 independently flags generative video as the least proven, most expensive capability. Making the renderer an interface means the cheap path ships and the expensive path is an upgrade, not a rewrite. This is the decision with the largest financial swing in the architecture — see 8.4 — and the template path is the default until real output is measured against it. | Low (by design) |
| 4.12 | **Self-hosted email/password auth with server-side role checks** | No self-signup, no social login, no SSO, ~100–1,000 users, and an invitation flow (project prd 3.1.3) that a third-party identity provider would only complicate. Roles live in our database because every permission check also needs product context. Transactional delivery is SMTP so the provider is configuration rather than code (project prd 7.1.6). | Moderate |
| 4.13 | **Structured citations + verse text fetched and cached from a free-use Bible text source** | project prd 3.7.3 mandates structured storage regardless. Keeping verse *text* as a cache rather than as data means the licensing answer changes one component instead of the schema — worst case, project prd 3.7.4 degrades to a link out. One free-use translation named in deployment configuration (project prd 3.7.9), which is what closed project prd 7.2.5. | Low — deliberately |
| 4.14 | **Podcast distribution as a self-hosted RSS feed** | Spotify has no push ingestion API; it polls a feed. So project prd 3.20.4 is architecturally a per-recording `include_in_feed` flag plus feed regeneration, not an outbound API call — and per-episode delivery status does not exist to be shown, which is what project prd 5.3.6 now says outright. See 5.6. | Low |

## 5. Boundaries & integration

- **5.1 Client ↔ API.** Versioned JSON over HTTPS. Session via HTTP-only cookie on web, secure native
  storage under Capacitor; the API accepts both against one session model. Every response is shaped
  by the caller's role — the API never returns a draft to a Member and never returns another
  member's private content to anyone (project prd 3.10.9, 3.13.8, 3.14.8, 3.15.9).

- **5.2 Client ↔ media.** The client asks the API for a playable URL; the API authorises, then mints
  a short-lived signed CDN URL. Bytes never pass through the API. Downloads use the same route and
  land in on-device storage.

- **5.3 Offline sync.** The client keeps an append-only outbox of writes made while disconnected —
  progress positions, notes, questionnaire answers, Flow Tracker responses — each with a
  client-generated id and a local timestamp. On reconnect the outbox is flushed to a single sync
  endpoint. **Conflict policy is per-entity and deliberately simple:** playback progress is
  last-write-wins on the furthest position; notes and responses are append/update by owner
  (single-writer by definition, so genuine conflicts are rare); and server-side deletions win, which
  is how project prd 3.18.12 removes an unpublished recording from a device. The reverse direction
  is a delta manifest the client pulls on reconnect, listing what has been added, changed or revoked
  since its last sync token.

- **5.4 API ↔ workers.** One direction only: the API enqueues, workers write results back as drafts.
  Workers never call the API. Job completion raises a domain event, which is what drives the
  notifications at project prd 3.17.10–3.17.12.

- **5.5 Workers ↔ AI providers.** Every provider sits behind a narrow adapter — `transcribe`,
  `generate`, `embed`, `synthesize`, `render` — with the model, version and prompt recorded on every
  output (project prd 4.5, *Generated by*). That record is what makes regeneration
  (project prd 3.6.9) and provider migration tractable. A single switch puts every provider into a
  local mock, so no development or test run reaches a paid one by accident (project prd 6.15).

- **5.6 Outbound publishing.** Each external platform is an adapter behind a common
  `publish(item, target)` contract with its own status per item (project prd 3.20.7). They differ
  enough — Instagram and LinkedIn take direct API posts, TikTok requires its Content Posting flow —
  that a shared abstraction only covers queuing, retry and audit logging (project prd 3.20.8), not
  the mechanics. **Spotify is not one of them.** It pulls a feed on its own schedule, so it has no
  queue and no per-item contract: the product sets `include_in_feed`, regenerates the feed, and
  knows only that the recording is in it and when Spotify last read it (project prd 5.3.6, and 4.14
  above). The admin surface must not imply more, which is why project prd 3.20.6 and 3.20.7 now
  carve it out explicitly. All platforms are publish-only; nothing is read back (project prd 5.3.5).

- **5.7 Cross-reference recomputation.** project prd 3.9.6 says references are recomputed when a
  recording joins the library. Recomputing all pairs is quadratic and unnecessary: embed the new
  recording's segments, run top-k ANN against the existing index, and write edges in both
  directions. Cost is linear in new content, and the existing library gains its links to the new
  arrival as a side-effect of the same pass.

- **5.8 Client ↔ device storage, on the browser route.** Store builds hold downloads on a filesystem
  the OS will not evict (4.3), so this boundary is the browser's alone. There, downloaded media
  lives in storage the browser may cap or reclaim, and a "Download all" of a long series
  (project prd 3.18.6) can exceed it. **The check happens before the queue is built, not during it:**
  the client reads what the device reports free, and a request that would not fit is refused up
  front with what the series needs, what is available, and an offer of the most recent recordings
  that do fit (project prd 3.18.17). Reading the estimate rather than pinning a constant is what
  keeps this correct on a 32 GB phone and on a desktop without the product carrying a number that
  ages.

## 6. Cross-cutting concerns

- **6.1 Authorisation.** One policy layer in the API, consulted on every request, expressed as
  `(actor, action, resource)`, denying by default. Three roles (project prd 3.1) plus one invariant
  enforced at the data layer rather than in policy: the last admin cannot be removed or demoted
  (project prd 3.1.11).

- **6.2 The review gate.** Draft-versus-published is not a per-feature flag; it is one state machine
  shared by summaries, scripture references, metadata, mind maps, recordings and videos. Every
  generated artefact enters as draft, every transition to published is an authenticated admin
  action, and every transition is logged. This is the mechanism behind project prd 4.17.3 and
  3.21.2.2, and it is why project prd 3.19.2's Pending Reviews queue is a single query over one
  status column rather than a union of six — the property project prd 4.17.6 states as a
  requirement.

- **6.3 Privacy.** Private member content is enforced at the query layer, not filtered in the UI.
  Search in particular (project prd 3.10.9) issues one query whose visibility predicate is
  `published OR owner = :me`, which is only possible because vectors and ownership live in the same
  database (4.4).

- **6.4 Errors and failure posture.** Two classes, handled differently. A *pipeline* failure halts
  that recording, records the failing step and reason, and raises an admin flag (project prd 3.4.11,
  3.5.8, 3.19.4) — it never publishes partial results. A *request* failure returns a typed error the
  client can distinguish; the distinction between "no results" and "search unavailable" at
  project prd 3.10.11 is a requirement that only works if error types are part of the API contract.

- **6.5 Notifications.** One event model, two transports. A domain event produces `Notification` rows
  for its audience (in-app centre, always) and, subject to per-category preference
  (project prd 3.17.13), a push payload dispatched via APNs/FCM in store builds and Web Push in
  browsers. Preferences gate push only; the in-app centre receives everything, including muted
  categories (project prd 3.17.14).

- **6.6 Observability.** Structured logs with a correlation id spanning API request → job → provider
  call, error tracking with alerting, and a pipeline dashboard fed from the job ledger rather than
  from logs (project prd 3.19.4). Provider spend is tracked per job, because project prd 6.15
  requires cost to be measured rather than estimated.

- **6.7 Audit.** An append-only log for external publishes (project prd 3.20.8) and for admin actions
  on member content (project prd 3.12.10, 3.16.11), carrying actor, action, target and timestamp.

- **6.8 Configuration.** Environment-injected secrets; product-level settings that admins change —
  the sound profile (project prd 3.4.6), video style presets (project prd 3.11.2.2), question banks
  (project prd 3.14.11) — are versioned rows in the database, not deploys. That is what makes
  project prd 3.4.7 work: a recording records which profile version processed it, so changing the
  profile cannot retroactively alter anything.

- **6.9 Flow Tracker assessment is a judgment, never a record.** project prd 3.14.6 needs a free-text
  answer evaluated to find a gap in understanding, and project prd 3.14.9 says no score, grade or
  pass mark exists. **Both hold, by never persisting the evaluation:** the model reads the answer,
  emits recommendations, and the judgment itself is written nowhere — not to `FlowTrackerSession`,
  not to logs, not to the provider-spend record beyond the fact that a call happened. What is stored
  is the answer the member gave and the reading list it produced. The consequence is accepted
  deliberately: recommendation quality cannot improve across runs, because there is nothing kept to
  improve it from. This sits under 6.3, and it is the strictest reading of project prd 3.14.8.

## 7. Scalability & growth posture

- **7.1 Content volume, not member count, is the growth axis.** project prd 6.1 says content grows
  unbounded while members go from 100 to 1,000+. Object storage and the CDN absorb member growth
  with no architectural change. The worker pool scales horizontally and independently of the API,
  which is what makes the back-catalogue burst (project prd 3.21.3.3) a concurrency-limit setting
  rather than an event.

- **7.2 Deliberately not built yet.** Single-region deployment — the audience is one group, and
  multi-region buys latency nobody has asked for. Single primary database with read replicas
  available if needed but not provisioned. No horizontal sharding, no CQRS, no event-sourcing: the
  read and write shapes here are ordinary. No self-hosted models; every AI capability is a paid API
  behind an adapter (5.5), which trades per-unit cost for the ability to change provider in a day.
  No real-time transport — notes and SOS signals refresh on poll and on push, not over a socket; if
  the SOS channel (project prd 3.16) turns out to need live presence, that is a bounded addition.

- **7.3 Where it will bend first.** Three places, in the order they are likely to arrive. **Video
  rendering**, which is CPU-bound and bursty and shares a host with the API and the database — it is
  the first thing that should be moved to its own box, and 8.1 says how. Then **the HNSW index**:
  4.4 chose 1536 dimensions with open eyes, and at roughly 200k–250k segments that index no longer
  fits the launch host's page cache, which on shared-vCPU hardware turns every ANN query into
  contended disk I/O. That is not a surprise to be discovered — it is a scheduled cost, and the
  dedicated-core swap in 8.1 is its answer, arriving before project prd 3.9 carries a full back
  catalogue rather than after. Then **vector search latency** once segments pass roughly a million
  rows, which would push the index to a dedicated vector store or to partitioning by series — a
  change whose cost is entirely the permission-model replication 4.4 exists to avoid.

## 8. Running costs

Launch = 100 members, ~4.3 recordings/month at ~90 min each, ~8 reels + 2 summary videos/month, ~4
hrs listening per member per month. Target = 1,000 members at the same publishing cadence and ~4×
the video output. Excludes the one-time back-catalogue run, listed at 8.3.

- **8.1 Deployment topology.** The three runtime roles remain three separate processes with the
  boundaries described in section 2 — but at launch they are *co-located on one host* alongside
  Postgres: API, feed, worker pool and database on a single European VPS. This is a deployment
  decision, not a structural one. Nothing in sections 1–5 changes, and moving a role onto its own
  box later is a deploy-target change rather than a rewrite. It is also what makes the launch bill
  fall from roughly $85 to roughly $20, and the reason is duty cycle: ~40 worker machine-hours a
  month against 730 is about 5%, so per-second billing charges for exactly those hours while a
  fixed-price host absorbs them at zero marginal cost — the other 690 hours are already bought.
  The constraint it introduces is contention. FFmpeg's two-pass `loudnorm` and a Remotion render are
  both CPU-bound and bursty, and they share four vCPU with a database that every API call touches;
  worker concurrency is therefore pinned to 1 and the render step capped in threads. **The first
  escape hatch is a like-for-like swap to a dedicated-core host** (netcup RS 1000 G12 — identical
  RAM and disk, ~€2.40/month more) before any topology change is considered. 7.3 expects that swap
  to be needed for the vector index, not only for steal time.

- **8.2 Recurring costs.**

  | Item | Usage assumption | Launch / month | Target / month |
  | :---- | :---- | :---- | :---- |
  | Application host | Launch: one netcup VPS 1000 G12 (4 vCPU, 8 GB DDR5 ECC, 256 GB NVMe, EU) running API, feed, workers and Postgres. Target: VPS 2000 G12 for app + workers, VPS 1000 G12 for Postgres. | $11 | $32 |
  | Queue | `SKIP LOCKED` polling over the job ledger — no broker, no separate spend (4.7) | $0 | $0 |
  | Database backups | `pgBackRest` nightly base + WAL archive to the object store | $1 | $3 |
  | Object storage | ~95 GB after back catalogue, +~1.4 GB/month; zero-egress tier | $2 | $6 |
  | Media egress | ~11 GB/month launch → ~130 GB/month target (streaming + downloads) | $0 | $0 |
  | Transcription | 6.5 hrs of audio/month @ ~$0.26/hr | $2 | $2 |
  | LLM generation | 4.3 recordings/month × ~80k input tokens across 5 passes; the transcript is cached once per recording and read by the remaining four | $2 | $3 |
  | Embeddings | 4.3 recordings/month × ~16k tokens, plus query embeddings | <$1 | $1 |
  | **Video generation — template path** | 10 videos/month launch, 40 target; render compute absorbed by the host, TTS billed | **$1** | **$4** |
  | **Video generation — generative path** | 10 videos/month × 45s, ~2 takes each at $0.10–0.50/generated second | **$80–360** | **$320–1,440** |
  | Text-to-speech | ~1,500 words/month of AI voiceover | <$1 | $2 |
  | Bible text API | ~500 verse lookups/month, cached | $0 | $0–10 |
  | Transactional email | Invitations and password resets only — a few dozen/month | $0 | $15 |
  | Error tracking + logs | Single project, moderate volume | $0 | $26 |
  | Push (APNs / FCM / Web Push) | All notification volume | $0 | $0 |
  | CDN + DNS | Cloudflare free tier at launch; standard tier at target | $0 | $5 |
  | **Total — template video path** | | **~$20** | **~$110** |
  | **Total — generative video path** | | **~$100–380** | **~$430–1,550** |

  Host prices are VAT-inclusive euro list rates converted at ~1.08 USD/EUR; net-of-VAT they are
  roughly 16% lower. The launch host is a shared-vCPU plan, so its cost is fixed but its CPU
  throughput is not guaranteed — see 8.1.

- **8.3 One-time costs.**

  | Item | Assumption | Cost |
  | :---- | :---- | :---- |
  | Back-catalogue transcription | ~300 recordings × ~1.5 hrs = 450 hrs @ ~$0.26/hr | ~$120 |
  | Back-catalogue LLM fan-out | 300 recordings × 5 passes | ~$110 |
  | Back-catalogue embedding | ~5 M tokens | <$5 |
  | Back-catalogue audio processing | ~45 worker-hrs of FFmpeg, absorbed by the host — wall-clock, not spend | $0 |
  | Apple Developer Program | Annual, not monthly | $99/yr |
  | Google Play developer account | One-time | $25 |

- **8.4 The line that dominates, and the decision it forces.** Every line in 8.2 except one is
  essentially flat between 100 and 1,000 members — this product's cost is driven by content volume,
  and content volume is set by a weekly cadence, not by audience. Co-locating the runtime roles has
  made that starker rather than changing it: infrastructure is now about $14 of a ~$20 launch bill
  and has stopped being the interesting number. The exception is video generation, which is ~5% of
  the bill on the template path and 80–95% of it on the generative path, and which scales with
  publishing cadence rather than membership. If the generative path is chosen, video becomes the
  single largest operating expense at every scale by a wide margin — it would multiply the launch
  bill roughly five- to nineteen-fold — and the approve-or-discard workflow at project prd 3.11.4.6,
  which bins a full-cost generation on rejection, becomes an expensive design. That is why 4.11
  specifies the renderer as an interface with the template path as the default: the choice is
  measured on real output rather than committed to now. It wants deciding before project prd 3.11 is
  scoped, because it also determines whether style presets are template definitions or model prompts
  — and those are different artefacts.
