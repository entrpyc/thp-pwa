# Ticket 01–02 — Follow-along transcript, correction, and the regeneration offer
_Story: Follow the transcript while it plays_

> Phase 6 artefact for [implementation plan § Ticket 01](docs/epics/epic-core-listening/implementation-plan.md#L393)
> and [§ Ticket 02](docs/epics/epic-core-listening/implementation-plan.md#L407) — **both tickets of the story
> planned as one doc at the operator's instruction.** The plan cuts them in two; this doc puts them together
> and states the cost below rather than leaving it to be discovered at review. The criteria stay in two
> groups, in the plan's order, so the halves can still be read and run apart.
>
> Sections pulled, Ticket 01: [epic prd § In scope → 6](docs/epics/epic-core-listening/prd.md#L132);
> [3.5.3](docs/project/prd.md#L114); [3.5.4](docs/project/prd.md#L115);
> [epic prd § Epic flows → C](docs/epics/epic-core-listening/prd.md#L210);
> [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) —
> *`(recording_id, timestamp_ms)` offset*; `bottom-navigation/subtitles.png`, the `Transcript` tab in
> `pages/recording.png`.
> Ticket 02: [epic prd § In scope → 6](docs/epics/epic-core-listening/prd.md#L132);
> [3.5.5](docs/project/prd.md#L116) (**admin-only in this epic**);
> [3.5.6](docs/project/prd.md#L117) (**narrowed to the summary**);
> [epic prd § Epic flows → D](docs/epics/epic-core-listening/prd.md#L210);
> [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The spine*,
> the corrected-by fields on `segment`.
>
> Carried in because this story touches them: [3.5.2](docs/project/prd.md#L113) and
> [4.4](docs/project/prd.md#L539), the segmented, timestamped shape this story is the first reader of;
> [3.2.2](docs/project/prd.md#L63) and [3.2.11](docs/project/prd.md#L72), the gate every read here obeys;
> [3.6.12](docs/project/prd.md#L138), the second gate on the summary the regeneration path must not trip;
> [3.6.9](docs/project/prd.md#L135), the regeneration this one routes through;
> [3.6.11](docs/project/prd.md#L137), the reason a published summary is still editable;
> [3.6.4](docs/project/prd.md#L130), the precedent for an admin acting from the recording page;
> [3.1.2](docs/project/prd.md#L44) and [3.1.5](docs/project/prd.md#L47), the two rules every route here obeys;
> [4.17.3](docs/project/prd.md#L683) and [3.21.2.2](docs/project/prd.md#L484), why regeneration produces a
> draft rather than a summary; [4.17.5](docs/project/prd.md#L685), the provenance the new draft carries;
> [3.6.3](docs/project/prd.md#L129), the notification this story does **not** get;
> [§3.9](docs/project/prd.md#L179), [§3.10](docs/project/prd.md#L194), [§3.12](docs/project/prd.md#L257),
> [§3.14](docs/project/prd.md#L300) — the four later features that resolve through the offset this story
> makes real; [epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341);
> [epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255);
> [epic architecture § Next.js application — client half](docs/epics/epic-core-listening/architecture.md#L109);
> [project architecture § Data model](docs/project/architecture.md#L171);
> [implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L48);
> [implementation plan § Design references](docs/epics/epic-core-listening/implementation-plan.md#L81);
> [style-guide.md § Player](docs/design%20referencess%20png/style-guide.md#L173) and
> [§ Side toolbar](docs/design%20referencess%20png/style-guide.md#L202);
> [01-04-listen-to-a-teaching.md](docs/epics/epic-core-listening/stories/listen-to-a-teaching/01-04-listen-to-a-teaching.md)
> — the app-wide player this story attaches to;
> [01-04-review-and-publish.md](docs/epics/epic-core-listening/stories/review-and-publish-a-teaching/01-04-review-and-publish.md)
> — the review gate and the `generate_draft` step the offer routes through.

## Goal

The transcript becomes a thing a member reads rather than a thing the machine wrote. It renders on the
recording page, highlights the segment being spoken, scrolls itself, floats the current line as a caption
above the transport wherever the member is in the app, and seeks the audio when any line is selected. Then
an admin can fix what the machine misheard — text and timings — and is offered a regenerated summary built
on the corrected words.

- As a member I want to be able to read the transcript of a teaching while it plays, and see which line is
  being spoken right now
- As a member I want to be able to tap any line and have the audio jump there
- As a member I want to be able to keep seeing the current line as a caption after I have navigated away
  from the recording page
- As an admin I want to be able to correct a misheard name, citation or timing in a published transcript
- As an admin I want to be offered a fresh summary after I correct the transcript, without the live one
  disappearing while the new draft is written

**Four things worth naming before the criteria.**

**One diff, two tickets.** The plan cuts these apart because each is independently reviewable — a member
read surface, and an admin write. Merged at the operator's instruction, the review cost is real: the
transcript payload shape decided in group 1 is what group 2 writes back to, and a doubt about it reaches
both. The mitigation is that the criteria stay in two groups and each group is separately runnable — group
1 ships a working follow-along transcript with no write path at all.

**This is where `(recording_id, timestamp_ms)` stops being a schema comment.**
[epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) names this pair
as the seam notes ([§3.12](docs/project/prd.md#L257)), cross-references ([§3.9](docs/project/prd.md#L179)),
search ([§3.10](docs/project/prd.md#L194)) and the Flow Tracker ([§3.14](docs/project/prd.md#L300)) all
resolve "open at the moment" through. So *which segment covers this offset* is a **pure function in its own
module**, unit-tested against a segment list, and the transcript view and the caption pill both call it. It
is deliberately not a `find` inlined in a component, because the next four features would each write their
own.

**Timings are editable, and that is the decision with the sharpest edge.** The operator chose text **and**
timings, which means an offset a member has already seeked to can move under them. The containment is that
a correction is refused unless it stays inside its neighbours — `startMs >= previous.endMs` and
`endMs <= next.startMs` — so the transcript's order can never change and the `(transcript_id, start_ms)`
index stays the ordering it claims to be. Gaps are allowed; overlaps are not. `speaker` stays uneditable:
it is the provider's anonymous index, not a label, and no epic has asked for a labelling surface.

**The live summary never goes dark.** Regeneration after a correction produces a **new open draft** through
the existing `generate_draft` step and the existing Pending Reviews queue. The published summary stays
visible to members the whole time, and is replaced only when an admin approves the new draft — the same
press that publishes any other summary. Nothing about this path publishes automatically
([4.17.3](docs/project/prd.md#L683)), and nothing about it touches `recording.published_at`.

## Out of scope

**The rest of the recording page's tab strip.** `Chapter`, `Scripture`, `Notes` and `Mindmap` have no data
in this epic. The strip arrives here holding **one** tab — `Transcript` — rather than five that lead
nowhere, and a deferred destination is dropped rather than rendered disabled, which is the line
[01-04-listen-to-a-teaching.md](docs/epics/epic-core-listening/stories/listen-to-a-teaching/01-04-listen-to-a-teaching.md)
already drew for the whole member surface.

**The rest of the `···` side toolbar.** `bottom-navigation/menu-opened.png` shows seven icons — chapters,
mind map, a list, an AI action, text size, notes, and CC. **Only CC has data.** The toolbar ships with that
one item; the other six are their own features' work.

**The rest of transcript correction.** Splitting, merging, inserting or deleting a segment. Editing
`speaker`, or naming one. Correcting a transcript on an **unpublished** recording — settled below as
published-only, so no admin transcript surface and no `?surface=` parameter on the transcript route.
Bulk find-and-replace across a transcript. A revision history of corrections beyond the single
`corrected_at` / `corrected_by_user_id` pair the row already carries.

**The rest of [3.5.6](docs/project/prd.md#L117).** Mind maps, scripture references, tags and
cross-references do not exist, so the offer is the summary and nothing else — which the plan already
narrowed. The Contributor half of [3.5.5](docs/project/prd.md#L116) is deferred with the role.

**Deferred behaviour a reasonable implementer would reach for here.** A `text` column on `transcript`
holding the joined transcript — Story 2 Ticket 03 deliberately did not write one, and correction is exactly
the reader that would have to keep a copy in step. Persisting the caption on/off choice to `user` — that is
a preferences column nobody asked for, and playback speed is the only preference this epic keeps. Notifying
the admin when the regenerated draft is ready ([3.6.3](docs/project/prd.md#L129)) — that arrives with
[§3.17](docs/project/prd.md#L361); until then the Pending Reviews queue is the signal. Transcript search,
pagination, download or export. A `duration` column — `packages/db/tests/integration/migrations.test.ts`
asserts its absence. An embedding column on `segment`. A fifth entry on the unauthenticated allowlist.

## User prerequisites

- **At least one published recording in the validation environment with a real transcript behind it** —
  several minutes long and more than a handful of segments. Follow-along highlighting, auto-scroll and the
  neighbour-overlap rules cannot be exercised against a two-segment fixture.
- **A working `generate` provider key in that environment.** The regeneration offer is only half-validated
  if the enqueued job cannot produce a draft; the queue accepting the job is not the same as the offer
  working.

## Acceptance criteria

### Group 1 — Follow-along transcript (plan Ticket 01)

- **A signed-in member can read the transcript of a published teaching; an unpublished id and a nonexistent
  id are refused identically** — verified by `packages/web/tests/integration/transcript.test.ts`, which
  fetches a published id, an unpublished id and a made-up id and asserts the payload and the two matching
  refusals.
  - A `GET /api/v1/recordings/{id}/transcript` route behind the existing `recording.browse` action.
  - The published gate is read through `packages/db/src/visibility.ts` — no second `published_at`
    comparison is written, which `tests/guards/visibility-boundary.test.ts` already enforces.
  - The payload is the whole transcript in one response: ~900 segments for a 90-minute teaching is one
    read, and pagination would be machinery with no reader.
  - Each segment carries `id`, `startMs`, `endMs`, `text` and `speaker`; `correctedAt` and
    `correctedByUserId` are not on the member shape, because who fixed a line is not a member's business.

- **The recording page carries a tab strip holding one tab, `Transcript`, and the segments render in
  playback order** — verified by `packages/web/tests/integration/transcript-screen.test.ts`, which signs in
  as a member, opens a published recording in a real browser, and asserts the tab and the segment order.
  - The strip is composed from `pages/recording.png` — same pill shape, same spacing — with the four
    deferred tabs dropped rather than disabled.
  - Order is the query's, by `(transcript_id, start_ms)`, so the screen and the database give one answer.
  - A published recording with no transcript renders the tab with an empty state rather than failing the
    page.

- **`segmentAt` answers which segment covers a given offset, for every offset including gaps, the exact
  boundary and past the end** — verified by `packages/web/tests/unit/current-segment.test.ts`, which drives
  a known segment list across those cases.
  - A pure function in `packages/web/src/client/transcript/current-segment.ts`, the same shape
    `packages/web/src/client/playback/cadence.ts` already set: the decision is testable without a clock, an
    element or a browser.
  - `startMs` inclusive, `endMs` exclusive, matching what the shared `Segment` type already documents.
  - An offset inside a gap answers *no segment* rather than the nearest one — a silence is a real answer.
  - Binary search rather than a scan, because it runs on every `timeupdate`.

- **The segment being spoken is highlighted as playback moves, and the highlight follows a seek** —
  verified by `packages/web/tests/integration/transcript-screen.test.ts`, which plays, asserts the
  highlighted line, scrubs to a known offset and asserts the highlight moved.
  - Driven off the player context's existing `currentMs`, which is already updated from `timeupdate` and
    `seeked` — no second timer and no second source of position.
  - The highlight is the style guide's accent treatment on the row, not a colour invented here.

- **Selecting any line seeks the audio to that segment's start** — verified by
  `packages/web/tests/integration/transcript-screen.test.ts`, which clicks a line and asserts the element's
  position and the transport's elapsed reading both moved to it.
  - The line is a real button, so the transcript is walkable and operable from a keyboard.
  - It calls the player context's existing `seekToMs` — the transcript does not touch the element.
  - Selecting a line does not start playback: a member reading a paused teaching has not asked for sound,
    which is the same rule opening a recording already follows.

- **The transcript keeps the current line in view by itself, and stops fighting a member who scrolls** —
  verified by `packages/web/tests/integration/transcript-screen.test.ts`, which asserts the view follows the
  highlight, that a manual scroll suspends the following, and that selecting a line resumes it.
  - Auto-scroll is suspended by a member-initiated scroll and resumed by selecting any line or pressing the
    *Jump to current* control the suspension reveals.
  - Scrolling caused by the auto-scroll itself does not count as a member scroll.

- **Captions can be turned on from the transport's `···` menu, and the current line floats as a pill above
  the bar on any member screen** — verified by
  `packages/web/tests/integration/transcript-screen.test.ts`, which turns captions on, navigates away from
  the recording page while playing, and asserts the pill is still showing the current line.
  - The `···` control opens the side toolbar of `bottom-navigation/menu-opened.png`, holding one item.
  - The pill is `bottom-navigation/subtitles.png` and
    [style-guide.md § Player](docs/design%20referencess%20png/style-guide.md#L173)'s floating pill — surface
    fill, muted text, trailing `×` that dismisses it.
  - Captions default to off, and the choice is client state for the session — nothing is written to `user`.
  - A gap between segments shows no pill rather than the previous line held over.

- **The transcript is fetched once per loaded recording and only when something needs it** — verified by
  `packages/web/tests/integration/transcript-screen.test.ts`, which counts the transcript request across
  opening a recording, opening the tab, and navigating away and back.
  - The player provider owns it, beside the grant, because the caption pill outlives the recording page.
  - Fetched on first need — captions turned on, or the tab mounted — not on open; a member who does neither
    downloads nothing.
  - Cleared when a different recording is opened, so the pill can never caption the wrong teaching.

- **Every route added by this group refuses an anonymous caller** — verified by the existing
  `packages/web/tests/integration/route-sweep.test.ts`.
  - The route declares its access as `apiRoute`'s first argument; nothing is added to
    `UNAUTHENTICATED_ROUTES`.

### Group 2 — Correction and the regeneration offer (plan Ticket 02)

- **An admin can correct a segment's text and its timings on a published recording, and a member reading
  the transcript afterwards sees the corrected words** — verified by
  `packages/web/tests/integration/transcript-correction.test.ts`, which corrects a segment as an admin and
  re-reads the transcript as a member.
  - A `PATCH /api/v1/recordings/{id}/transcript/segments/{segmentId}` route behind a new
    `transcript.correct` policy action, accepting `text`, `startMs` and `endMs`.
  - `corrected_at` and `corrected_by_user_id` are written on every accepted correction — the two columns
    Story 2 shipped unwritten.
  - `speaker` is not accepted; a request carrying it is refused rather than silently ignored.
  - The write goes through `packages/db/src/transcripts.ts`, which is the only place segment queries are
    written.

- **A correction that would cross a neighbour, invert its own bounds, go negative or empty the line is
  refused, and the transcript is left exactly as it was** — verified by
  `packages/web/tests/integration/transcript-correction.test.ts`, which drives each of the five refusals and
  re-reads the segment after every one.
  - `startMs >= 0`, both integers, and `startMs < endMs`.
  - `startMs >= previous.endMs` and `endMs <= next.startMs` within the same transcript; the first segment's
    floor is `0` and the last has no ceiling, because nothing in this epic stores a duration.
  - Gaps are allowed — a widened gap is a legitimate correction, an overlap is not.
  - `text` must be non-empty after trimming, with the same field ceiling the review gate already uses.
  - The neighbour read and the update happen in one transaction, so two corrections landing together
    cannot cross each other.

- **A member is refused by the API, and never shown the affordance** — verified by
  `packages/web/tests/integration/transcript-correction.test.ts` for the refusal and
  `packages/web/tests/integration/transcript-correction-screen.test.ts` for the absence.
  - `transcript.correct` is added to `POLICY_ACTIONS` and answers per role, so the exhaustiveness check
    keeps it honest when Contributor arrives — which is the whole of what widening this action later costs.
  - The client hides the edit control; the API is what refuses it, per the standing constraint.

- **The policy module denies both new actions by default and answers exhaustively over roles** — verified
  by the existing `packages/web/tests/unit/policy.test.ts`.
  - `transcript.correct` and `summary.regenerate` are added to the table rather than checked at a call site.

- **Saving a correction offers a regenerated summary; declining does nothing at all** — verified by
  `packages/web/tests/integration/transcript-correction-screen.test.ts`, which corrects a segment, dismisses
  the offer, and asserts no job was enqueued and no review item was created.
  - The offer appears after the correction is saved, never before, and never fires by itself
    ([3.5.6](docs/project/prd.md#L117) offers; it does not act).
  - It names the summary and nothing else, because nothing else derived from the transcript exists yet.

- **Accepting the offer enqueues one `generate_draft` for the summary, and the resulting draft lands in
  Pending Reviews where the existing approve press publishes it over the old summary** — verified by
  `packages/web/tests/integration/transcript-correction.test.ts`, which accepts, runs the worker, asserts
  one open `review_item` of kind `summary`, approves it, and asserts the member-visible summary changed.
  - A `POST /api/v1/recordings/{id}/summary/regenerate` route behind a new `summary.regenerate` action,
    enqueuing through the existing queue port with `{ kinds: ['summary'] }`.
  - The worker's existing `replaceOpenDrafts` is what makes a repeated dispatch leave one draft, and the
    generated draft carries the AI-suggested provenance every draft carries
    ([4.17.5](docs/project/prd.md#L685)).
  - Nothing in this path writes `summary.published_at` — approving does, exactly as it already does.

- **The published summary stays visible to members from the moment the offer is accepted until the new
  draft is approved** — verified by `packages/web/tests/integration/transcript-correction.test.ts`, which
  reads the recording as a member after accepting and again after the draft lands, and asserts the old
  summary both times.
  - Regeneration creates a draft; it does not discard the published `summary` row, which is what makes this
    path different from [3.6.9](docs/project/prd.md#L135)'s discard-and-replace of an open draft.

- **A second regeneration while one is in flight is refused rather than answered** — verified by
  `packages/web/tests/integration/transcript-correction.test.ts`, which asks twice and asserts
  `generation_in_flight` on the second.
  - The same unfinished-job check `regenerateReview` already makes, for the same reason: the partial unique
    index over `(recording_id, step)` would otherwise make the second enqueue a no-op wearing a success.

- **Correcting a transcript and regenerating a summary leave member progress and the recording's
  publication state untouched** — verified by
  `packages/web/tests/integration/transcript-correction.test.ts`, which records a `playback_progress` row
  and reads `published_at` before and after both operations.
  - Neither route writes to `recording` or `playback_progress` at all; the assertion is what turns that
    from a reading of the code into a property.

- **Every correction and every regeneration is logged with actor, action, target and timestamp** —
  verified by `packages/web/tests/integration/transcript-correction.test.ts`, which asserts the log lines
  for both.
  - The same `logger.info` shape the review gate's transitions already use, carrying the recording id and
    the segment id.

## User steps

- none

## Assumptions

### Major (confirmed with the operator)

- Correction lives **inline in the `Transcript` tab of the member recording page**, with admin-only
  affordances, rather than in a new admin console screen — the precedent [3.6.4](docs/project/prd.md#L130)
  already set for acting on a recording from its own page.
- Correction is **published recordings only**. Epic flow B's pre-publish correction is satisfied by
  correcting after publish, per flow D; the transcript route grows no `?surface=` parameter and no admin
  route into an unpublished recording page is built.
- The regeneration offer is a **new route enqueuing `generate_draft`**, producing a fresh open review item
  in the existing Pending Reviews queue — not a reopening of the closed review item, which would break the
  audit trail the closed row exists to keep.
- An admin may edit a segment's **text and its timings**; `speaker` is not editable, and segments cannot be
  split, merged, inserted or deleted.
- The transcript is **owned by the player provider and fetched lazily**, so the caption pill keeps working
  after a member navigates away from the recording page; captions default to off and the choice is session
  state rather than a column on `user`.

### Minor

- The transcript is one response, unpaginated — ~900 segments for a 90-minute teaching.
- `correctedAt` and `correctedByUserId` are omitted from the member-facing segment shape.
- Timing bounds are validated against immediate neighbours only, inside one transaction; no whole-transcript
  consistency pass runs.
- Gaps between segments are permitted and widening one is a legitimate correction; the caption pill shows
  nothing inside a gap.
- `transcript.correct` and `summary.regenerate` are two actions rather than one, matching the split every
  other group in the policy table already takes.
- The `···` side toolbar ships holding one item rather than being hidden until it has more.
- A published recording with no transcript renders an empty state under the tab rather than dropping the
  tab.
- Auto-scroll suspension is client-only state and resets when a different recording is opened.

## Edge cases

- A transcript that fails to download shows the tab's "Loading the transcript…" line indefinitely —
  no error message, no retry control. Closing and re-opening the tab tries again.
- A very long teaching downloads its whole transcript in one response before the first line appears;
  on a slow connection that is a visible wait with no progress indication.
- The correction form takes start and end as raw milliseconds. An admin who mistypes a digit gets a
  refusal only if the result crosses a neighbour or inverts — a line silently moved by one second
  inside its own space is accepted.
- A correction saved while the member's audio is playing does not move the playhead. If the
  corrected line's start moved past the current position, the highlight jumps on the next tick.
- Two admins correcting the **same** segment at once: last write wins, and the earlier admin's
  screen keeps showing their own text until they reload. Neighbour crossings between two *different*
  segments are still refused, because that check and the update share a transaction.
- The regeneration offer appears once per saved correction. An admin who corrects five lines and
  accepts on the first will be refused on the second with `generation_in_flight` until the worker
  finishes — the message says to wait and try again, and nothing tells them when it has.
- Accepting the offer and then never approving the draft leaves an open review item indefinitely;
  nothing notifies the admin it is ready ([3.6.3](docs/project/prd.md#L129) arrives with
  [§3.17](docs/project/prd.md#L361), so Pending Reviews is the only signal).
- A regenerated draft is written from the transcript as it stands when the **worker** runs, not as it
  stood when the offer was accepted. A correction made in between is included silently.
- Auto-scroll suspension resets when the tab is closed and re-opened, and when a different teaching
  is opened — a member who scrolled away, closed the tab and re-opened it finds it following again.
- The caption pill and the transcript list both show the corrected words only for the admin who made
  the correction. Another member already on the page keeps the old words until they reload.
- Captions turned on are forgotten on a full page reload — the choice is session state in the
  provider, and nothing is written to `user`.
- A correction on a recording that is unpublished between the page load and the save is refused with
  `not_found`, which reads as "there is no such teaching" rather than "it was just taken down".
- The transcript list is bounded to `50vh` and scrolls inside itself. On a very short viewport that
  is a small window; nothing is hidden, but few lines are visible at once.

## Implementation notes

### Assumptions — major (confirmed with the operator)

- none — planning settled every major call this ticket needed, and nothing implementation hit
  contradicted one.

### Assumptions — minor

- The `Transcript` tab **starts closed** and toggles. Nothing is fetched until it is pressed, which
  is what makes "a member who never opens it downloads nothing" true; a tab selected by default
  would have fetched on every recording page load.
- The transcript read route uses the member gate unconditionally — no `includeUnpublished`, no
  surface parameter — so an admin is refused an unpublished transcript exactly as a member is. That
  follows from the published-only decision rather than adding to it.
- The correction body must carry `text`, `startMs` and `endMs` **together**; there is no partial
  `PATCH`. A body omitting a timing is refused rather than read as "leave it alone".
- A body carrying `speaker` is refused by a key check on the request object rather than by a schema,
  so `{ speaker: null }` is refused too.
- The correction response returns the segment in the member shape, so the client has one idea of
  what a segment is on both routes.
- The `20 000` character ceiling on a corrected line is restated as a local constant in
  `packages/web/src/server/transcripts/service.ts`; the review gate's own copy is private to its
  module, and exporting one for two callers was not worth a shared constant.
- Neighbours are found with two indexed one-row queries excluding the segment by **id**, so a
  correction that leaves `startMs` where it is does not find itself as its own neighbour.
- `corrected_at` is the database's `now()` inside the update, not a `Date` from the API process.
- The offer's accepted state is a message naming Pending Reviews rather than a link to it — the
  console is a different surface, and sending an admin there mid-correction was not asked for.
- The caption pill is a `<section aria-label="Caption">` and the side toolbar a
  `<nav aria-label="Player tools">`, so both are addressable by role; the `···` control's accessible
  name is *More player controls* rather than the glyph.
- Auto-scroll is done by writing `list.scrollTop` and remembering the value, rather than
  `scrollIntoView` — that method scrolls every ancestor, including the page, and the transcript
  following itself must not move the rest of the screen.

### Other notes

- **Three Story 4 assertions were reversed rather than deleted**, and each was a fact Story 4
  recorded as *"Story 5 changes this"*: the recording page now has a tab strip
  (`member-library-screen.test.ts`), the transport now has the `···` control
  (`player-screen.test.ts`), and `tests/fixtures/type-errors/policy-rules-complete.ts` gained the
  two new actions — the exhaustiveness mechanism doing its job in the direction it was built for.
- The player provider gained `applyCorrection`, which replaces one segment in the loaded transcript
  by id. It is state ownership rather than a knob: the caption pill and the transcript list read the
  same array, and a correction that updated only the list would leave the pill saying the old words.
- **`segmentAt` is where the next four features hook in.** Notes, cross-references, search and the
  Flow Tracker all resolve "open at the moment" through `(recording_id, timestamp_ms)`; each of them
  calls this function rather than writing its own `find`, and its unit suite is where the
  inclusive/exclusive and gap rules are pinned.
- The transcript route is the **fifth** read path through `findVisibleRecording`. Nothing new was
  written about publication, which is what `tests/guards/visibility-boundary.test.ts` is for.
- No fifth entry was added to `UNAUTHENTICATED_ROUTES`, and the correction route is the first in the
  product with two dynamic path segments — named explicitly in `route-sweep.test.ts` so the sweep is
  provably about it.
