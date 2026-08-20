# Teaching Hub — Slice 01 PRD: core-listening

## Builds on

Nothing — this is the first slice. The repository holds the full-scope PRD
([prd.md](prd.md)) and the north-star architecture ([architecture.md](architecture.md)) and no
application code. Remaining is therefore the whole of [§3](prd.md#L29), and this slice cuts through
every layer of the system described in [architecture.md § Overview](architecture.md#L8) for the
first time.

## What the slice is

A private, invite-only web app where a teaching stops being lost after one hearing.

An admin invites a member by email; the member sets a password and signs in. An admin
uploads a recording, and it runs itself through the pipeline unattended — transcribed into
timestamped segments, then written up as a draft summary and description. The audio itself is
served exactly as uploaded; cleaning and levelling it ([§3.4](prd.md#L88)) is a later slice.
Nothing reaches a member on its own: the admin opens a Pending Reviews queue, reads what
the AI produced, edits or regenerates it, and publishes. From that moment every member sees the
teaching in a date-ordered library, plays it at their chosen speed, picks up exactly where they left
off on any device they sign in from, scrubs to any moment, and reads the transcript scrolling along
with the audio.

This is steps 2, 4, half of 5, 8 and 9 of the weekly pipeline at [3.21.1](prd.md#L463), with step 12
reduced to listening — step 3 is out with [§3.4](prd.md#L88). It is the smallest thing that is
simultaneously a real member product and a real content studio — and it establishes the two
structures every later slice depends on: the
**timestamped segment** as the atom of the system ([architecture.md § Overview](architecture.md#L8)),
and the **draft-then-admin-review gate** ([4.17.3](prd.md#L683)) that every AI artefact after this
one will pass through.

## In scope — core features

### 1. Accounts, invitation and roles

*In the spine because [3.1.2](prd.md#L44) puts every single thing in this product behind it. There is
no version of this app without auth.*

- Individual email/password accounts ([3.1.1](prd.md#L43)) with every request authenticated
  ([3.1.2](prd.md#L44)).
- Admin-issued invitations with role assignment, expiry, revoke and re-send
  ([3.1.3](prd.md#L45)–[3.1.4](prd.md#L46)).
- Two of the three roles from [§3.1](prd.md#L31) — **Admin** and **Member** — enforced server-side on
  every request, not only in the interface ([3.1.5](prd.md#L47)). **Contributor is deferred**: every
  capability it would hold in this slice (upload, transcript correction, series management) is
  Admin-only for now, so the slice ships one privileged role rather than two.
- Self-service password reset by email ([3.1.6](prd.md#L48)), account deactivation
  ([3.1.7](prd.md#L49)), and the last-admin guard ([3.1.11](prd.md#L53)).
- A profile carrying display name ([3.1.12](prd.md#L54)); avatar deferred.

### 2. Upload and the automated pipeline to draft

*The engine room. [3.5.2](prd.md#L113) is named in the PRD as the hinge of the whole product and in
[architecture.md § Data model](architecture.md#L171) as the atom of the data model — building it
later would mean rebuilding everything attached to it.*

- Audio upload, Admin-only in this slice — the Contributor half of [3.2.1](prd.md#L62) arrives with
  the role.
- **The uploaded file is stored as-is and streamed as-is.** [§3.4](prd.md#L88) audio processing is
  out of this slice in its entirety, which means the ordering in [3.4.1](prd.md#L94) — processed
  before available for playback — is deliberately not met here: members hear the raw recording. The
  upload is retained unmodified regardless ([3.4.9](prd.md#L102)), so it is the input the processing
  job reads when [§3.4](prd.md#L88) lands, and nothing has to be re-uploaded.
- **Transcription triggers on upload completing**, not on processing completing — the one place this
  slice narrows [3.5.1](prd.md#L112). It produces timestamped segments and records the detected
  language ([3.5.2](prd.md#L113), [3.5.7](prd.md#L118)).
- The pipeline runs unattended and produces drafts only
  ([3.21.2.1](prd.md#L483)–[3.21.2.2](prd.md#L484)) — narrowed here to step 4 and the summary half
  of step 5, since audio processing, mind maps, cross-references, tags and scripture references are
  all out.
- A failure halts that recording's chain and flags it rather than publishing partial results
  ([3.21.2.3](prd.md#L485), [3.5.8](prd.md#L119) — [3.4.11](prd.md#L104)'s processing-failure case
  has nothing to fire on yet), and an admin can re-run a step without re-running the pipeline
  ([3.21.2.4](prd.md#L486)).

### 3. AI summary and description behind the review gate

*One derived artefact is enough to make the review gate real. Chosen over mind maps, tags or
scripture references because it carries the most member value per unit of build — a member who missed
a session finds out what it was about — and because it is the artefact [3.21.1](prd.md#L463) step 5
puts first.*

- One draft summary per recording, generated on transcription completion, never member-visible while
  draft ([3.6.1](prd.md#L127)–[3.6.2](prd.md#L128)).
- An AI-suggested description on the recording ([4.17.1](prd.md#L681)) — topics, tags and scripture
  references deferred with the features they exist to power.
- Review from the Pending Reviews queue and from the recording page as an admin
  ([3.6.4](prd.md#L130)), showing title, date and word count ([3.6.5](prd.md#L131)).
- All four review actions: approve, edit-then-approve, regenerate with an optional steering prompt,
  discard ([3.6.6](prd.md#L132)–[3.6.10](prd.md#L136)); plus post-publish edit and unpublish
  ([3.6.11](prd.md#L137)–[3.6.12](prd.md#L138)). The in-app "ready for review" notification
  ([3.6.3](prd.md#L129)) is deferred with [§3.17](prd.md#L361); the queue is how an admin finds work
  in this slice.
- Per-field accept/edit/discard in the review form ([4.17.2](prd.md#L682)), with each AI-suggested
  field recording that it was AI-suggested and whether an admin changed it
  ([4.17.5](prd.md#L685)).
- Nothing publishes automatically ([4.17.3](prd.md#L683)).

### 4. Publish, unpublish and series

*Publishing is the gate itself. Series is in because [3.3.1](prd.md#L78) alone gives an
undifferentiated list, and a member who fell out of a series — the exact person the product exists
for — needs the series to exist to find their way back.*

- Explicit admin publish ([3.2.2](prd.md#L63)) and unpublish without deletion
  ([3.2.11](prd.md#L72)).
- Date-ordered browsing, newest first ([3.3.1](prd.md#L78)), including recordings with no series
  ([3.3.9](prd.md#L86)).
- Named series with at most one per recording ([3.3.2](prd.md#L79)); a series view listing its
  recordings chronologically with the member's progress on each ([3.3.4](prd.md#L81)); series title,
  description, date range and count ([3.3.5](prd.md#L82)) minus cover artwork.
- Admins create, rename and move a recording between series without losing metadata or member
  progress (the create/rename/move part of [3.3.6](prd.md#L83); reorder, merge and the Contributor
  half deferred).

### 5. The player

*What the member actually came for, and the reason [3.2.5](prd.md#L66) cannot wait: resume-anywhere
is what makes a 90-minute teaching consumable across a week of commutes.*

- Stream any published recording ([3.2.3](prd.md#L64)).
- Speed control across all six steps, persisting across recordings for that user
  ([3.2.4](prd.md#L65)).
- Per-user, per-recording playback position, resuming on any device that user signs in from
  ([3.2.5](prd.md#L66)).
- Scrubbing to any position ([3.2.9](prd.md#L70)).
- Listening history ([3.2.7](prd.md#L68)) and the completed marker ([3.2.8](prd.md#L69)) are out.
  Resume position ([3.2.5](prd.md#L66)) is the only playback state this slice keeps — enough to pick
  a teaching back up, not enough to tell a member which ones they have finished.

### 6. Follow-along transcript

*The cheapest possible proof that the segment model works end to end, and the first place a member
touches it.*

- The transcript readable on the recording page, highlighting the currently spoken segment as
  playback moves ([3.5.3](prd.md#L114)).
- Selecting any point in the transcript seeks the audio there ([3.5.4](prd.md#L115)).
- Admin-only transcript correction ([3.5.5](prd.md#L116) minus its Contributor half), which is in
  scope because the transcript is member-visible from this slice and ministry names will be wrong
  without it.
  [3.5.6](prd.md#L117)'s regeneration offer is narrowed to the summary — the other derived artefacts
  it names do not exist yet.

### 7. Minimal admin dashboard

*The operator surface for everything above. Scoped strictly to the capabilities this slice ships —
each later slice adds its own panel.*

- An Admin-only dashboard — [3.19.1](prd.md#L429)'s per-role gating has nothing to gate until the
  Contributor role exists, so this slice ships one flat operator surface behind an admin check.
- Pending Reviews, carrying draft summaries and suggested metadata only
  ([3.19.2](prd.md#L430)).
- Upload, the metadata review form and the publish action ([3.19.3](prd.md#L431)).
- Pipeline status — which recordings are transcribing or generating, and which have failed
  ([3.19.4](prd.md#L432) minus its processing column).
- Series management minus artwork upload ([3.19.5](prd.md#L433)).
- User management: invitations, roles, deactivation, member list ([3.19.9](prd.md#L437)).

### 8. Platform baseline

- Responsive across phone, tablet and desktop from one codebase — the responsive row of
  [§5.1](prd.md#L689) — delivered as a browser web app.
- The API-first boundary from [§6](prd.md#L724): the client holds no authorisation decision, so the
  store builds added later are the same client against the same contract
  ([5.2.2](prd.md#L706)).
- Media never publicly addressable; every read a short-lived signed URL issued after an
  authorisation check ([§6](prd.md#L724) Security).

## Still remaining after this slice

**Whole features not started**

| Full-scope feature | How it attaches later |
| :---- | :---- |
| [§3.4](prd.md#L88) Audio processing & quality | A worker job reading the retained originals ([3.4.9](prd.md#L102)) and writing a processed rendition that becomes the streamed file, plus the sound profile and its admin UI ([3.4.5](prd.md#L98)–[3.4.8](prd.md#L101)) and the processing-failure flag ([3.4.11](prd.md#L104)). Slot it before podcast distribution, which depends on [3.4.10](prd.md#L103). Existing recordings are back-filled by running the job over the library, and are worth re-transcribing afterwards since [§3.5](prd.md#L106) reads cleaner audio more accurately. |
| [§3.7](prd.md#L140) Scripture references | A third derived artefact through the same pipeline fan-out and the same review gate this slice builds; structured citations hang off the recording. |
| [§3.8](prd.md#L154) Mind maps | Recording maps are another pipeline artefact behind the same gate; personal maps are a new member-owned entity generated from the segments this slice already stores. |
| [§3.9](prd.md#L179) Intelligent cross-referencing | Adds an embedding column and an edge table over segments that already exist — no re-transcription. Ships with search, since [architecture.md § Key technology choices](architecture.md#L209) makes them one capability. |
| [§3.10](prd.md#L194) Semantic search | The same vector index as cross-referencing, plus full-text over the transcripts, summaries and titles this slice populates. |
| [§3.11](prd.md#L212) AI video generation | Reads the segmented transcript this slice produces and reuses the draft/approve pattern of [3.6.6](prd.md#L132). |
| [§3.12](prd.md#L257) Timestamp notes | Anchors to the playback position the player already tracks; markers hang on the progress bar built here. |
| [§3.13](prd.md#L281) Reflective questionnaires | A new admin-authored entity attached to the recording page below the summary. |
| [§3.14](prd.md#L300) Flow tracker | Depends on cross-referencing ([3.9.8](prd.md#L192)) and on listening history ([3.2.7](prd.md#L68)), which is itself deferred — so this is at least two slices out. |
| [§3.15](prd.md#L318) Highlights playlist | Pins the `(recording, timestamp)` pair the player already resolves; needs notes for [3.15.3](prd.md#L328). |
| [§3.16](prd.md#L334) SOS signal | Independent of the content pipeline; needs only accounts and, to be useful, notifications. |
| [§3.17](prd.md#L361) Notifications | Fans out per recipient off events this slice already emits — publish, transcription failure, summary ready. Push delivery pairs naturally with the store packaging slice. |
| [§3.18](prd.md#L391) Offline support & downloads | Client-side cache and outbox over the API contract this slice defines; the playback state at [3.2.5](prd.md#L66) is already client-owned, which is what makes [3.18.14](prd.md#L419) an addition rather than a rewrite. |
| [§3.20](prd.md#L442) External distribution | Podcast feed regenerates from series metadata and the processed audio this slice produces; needs [3.3.3](prd.md#L80) artwork and [3.3.7](prd.md#L84) podcast-shaped metadata first. |
| [3.21.3](prd.md#L488) Back-catalogue processing | Bulk entry and bulk review over the identical pipeline — the per-recording path has to exist and be trusted first. |
| [§5.2](prd.md#L701) App store distribution | Capacitor wraps the same web build; brings background audio ([3.2.6](prd.md#L67)), push ([5.2.5](prd.md#L709)) and non-evictable download storage with it, and forces account self-deletion ([5.2.6](prd.md#L710)). |
| PWA installability and service worker ([§5.1](prd.md#L689)) | Manifest and service worker over the responsive app this slice ships; pairs with offline. |

**Left out of features this slice touches**

| Deferred | How it attaches later |
| :---- | :---- |
| The **Contributor** role ([§3.1](prd.md#L31)) and every "and Contributors" clause that depends on it — upload ([3.2.1](prd.md#L62)), transcript correction ([3.5.5](prd.md#L116)), series management ([3.3.6](prd.md#L83)), the role-gated dashboard ([3.19.1](prd.md#L429)) | Adding a third role to a permission model that is already enforced server-side per request, then widening the four capabilities above from admin-only to admin-or-contributor. Cheap precisely because [3.1.5](prd.md#L47) is in scope now — the check exists, it gains a case. Also unlocks the Contributor-only capabilities of later slices: video generation ([3.11.1.3](prd.md#L220)) and mind map curation ([3.8.2](prd.md#L163)). |
| Listening history ([3.2.7](prd.md#L68)) and the completed marker ([3.2.8](prd.md#L69)) | Both are reads over per-user playback state this slice already writes ([3.2.5](prd.md#L66)) — history adds an append-only play log, the marker adds a completion threshold and a badge in the browse list. Listening history is a prerequisite for the Flow Tracker ([§3.14](prd.md#L300)), so it should land no later than that. |
| Account self-deletion and private-content cascade ([3.1.8](prd.md#L50)–[3.1.10](prd.md#L52)) | Becomes a store compliance requirement at [5.2.6](prd.md#L710); the cascade needs private content to exist, and none does yet. |
| Avatar ([3.1.12](prd.md#L54)) | Cosmetic until notes and SOS give it somewhere to show. |
| Background audio and lock-screen transport ([3.2.6](prd.md#L67)) | Deliberately held for the Capacitor shell, which [architecture.md § Client](architecture.md#L111) names as the only reliable route to it. |
| Replace audio on an existing recording ([3.2.10](prd.md#L71)) | Per-step re-run ([3.21.2.4](prd.md#L486)) covers failure recovery in the meantime. |
| Series cover artwork ([3.3.3](prd.md#L80)), reorder and merge ([3.3.6](prd.md#L83)), podcast-shaped metadata ([3.3.7](prd.md#L84)), videos in the series view ([3.3.8](prd.md#L85)) | Artwork and podcast shape land together with distribution, which is what drives their real requirements. |
| Summary-ready notification ([3.6.3](prd.md#L129)) | Arrives with [§3.17](prd.md#L361); until then the queue is the signal. |
| Topics and tags ([4.7](prd.md#L568), the tag half of [4.17.1](prd.md#L681)) | Ship with search and cross-referencing, the features that consume them. |
| Remaining dashboard panels ([3.19.6](prd.md#L434)–[3.19.8](prd.md#L436), [3.19.10](prd.md#L438)–[3.19.12](prd.md#L440)) | Each arrives with its feature. |

## Slice flows

**A. Getting a member in.** Admin opens User management → enters an email and picks a role → invitee
receives an invitation → sets a password → signs in and lands on the library. Admin can revoke or
re-send before acceptance, and deactivate afterwards.
*Requirements: [3.1.3](prd.md#L45)–[3.1.7](prd.md#L49), [3.19.9](prd.md#L437).*

**B. Weekly upload to publish.** Admin uploads an audio file with a title and date
recorded → the recording appears in Pipeline status → the uploaded audio is transcribed
into timestamped segments → a draft summary and description are generated → the recording surfaces in
Pending Reviews → admin reads the summary, edits or regenerates it, approves, corrects the transcript
if a name is wrong, optionally assigns a series → admin publishes → the recording is live to every
member. Any failure stops the chain there and shows in Pipeline status with a re-run control.
*Requirements: [3.2.1](prd.md#L62), [3.5.1](prd.md#L112)–[3.5.2](prd.md#L113), [3.6.1](prd.md#L127)–[3.6.10](prd.md#L136),
[4.17.2](prd.md#L682)–[4.17.3](prd.md#L683), [3.2.2](prd.md#L63),
[3.21.2.1](prd.md#L483)–[3.21.2.4](prd.md#L486), [3.19.2](prd.md#L430)–[3.19.4](prd.md#L432).*

**C. A member listens.** Member signs in → library shows teachings newest first, grouped by series
→ opens a recording → reads the published summary → presses play, sets
1.25x → transcript scrolls along and highlights the current segment → taps a line further down and
the audio jumps there → closes the app mid-teaching → opens it on a laptop the next day and resumes
at the same second.
*Requirements: [3.3.1](prd.md#L78), [3.3.4](prd.md#L81), [3.2.3](prd.md#L64)–[3.2.5](prd.md#L66),
[3.2.9](prd.md#L70), [3.5.3](prd.md#L114)–[3.5.4](prd.md#L115), [3.6.7](prd.md#L133).*

**D. An admin corrects and republishes.** Admin spots a mangled name in a published transcript →
edits the segment text → is offered regeneration of the summary → accepts → reviews the new draft →
approves. Member progress and the recording's publication state are untouched throughout.
*Requirements: [3.5.5](prd.md#L116)–[3.5.6](prd.md#L117), [3.6.9](prd.md#L135),
[3.6.11](prd.md#L137).*

## Rationale

**Why this is the spine now.** Nothing is delivered, so remaining is full scope and the cut is
governed entirely by dependency structure. [prd.md § 1](prd.md#L8) names three problems: a teaching
is heard once and lost, members who miss a session fall out of a series, and insight has nowhere to
live. Only the first can be attacked without other features existing underneath it — and it is also
the one whose solution every other feature is built on top of. Transcript segments feed search,
cross-referencing, mind maps, video scripts, Flow Tracker and note anchors; the review gate is the
shape every AI artefact after this one passes through. Building either later means rebuilding what
was attached to it in the meantime.

**Why an AI summary is in and the other five derived artefacts are out.** The review gate at
[4.17.3](prd.md#L683) is a structure, not a feature, and it needs exactly one artefact to become
real. The summary is the cheapest of the six and the only one that delivers member value on its own
in a library of a handful of recordings — mind maps, tags, scripture links and cross-references all
get materially better as the corpus grows, so they are worth more in a later slice than they are now.

**Why audio processing is out, and what that costs.** [§3.4](prd.md#L88) is deferred by decision:
the sound profile is a self-contained worker job that reads a file this slice already retains and
writes one this slice already knows how to serve, so it attaches cleanly later and nothing about the
slice is shaped around its absence. Two consequences are worth stating plainly rather than
discovering during the build. First, [3.4.1](prd.md#L94)'s "processed before available for playback"
does not hold in slice 01 — members hear whatever was uploaded, inconsistent levels included, which
is the exact complaint [§3.4](prd.md#L88) exists to answer. Second, ASR accuracy is a function of
input quality, so transcripts in this slice will be somewhat worse than they will be once processing
lands, and the recordings uploaded before then are worth re-transcribing afterwards. Both are
recoverable precisely because the original upload is retained ([3.4.9](prd.md#L102)); neither is
recoverable if the originals are ever discarded, which makes that the one non-negotiable in this
area.

**Why cross-referencing and search are out despite being the product's identity.** Both are
segment-level operations over a library that, at the end of this slice, contains a few weeks of
teaching. Semantic search across five recordings is a worse experience than scrolling the list. They
become valuable precisely when the back catalogue lands — which is why they should ship near it, not
before it.

**Why offline and the app stores are out despite being called first-class.** [§3.18](prd.md#L391)
is explicit that offline is a core mode, not a fallback, and this slice does not deliver it. It is
deferred rather than dismissed: because playback speed and position are client-owned state synced to
the API from day one, and because the API is the only place authorisation is decided, offline
downloads and Capacitor packaging are additive over this slice's contract. That is the specific check
that this cut is not a dead end.

**What would make this a throwaway, and why it isn't.** Three things would force a later rewrite:
transcribing without segment timestamps, publishing content without a review gate, or putting
authorisation in the client. All three are in scope here for exactly that reason. The cost of
including them now is small; the cost of retrofitting any of them is most of the codebase.

## Duplicate & reference audit

Every citation above was resolved against the live line in `prd.md` and `architecture.md` before
this table was written.

| Fact | Defined at | Also defined at | Recommended owner |
| :---- | :---- | :---- | :---- |
| The weekly pipeline's step sequence | [3.21.1](prd.md#L463) | [slice-prd.md § What the slice is](slice-prd.md#L11) — names steps 2, 4, 5, 8, 9 | [3.21.1](prd.md#L463) — the slice cites step numbers rather than restating the table; no change needed |
| How long an invitation stays valid | — | [3.1.4](prd.md#L46) says "a fixed window" | nothing defines it — **ask**. Small, but slice 01 is where it becomes real |
| Which audio formats and what maximum upload size are accepted | — | [3.2.1](prd.md#L62) says "the common formats produced by consumer and semi-professional capture equipment" | nothing defines it — **ask**. Determines the upload path and the ASR adapter |
| Regeneration cascade on transcript correction | [3.5.6](prd.md#L117) | [slice-prd.md § In scope → 6](slice-prd.md#L132) — narrowed to the summary | [3.5.6](prd.md#L117) — the slice narrows the list to artefacts that exist, and the full list returns as each artefact ships |

No mis-pointed references found. No stale "still remaining" entries — nothing has been delivered, so
every entry is genuinely outstanding.
