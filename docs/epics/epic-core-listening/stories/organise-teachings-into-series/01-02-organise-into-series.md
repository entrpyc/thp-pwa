# Ticket 01–02 — Series management, and the member series view
_Story: Organise teachings into series_

> Phase 6 artefact for [implementation plan § Ticket 01](docs/epics/epic-core-listening/implementation-plan.md#L427)
> and [§ Ticket 02](docs/epics/epic-core-listening/implementation-plan.md#L441) — **both tickets of the story
> planned as one doc at the operator's instruction.** The plan cuts them into two; this doc puts them back
> together and states the cost of that below rather than leaving it to be discovered at review. The criteria
> stay in two groups, in the plan's order, so the halves can still be read and run apart.
>
> Sections pulled, Ticket 01: [epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100);
> [3.3.2](docs/project/prd.md#L84); [3.3.6](docs/project/prd.md#L88) — **create / rename / move only**;
> [3.19.5](docs/project/prd.md#L443) minus artwork upload; [4.3](docs/project/prd.md#L544);
> [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The spine*.
> Ticket 02: [3.3.4](docs/project/prd.md#L86); [3.3.5](docs/project/prd.md#L87) minus cover artwork;
> [epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100);
> [epic prd § Epic flows → C](docs/epics/epic-core-listening/prd.md#L210);
> `pages/series-listing.png`, `pages/series-inner.png`.
>
> Carried in because this story touches them: [3.3.1](docs/project/prd.md#L83) and
> [3.3.9](docs/project/prd.md#L91), the date-primary order this story must not displace and the recording
> with no series it must keep showing; [3.2.2](docs/project/prd.md#L65) and
> [3.2.11](docs/project/prd.md#L74), the gate every member read here obeys;
> [3.2.5](docs/project/prd.md#L68), the progress row the series view renders and never writes;
> [3.1.2](docs/project/prd.md#L44) and [3.1.5](docs/project/prd.md#L47), the two rules every route here
> obeys; [3.19.1](docs/project/prd.md#L439), the console this panel is the fifth of;
> [3.3.3](docs/project/prd.md#L85), [3.3.7](docs/project/prd.md#L89), [3.3.8](docs/project/prd.md#L90),
> [§3.10](docs/project/prd.md#L204), [§3.12](docs/project/prd.md#L267) — what the two references show that
> this story does not ship;
> [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — the *Role enum
> + policy module* row, which names series management as one of Contributor's four widened cases;
> [epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341);
> [project architecture § Data model](docs/project/architecture.md#L171);
> [implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L48);
> [implementation plan § Design references](docs/epics/epic-core-listening/implementation-plan.md#L81) — the
> third column, which is most of this doc's *Out of scope*;
> [01-04-listen-to-a-teaching.md](docs/epics/epic-core-listening/stories/listen-to-a-teaching/01-04-listen-to-a-teaching.md)
> — the member chrome, the visibility condition and the `playback_progress` row this story reads.

**This is the last member-facing story of the epic**, and the only one that adds an entity to the spine
rather than a column. After it, [epic prd § Epic flows → C](docs/epics/epic-core-listening/prd.md#L210) is
walkable whole: a member who fell out of a series in March opens it, sees every teaching in it in order with
their own progress against each, and picks up where they stopped.

**Five things worth naming before the criteria.**

**One diff, two tickets.** The plan cuts them apart because each is independently reviewable — an admin
write surface and a member read surface. Merged at the operator's instruction, the review cost is smaller
than Story 4's was: group 2 consumes group 1's table and adds no writes, so the coupling runs one way. The
criteria stay in two groups and each group is separately runnable.

**The references show a series page this epic has almost none of.** `pages/series-inner.png` carries hero
artwork, a download control, a five-tab strip, a *Search recordings* box, and a per-recording duration. Every
one of those is deferred or unstorable here. What survives is the layout, the meta row, the numbered row list
and the token layer — following the rule the member surface already set in Story 4: **a deferred destination
is dropped, not rendered dead.**

**`2h 14m total` becomes the date range, and that is not a substitution of convenience.**
[3.3.5](docs/project/prd.md#L87) names title, description, date range and count as what a series carries;
the reference's running time is not on that list, and this epic stores no duration anywhere by deliberate
choice. So the meta row reads `8 recordings · 12 Mar 2025 – 4 Jun 2025`, which is the requirement rather
than a degraded version of the picture.

**A series orders forwards; the library orders backwards.** [3.3.1](docs/project/prd.md#L83) makes newest-
first the product's default reading and the library obeys it. [3.3.4](docs/project/prd.md#L86) asks for
*chronological* inside a series, and the reference numbers its rows `01.`–`08.` — a study is read forwards.
Both orders are correct and they are opposite; this is stated here so it reads as a decision at validation
rather than as a bug.

**Two counts of the same series can legitimately differ.** The console counts every recording assigned to a
series; the member's page counts only the published ones. That falls straight out of
[3.2.2](docs/project/prd.md#L65), and it is why the count is a query rather than a column on the row.

## Goal

An admin groups recordings into named series and moves a recording between them without disturbing anything
else about it; a member finds a series from the library or the landing, opens it, and sees every published
teaching in it in order with their own progress against each.

- As an admin I want to create a series with a title and a description, and rename or reword it later
- As an admin I want to put a recording into a series, move it to another, or take it out — from the screen
  where I am already reviewing it before publish
- As an admin I want to be certain that moving a recording loses nothing: not its summary, not its
  transcript, not its publication state, and not anybody's listening position
- As a member I want to see the series that exist, so a study I fell out of is findable
- As a member I want to open a series and see its teachings in the order they were taught, numbered
- As a member I want to see, on each teaching in a series, whether I have already started it and where I got
  to
- As a member I want a teaching's page to tell me which series it belongs to, and to get me back there in one
  press

## Out of scope

Most of this list is visible in one of the two design references. That is the point of the list.

**Deferred features the references show.** Series cover artwork, anywhere it appears
([3.3.3](docs/project/prd.md#L85)) — the listing thumbnail and the series-page hero, which becomes a flat
`--color-bg-deep` band exactly as the recording page's did. The download control, on the series header and on
every row. The `Scripture`, `Notes`, `Transcript` and `Mindmap` tabs of `pages/series-inner.png`, and the tab
strip that holds them — the series page has one thing to show and needs no strip to show it. The *Search
recordings* box ([§3.10](docs/project/prd.md#L204)). The per-row duration and the `2h 14m total` figure.

**Deferred series behaviour.** Reordering a series and merging two ([3.3.6](docs/project/prd.md#L88)) —
the plan's reference says *create / rename / move only*, and order inside a series is
`recorded_at` and nothing else. Podcast-shaped metadata and any external-publication field
([3.3.7](docs/project/prd.md#L89), [4.3](docs/project/prd.md#L544)'s *External publication status*) —
they arrive with distribution, which is what drives their real requirements. Videos in the series view
([3.3.8](docs/project/prd.md#L90)). The Contributor half of [3.3.6](docs/project/prd.md#L88) — this epic
has two roles, and widening series management is one of the four cases
[epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) already names.

**Not this story.** Deleting a series — [3.3.6](docs/project/prd.md#L88) names create, rename, reorder,
merge and move, and no delete; nothing in this story removes a series, and a series an admin regrets is
renamed or emptied. A recording in more than one series — [3.3.2](docs/project/prd.md#L84) says at most one,
and the nullable foreign key is what makes that a property of the database rather than of a check. Any change
to how the library orders itself — [3.3.1](docs/project/prd.md#L83) stands, and grouping the library by
series is explicitly not what "surfaced from the library" means here.

**Reachable-for and not wanted.** Stored `recording_count` or `date_range` columns on `series` —
[4.3](docs/project/prd.md#L544) calls both auto-calculated, and a denormalised count is a second answer to a
question one query already answers. A slug column or a human-readable series URL — the id is what every other
resource in this product is addressed by. A second visibility query: `packages/db/src/visibility.ts` is the
only file allowed to compare `published_at`, and `tests/guards/visibility-boundary.test.ts` enforces it, so
both series reads are written there. A sixth entry on the unauthenticated allowlist — every route here
requires a session, and the plan's standing constraints say no ticket in it adds a fifth. Pagination,
filtering or a search box on either new screen.

## User prerequisites

- none

## Acceptance criteria

### Group 1 — Series management for admins (plan Ticket 01)

- **A `series` table exists carrying title, description and creation time, and `recording` carries a
  nullable series reference — and no count, date-range, artwork or external-publication column exists on
  either** — verified by `packages/db/tests/integration/migrations.test.ts`, which asserts the exact column
  set of both tables, and by `packages/db/tests/integration/series.test.ts`, which round-trips a series and
  an assignment.
  - One new migration under `packages/db/drizzle/`, added to the numbered sequence, plus the two table
    declarations in `packages/db/src/schema.ts`.
  - `recording.series_id` is nullable with an index, because a recording may have none
    ([3.3.9](docs/project/prd.md#L91)) and every series read filters on it.
  - The absent columns are asserted rather than described, which is how this repository has kept every
    deferral honest so far.

- **An admin creates a series with a title and a description, and a request with a blank or missing title is
  refused before a row exists** — verified by `packages/web/tests/integration/series-management.test.ts`,
  which creates one, reads it back, and asserts the two refusals leave the series list unchanged.
  - `POST /api/v1/series` behind a new `series.create` policy action, admin-only in this epic.
  - The title is trimmed and required; the description is optional and may be empty; both are subject to the
    same generic field cap every other route applies.
  - Two series may share a title — nothing in [3.3](docs/project/prd.md#L79) makes a title an identifier, and
    a uniqueness rule nobody asked for is a rule somebody has to discover.

- **An admin renames a series and rewrites its description, and the recordings in it are unaffected** —
  verified by `packages/web/tests/integration/series-management.test.ts`, which renames a series holding two
  recordings and asserts both rows are byte-identical afterwards.
  - `PATCH /api/v1/series/{id}` behind a new `series.update` action.
  - The write touches the `series` row only; no recording is read or written by the rename path.

- **An admin assigns a recording to a series, moves it to another, and takes it out — and the recording's
  title, date, description, summary, transcript, jobs and publication state are untouched by every one of
  those** — verified by `packages/web/tests/integration/series-management.test.ts`, which snapshots the
  recording row and its related rows before an assign-move-clear sequence and asserts equality after it.
  - `PUT /api/v1/recordings/{id}/series` behind a new `series.assign` action, taking a series id or `null`.
  - One column is written and no other, which is what makes "loses nothing" a property of the statement
    rather than of the test.
  - A series id that does not exist is refused, and the recording keeps whatever it had.

- **Moving a recording between series leaves every member's playback position exactly as it was** —
  verified by `packages/web/tests/integration/series-management.test.ts`, which writes progress for two
  members against a recording, moves it twice, and asserts both `playback_progress` rows — position and
  `updated_at` — are unchanged.
  - The plan names this as the criterion with teeth; progress is keyed on `(user_id, recording_id)` and no
    series write goes near that table.
  - Asserted rather than inferred from the schema, because the assertion is what will still be true after
    somebody later adds a cascade nobody thought about.

- **A member is refused every series write, by the API rather than by the interface** — verified by
  `packages/web/tests/integration/series-management.test.ts`, which attempts create, rename and assign as a
  member and asserts three refusals, and by `tests/guards/role-usage.test.ts`, which fails the build if a
  role is compared anywhere outside the policy module.
  - Three new actions in the policy table — `series.create`, `series.update`, `series.assign` — each
    answering per role, split for the reason every group in that table is split.
  - A fourth, `series.list`, admits the console's reading of the series list; a fifth, `series.browse`,
    admits both roles to the member surface. Same shape as `recording.list` and `recording.browse`.

- **Every route added by this group refuses an anonymous caller** — verified by the existing
  `packages/web/tests/integration/route-sweep.test.ts`, which asserts every route not on the allowlist
  refuses an anonymous request.
  - Each new route declares its access as `apiRoute`'s first argument; nothing is added to
    `UNAUTHENTICATED_ROUTES`.

- **A fifth console panel, *Series*, lists every series with its recording count and date range — including
  a series with no recordings at all — and creates and renames from that screen** — verified by
  `packages/web/tests/integration/series-management-screen.test.ts`, which signs in as an admin in a real
  browser, creates a series, renames it, and reads the count back after an assignment.
  - One entry in the console shell's panel list and one new page under `packages/web/src/app/admin/series/`,
    composed from [style-guide.md](docs/design%20referencess%20png/style-guide.md) — there is no admin
    reference and the previous stories' panels are the precedent.
  - The console's count and range include unpublished recordings; the member's do not, and the difference is
    the `includeUnpublished` boolean the visibility module already takes.
  - A series with no recordings shows a count of zero and no date range, rather than being hidden — the
    console is where an empty series has to be visible in order to be filled.

- **The admin Recordings panel assigns, moves and clears a recording's series from each row** — verified by
  `packages/web/tests/integration/recordings-screen.test.ts`, extended to pick a series on a row and assert
  the row reads back with it, then to clear it.
  - A picker per row listing *No series* and every series, issuing the assignment request on change.
  - It sits here rather than in the Series panel because
    [epic prd § Epic flows → B](docs/epics/epic-core-listening/prd.md#L210) assigns a series while reviewing,
    immediately before publishing, and that is the screen the admin is already on.

- **Creating, renaming and assigning are each logged with actor, action, target and timestamp under the
  request's correlation id** — verified by `packages/web/tests/integration/series-management.test.ts` using
  the existing `tests/support/log-reader.ts`.
  - The same logging shape every write in this epic already emits; no new mechanism.

### Group 2 — The member series view (plan Ticket 02)

- **A member sees every series that holds at least one published recording, and no other** — verified by
  `packages/web/tests/integration/series-browse.test.ts`, which builds a series with a published recording, a
  series whose only recording is unpublished, and a series with none, and asserts exactly one comes back.
  - `GET /api/v1/series` behind `series.browse`, reading a new `listVisibleSeries` in
    `packages/db/src/visibility.ts` — the only file allowed to compare `published_at`.
  - The member surface is requested with the existing `?surface=library` parameter, so an admin browsing
    `/series` sees what a member sees, exactly as the library already does.
  - Series are ordered by their most recent published recording, newest first, matching the product's one
    answer to "what is most recent".

- **Each series carries its title, description, recording count and date range, counted over published
  recordings only** — verified by `packages/web/tests/integration/series-browse.test.ts`, which publishes two
  of three recordings in a series and asserts a count of two and a range spanning only those two.
  - Count and range are aggregates in the same statement, never stored columns.
  - Unpublishing the last published recording of a series removes the series from the member's list without
    deleting anything, and republishing brings it back.

- **A member opens one series and sees its published recordings oldest-recorded first, numbered from `01`** —
  verified by `packages/web/tests/integration/series-browse.test.ts`, which asserts the order and the numbers
  against three known dates, and that an unpublished recording in the same series is absent.
  - `GET /api/v1/series/{id}` behind `series.browse`, through a new `findVisibleSeries` beside the list, with
    the same two gates.
  - The number is the row's position in the returned order, computed for display and stored nowhere — there
    is no ordering column, because reordering is deferred.
  - A series id that holds nothing this member may see is refused identically to one that never existed, so
    the API does not report which ids exist.

- **Each row of the series page shows the member's own progress on that recording, and only their own** —
  verified by `packages/web/tests/integration/series-browse.test.ts`, which writes progress for two members
  against the same recording and asserts each reads back their own value and never the other's.
  - The detail query joins `playback_progress` on `(user_id, recording_id)` for the requesting member.
  - A started row prints *Resume at 12:34* where the reference prints a duration; an unstarted row prints its
    date recorded. No percentage and no bar — a percentage needs a total this epic deliberately does not
    store.
  - The series view reads that row and never writes it; the player is still the only writer.

- **`/series` and `/series/{id}` are member screens built from their references, and both hold without
  artwork** — verified by `packages/web/tests/integration/series-screen.test.ts`, which signs in as a member
  in a real browser, walks the listing, opens a series, and follows a row into the recording page.
  - `/series` composes `pages/series-listing.png`: the page title, the sentence under it, and rounded rows
    with a chevron — the artwork thumbnail dropped and the row rebalanced without it.
  - `/series/{id}` composes `pages/series-inner.png`: a flat `--color-bg-deep` band with the back control
    where the hero sits, the title, the description, the meta row, and the numbered recording list. No tab
    strip, no search box, no download control.
  - Both screens are client-rendered against the API through `apiFetch`, matching every other member screen.
  - `tests/guards/style-tokens.test.ts` keeps both screens on the token layer.

- **A member reaches the series listing from the landing and from the menu, and reaches one series from a
  library row** — verified by `packages/web/tests/integration/series-screen.test.ts`, which walks landing →
  `/series` and library row → series page, and by
  `packages/web/tests/integration/member-library-screen.test.ts`, extended to assert the series label on a
  row and its absence on a recording with no series.
  - The landing's way-in row becomes *View all series* pointing at `/series`, which is what
    `pages/dashboard.png` shows; *All recordings* stays in the menu, and *All series* joins it.
  - A library row gains its series name as a small link rendered **beside** the row's own link rather than
    inside it — an anchor within an anchor is not valid markup, and the row is a whole-row link today.
  - A recording with no series shows no label and is otherwise unchanged
    ([3.3.9](docs/project/prd.md#L91)).

- **A recording that belongs to a series shows `home › series › recording` in the breadcrumb, whichever way
  the page was opened, and the series segment is a link** — verified by
  `packages/web/tests/integration/series-screen.test.ts`, which opens a recording page directly by URL and
  asserts the three segments and the link target.
  - The member recording payload gains the recording's series — id and title — so the trail is a fact about
    the recording rather than about the navigation that reached it.
  - The breadcrumb context widens from one current title to an optional parent plus a current, which is the
    shape `top-navigation/default.png` has always drawn.
  - A recording with no series keeps today's two-segment trail.

- **Every route added by this group refuses an anonymous caller, and a member is answered published rows
  only whatever the caller's role** — verified by the existing
  `packages/web/tests/integration/route-sweep.test.ts` and by
  `packages/web/tests/integration/series-browse.test.ts`, which requests the member surface as an admin and
  asserts the unpublished recording is absent from the series page.
  - The member read passes `includeUnpublished: false` explicitly rather than deriving it from the caller's
    role, which is the rule Story 4 settled.

## User steps

- none

## Assumptions

### Major (confirmed with the operator)

- Recordings inside a series are ordered oldest `recorded_at` first and numbered `01`…`NN`, the reverse of
  the library's newest-first, because a series is a study read forwards.
- Progress on a series row renders as *Resume at 12:34* for a started recording and as the date recorded for
  an unstarted one; there is no percentage and no progress bar, because no duration is stored.
- The library is not regrouped by series. Each library row gains its series name as a secondary link, the
  landing's way-in row becomes *View all series* → `/series`, and the menu carries both *All recordings* and
  *All series*.
- A member sees only series holding at least one published recording, with count and date range computed over
  published recordings only; the console sees every series and counts everything assigned.
- The Series console panel owns create, rename and description; assignment, move and clear are a picker on
  each row of the existing Recordings panel, where the admin already is before publishing.
- A recording that belongs to a series renders `home › series › recording` in the breadcrumb regardless of how
  the page was reached, and the series page renders `home › series`.
- The series-page hero artwork, download control, tab strip and *Search recordings* box are dropped rather
  than rendered disabled, and the hero becomes a flat `--color-bg-deep` band — the rule the member surface
  set in Story 4.
- `2h 14m total` in `pages/series-inner.png` is replaced by the date range
  [3.3.5](docs/project/prd.md#L87) actually specifies, not by a stored duration.

### Minor

- `series` carries `id`, `title`, `description` (nullable) and `created_at`, and nothing else; count, date
  range and artwork are absent for the reasons above.
- `recording.series_id` is a nullable foreign key declared `on delete set null` with an index on it; no
  delete route ships in this story.
- Series are addressed by uuid at `/series/{id}`, matching every other resource; no slug column.
- The member series listing orders by most recent published recording, newest first; the console list appends
  series with no recordings, ordered by title.
- The console's series list and the member's are one route separated by the existing `?surface=library`
  parameter and the `series.list` / `series.browse` action pair, not two endpoints.
- Assignment is `PUT /api/v1/recordings/{id}/series` — a sub-resource of the recording, because what it
  changes is the recording — while create, rename and read hang off `/api/v1/series`.
- Two series may share a title; there is no uniqueness constraint.
- Both new page screens and the wire contract live where their siblings do:
  `packages/shared/src/series.ts`, `packages/db/src/series.ts` for writes, and the two visibility reads in
  `packages/db/src/visibility.ts`.
- Dates render through the same `en-GB` day formatter the library and console already use, so a range reads
  `12 Mar 2025 – 4 Jun 2025`; a single-recording series prints one date.
- The series description is truncated to two lines on the series page and is absent from the listing row,
  matching what the two references show.

## Edge cases

**The console**

- The Recordings panel reads the list of series **once, when the panel loads**. A series created in
  another tab is missing from every row's picker until the page is reloaded — the admin sees a
  picker that simply does not offer the study they just named.
- Two series may share a title, and the picker shows two identical entries. An admin cannot tell
  them apart from the row and has to pick one and check the count on the Series panel.
- The picker is a plain `<select>` with no search. With a few dozen series it is a long scroll on a
  phone.
- The Series panel has no delete. A series an admin regrets exists forever; the only remedies are
  renaming it or emptying it, and an emptied series stays in the console list showing `0 recordings`.
- Two admins renaming the same series at once: last write wins silently, and the one who lost sees
  their wording replaced on the next reload with no warning. The same holds for two admins assigning
  the same recording to different series.
- Deleting a series directly in the database is safe but silent: its recordings survive with no
  series, and nothing tells the admin which teachings just lost their grouping.
- A description longer than 512 characters is refused with a generic sentence rather than a
  character count, so an admin who pasted a long blurb has to guess how much to cut.

**The member surface**

- Order inside a series is `recorded_at` alone, with the creation time breaking a tie. Two teachings
  recorded on the same day appear in the order they were uploaded and **cannot be reordered** — an
  admin who wants them the other way round has to change one recording's date.
- The `01.`–`NN` numbers are positions, not stored labels. Assigning a recording into the middle of
  a series **renumbers every row after it**, so a member who wrote down "number 4" finds a different
  teaching there.
- Past ninety-nine the number renders as `100.` rather than a padded three digits, so the column
  stops lining up in a series that long.
- A member sitting on a series page when its last published recording is taken down sees no change
  until they navigate; the next load answers "There is no such series" rather than saying the series
  emptied.
- Neither series screen paginates or filters. Every series with a published recording is one page,
  and so is every recording in one.
- A very long series title on a library row is truncated with an ellipsis and has no tooltip.
- `GET /api/v1/series/{id}` **without** the surface parameter answers an admin with unpublished
  recordings. That is the console's reading and is deliberate; no screen calls it that way today, so
  the only way to see it is by hand.
- The series listing has no empty state distinct from a failure: a member for whom nothing is
  published reads "No series have been published yet", which is also what they would read if every
  series happened to be empty.

## Implementation notes

### Assumptions — major (confirmed with the operator)

- none. Planning settled every user-facing decision this ticket needed; nothing came up in the code
  that changed the target architecture, the cost of running it, or what a person sees.

### Assumptions — minor

- The generic 512-character field cap covers the description as well as the title, exactly as the
  criterion says. No longer ceiling was invented for prose.
- An empty description is stored as `null`, so "nothing written here" has one representation rather
  than two.
- `PUT /api/v1/recordings/{id}/series` answers with a bare `{ id, seriesId }` rather than the whole
  recording — the picker needs to know the write landed and re-reads the list for everything else.
- The `series.assign` log line's target is `series:<id>`, or `series:none` when the recording is
  taken out of one, with the recording id carried alongside as its own field.
- `findVisibleSeries` takes the requesting account's id as a parameter, because the progress join is
  per-caller. The list read does not, because a listing shows no progress.
- The member series listing is fetched with `?surface=library`; the console's Series panel calls the
  same route with no parameter, matching the recordings pair exactly.
- The breadcrumb hook widened from `useBreadcrumbTitle(title)` to
  `useBreadcrumbTrail(current, parentLabel, parentHref)`. The parent is passed as two strings rather
  than an object so the effect's dependencies are stable.
- The library's hairline divider moved from the row's link onto the list item, because a row is now
  a link plus an optional series link and a border on the link alone would draw a line between them.
- Both series screens declare their own `en-GB` day formatter, matching what the library, the
  console and the recording page already do.
- `Intl` renders September as `Sept` in `en-GB`, so a range can read `11 Mar 2026 – 2 Sept 2026`.
  Consistent everywhere, and the tests assert that spelling rather than working around it.

### Other notes

- **The exact-column-set migration tests were the reason two absences stayed absent.** Adding
  `series` meant touching `packages/db/tests/integration/migrations.test.ts`'s table list and adding
  a before-and-after block; the block asserts `recording_count`, `date_range`, artwork, `position`,
  `slug` and the podcast fields are all missing, which is what stops the next person adding one "for
  later".
- **Three existing tests asserted an exact payload key set** — `publishing.test.ts` twice and
  `pipeline.test.ts` once — and all three had to gain `series`. That is the mechanism working: a new
  field on `RecordingView` cannot cross the wire unnoticed.
- **The landing's way-in row changed destination**, so four screen tests that used it as a "you are
  signed in" marker now look for *View all series*. Worth knowing before reading their diffs.
- **`describeSeriesMeta` is written twice** — once in the console panel, once in
  `series-listing.tsx`, which the series page imports. They are the same sentence for two different
  surfaces; if a third appears, that is the moment to move it into `@thp/shared`.
- The console's picker loading its series list once (first edge case above) is the one gap that
  would be cheap to close — reloading the list alongside the recordings list — and it was left out
  because no acceptance criterion asks for it.
