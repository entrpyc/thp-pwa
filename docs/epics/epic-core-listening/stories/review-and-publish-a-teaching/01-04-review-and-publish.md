# Ticket 01–04 — Draft generation, the review gate, regeneration, and publish
_Story: Review and publish a teaching_

> Phase 6 artefact for [implementation plan § Ticket 01](docs/epics/epic-core-listening/implementation-plan.md#L253),
> [§ Ticket 02](docs/epics/epic-core-listening/implementation-plan.md#L274),
> [§ Ticket 03](docs/epics/epic-core-listening/implementation-plan.md#L291) and
> [§ Ticket 04](docs/epics/epic-core-listening/implementation-plan.md#L302) — **the whole story planned as one
> doc at the operator's instruction.** The plan cuts them into four; this doc puts them back together and
> states the cost of that below rather than leaving it to be discovered at review. The criteria stay in four
> groups so the parts can still be read apart.
>
> Sections pulled, Ticket 01: [epic prd § In scope → 3](docs/epics/epic-core-listening/prd.md#L77);
> [3.6.1](docs/project/prd.md#L135); [3.6.2](docs/project/prd.md#L136);
> [4.17.1](docs/project/prd.md#L699) (**description only** — topics, tags and scripture references deferred);
> [4.17.5](docs/project/prd.md#L703); [3.21.2.2](docs/project/prd.md#L495); [4.5](docs/project/prd.md#L567);
> [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The review gate*;
> [epic architecture § Worker process](docs/epics/epic-core-listening/architecture.md#L139);
> [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Review-gate `kind`*
> and *Domain events*.
> Ticket 02: [3.6.4](docs/project/prd.md#L138); [3.6.5](docs/project/prd.md#L139); [3.6.6](docs/project/prd.md#L140);
> [3.6.7](docs/project/prd.md#L141); [3.6.10](docs/project/prd.md#L144); [4.17.2](docs/project/prd.md#L700);
> [3.19.2](docs/project/prd.md#L440); [3.19.3](docs/project/prd.md#L441).
> Ticket 03: [3.6.9](docs/project/prd.md#L143).
> Ticket 04: [epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100);
> [3.2.2](docs/project/prd.md#L65); [3.2.11](docs/project/prd.md#L74); [3.6.11](docs/project/prd.md#L145);
> [3.6.12](docs/project/prd.md#L146); [4.17.3](docs/project/prd.md#L701);
> [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The spine*.
>
> Carried in because this story touches them: [3.6.8](docs/project/prd.md#L142), the editor approve-with-edits
> opens; [3.5.8](docs/project/prd.md#L125) and [3.21.2.3](docs/project/prd.md#L496), the reason a draft can be
> absent; [3.21.2.4](docs/project/prd.md#L497), the re-run this story's regeneration sits beside;
> [3.19.1](docs/project/prd.md#L439), the console these panels join; [3.1.2](docs/project/prd.md#L44) and
> [3.1.5](docs/project/prd.md#L47), the two rules every route here obeys;
> [epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255) — the generate-adapter row
> and the one-call row;
> [epic architecture § Divergence from the north star](docs/epics/epic-core-listening/architecture.md#L294);
> [epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341);
> [project architecture § Estimated running costs](docs/project/architecture.md#L343) — the LLM line this story
> spends against;
> [project architecture § Cross-cutting concerns](docs/project/architecture.md#L271) — the single-query Pending
> Reviews the `kind` column exists to protect;
> [implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L48);
> [implementation plan § Design references](docs/epics/epic-core-listening/implementation-plan.md#L81) — the
> admin-screen carve-out;
> [02-job-ledger-and-worker-loop.md](docs/epics/epic-core-listening/stories/get-a-recording-transcribed/02-job-ledger-and-worker-loop.md)
> — the no-payload decision Ticket 03 reverses, and the partial unique index regeneration relies on;
> [04-05-pipeline-status-and-speaker-labels.md](docs/epics/epic-core-listening/stories/get-a-recording-transcribed/04-05-pipeline-status-and-speaker-labels.md)
> — the stub marker Ticket 01 removes and the per-step re-run that is the escape hatch here.

**This is the story that makes the epic non-throwaway.**
[epic prd § Rationale](docs/epics/epic-core-listening/prd.md#L241) names publishing-without-a-review-gate as one of
three things that would make this epic disposable. Until this story lands, the pipeline produces a transcript
nobody reads and `published_at` is a column nothing writes. After it, every AI artefact this product will ever
generate has a shape to arrive in, and member visibility is one condition in one place.

**Five things worth naming before the criteria.**

**One diff, four tickets.** The plan cuts these apart because each is independently reviewable — a worker
step, an admin screen, a re-enqueue path, a publish gate. Merged at the operator's instruction, the review
cost is real and concentrated: a doubt about the visibility condition blocks the schema, and a schema change
lands in the same diff as two screens. The mitigation is that the criteria below stay in four groups in the
plan's order, and each group is separately runnable.

**The generation provider is MiniMax, not Claude — and that is a divergence nothing has recorded yet.**
[epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255) says "Claude behind a
`generate` adapter" and [project architecture § Key technology choices](docs/project/architecture.md#L209) picked
Claude by name for long-context generation. The operator chose MiniMax M3 instead. The same architecture row
calls this reversal cost *deliberately low* — a narrow port, one file — so the seam is working exactly as
designed rather than breaking. But
[epic architecture § Divergence from the north star](docs/epics/epic-core-listening/architecture.md#L294) lists two
divergences and this is a third. **Amending it is a Phase 4 edit and is out of scope here**; until somebody
makes it, the next person reading the architecture against the code finds a vendor the architecture never
named.

**Structured output is a forced tool call, not a schema parameter.** Neither of MiniMax's compatible surfaces
documents JSON-schema response formatting; both support tool calling. So the two artefacts come back as one
tool call carrying a two-property object, parsed as JSON. The failure mode this creates is named rather than
defended against: a model that answers in prose instead of calling the tool **fails the job**, which reads on
`/admin/pipeline` with its reason and is re-runnable — the same failure shape a bad ASR response already has.

**Generation costs about a fiftieth of the budgeted line.** M3 is $0.30/M input and $1.20/M output below 512K
input. An ~80k-token transcript plus ~1k of output is **~$0.025 a recording, ~$0.11/month** at 4.3
recordings, against the $2 LLM row in
[project architecture § Estimated running costs](docs/project/architecture.md#L343) — which budgets five passes
where this epic runs one. The table is now conservative rather than wrong, so it needs no edit; regeneration
is cheap enough that nothing in this story rations it.

**"Per-field" has one field per kind in this epic.** [4.17.2](docs/project/prd.md#L700) wants accept/edit/discard
per field, and both kinds here carry exactly one — `summary`, `description`. The form is built generically
over `fields` and `provenance` anyway, because that generality is what kinds 3–6 inherit
([epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) — *Review-gate `kind`*).
It is structure earning its keep later, not decoration now.

---

## Goal

Transcription completing produces a draft summary and a suggested description from one provider call; an
admin reads them in a queue, accepts, edits, regenerates or discards each, and then explicitly publishes the
recording — which is the only thing that makes anything visible to a member.

- As an admin I want the machine to draft a summary and a description as soon as a teaching is transcribed,
  so reviewing is editing rather than writing ([3.6.1](docs/project/prd.md#L135),
  [4.17.1](docs/project/prd.md#L699)).
- As an admin I want one queue holding everything waiting on me, so finding work is not opening recordings
  one at a time ([3.19.2](docs/project/prd.md#L440)).
- As an admin I want to accept, edit, regenerate or discard each draft, and to steer a regeneration with a
  sentence when the first pass missed the point
  ([3.6.6](docs/project/prd.md#L140)–[3.6.10](docs/project/prd.md#L144)).
- As an admin I want to decide when a teaching goes live, and to take it back down without losing anything
  ([3.2.2](docs/project/prd.md#L65), [3.2.11](docs/project/prd.md#L74), [4.17.3](docs/project/prd.md#L701)).
- As a member I want to be refused everything that has not been published, by the API and not merely by the
  interface ([3.1.2](docs/project/prd.md#L44), [3.1.5](docs/project/prd.md#L47)).

## Out of scope

- **Every review-gate `kind` except the two.** Scripture references, tags, topics, mind maps and video
  scripts each add a `kind` value and a generation step in a later epic; the queue query does not change when
  they do ([epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323)). Nothing
  here anticipates them beyond the column that holds them.
- **The in-app "ready for review" notification** ([3.6.3](docs/project/prd.md#L137)) and the "notified when the
  new draft is ready" half of [3.6.9](docs/project/prd.md#L143). Both deferred with
  [§3.17](docs/project/prd.md#L371); the queue is how an admin finds work in this epic. Domain events are
  emitted and logged so [§3.17](docs/project/prd.md#L371) has something to subscribe to — **nothing subscribes,
  and no notification row exists.**
- **Every member-facing screen.** The library, the recording page, the player and the transcript are Story 4
  and Story 5. This story ships the member-visible *read* and no interface over it — validation is that the
  API grants and refuses correctly.
- **Series** ([epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md#L100)'s other half) — Story 6. A
  recording has no series and there is no column for one.
- **Prompt caching.** The cost table's "cached once per recording and read by the remaining four" describes a
  five-pass future; this epic makes one call per recording, where a cache write costs 1.25× for no read.
- **Bulk review** ([3.21.3.4](docs/project/prd.md#L507)) and back-catalogue items in the queue. Reviewing is one
  item at a time.
- **Rich text.** [3.6.8](docs/project/prd.md#L142) says plain text with line breaks is sufficient. No editor
  toolbar, no markdown rendering, no formatting controls.
- **Summary history, versioning, or diffing an edit against the draft.** The closed `review_item` holds what
  the machine said and the `summary` row holds what the admin approved; nothing computes the difference
  between them.
- **A per-recording admin page.** [3.6.4](docs/project/prd.md#L138)'s "from the recording page" is served by a
  control on the existing `/admin/recordings` row, because the recording page itself is Story 4 Ticket 01.
- **Editing the description after publish.** [3.6.11](docs/project/prd.md#L145) is about the summary, and only
  the summary gets a post-publish edit path here.
- **Automatic retry or backoff on a failed generation.** A failed job stays failed until a human presses
  re-run, exactly as Story 2 Ticket 02 settled.
- **Streaming the generation anywhere.** The handler blocks on one request and writes rows; no screen watches
  a draft being written.
- **Any quality score, confidence or gate on the generated text.** The confidence gate belongs to
  transcription ([3.5.8](docs/project/prd.md#L125)); a draft's quality is a judgement the admin makes by reading
  it.
- **Pagination, filtering, sorting or search over the queue.** There are five recordings and at most ten open
  items.
- **The Contributor role.** Two roles, one privileged, exactly as everywhere else in this epic
  ([epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341)).
- **Amending the architecture's Claude row or adding a third entry to
  [§ Divergence](docs/epics/epic-core-listening/architecture.md#L294).** A Phase 4 edit, named in the preamble,
  not made here.

## User prerequisites

- **A MiniMax API key**, from the international platform, set as `GENERATE_API_KEY`. No default exists and
  none will: a missing key must fail at the first generation naming the variable, not as an authorisation
  error inside a provider call.
- **Confirm M3's published rate before implementation starts.** The numbers this doc reasons with are $0.30/M
  input and $1.20/M output below 512K input. If they have moved by an order of magnitude,
  [project architecture § Estimated running costs](docs/project/architecture.md#L343) needs revisiting and that is
  a scope decision rather than something to absorb here.
- **A real transcribed teaching** — the Story 2 pipeline run end to end against a genuine 90-minute
  recording, not a fixture. Whether the draft is any good is the one thing no test can answer, and a
  fixture-length transcript cannot show it.
- The app and the worker both running, as Story 2 already established.

## Acceptance criteria

### Ticket 01 — Draft generation: summary and description

- `review_item` exists with exactly `(id, recording_id, kind, status, fields, provenance, created_at,
  reviewed_by, reviewed_at)` and no other column — verified by the existing migration test asserting the
  exact column set.
  - A new numbered SQL migration beside the existing eight; `recording_id` cascades, `reviewed_by` sets null
    on delete because a closed item is a record of something that happened.
  - Two new enums, `review_kind` (`summary`, `recording_metadata`) and `review_status` (`draft`, `published`,
    `discarded`), **derived from shared TypeScript constants** rather than restated beside them, which is what
    `tests/guards/domain-declarations.test.ts` already enforces for the three existing enums.
  - `fields` and `provenance` are `jsonb`, which is what makes per-field accept/edit/discard a form over one
    row rather than a column per field per artefact.
- `summary` exists with exactly `(id, recording_id, content, published_at, created_at, updated_at)`, unique
  on `recording_id` — verified by the same migration test.
  - `published_at` nullable, not a status column: the same shape as `recording.published_at` and
    `user.deactivated_at`, so [3.6.12](docs/project/prd.md#L146)'s return-to-draft is one write of null and
    "published" is a fact about the column rather than a second thing to keep in step.
  - Unique on `recording_id` because [4.5](docs/project/prd.md#L567) is one summary per recording, and the
    database is what says so.
- Transcription completing chains into `generate_draft`, and the step is no longer a stub — verified by an
  integration test running the real loop and asserting the job's `provider_meta` carries no stub marker and
  two `review_item` rows exist.
  - The chain rule is untouched; what changes is the handler behind the step. The stub marker in
    `packages/worker/src/handlers.ts` goes with it, and it is the last one.
- **One provider call produces both artefacts** — verified by a unit test over the adapter asserting a single
  request is built carrying the whole transcript, and an integration test asserting one fake call yields two
  rows.
  - The transcript is joined from `segment` rows in index order; there is no concatenated copy to read
    because Story 2 Ticket 03 deliberately did not write one.
  - One call for both is the cost and consistency decision
    [epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255) already took.
- Two rows are written, one `summary` and one `recording_metadata` carrying the suggested description —
  verified by an integration test asserting the kinds and the `fields` contents.
- Each row records the model, the model version and the prompt version that produced it — verified by a test
  asserting all three are present and non-empty on both rows ([4.17.5](docs/project/prd.md#L703)).
  - Prompt version is a named constant in the prompt module, bumped by hand when the prompt text changes; the
    value is meaningless as anything but a label, and deriving it would make it lie.
- Per-field provenance records that each field was AI-suggested and that no admin has changed it — verified
  by a test asserting the provenance shape for both kinds.
- The job's `provider_meta` carries model, version, token counts and cost — verified by a test asserting the
  fields, in the shape the `transcribe` handler's already uses ([§7](docs/project/prd.md#L779) wants spend
  measured rather than estimated).
- **Nothing is member-visible.** No `summary` row is created, `recording.description` is untouched, and
  `published_at` stays null — verified by a test asserting all three after a successful generation
  ([3.21.2.2](docs/project/prd.md#L495), [3.6.2](docs/project/prd.md#L136)).
- **Running the handler twice leaves one draft per kind** — verified by an integration test invoking it twice
  on the same recording and asserting two rows, not four.
  - Dispatch is at-least-once, so the write replaces open drafts for the kinds it generates rather than
    appending. Closed items are never touched, which is what keeps the audit trail intact.
- A recording with no transcript fails the job naming that, rather than generating from nothing — verified by
  an integration test asserting the job's error text.
- **The provider is named in exactly one file** — verified by a new `tests/guards/generate-boundary.test.ts`
  in the shape `asr-boundary.test.ts` already takes, refusing both a provider SDK import and a literal
  provider host anywhere outside `packages/worker/src/generate/minimax.ts`.
  - Hosts checked include the ones not in use, so a second door needs a deliberate edit to a named list
    rather than merely a different vendor.
  - This is what makes the low reversal cost the architecture claims for the generate adapter true rather
    than intended — the same argument the ASR guard already carries.
- The two artefacts come back as **a forced tool call**, and a response that is prose instead fails the job
  with a reason — verified by unit tests over two captured fixtures, one a well-formed tool call and one a
  text-only answer.
  - Structured output by schema is not documented on either MiniMax-compatible surface; tool calling is, and
    it is the reliable route to two named strings.
- A `fake` generator reads a fixed script off disk and reaches no network — verified by the suite running
  against it throughout, and by a unit test asserting the factory builds it from `GENERATE_PROVIDER=fake`.
  - The same shape as `ASR_PROVIDER=fake` and `MAIL_TRANSPORT=capture`, which is what makes "no test reaches a
    provider" a property of the configuration rather than of a mock somebody remembered to install.
- A domain event is emitted at job completion, logged, with nothing subscribing — verified by a test reading
  the log sink ([epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) —
  *Domain events*).

### Ticket 02 — Pending Reviews queue and review form

- Everything awaiting admin action is readable as **one query over `review_item.status`** — verified by an
  integration test in `packages/db` seeding items of both kinds in all three statuses and asserting only the
  drafts come back, from a single call.
  - A new `packages/db/src/reviews.ts` holding the read. The query filters one column and joins the recording
    for its title and date; it does not branch on `kind`, which is the property
    [project architecture § Cross-cutting concerns](docs/project/architecture.md#L271) says must not degrade into
    a union of six.
- `GET /api/v1/reviews` serves the queue, admin-only — verified by API tests asserting the payload and
  asserting `forbidden` for a member session and an anonymous request.
- A fourth console panel exists at `/admin/reviews`, reachable from the panel list — verified by a Playwright
  test in the shape `recordings-screen.test.ts` uses, asserting the link and the landing.
  - One entry in `PANELS` in `packages/web/src/app/admin/console-shell.tsx`, which is all "a fourth panel is
    one entry" ever had to mean.
  - **No design reference exists for any admin screen** — composed from
    [style-guide.md](docs/design%20referencess%20png/style-guide.md) and the token layer, the same carve-out
    the three existing panels took, with `reviews.module.css` composing from `admin.module.css` so the four
    cannot drift.
- The queue lists items of both kinds together, newest recording first — verified by a Playwright test
  seeding both kinds and asserting the rendered rows and their order.
- The review form shows the draft in full alongside the recording title, date and word count — verified by a
  Playwright test asserting all four ([3.6.5](docs/project/prd.md#L139)).
  - Word count is the transcript's, computed from the segment rows at read time. Nothing stores it; at ~900
    segments the sum is cheaper than a column somebody has to keep in step.
- **Approve writes through to the canonical entity and closes the item** — verified by integration tests per
  kind: `summary` writes `summary.content` with `published_at` set, `recording_metadata` writes
  `recording.description`, and both leave the item `published` with `reviewed_by` and `reviewed_at` stamped.
- **Edit then approve** writes the admin's text, not the machine's, and provenance records that an admin
  changed the field — verified by an integration test asserting the stored content and the provenance flag
  ([3.6.8](docs/project/prd.md#L142), [4.17.5](docs/project/prd.md#L703)).
  - Plain text with line breaks; the editor is a textarea.
- **Discard closes the item with no replacement, and the recording remains publishable** — verified by an
  integration test asserting the item reads `discarded`, no `summary` row exists, `recording.description` is
  untouched, and a publish immediately after succeeds ([3.6.10](docs/project/prd.md#L144)).
  - The draft text stays in the closed row. What [3.6.10](docs/project/prd.md#L144) calls deletion is satisfied
    in the sense that matters — no summary exists and nothing is member-visible — while the row remains the
    record of what the machine proposed and who rejected it.
- Acting on an item that is already closed is refused rather than silently re-applied — verified by API tests
  asserting the error code for approve, edit-approve and discard against a `published` and a `discarded` item.
- The review form is reachable from the queue **and** from the `/admin/recordings` row — verified by a
  Playwright test opening it from both and asserting the same form ([3.6.4](docs/project/prd.md#L138)).
- Every gate transition is logged with actor, action, target and timestamp — verified by a test reading the
  log sink in the shape the existing transition tests use
  ([implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L48)).
- The panel and the form work on phone, tablet and desktop — verified by the Playwright tests running their
  assertions at the three viewports the existing screen tests already use.
- A member who navigates to `/admin/reviews` is redirected, and every review route refuses a member
  independently — verified by API tests per route and a Playwright test asserting the redirect.
  - The page gate decides what to render and authorises nothing, exactly as the three existing panels.

### Ticket 03 — Regenerate with a steering prompt

- `job` carries a nullable `payload` column and no other new column — verified by the existing migration test
  asserting the exact column set.
  - **This reverses Story 2 Ticket 02's deliberate "no payload".** That decision rested on "a step's input is
    the recording it names", which stops being true the moment [3.6.9](docs/project/prd.md#L143) steers one kind
    with a sentence. `jsonb`, null on every chained job, so the chain is unchanged.
- An admin regenerates a draft, optionally supplying a short prompt — verified by an API integration test
  asserting the current item closes as `discarded` and a `generate_draft` job is enqueued carrying the kind
  and the prompt in its payload.
  - `POST /api/v1/reviews/{id}/regenerate`, enqueued through the existing queue port so the row carries the
    request's correlation id and computes `attempt` inside the insert.
  - The same handler as Ticket 01, not a second path — which is what makes Story 5 Ticket 02's regeneration
    offer a call to something that already exists.
- The handler generates **only the kinds the payload names**, and includes the steering prompt in the request
  — verified by an integration test asserting one row written for a single-kind payload, and a unit test
  asserting the prompt reaches the built request.
- A payload-free job still generates both kinds — verified by the Ticket 01 chain test continuing to pass
  unchanged.
- The new draft returns to the queue as a fresh `draft` item — verified by an integration test asserting the
  queue read returns it.
- The steering prompt is recorded on the new item's provenance — verified by a test asserting it is readable
  after generation, so an admin can see what they asked for.
- **One generation in flight per recording**: a second regeneration while one is unfinished is refused with a
  named error rather than silently answered with the in-flight job — verified by an API test issuing two and
  asserting the second's error code.
  - The partial unique index on `(recording_id, step)` allows only one unfinished `generate_draft`, so
    returning the existing job would hand back work for a different kind. Refusing is the honest answer at
    4.3 recordings a month.
- Regenerating with no prompt is legal — verified by an API test omitting the field.
- Regenerating an already-closed item is refused — verified by an API test asserting the error code.
- The regeneration is logged with actor, action, target and timestamp — verified by a test reading the log
  sink.
- The route refuses a member and an anonymous request — verified by API tests asserting `forbidden` and
  `unauthenticated`.

### Ticket 04 — Publish and unpublish

- An admin publishes a recording, setting `published_at`; unpublish clears it — verified by API integration
  tests asserting the column after each ([3.2.2](docs/project/prd.md#L65), [3.2.11](docs/project/prd.md#L74)).
  - `POST /api/v1/recordings/{id}/publish` and `.../unpublish`. Publishing an already-published recording is
    a no-op answering with the existing timestamp, so pressing twice is harmless without the API inventing a
    conflict.
- **Unpublish deletes nothing** — verified by an integration test asserting the summary, transcript, segments,
  jobs and review items all survive an unpublish and that a re-publish restores visibility.
- **The member visibility condition is written once, in one place** — verified by a new
  `tests/guards/visibility-boundary.test.ts` refusing a `published_at` comparison anywhere outside the one
  query module that owns it.
  - The same shape of rule as the role-usage and queue-boundary guards, and for the reason the plan states:
    every read path added in the next three stories inherits this rule, and a rule re-implemented per route is
    a rule that will be forgotten on the fourth one. A guard makes "written once" checkable rather than
    reviewed.
- `GET /api/v1/recordings` answers both roles, and **a member sees only published recordings and no
  admin-only fields** — verified by API tests for both roles asserting the rows returned and the exact key set
  of the payload.
  - A new `recording.browse` policy action permitting both roles, following the split every action pair in
    this codebase already takes; the service adds unpublished rows and `originalMediaKey` only when the caller
    also satisfies `recording.list`.
  - One route rather than two, so Story 4 Ticket 01 builds its library on this and does not invent a second
    answer to "what may this person see".
- **A summary is member-visible only when both gates are open** — verified by API tests over the four
  combinations: published recording with a published summary shows it; published recording with a draft,
  discarded or absent summary shows none; unpublished recording shows nothing at all.
- An admin can edit a summary after publish — verified by an API integration test asserting the new content
  and that `published_at` is unchanged ([3.6.11](docs/project/prd.md#L145)).
- An admin can return a published summary to draft — verified by an API integration test asserting
  `published_at` is null, the content is retained, and the member read no longer carries it
  ([3.6.12](docs/project/prd.md#L146)).
- **Publishing has no precondition beyond the recording existing** — verified by integration tests publishing
  a recording with open draft items, one with a discarded summary, and one with no transcript at all, and
  asserting each succeeds ([3.6.10](docs/project/prd.md#L144)).
  - Nothing publishes automatically ([4.17.3](docs/project/prd.md#L701)); nothing blocks an admin who has
    decided either.
- A publish or unpublish for an unknown recording answers `not_found` — verified by API tests asserting the
  code.
- A domain event is emitted on publish, logged, with nothing subscribing — verified by a test reading the log
  sink.
- Publish and unpublish are logged with actor, action, target and timestamp — verified by a test reading the
  log sink.
- Publish, unpublish and the summary controls are reachable from the `/admin/recordings` row, and the row
  shows whether the recording is live — verified by a Playwright test pressing each and asserting the
  rendered state, at the three viewports.
- Every new route refuses a member except `recording.browse`, and refuses an anonymous request — verified by
  API tests per route.

### End to end

- Upload → transcribe → generate_draft → queue → approve both kinds → publish leaves a recording a member's
  `GET /api/v1/recordings` returns with its summary and description; unpublishing removes it from that answer
  — verified by an integration test running the real loop against MinIO and the fake generator, driving the
  admin actions through the API and reading back as a member.
- Regenerating with a prompt, approving the second draft and publishing produces the second draft's text —
  verified by the same test extended, which is [epic prd § Epic flows](docs/epics/epic-core-listening/prd.md#L210)'s
  review path end to end.
- Every new `/api/v1` route requires a session — verified by the existing route-sweep test, which must still
  pass with **no new entry on the unauthenticated allowlist**.
- `/admin/pipeline` shows `generate_draft` as a real success rather than *not built yet* — verified by the
  existing pipeline panel test, whose stub-marker assertion for that step is removed with the stub.

## User steps

- Run `npm run migrate` against any environment that already has a database.
- Add `GENERATE_PROVIDER`, `GENERATE_API_KEY` and `GENERATE_FAKE_SCRIPT` to `.env` from `.env.example`.
- With the app and the worker both running, upload a genuine 90-minute teaching and let the pipeline run to
  the end.
- **Read the generated summary and description against the audio.** Whether they are worth publishing is the
  one judgement no test makes, and it is the whole reason the review gate exists. If they are poor, try a
  steering prompt before concluding anything about the model.
- Confirm `provider_meta` on the `generate_draft` job reports a cost near $0.025 for a 90-minute teaching. An
  order of magnitude above that means the rate or the token count is not what this plan assumed, and
  [project architecture § Estimated running costs](docs/project/architecture.md#L343) needs revisiting.
- Approve both drafts, publish the recording, then sign in as a member and confirm it is visible; unpublish
  and confirm it is not.
- **Record the third divergence** in
  [epic architecture § Divergence from the north star](docs/epics/epic-core-listening/architecture.md#L294) and
  amend the generate-adapter row of
  [§ Key choices](docs/epics/epic-core-listening/architecture.md#L255) to name MiniMax. A Phase 4 edit, deliberately
  not made by this ticket.

## Assumptions

### Major (confirmed with the operator)

- **The generation provider is MiniMax M3**, reached over the Anthropic-compatible endpoint with plain
  `fetch` and no SDK — the same shape the Deepgram adapter takes, behind a `generate` port with a `fake`
  beside it and a boundary guard over both.
- **Structured output is a forced tool call**, because neither MiniMax-compatible surface documents JSON
  schema response formatting. A prose answer fails the job rather than being salvaged.
- **The whole transcript of every teaching leaves the system to a third-party provider outside the EU.**
  Third-party LLM egress was already the architecture's position; the jurisdiction is what changed, and the
  operator has settled it.
- **`summary` is its own table** with `content` and a nullable `published_at`, created on approve. A summary
  is member-visible only when both `summary.published_at` and `recording.published_at` are set — two gates.
  The description has no second gate; it is a column on `recording` and rides the recording's publish state.
- **`job` gains a nullable `payload` column**, reversing Story 2 Ticket 02's explicit no-payload decision,
  because a steered regeneration has nowhere else to put the kind and the prompt. Null on every chained job.
- **One generation in flight per recording.** A second regeneration request is refused with a named error
  rather than answered with the unfinished job, which the partial unique index would otherwise hand back for
  the wrong kind.
- **Discard closes the item as `discarded` and retains the draft text** in the closed row. No summary exists
  and nothing is member-visible, which is what [3.6.10](docs/project/prd.md#L144) is protecting; the row stays
  as the record of what was rejected.
- **`GET /api/v1/recordings` widens to both roles** and is where the one visibility condition lives, guarded
  so no second implementation of it can be written. A member sees published rows without admin-only fields.
- **Publishing has no precondition on the review queue.** Open drafts, a discarded summary and a missing
  transcript all leave a recording publishable.
- **Pending Reviews is a fourth console panel at `/admin/reviews`**, with a second entry point as a control on
  the `/admin/recordings` row. No per-recording admin page is built.

### Minor

- Env variables are `GENERATE_PROVIDER`, `GENERATE_API_KEY` and `GENERATE_FAKE_SCRIPT`, mirroring the ASR
  block's naming so the pattern holds across adapters.
- Adaptive thinking is left off on the generation call. Summarising a transcript is not reasoning-bound, and
  turning it on is one line if a read of the first real drafts says otherwise.
- The prompt lives in its own module beside the adapter with a hand-maintained version constant, so a prompt
  change is one edit and one bumped label.
- New policy actions: `review.list`, `review.resolve`, `review.regenerate`, `recording.publish`,
  `recording.unpublish`, `summary.edit`, `summary.unpublish` — all admin-only — plus `recording.browse` for
  both roles. Split per action, as every existing group is.
- Word count is the transcript's, summed over segments at read time rather than stored.
- Domain events are a typed union emitted through one function whose only sink is the logger, because no
  consumer exists to write to.
- The queue is ordered by the recording's `recorded_at` descending, matching every other admin list.
- `review_item.fields` holds `{ summary }` for the summary kind and `{ description }` for the metadata kind;
  `provenance` holds, per field, that it was AI-suggested and whether an admin changed it.

## Edge cases

- A worker killed mid-generation loses the steering prompt and the single-kind scope: the startup
  sweep re-queues the job **without its payload**, so the retry drafts both kinds and replaces the
  other kind's open draft too. The admin sees an un-steered draft where they asked for a steered
  one, and has to press Regenerate again.
- Two admins approving the same draft at the same moment: one succeeds and the other is told the
  draft has already been dealt with, but the second admin's edits are lost with the refusal — the
  form does not offer them the winning text to merge against.
- Editing a summary after publish has no concurrency check: two admins editing at once, last write
  wins silently and neither is told.
- A draft whose text is longer than 20,000 characters is refused at approval with "not text this
  can store" — the form gives no warning while it is being typed, and the length is not shown.
- A regeneration refused with `generation_in_flight` gives no indication of how long the in-flight
  job has left, or which kind it is generating. The admin presses again and finds out.
- Nothing shows an admin that a `generate_draft` job *failed*: the queue only lists what exists, so
  a recording whose drafting failed reads as "no drafts yet" here and only says why on
  `/admin/pipeline`.
- A recording deleted while its drafts are open takes them with it (cascade), and any admin holding
  the queue open gets `not_found` on the next press rather than a message about the recording.
- Approving a `recording_metadata` draft overwrites `recording.description` with no record of what
  was there before, if a previous draft had already been approved.
- The queue has no pagination, filtering or search, and the panel does not poll: an admin leaving it
  open while the worker finishes a recording sees nothing new until they reload.
- The steering prompt is sent to the provider verbatim. Nothing sanitises it, and an admin who
  writes instructions contradicting the standing prompt gets whatever the model does with that.
- A member calling `GET /api/v1/recordings` gets every published recording in one answer, unpaged.
  At five recordings that is correct; the payload grows linearly with the library.
- The word count counts whitespace-separated tokens, so hyphenated words count as one and numbers
  count as words. It is an indication of length, not a metric.
- `summary.updated_at` is written but nothing reads it — no screen shows when a summary was last
  edited.

## Implementation notes

### Assumptions — major (confirmed with the operator)

- Everything under *Assumptions → Major* above held in implementation; nothing needed a new
  decision from the operator. The two worth re-stating because the code makes them concrete:
  **approving a summary publishes the summary** (its `published_at` is set by the approve write),
  and **the recording's own gate is a separate press** — so a fully reviewed teaching is still
  invisible until an admin publishes it.
- **`GET /api/v1/recordings` widened from `recording.list` to `recording.browse`**, which changes an
  existing behaviour rather than adding one: a member who previously got `forbidden` now gets a
  filtered list. The existing test asserting that refusal was updated to assert the new answer.

### Assumptions — minor

- Two new API error codes rather than reusing existing ones: `review_closed` for acting on a closed
  item, and `generation_in_flight` for a second regeneration while one is unfinished.
- The queue port gained a **read** — `findUnfinished(recordingId, step)` — because the in-flight
  refusal cannot be asked any other way without reaching past the port and breaking the
  queue-boundary guard. Documented at the interface as a deliberate exception.
- Resolve is one route taking an action in the body (`approve` | `discard`) rather than three
  routes, so the already-closed refusal is remembered in one place.
- Publish, unpublish and summary-to-draft are bodiless `POST`s to named sub-resources; the summary
  edit is a `PUT` because it genuinely replaces the content of a resource that already exists.
- The `Generator` port answers **one string per kind** (`Partial<Record<ReviewKind, string>>`)
  rather than a nested field map, because every kind in this epic carries exactly one field and the
  field's *name* is `REVIEW_FIELD`'s business. A later kind with two fields widens that type.
- The MiniMax adapter builds its tool schema from the requested kinds, so a single-kind
  regeneration does not pay for a field it would discard.
- Prompt version is the constant `draft-1` in `packages/worker/src/generate/prompt.ts`.
- `describeRecording` (the creation response) always answers `summary: null`, so what the API
  returns on create is the same shape the list returns.
- The reviews panel reads its deep-link parameter from `window.location.search` in an effect rather
  than through a router hook, so the panel needs no Suspense boundary around it.

### Other notes

- **The last stub is gone.** `STUB_PROVIDER_META` was deleted from the worker; `STUB_PROVIDER_META_KEY`
  and `isStubProviderMeta` stay in `@thp/shared` because rows written while the stub existed are
  still in the ledger and `/admin/pipeline` must still read them as *not built yet*. Three tests
  that seeded a stub row now build the marker from the shared key, which is what they were always
  simulating.
- **`packages/db/src/recordings.ts` no longer exports `listRecordings`.** Every list of recordings
  now goes through `visibility.ts`, so there is one answer to "who may see this" and one answer to
  "what order". The console's list is that same query with the gate open.
- **The migration test's before/after comparisons are now bounded to one migration each.** They
  previously photographed the *end* state as "after", which worked only while each block was about
  the newest migration — Ticket 03 altering `job` would have broken all four earlier blocks. The
  `segment` block's expectation lost `speaker` as a consequence, which is more honest: that column
  arrives in its own migration and its own block.
- `tests/guards/visibility-boundary.test.ts` refuses a `published_at` null *predicate* — the shape a
  visibility rule takes — and deliberately not a write or a render. Story 4's library, recording
  page and player each inherit the rule by calling `listVisibleRecordings`.
- **The architecture still says Claude.** Amending
  [§ Key choices](docs/epics/epic-core-listening/architecture.md#L255) and adding a third entry to
  [§ Divergence from the north star](docs/epics/epic-core-listening/architecture.md#L294) is a
  Phase 4 edit and was deliberately not made here — it is in User steps.
- `packages/web/tests/unit/display-name.test.ts` had a latent CRLF bug: its comment-stripping regex
  could not anchor on a line ending with a carriage return, so on a checkout with CRLF endings every
  doc comment explaining the avatar deferral read as a violation of it. Fixed in place.
