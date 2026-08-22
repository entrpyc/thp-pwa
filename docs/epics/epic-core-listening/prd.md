# Teaching Hub — Epic PRD: core-listening

## Builds on

Nothing — this is the first epic. The repository holds the full-scope PRD
([project prd](docs/project/prd.md)) and the north-star architecture ([project architecture](docs/project/architecture.md)) and no
application code. Remaining is therefore the whole of [§3](docs/project/prd.md#L29), and this epic cuts through
every layer of the system described in [project architecture § Overview](docs/project/architecture.md#L8) for the
first time.

## What the epic is

A private, invite-only web app where a teaching stops being lost after one hearing.

An admin invites a member by email; the member sets a password and signs in. An admin
uploads a recording, and it runs itself through the pipeline unattended — transcribed into
timestamped segments, then written up as a draft summary and description. The audio itself is
served exactly as uploaded; cleaning and levelling it ([§3.4](docs/project/prd.md#L94)) is a later epic.
Nothing reaches a member on its own: the admin opens a Pending Reviews queue, reads what
the AI produced, edits or regenerates it, and publishes. From that moment every member sees the
teaching in a date-ordered library, plays it at their chosen speed, picks up exactly where they left
off on any device they sign in from, scrubs to any moment, and reads the transcript scrolling along
with the audio.

This is steps 2, 4, half of 5, 8 and 9 of the weekly pipeline at [3.21.1](docs/project/prd.md#L474), with step 12
reduced to listening — step 3 is out with [§3.4](docs/project/prd.md#L94). It is the smallest thing that is
simultaneously a real member product and a real content studio — and it establishes the two
structures every later epic depends on: the
**timestamped segment** as the atom of the system ([project architecture § Overview](docs/project/architecture.md#L8)),
and the **draft-then-admin-review gate** ([4.17.3](docs/project/prd.md#L701)) that every AI artefact after this
one will pass through.

## In scope — core features

### 1. Accounts, invitation and roles

*In the spine because [3.1.2](docs/project/prd.md#L44) puts every single thing in this product behind it. There is
no version of this app without auth.*

- Individual email/password accounts ([3.1.1](docs/project/prd.md#L43)) with every request authenticated
  ([3.1.2](docs/project/prd.md#L44)).
- Admin-issued invitations with role assignment, expiry, revoke and re-send
  ([3.1.3](docs/project/prd.md#L45)–[3.1.4](docs/project/prd.md#L46)).
- Two of the three roles from [§3.1](docs/project/prd.md#L31) — **Admin** and **Member** — enforced server-side on
  every request, not only in the interface ([3.1.5](docs/project/prd.md#L47)). **Contributor is deferred**: every
  capability it would hold in this epic (upload, transcript correction, series management) is
  Admin-only for now, so the epic ships one privileged role rather than two.
- Self-service password reset by email ([3.1.6](docs/project/prd.md#L48)), account deactivation
  ([3.1.7](docs/project/prd.md#L49)), and the last-admin guard ([3.1.11](docs/project/prd.md#L53)).
- A profile carrying display name ([3.1.12](docs/project/prd.md#L54)); avatar deferred.

### 2. Upload and the automated pipeline to draft

*The engine room. [3.5.2](docs/project/prd.md#L119) is named in the PRD as the hinge of the whole product and in
[project architecture § Data model](docs/project/architecture.md#L171) as the atom of the data model — building it
later would mean rebuilding everything attached to it.*

- Audio upload, Admin-only in this epic — the Contributor half of [3.2.1](docs/project/prd.md#L64) arrives with
  the role.
- **The uploaded file is stored as-is and streamed as-is.** [§3.4](docs/project/prd.md#L94) audio processing is
  out of this epic in its entirety, which means the ordering in [3.4.1](docs/project/prd.md#L100) — processed
  before available for playback — is deliberately not met here: members hear the raw recording. The
  upload is retained unmodified regardless ([3.4.9](docs/project/prd.md#L108)), so it is the input the processing
  job reads when [§3.4](docs/project/prd.md#L94) lands, and nothing has to be re-uploaded.
- **Transcription triggers on upload completing**, not on processing completing — the one place this
  epic narrows [3.5.1](docs/project/prd.md#L118). It produces timestamped segments and records the detected
  language ([3.5.2](docs/project/prd.md#L119), [3.5.7](docs/project/prd.md#L124)).
- The pipeline runs unattended and produces drafts only
  ([3.21.2.1](docs/project/prd.md#L494)–[3.21.2.2](docs/project/prd.md#L495)) — narrowed here to step 4 and the summary half
  of step 5, since audio processing, mind maps, cross-references, tags and scripture references are
  all out.
- A failure halts that recording's chain and flags it rather than publishing partial results
  ([3.21.2.3](docs/project/prd.md#L496), [3.5.8](docs/project/prd.md#L125) — [3.4.11](docs/project/prd.md#L110)'s processing-failure case
  has nothing to fire on yet), and an admin can re-run a step without re-running the pipeline
  ([3.21.2.4](docs/project/prd.md#L497)).

### 3. AI summary and description behind the review gate

*One derived artefact is enough to make the review gate real. Chosen over mind maps, tags or
scripture references because it carries the most member value per unit of build — a member who missed
a session finds out what it was about — and because it is the artefact [3.21.1](docs/project/prd.md#L474) step 5
puts first.*

- One draft summary per recording, generated on transcription completion, never member-visible while
  draft ([3.6.1](docs/project/prd.md#L135)–[3.6.2](docs/project/prd.md#L136)).
- An AI-suggested description on the recording ([4.17.1](docs/project/prd.md#L699)) — topics, tags and scripture
  references deferred with the features they exist to power.
- Review from the Pending Reviews queue and from the recording page as an admin
  ([3.6.4](docs/project/prd.md#L138)), showing title, date and word count ([3.6.5](docs/project/prd.md#L139)).
- All four review actions: approve, edit-then-approve, regenerate with an optional steering prompt,
  discard ([3.6.6](docs/project/prd.md#L140)–[3.6.10](docs/project/prd.md#L144)); plus post-publish edit and unpublish
  ([3.6.11](docs/project/prd.md#L145)–[3.6.12](docs/project/prd.md#L146)). The in-app "ready for review" notification
  ([3.6.3](docs/project/prd.md#L137)) is deferred with [§3.17](docs/project/prd.md#L371); the queue is how an admin finds work
  in this epic.
- Per-field accept/edit/discard in the review form ([4.17.2](docs/project/prd.md#L700)), with each AI-suggested
  field recording that it was AI-suggested and whether an admin changed it
  ([4.17.5](docs/project/prd.md#L703)).
- Nothing publishes automatically ([4.17.3](docs/project/prd.md#L701)).

### 4. Publish, unpublish and series

*Publishing is the gate itself. Series is in because [3.3.1](docs/project/prd.md#L83) alone gives an
undifferentiated list, and a member who fell out of a series — the exact person the product exists
for — needs the series to exist to find their way back.*

- Explicit admin publish ([3.2.2](docs/project/prd.md#L65)) and unpublish without deletion
  ([3.2.11](docs/project/prd.md#L74)).
- Date-ordered browsing, newest first ([3.3.1](docs/project/prd.md#L83)), including recordings with no series
  ([3.3.9](docs/project/prd.md#L91)).
- Named series with at most one per recording ([3.3.2](docs/project/prd.md#L84)); a series view listing its
  recordings chronologically with the member's progress on each ([3.3.4](docs/project/prd.md#L86)); series title,
  description, date range and count ([3.3.5](docs/project/prd.md#L87)) minus cover artwork.
- Admins create, rename and move a recording between series without losing metadata or member
  progress (the create/rename/move part of [3.3.6](docs/project/prd.md#L88); reorder, merge and the Contributor
  half deferred).

### 5. The player

*What the member actually came for, and the reason [3.2.5](docs/project/prd.md#L68) cannot wait: resume-anywhere
is what makes a 90-minute teaching consumable across a week of commutes.*

- Stream any published recording ([3.2.3](docs/project/prd.md#L66)).
- Speed control across all six steps, persisting across recordings for that user
  ([3.2.4](docs/project/prd.md#L67)).
- Per-user, per-recording playback position, resuming on any device that user signs in from
  ([3.2.5](docs/project/prd.md#L68)).
- Scrubbing to any position ([3.2.9](docs/project/prd.md#L72)).
- Listening history ([3.2.7](docs/project/prd.md#L70)) and the completed marker ([3.2.8](docs/project/prd.md#L71)) are out.
  Resume position ([3.2.5](docs/project/prd.md#L68)) is the only playback state this epic keeps — enough to pick
  a teaching back up, not enough to tell a member which ones they have finished.

### 6. Follow-along transcript

*The cheapest possible proof that the segment model works end to end, and the first place a member
touches it.*

- The transcript readable on the recording page, highlighting the currently spoken segment as
  playback moves ([3.5.3](docs/project/prd.md#L120)).
- Selecting any point in the transcript seeks the audio there ([3.5.4](docs/project/prd.md#L121)).
- Admin-only transcript correction ([3.5.5](docs/project/prd.md#L122) minus its Contributor half), which is in
  scope because the transcript is member-visible from this epic and ministry names will be wrong
  without it.
  [3.5.6](docs/project/prd.md#L123)'s regeneration offer is narrowed to the summary — the other derived artefacts
  it names do not exist yet.

### 7. Minimal admin dashboard

*The operator surface for everything above. Scoped strictly to the capabilities this epic ships —
each later epic adds its own panel.*

- An Admin-only dashboard — [3.19.1](docs/project/prd.md#L439)'s per-role gating has nothing to gate until the
  Contributor role exists, so this epic ships one flat operator surface behind an admin check.
- Pending Reviews, carrying draft summaries and suggested metadata only
  ([3.19.2](docs/project/prd.md#L440)).
- Upload, the metadata review form and the publish action ([3.19.3](docs/project/prd.md#L441)).
- Pipeline status — which recordings are transcribing or generating, and which have failed
  ([3.19.4](docs/project/prd.md#L442) minus its processing column).
- Series management minus artwork upload ([3.19.5](docs/project/prd.md#L443)).
- User management: invitations, roles, deactivation, member list ([3.19.9](docs/project/prd.md#L447)).

### 8. Platform baseline

- Responsive across phone, tablet and desktop from one codebase — the responsive row of
  [§5.1](docs/project/prd.md#L723) — delivered as a browser web app.
- The API-first boundary from [§6](docs/project/prd.md#L758): the client holds no authorisation decision, so the
  store builds added later are the same client against the same contract
  ([5.2.2](docs/project/prd.md#L740)).
- Media never publicly addressable; every read a short-lived signed URL issued after an
  authorisation check ([§6](docs/project/prd.md#L758) Security).

## Still remaining after this epic

**Whole features not started**

| Full-scope feature | How it attaches later |
| :---- | :---- |
| [§3.4](docs/project/prd.md#L94) Audio processing & quality | A worker job reading the retained originals ([3.4.9](docs/project/prd.md#L108)) and writing a processed rendition that becomes the streamed file, plus the sound profile and its admin UI ([3.4.5](docs/project/prd.md#L104)–[3.4.8](docs/project/prd.md#L107)) and the processing-failure flag ([3.4.11](docs/project/prd.md#L110)). Slot it before podcast distribution, which depends on [3.4.10](docs/project/prd.md#L109). Existing recordings are back-filled by running the job over the library, and are worth re-transcribing afterwards since [§3.5](docs/project/prd.md#L112) reads cleaner audio more accurately. |
| [§3.7](docs/project/prd.md#L150) Scripture references | A third derived artefact through the same pipeline fan-out and the same review gate this epic builds; structured citations hang off the recording. |
| [§3.8](docs/project/prd.md#L164) Mind maps | Recording maps are another pipeline artefact behind the same gate; personal maps are a new member-owned entity generated from the segments this epic already stores. |
| [§3.9](docs/project/prd.md#L189) Intelligent cross-referencing | Adds an embedding column and an edge table over segments that already exist — no re-transcription. Ships with search, since [project architecture § Key technology choices](docs/project/architecture.md#L209) makes them one capability. |
| [§3.10](docs/project/prd.md#L204) Semantic search | The same vector index as cross-referencing, plus full-text over the transcripts, summaries and titles this epic populates. |
| [§3.11](docs/project/prd.md#L222) AI video generation | Reads the segmented transcript this epic produces and reuses the draft/approve pattern of [3.6.6](docs/project/prd.md#L140). |
| [§3.12](docs/project/prd.md#L267) Timestamp notes | Anchors to the playback position the player already tracks; markers hang on the progress bar built here. |
| [§3.13](docs/project/prd.md#L291) Reflective questionnaires | A new admin-authored entity attached to the recording page below the summary. |
| [§3.14](docs/project/prd.md#L310) Flow tracker | Depends on cross-referencing ([3.9.8](docs/project/prd.md#L202)) and on listening history ([3.2.7](docs/project/prd.md#L70)), which is itself deferred — so this is at least two epics out. |
| [§3.15](docs/project/prd.md#L328) Highlights playlist | Pins the `(recording, timestamp)` pair the player already resolves; needs notes for [3.15.3](docs/project/prd.md#L336). |
| [§3.16](docs/project/prd.md#L344) SOS signal | Independent of the content pipeline; needs only accounts and, to be useful, notifications. |
| [§3.17](docs/project/prd.md#L371) Notifications | Fans out per recipient off events this epic already emits — publish, transcription failure, summary ready. Push delivery pairs naturally with the store packaging epic. |
| [§3.18](docs/project/prd.md#L401) Offline support & downloads | Client-side cache and outbox over the API contract this epic defines; the playback state at [3.2.5](docs/project/prd.md#L68) is already client-owned, which is what makes [3.18.14](docs/project/prd.md#L429) an addition rather than a rewrite. |
| [§3.20](docs/project/prd.md#L453) External distribution | Podcast feed regenerates from series metadata and the processed audio this epic produces; needs [3.3.3](docs/project/prd.md#L85) artwork and [3.3.7](docs/project/prd.md#L89) podcast-shaped metadata first. |
| [3.21.3](docs/project/prd.md#L502) Back-catalogue processing | Bulk entry and bulk review over the identical pipeline — the per-recording path has to exist and be trusted first. |
| [§5.2](docs/project/prd.md#L735) App store distribution | Capacitor wraps the same web build; brings background audio ([3.2.6](docs/project/prd.md#L69)), push ([5.2.5](docs/project/prd.md#L743)) and non-evictable download storage with it, and forces account self-deletion ([5.2.6](docs/project/prd.md#L744)). |
| PWA installability and service worker ([§5.1](docs/project/prd.md#L723)) | Manifest and service worker over the responsive app this epic ships; pairs with offline. |

**Left out of features this epic touches**

| Deferred | How it attaches later |
| :---- | :---- |
| The **Contributor** role ([§3.1](docs/project/prd.md#L31)) and every "and Contributors" clause that depends on it — upload ([3.2.1](docs/project/prd.md#L64)), transcript correction ([3.5.5](docs/project/prd.md#L122)), series management ([3.3.6](docs/project/prd.md#L88)), the role-gated dashboard ([3.19.1](docs/project/prd.md#L439)) | Adding a third role to a permission model that is already enforced server-side per request, then widening the four capabilities above from admin-only to admin-or-contributor. Cheap precisely because [3.1.5](docs/project/prd.md#L47) is in scope now — the check exists, it gains a case. Also unlocks the Contributor-only capabilities of later epics: video generation ([3.11.1.3](docs/project/prd.md#L230)) and mind map curation ([3.8.2](docs/project/prd.md#L173)). |
| Listening history ([3.2.7](docs/project/prd.md#L70)) and the completed marker ([3.2.8](docs/project/prd.md#L71)) | Both are reads over per-user playback state this epic already writes ([3.2.5](docs/project/prd.md#L68)) — history adds an append-only play log, the marker adds a completion threshold and a badge in the browse list. Listening history is a prerequisite for the Flow Tracker ([§3.14](docs/project/prd.md#L310)), so it should land no later than that. |
| Account self-deletion and private-content cascade ([3.1.8](docs/project/prd.md#L50)–[3.1.10](docs/project/prd.md#L52)) | Becomes a store compliance requirement at [5.2.6](docs/project/prd.md#L744); the cascade needs private content to exist, and none does yet. |
| Avatar ([3.1.12](docs/project/prd.md#L54)) | Cosmetic until notes and SOS give it somewhere to show. |
| Background audio and lock-screen transport ([3.2.6](docs/project/prd.md#L69)) | Deliberately held for the Capacitor shell, which [project architecture § Client](docs/project/architecture.md#L111) names as the only reliable route to it. |
| Replace audio on an existing recording ([3.2.10](docs/project/prd.md#L73)) | Per-step re-run ([3.21.2.4](docs/project/prd.md#L497)) covers failure recovery in the meantime. |
| Series cover artwork ([3.3.3](docs/project/prd.md#L85)), reorder and merge ([3.3.6](docs/project/prd.md#L88)), podcast-shaped metadata ([3.3.7](docs/project/prd.md#L89)), videos in the series view ([3.3.8](docs/project/prd.md#L90)) | Artwork and podcast shape land together with distribution, which is what drives their real requirements. |
| Summary-ready notification ([3.6.3](docs/project/prd.md#L137)) | Arrives with [§3.17](docs/project/prd.md#L371); until then the queue is the signal. |
| Topics and tags ([4.7](docs/project/prd.md#L586), the tag half of [4.17.1](docs/project/prd.md#L699)) | Ship with search and cross-referencing, the features that consume them. |
| Remaining dashboard panels ([3.19.6](docs/project/prd.md#L444)–[3.19.8](docs/project/prd.md#L446), [3.19.10](docs/project/prd.md#L448)–[3.19.12](docs/project/prd.md#L450)) | Each arrives with its feature. |

## Epic flows

**A. Getting a member in.** Admin opens User management → enters an email and picks a role → invitee
receives an invitation → sets a password → signs in and lands on the library. Admin can revoke or
re-send before acceptance, and deactivate afterwards.
*Requirements: [3.1.3](docs/project/prd.md#L45)–[3.1.7](docs/project/prd.md#L49), [3.19.9](docs/project/prd.md#L447).*

**B. Weekly upload to publish.** Admin uploads an audio file with a title and date
recorded → the recording appears in Pipeline status → the uploaded audio is transcribed
into timestamped segments → a draft summary and description are generated → the recording surfaces in
Pending Reviews → admin reads the summary, edits or regenerates it, approves, corrects the transcript
if a name is wrong, optionally assigns a series → admin publishes → the recording is live to every
member. Any failure stops the chain there and shows in Pipeline status with a re-run control.
*Requirements: [3.2.1](docs/project/prd.md#L64), [3.5.1](docs/project/prd.md#L118)–[3.5.2](docs/project/prd.md#L119), [3.6.1](docs/project/prd.md#L135)–[3.6.10](docs/project/prd.md#L144),
[4.17.2](docs/project/prd.md#L700)–[4.17.3](docs/project/prd.md#L701), [3.2.2](docs/project/prd.md#L65),
[3.21.2.1](docs/project/prd.md#L494)–[3.21.2.4](docs/project/prd.md#L497), [3.19.2](docs/project/prd.md#L440)–[3.19.4](docs/project/prd.md#L442).*

**C. A member listens.** Member signs in → library shows teachings newest first, grouped by series
→ opens a recording → reads the published summary → presses play, sets
1.25x → transcript scrolls along and highlights the current segment → taps a line further down and
the audio jumps there → closes the app mid-teaching → opens it on a laptop the next day and resumes
at the same second.
*Requirements: [3.3.1](docs/project/prd.md#L83), [3.3.4](docs/project/prd.md#L86), [3.2.3](docs/project/prd.md#L66)–[3.2.5](docs/project/prd.md#L68),
[3.2.9](docs/project/prd.md#L72), [3.5.3](docs/project/prd.md#L120)–[3.5.4](docs/project/prd.md#L121), [3.6.7](docs/project/prd.md#L141).*

**D. An admin corrects and republishes.** Admin spots a mangled name in a published transcript →
edits the segment text → is offered regeneration of the summary → accepts → reviews the new draft →
approves. Member progress and the recording's publication state are untouched throughout.
*Requirements: [3.5.5](docs/project/prd.md#L122)–[3.5.6](docs/project/prd.md#L123), [3.6.9](docs/project/prd.md#L143),
[3.6.11](docs/project/prd.md#L145).*

## Rationale

**Why this is the spine now.** Nothing is delivered, so remaining is full scope and the cut is
governed entirely by dependency structure. [project prd § 1](docs/project/prd.md#L8) names three problems: a teaching
is heard once and lost, members who miss a session fall out of a series, and insight has nowhere to
live. Only the first can be attacked without other features existing underneath it — and it is also
the one whose solution every other feature is built on top of. Transcript segments feed search,
cross-referencing, mind maps, video scripts, Flow Tracker and note anchors; the review gate is the
shape every AI artefact after this one passes through. Building either later means rebuilding what
was attached to it in the meantime.

**Why an AI summary is in and the other five derived artefacts are out.** The review gate at
[4.17.3](docs/project/prd.md#L701) is a structure, not a feature, and it needs exactly one artefact to become
real. The summary is the cheapest of the six and the only one that delivers member value on its own
in a library of a handful of recordings — mind maps, tags, scripture links and cross-references all
get materially better as the corpus grows, so they are worth more in a later epic than they are now.

**Why audio processing is out, and what that costs.** [§3.4](docs/project/prd.md#L94) is deferred by decision:
the sound profile is a self-contained worker job that reads a file this epic already retains and
writes one this epic already knows how to serve, so it attaches cleanly later and nothing about the
epic is shaped around its absence. Two consequences are worth stating plainly rather than
discovering during the build. First, [3.4.1](docs/project/prd.md#L100)'s "processed before available for playback"
does not hold in this epic — members hear whatever was uploaded, inconsistent levels included, which
is the exact complaint [§3.4](docs/project/prd.md#L94) exists to answer. Second, ASR accuracy is a function of
input quality, so transcripts in this epic will be somewhat worse than they will be once processing
lands, and the recordings uploaded before then are worth re-transcribing afterwards. Both are
recoverable precisely because the original upload is retained ([3.4.9](docs/project/prd.md#L108)); neither is
recoverable if the originals are ever discarded, which makes that the one non-negotiable in this
area.

**Why cross-referencing and search are out despite being the product's identity.** Both are
segment-level operations over a library that, at the end of this epic, contains a few weeks of
teaching. Semantic search across five recordings is a worse experience than scrolling the list. They
become valuable precisely when the back catalogue lands — which is why they should ship near it, not
before it.

**Why offline and the app stores are out despite being called first-class.** [§3.18](docs/project/prd.md#L401)
is explicit that offline is a core mode, not a fallback, and this epic does not deliver it. It is
deferred rather than dismissed: because playback speed and position are client-owned state synced to
the API from day one, and because the API is the only place authorisation is decided, offline
downloads and Capacitor packaging are additive over this epic's contract. That is the specific check
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
| The weekly pipeline's step sequence | [3.21.1](docs/project/prd.md#L474) | [epic prd § What the epic is](docs/epics/epic-core-listening/prd.md#L11) — names steps 2, 4, 5, 8, 9 | [3.21.1](docs/project/prd.md#L474) — the epic cites step numbers rather than restating the table; no change needed |
| How long an invitation stays valid | — | [3.1.4](docs/project/prd.md#L46) says "a fixed window" | nothing defines it — **ask**. Small, but this epic is where it becomes real |
| Which audio formats and what maximum upload size are accepted | — | [3.2.1](docs/project/prd.md#L64) says "the common formats produced by consumer and semi-professional capture equipment" | nothing defines it — **ask**. Determines the upload path and the ASR adapter |
| Regeneration cascade on transcript correction | [3.5.6](docs/project/prd.md#L123) | [epic prd § In scope → 6](docs/epics/epic-core-listening/prd.md#L132) — narrowed to the summary | [3.5.6](docs/project/prd.md#L123) — the epic narrows the list to artefacts that exist, and the full list returns as each artefact ships |

No mis-pointed references found. No stale "still remaining" entries — nothing has been delivered, so
every entry is genuinely outstanding.
