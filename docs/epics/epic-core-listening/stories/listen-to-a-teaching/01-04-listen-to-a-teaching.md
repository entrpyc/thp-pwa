# Ticket 01–04 — Member library, streaming playback, persistent speed, and resume across devices
_Story: Listen to a teaching_

> Phase 6 artefact for [implementation plan § Ticket 01](docs/epics/epic-core-listening/implementation-plan.md#L329),
> [§ Ticket 02](docs/epics/epic-core-listening/implementation-plan.md#L344),
> [§ Ticket 03](docs/epics/epic-core-listening/implementation-plan.md#L362) and
> [§ Ticket 04](docs/epics/epic-core-listening/implementation-plan.md#L369) — **the whole story planned as one
> doc at the operator's instruction.** The plan cuts them into four; this doc puts them back together and
> states the cost of that below rather than leaving it to be discovered at review. The criteria stay in four
> groups, in the plan's order, so the parts can still be read and run apart.
>
> Sections pulled, Ticket 01: [epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100);
> [3.3.1](docs/project/prd.md#L83); [3.3.9](docs/project/prd.md#L91); [3.6.7](docs/project/prd.md#L141);
> [epic prd § Epic flows → C](docs/epics/epic-core-listening/prd.md#L210);
> [epic architecture § Next.js application — client half](docs/epics/epic-core-listening/architecture.md#L109);
> `pages/dashboard.png`, `pages/recording.png`, `top-navigation/default.png`,
> `top-navigation/menu-opened.png`.
> Ticket 02: [epic prd § In scope → 5](docs/epics/epic-core-listening/prd.md#L117);
> [3.2.3](docs/project/prd.md#L66); [3.2.9](docs/project/prd.md#L72);
> [epic architecture § Media store](docs/epics/epic-core-listening/architecture.md#L164);
> [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Second media
> pointer*; [§6](docs/project/prd.md#L758) Security; `bottom-navigation/default.png`, `pages/player.png`.
> Ticket 03: [3.2.4](docs/project/prd.md#L67);
> [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *Accounts*;
> `bottom-navigation/default.png`.
> Ticket 04: [3.2.5](docs/project/prd.md#L68);
> [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *Member-owned
> state*; [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) —
> *Client-owned playback state*; `pages/dashboard.png` — the *Resume recording* card.
>
> Carried in because this story touches them: [3.2.2](docs/project/prd.md#L65) and
> [3.2.11](docs/project/prd.md#L74), the gate every read here obeys; [3.6.12](docs/project/prd.md#L146), the
> second gate on the summary; [3.6.10](docs/project/prd.md#L144), the reason a published teaching may have no
> summary; [3.1.2](docs/project/prd.md#L44) and [3.1.5](docs/project/prd.md#L47), the two rules every route
> here obeys; [4.1](docs/project/prd.md#L515) and [4.2](docs/project/prd.md#L529), the two entities this
> story widens by one column each; [3.4.1](docs/project/prd.md#L100) and
> [§3.4](docs/project/prd.md#L94), the processed rendition members do not get in this epic;
> [3.4.9](docs/project/prd.md#L108), the original this story reads and never writes;
> [3.2.6](docs/project/prd.md#L69), [3.2.7](docs/project/prd.md#L70), [3.2.8](docs/project/prd.md#L71),
> [3.3.4](docs/project/prd.md#L86), [§3.10](docs/project/prd.md#L204), [§3.12](docs/project/prd.md#L267) —
> the six things the design references show that this story does not ship;
> [3.5.3](docs/project/prd.md#L120)–[3.5.4](docs/project/prd.md#L121), the follow-along transcript that
> attaches to this story's player next;
> [epic architecture § Divergence from the north star](docs/epics/epic-core-listening/architecture.md#L294);
> [epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341);
> [epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255);
> [project architecture § Client — PWA shell](docs/project/architecture.md#L111);
> [project architecture § Data model](docs/project/architecture.md#L171);
> [project architecture § Cross-cutting concerns](docs/project/architecture.md#L271);
> [implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L48);
> [implementation plan § Design references](docs/epics/epic-core-listening/implementation-plan.md#L81) — the
> third column, which is what most of this doc's *Out of scope* is;
> [01-04-review-and-publish.md](docs/epics/epic-core-listening/stories/review-and-publish-a-teaching/01-04-review-and-publish.md)
> — the visibility condition and the `recording.browse` action this story is the first member-facing consumer
> of.

**This is the story the product exists for.** Everything before it is machinery: accounts nobody uses, a
pipeline nobody reads, a publish gate with nothing behind it. After it, a member signs in and hears a
teaching — and [epic prd § Epic flows → C](docs/epics/epic-core-listening/prd.md#L210) is walkable end to end
apart from the transcript.

**Five things worth naming before the criteria.**

**One diff, four tickets.** The plan cuts these apart because each is independently reviewable — a read
surface, a signed grant, a preference column, a sync endpoint. Merged at the operator's instruction, the
review cost is real: the chrome decisions of group 1 constrain groups 2–4, and a doubt about where the
audio element is mounted reaches three of the four groups. The mitigation is that the criteria stay in four
groups and each group is separately runnable.

**The member chrome is settled here once, and getting it wrong is a rewrite of every member screen after
it.** `pages/dashboard.png`, `pages/recording.png` and `top-navigation/*` carry chapters, notes, mind maps,
scripture, downloads, series and search — **none of which exist**. The decision recorded in *Assumptions*
below is that a deferred destination is **dropped, not rendered dead**: no disabled search control, no empty
*All chapters* entry, no greyed tab strip. A disabled control is a promise the epic cannot keep, and it is
also a thing the next epic has to find and un-disable. What survives is the layout, the tone and the token
layer, so the deferred pieces drop into slots that already exist.

**The audio element is mounted app-wide, and that is the one decision here that is expensive to walk back.**
`bottom-navigation/default.png` is a docked bar with its own title slot, which is the app-wide pattern; the
*Resume recording* card on the landing assumes a member leaves the recording page; and Story 5's caption pill
floats above the same bar. Mounting the element on the recording page instead would be smaller today and
would mean moving the element, its transport state, its speed and its progress timer in Story 5. So it goes
in the member layout now, and playback survives client-side navigation within the app.

**`pages/player.png` ships nothing.** Its two contents — hero artwork and the scripture-reference list — are
both deferred, so there is no now-playing route in this epic. The transport bar *is* the player. That is
recorded here rather than left as a missing screen somebody looks for at validation.

**One architecture line is contradicted deliberately.**
[epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) says
`playback_progress` is "last-write-wins on the furthest position", which is two rules that disagree. Taken as
*furthest*, a member who scrubs back to re-hear something and then closes the tab is returned to where they
had got to, not where they were listening — which is the opposite of what [3.2.5](docs/project/prd.md#L68)
promises. This story implements **last-write-wins, plainly**: the newest write sets the position. Amending
that line is a Phase 4 edit and is **out of scope here**; until somebody makes it, the architecture and the
schema disagree by one word.

## Goal

A signed-in member browses published teachings newest first, opens one, reads its summary, presses play,
scrubs to any position, sets a speed that survives every later recording, and picks the teaching back up at
the same second on a different device the next day.

- As a member I want to see every published teaching, newest by date recorded first, so I can find what was
  taught most recently
- As a member I want to open a teaching and read its title, date, summary and description before I commit
  ninety minutes to it
- As a member I want to press play and hear the teaching, and drag to any point in it
- As a member I want the speed I chose to still be the speed the next teaching plays at
- As a member I want to close a teaching mid-way on my phone and carry on at the same second on my laptop
- As a member I want the landing screen to offer me the teaching I was part-way through

## Out of scope

Almost everything in this list is visible in a design reference. That is the point of the list.

**Deferred features the references show.** Chapters and the chapter list, the `Chapter` / `Scripture` /
`Notes` / `Mindmap` tabs and the tab strip that holds them, the *My notes* card
([§3.12](docs/project/prd.md#L267)), the download control and any offline behaviour, search
([§3.10](docs/project/prd.md#L204)) and the search control in the top bar, *All chapters* as a destination,
hero and series artwork, the scripture-reference list of `pages/player.png`, and the `···` side toolbar of
`bottom-navigation/menu-opened.png`.

**Deferred playback behaviour.** Background audio and lock-screen transport ([3.2.6](docs/project/prd.md#L69))
— it needs the Capacitor shell. Listening history ([3.2.7](docs/project/prd.md#L70)) and the completed marker
([3.2.8](docs/project/prd.md#L71)) — this story writes one row per user per recording and no play log.
Per-recording progress in the library list and the series view's progress column
([3.3.4](docs/project/prd.md#L86)) — that arrives with Story 6.

**Not this story.** The follow-along transcript, the current-segment caption and seek-from-transcript
([3.5.3](docs/project/prd.md#L120)–[3.5.4](docs/project/prd.md#L121)) — Story 5. Series, the series listing
and the series segment of the breadcrumb — Story 6. Audio processing and any processed rendition
([§3.4](docs/project/prd.md#L94)) — members hear the raw upload, which
[epic architecture § Divergence from the north star](docs/epics/epic-core-listening/architecture.md#L294)
already records.

**Reachable-for and not wanted.** A `duration` column on `recording` or `transcript` — deliberately deferred,
and `packages/db/tests/integration/migrations.test.ts` asserts its absence. A CDN in front of the object
store. A batch or outbox sync endpoint for playback state — [§3.18](docs/project/prd.md#L401) adds that
beside the single-position endpoint this story ships. Pagination or filtering on the library. A second
visibility query: `packages/db/src/visibility.ts` is the only file allowed to compare `published_at`, and the
guard enforces it. A fifth entry on the unauthenticated allowlist — every route here requires a session.

## User prerequisites

- **The object store's CORS policy must permit `GET` with a `Range` header from the application origin**, in
  addition to the `PUT` the upload story already needs. A media element fetching a same-document `src` is not
  a CORS request, so this may already work untouched — but it is the operator's bucket configuration, it is
  invisible from inside the application, and discovering it wrong means a player that never starts.
- **At least one published recording with real audio behind it** in the environment the work is validated
  in. Stories 2 and 3 produce one; the resume criteria cannot be exercised without it.

## Acceptance criteria

### Group 1 — Member library and recording page (plan Ticket 01)

- **A signed-in member sees every published teaching, newest `recorded_at` first, and no unpublished one** —
  verified by `packages/web/tests/integration/member-library.test.ts`, which publishes two recordings with
  known dates, leaves a third unpublished, and asserts the order and the absence.
  - The library reads `listVisibleRecordings` through the existing service, which already answers from
    `packages/db/src/visibility.ts` — no second published-at comparison is written.
  - Ordering is the query's, not the client's, so the library and the console give one answer to "what is
    most recent".
  - A published teaching with no series and a published teaching with no summary both appear
    ([3.3.9](docs/project/prd.md#L91), [3.6.10](docs/project/prd.md#L144)).

- **The member surface shows published rows only, whatever the caller's role** — verified by
  `packages/web/tests/integration/member-library.test.ts`, which requests the member surface as an admin and
  asserts the unpublished recording is absent from it while still present in the console's list.
  - The member read passes `includeUnpublished: false` explicitly rather than deriving it from
    `recording.list`, which is what makes an admin browsing the library see what a member sees.
  - The console keeps the operator answer; one route, two shapes, as
    [01-04-review-and-publish.md](docs/epics/epic-core-listening/stories/review-and-publish-a-teaching/01-04-review-and-publish.md)
    established.
  - No object key and no `createdAt` reach the member surface at either role.

- **A member can open one published teaching by id and read its title, date recorded, published summary and
  description; an unpublished id is refused rather than rendered empty** — verified by
  `packages/web/tests/integration/member-library.test.ts`, which fetches a published id, an unpublished id
  and a nonexistent id and asserts the payload and the two refusals.
  - A `GET /api/v1/recordings/[id]` route behind `recording.browse`, reading the same visibility condition
    as the list.
  - The summary is present only when both gates are open, and `null` when
    [3.6.12](docs/project/prd.md#L146)'s return-to-draft has closed the second one.
  - Unpublished and nonexistent answer the same refusal, so the API does not report which ids exist.

- **Every route added by this group refuses an anonymous caller** — verified by the existing
  `packages/web/tests/integration/route-sweep.test.ts`, which asserts every route not on the allowlist
  refuses an anonymous request.
  - Each new route declares its access as `apiRoute`'s first argument; nothing is added to
    `UNAUTHENTICATED_ROUTES`.

- **`/` is the member landing, `/recordings` is the library and `/recordings/[id]` is the recording page,
  and the placeholder home screen is gone** — verified by
  `packages/web/tests/integration/member-library-screen.test.ts`, which signs in as a member and walks all
  three in a real browser, and asserts the placeholder's *Signed in as* card no longer renders.
  - The landing composes `pages/dashboard.png`: the *Resume recording* card slot, and a *View all
    recordings* row where the reference puts *View all series*.
  - `packages/web/src/app/page.tsx` is replaced rather than extended; the temporary admin-console link it
    carried moves into the navigation menu.
  - The recording page composes `pages/recording.png` with the hero artwork replaced by a flat
    `--color-bg-deep` band carrying the back control, so artwork drops into the same slot later.
  - Summary and description render directly in the page body — **no tab strip in this story**; Story 5
    introduces it carrying `Transcript` as its only tab.

- **The top navigation carries a working breadcrumb and menu, and renders no control for a deferred
  destination** — verified by `packages/web/tests/integration/member-library-screen.test.ts`, which asserts
  the menu's exact entry set per role and asserts the search control, *All series* and *All chapters* are
  absent from the DOM.
  - Menu entries: *Dashboard*, *All recordings*, *Admin console* (rendered only when the policy module
    permits it), *Sign out*.
  - Breadcrumb: the home icon alone on the landing and the library; home icon → recording title on a
    recording page, the title in `--color-primary-strong` as the reference's current item is.
  - The menu is composed from `top-navigation/menu-opened.png` and the admin entry grants nothing —
    `/admin` gates itself server-side and every route behind it refuses independently.

- **Every screen in this group works at phone, tablet and desktop widths** — verified by
  `packages/web/tests/integration/member-library-screen.test.ts`, which runs its assertions across the three
  viewports the existing screen suites use.
  - One codebase, the responsive standing constraint of
    [implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L48).
  - Every colour, radius and spacing value comes from the token layer; `tests/guards/style-tokens.test.ts`
    fails the build on a raw hex.

### Group 2 — Streaming playback and scrubbing (plan Ticket 02)

- **The API mints a short-lived signed `GET` for a published recording only, to an authenticated caller
  only** — verified by `packages/web/tests/integration/playback.test.ts`, which asserts a member gets a URL
  for a published recording, is refused for an unpublished one, and an anonymous request is refused.
  - One route behind `recording.browse`, which checks publication through the visibility condition before
    anything is signed.
  - The payload carries the URL and its expiry and never the object key.
  - The signing call is `mediaStore().presignGet`, the port that already exists.

- **Signed-URL minting for playback is one function** — verified by
  `packages/web/tests/integration/playback.test.ts`, which asserts there is a single exported minting
  function and that the route is its only caller.
  - [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323)'s *Second
    media pointer* attaches here: [§3.4](docs/project/prd.md#L94) later makes this function prefer a
    processed rendition and fall back to the original, and it can only do that if there is one of it.

- **A member presses play and hears the recording** — verified by
  `packages/web/tests/integration/player-screen.test.ts`, which drives a real browser against a real object
  store and asserts the element leaves the paused state and `currentTime` advances.
  - The transport bar of `bottom-navigation/default.png`: play/pause as the one filled purple circle,
    ±10s as outlined circles, the thin track with a purple fill and a round thumb, elapsed and total either
    side of it.
  - The left slot carries the recording title only — the reference's thumbnail is artwork, and artwork is
    deferred.
  - No `···` control: everything behind it in `bottom-navigation/menu-opened.png` is deferred, and Story 5
    is what gives that button its first item.

- **Scrubbing to an unbuffered position works, and the audio never passes through the application** —
  verified by `packages/web/tests/integration/player-screen.test.ts`, which seeks past the buffered region
  and asserts a ranged request goes to the object-store origin and that no request for media bytes reaches
  the API origin.
  - The element's `src` is the signed URL, so the browser makes range requests to the store directly —
    which is what makes scrubbing work without a CDN.
  - The API is in the authorisation path and never in the audio path.

- **A grant that expires mid-listen is replaced without the member noticing** — verified by
  `packages/web/tests/unit/playback-grant.test.ts` for the decision function and
  `packages/web/tests/integration/player-screen.test.ts` for the behaviour, which forces the element to
  error on a dead URL and asserts playback resumes at the same `currentTime` in the same play state.
  - The grant is minted for one hour, which outlives a sitting but not a copied URL.
  - The client re-requests a URL when the element errors **or** when the grant is within five minutes of
    expiry, whichever comes first; the near-expiry check is a pure function so it is testable without a
    clock.
  - `currentTime` and the paused state are captured before the swap and restored after it.

- **The transport bar is mounted app-wide and playback survives navigation inside the app** — verified by
  `packages/web/tests/integration/player-screen.test.ts`, which starts playback on a recording page,
  navigates to the library, and asserts the bar is still present and `currentTime` still advancing.
  - The `<audio>` element and its transport state live in the member layout, not the recording page.
  - The bar renders only when something is loaded, so the landing before a first play is the reference's
    layout unchanged.

### Group 3 — Playback speed that persists (plan Ticket 03)

- **Speed is adjustable across exactly the six steps and takes effect immediately** — verified by
  `packages/web/tests/unit/playback-speed.test.ts` for the step set and
  `packages/web/tests/integration/player-screen.test.ts` for the effect, which sets 1.5x mid-playback and
  asserts the element's `playbackRate`.
  - 0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x, declared once in `@thp/shared` so the control, the API and the
    database constraint read the same list.
  - The control is the pill at the right of `bottom-navigation/default.png`.

- **The chosen speed persists across recordings and across sessions for that user** — verified by
  `packages/web/tests/integration/playback-speed.test.ts`, which sets a speed, signs in again in a fresh
  context, opens a different recording and asserts the element starts at that rate.
  - Stored on `user.preferred_playback_speed`, per
    [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — on the
    user because [3.2.4](docs/project/prd.md#L67) persists it across recordings, not per recording.
  - Written by a route behind a session when the value changes, and applied optimistically before the
    write returns.
  - A value outside the six is refused by the API and by a database check constraint, so the column cannot
    hold a rate no control can produce.

- **The column exists with the right shape and default** — verified by
  `packages/db/tests/integration/migrations.test.ts`, which asserts the column, its `NOT NULL`, its default
  of `1` and its check constraint, and continues to assert `duration` is absent from `recording`.
  - One migration, additive; every existing account gets `1` and nobody has to be back-filled by hand.

### Group 4 — Resume position across devices (plan Ticket 04)

- **A member's position in a recording is stored per user per recording and survives to another device** —
  verified by `packages/web/tests/integration/playback-progress.test.ts`, which writes a position as one
  signed-in context and reads it back as a second, independently signed-in context for the same user.
  - `playback_progress (user_id, recording_id, position_ms, updated_at)`, primary-keyed on the pair — one
    row per pair, so there is no history to reconcile.
  - Written through a single-position endpoint behind a session; the row is upserted, never inserted twice.
  - The recording page reads the position when it loads the recording.

- **The newest write sets the position, including a write that moves it backwards** — verified by
  `packages/web/tests/integration/playback-progress.test.ts`, which writes 40:00, then writes 10:00, then
  asserts the stored position is 10:00.
  - Last-write-wins, plainly — a member who scrubs back to re-hear something and closes the tab is returned
    to where they were listening.
  - This contradicts the word *furthest* in
    [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193); the
    contradiction is stated in *Assumptions* and amending the architecture is not this story's work.

- **Opening a recording restores the stored position and does not start playing** — verified by
  `packages/web/tests/integration/resume-screen.test.ts`, which opens a recording with a stored position and
  asserts `currentTime` is at it and the element is paused.
  - The seek happens once metadata has loaded, so it is not silently clamped to zero.
  - No autoplay: a member who opens a teaching on a phone in company has not asked for sound.

- **Position is pushed on a bounded cadence and on the events that matter, and a trivial position is not
  written** — verified by `packages/web/tests/unit/playback-progress-cadence.test.ts` for the decision
  function and `packages/web/tests/integration/resume-screen.test.ts` for the behaviour, which counts
  requests to the endpoint over a period of playback and asserts a write follows a pause and a page hide.
  - At most one write every ten seconds while playing, plus one on pause, one after a seek settles, and one
    on page hide.
  - Positions below five seconds are not written, so opening a teaching and closing it does not create a
    resume point at the very beginning.
  - The cadence is a pure function over elapsed time and event kind, so it is asserted without a real clock
    or a real player.

- **The landing offers the teaching the member was part-way through** — verified by
  `packages/web/tests/integration/resume-screen.test.ts`, which stores progress on two recordings, unpublishes
  the more recent one, and asserts the card offers the other.
  - The card is `pages/dashboard.png`'s *Resume recording*: title, description, elapsed, and the filled
    purple play circle.
  - It shows the most recently updated progress row whose recording is **still published** — a teaching
    taken down by [3.2.11](docs/project/prd.md#L74) does not reappear through a resume card.
  - **Elapsed only** — "Resume at 01:23", not the reference's "01:23 / 02:30", because no duration is stored
    anywhere and the player learns duration from the element.
  - No card renders when the member has no progress on any published recording.

- **The table exists with the right shape** — verified by
  `packages/db/tests/integration/migrations.test.ts`, which asserts the composite primary key, the two
  cascading foreign keys and the exact column set.
  - Cascades on both sides: progress is a fact about a pairing and is meaningless without either half.

## User steps

- none

## Assumptions

### Major (confirmed with the operator)

- `/` is the member landing for both roles, `/recordings` the date-ordered library and `/recordings/[id]` the
  recording page; the placeholder home screen retires and its admin-console link moves into the menu.
- A deferred destination is dropped, not rendered dead — no search control, no *All series* or *All chapters*
  entry, no disabled tab strip; the menu ships *Dashboard*, *All recordings*, *Admin console* and *Sign out*.
- The breadcrumb is home icon → recording title, with the series segment inserted by Story 6.
- The member surface asks for published rows only whatever the caller's role, so an admin browsing the
  library sees exactly what a member sees; unpublished rows stay in the console.
- Ticket 01's recording page has no tab strip — summary and description render in the page body, and the
  strip arrives in Story 5 holding `Transcript` alone; the hero artwork becomes a flat `--color-bg-deep` band.
- There is no now-playing route: both of `pages/player.png`'s contents are deferred, so the transport bar is
  the player.
- The `<audio>` element and the transport bar are mounted app-wide in the member layout, so playback survives
  client-side navigation.
- The playback grant is minted for one hour by one function, and the client re-requests it on element error
  or within five minutes of expiry, restoring `currentTime` and play state.
- No duration is stored: the player reads it from the element, and the resume card shows elapsed only.
- `playback_progress` is last-write-wins, plainly — not "furthest" — and the divergence from
  [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) is left for a
  Phase 4 amendment rather than fixed here.
- Progress is pushed at most every ten seconds while playing, plus on pause, after a seek settles and on page
  hide; positions under five seconds are not written; opening a recording seeks but never autoplays; the
  resume card shows the most recently updated row whose recording is still published; the library list shows
  no per-recording progress.

### Minor

- The ±10s skip controls ship with the transport bar — they are transport, not a deferred feature.
- `preferred_playback_speed` is a `real` column, `NOT NULL DEFAULT 1`, with a check constraint over the six
  values.
- `position_ms` is an integer of milliseconds, matching the `(recording_id, timestamp_ms)` offset `segment`
  already establishes.
- The speed and progress endpoints hang off the recording and user resources already under `/api/v1` and add
  no new top-level path segment.
- Elapsed and remaining times are formatted `mm:ss`, rolling to `h:mm:ss` past an hour, by one shared
  formatter.
- The library list row shows title, date recorded and the description truncated to one line, as the style
  guide's list row specifies.
- The member surface is client-rendered against the API through `apiFetch`, matching the admin panels, so the
  client holds no database access and imports no server module.
- The back control on the recording page returns to the library rather than to browser history, so it behaves
  the same when the page is opened directly.

## Edge cases

- **Opening a teaching re-stamps its stored position even if nothing is played** — the restore seek
  counts as a seek, so a member who opens a teaching they had listened to before, and immediately
  leaves, has made it the one the landing offers to resume.
- **A failed grant renewal is silent** — if the API is unreachable when the player asks for a fresh
  URL, playback stops and nothing on screen says why; it retries every fifteen seconds and recovers
  by itself when the API comes back.
- **A dropped progress write is not retried** — a member who loses connection mid-listen resumes
  from the last position that reached the server, up to ten seconds earlier than where they were.
- **A teaching unpublished mid-listen keeps playing** — the grant already minted stays valid until
  it expires, so a member hears the rest of the sitting; the next renewal is refused and playback
  stops without a message. Opening it again refuses immediately.
- **Two tabs on the same account overwrite each other** — last write wins, so listening in two
  places at once can move the stored position backwards to wherever the other tab was.
- **Playback does not survive a full page reload** — only client-side navigation. A reload leaves
  the member on the recording page, paused, at the stored position, having to press play again.
- **A media file the browser cannot decode looks like a dead grant** — the element errors, the
  player re-requests a URL, and it repeats every fifteen seconds rather than saying the file cannot
  be played.
- **The scrubber is dead until the element reports a duration** — a teaching whose object is missing
  from the store shows the transport bar with `--:--` and an unusable track, and no message.
- **Scrubbing lands on whole seconds** — the position slider steps in seconds, so a member cannot
  seek to a finer offset than that from the bar.
- **Locking a phone stops playback** — background audio and lock-screen transport need the Capacitor
  shell ([3.2.6](docs/project/prd.md#L69)) and are deferred.
- **A speed changed in one tab does not reach another tab already open** — the rate is applied when
  the element loads metadata, so a second open tab keeps the old rate until it navigates or reloads.
- **The resume card appears after the landing has rendered** — on a slow connection the landing
  paints without it and it drops in a moment later, moving the *View all recordings* row down.
- **An admin can still ask for the console's shape of a member screen's data** by removing the
  `surface` query parameter by hand. That is the console's answer and it is what the console uses;
  it means the two readings differ by a parameter rather than by a route.
- **No listening history and no completed marker** — one row per member per teaching and nothing
  else, so "what have I finished" and "what have I played" are unanswerable
  ([3.2.7](docs/project/prd.md#L70), [3.2.8](docs/project/prd.md#L71), both deferred).
- **The library has no pagination, filter or search** — every published teaching is one list, which
  is fine at five and is not at five hundred ([§3.10](docs/project/prd.md#L204) is deferred).

## Implementation notes

### Assumptions — major (confirmed with the operator)

- `GET /api/v1/recordings` and `GET /api/v1/recordings/{id}` take a `?surface=library` query
  parameter, and the member screens always send it. Without it the shape is derived from
  `recording.list` alone, which made an admin opening the member library see unpublished rows and
  object keys — the exact thing the criterion forbids. The parameter can only ever *narrow* what
  comes back: a member sending it changes nothing, because the policy is what decides which rows
  exist for them. Absent means the console's reading, so nothing that already called the route
  changed.
- `SessionUser` gained `preferredPlaybackSpeed`, so the member layout can hand the transport a
  starting rate without a second request. The alternative is a `GET` on the speed endpoint and a
  bar that renders at 1x until it answers.

### Assumptions — minor

- The playback grant's one hour lives in `packages/web/src/server/playback/grant.ts` beside the
  minting function rather than in `@thp/media`, because it is a decision about listening rather than
  about the store; `UPLOAD_GRANT_SECONDS` stays where it is.
- The near-expiry check runs on a fifteen-second interval. It compares two numbers, so the cost is
  nothing and the resolution is far finer than the five-minute margin needs.
- The speed control is a **single pill that cycles** the six steps rather than a menu, because
  `bottom-navigation/default.png` gives it one tap target.
- Circular controls take `--radius-pill` rather than `50%`. The guide lists a `--radius-circle`
  token in its Radius table but not in its *Quick token block*, and the token layer is that block;
  `999px` on a square box is a circle.
- The landing carries an unpainted `h1` reading *Dashboard*. `pages/dashboard.png` has no page
  title — the breadcrumb bar is the heading — and a screen with no heading is one a screen reader
  cannot summarise.
- The recording page keeps the reference's filled play circle, and it drives the same element the
  docked bar does. Pressing either is pressing the same player.
- The transport's position control is an `<input type="range">`, so scrubbing works from a keyboard
  and is announced as a slider without a hand-written drag handler.
- The player keeps its own record of the last good position and of whether the member wants sound,
  rather than reading both off the element at renewal time. Pointing a media element at a new source
  resets `currentTime` and pauses it, and a source that has *failed* is already reset when `error`
  fires — reading the element then would restore a member to the beginning of a teaching they were
  forty minutes into.
- The `surface` parameter's value is `library`, named after the screen rather than the person at it.
- `sign-out-button.tsx` takes an optional `className` and its fallback shape moved from
  `home.module.css` to `sign-out.module.css` when the placeholder landing retired.

### Other notes

- **The member surface gap was found by a false-positive check, not by the first run.** The original
  browser assertion polled `getByRole('listitem')` unscoped, which the breadcrumb's own list items
  satisfied before the library had loaded — so it passed while an admin was in fact seeing
  unpublished rows. Both library assertions are now scoped to the list's own `aria-label`, and the
  API test asks for the member surface as an admin rather than merely comparing two roles.
- **Four existing suites were updated because this ticket retired the placeholder landing**:
  `sign-in-screen`, `accept-invitation-screen` and `reset-password-screen` asserted its *Signed in
  as* card, and `admin-console` clicked its console link, which now lives in the navigation menu.
  `tests/guards/style-tokens` names the three new member stylesheets where it named
  `home.module.css`, and `packages/db/tests/integration/accounts` now expects
  `preferred_playback_speed` in the `user` column set.
- **The browser suites listen to real audio**, synthesised as a WAV by `tests/support/audio.ts` and
  uploaded through the same presigned `PUT` the admin screen uses. Nothing binary entered the
  repository, and the length is a parameter — which is what lets the scrubbing suite seek to a
  hundred seconds into a two-minute teaching and know the position was genuinely unbuffered.
- **A presigned `GET` for the same key, minted twice inside one second, is byte-for-byte
  identical.** The renewal test therefore counts grant requests rather than comparing URLs; anything
  asserting "a *different* URL" will be asserting a coincidence of the clock.
- **`playback_progress` is the last table of this epic.** Story 5 adds no table — it writes to
  `segment` — and Story 6's series work is the next migration.
- **The transport is mounted in the member layout**, so Story 5's caption pill and its first `···`
  item attach to `packages/web/src/app/(member)/transport-bar.tsx` and the state they need is
  already in `player-context.tsx`.
- **`mintPlaybackGrant` is the seam for a processed rendition** and a test asserts it is the only
  caller of `presignGet` and that the route is its only caller. [§3.4](docs/project/prd.md#L94)
  changes that one function; a second caller appearing fails the build.
