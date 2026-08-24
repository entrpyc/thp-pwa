# Teaching Hub — Implementation plan: scripture

_Planned: 2026-08-24_

## Status

31/71 criteria met. Groups complete: Group 1.
_Maintained by implementation — see the checkboxes for detail._

## Background to research

- Bible book canon and citation notation, including chapter and verse ranges
- Free-use and public-domain Bible translations, and what their terms permit
- List-shaped structured output from a language model, rather than a single string
- Cache-aside reads against a database-backed cache
- Canon ordering as a sort key, where the order is neither alphabetical nor numeric

---

## Group 1 — An admin sees a teaching's scriptures and approves or discards them

**Delivers:** a teaching that finishes transcribing arrives in Pending Reviews with the scriptures
the machine heard in it. An admin opens the item, reads the list, and either approves it onto the
teaching or throws it away — the same two presses they already make on a draft summary.
**Feature:** active-scope prd 3.1, and the approve-or-discard half of active-scope prd 3.2

### Task 1.1 — A citation is one value the product agrees on

**Delivers:** a scripture citation that validates, compares, orders and renders identically in the
worker, the API and the client — and the one place the 66-book canon is stated.
**References:** active-scope prd 3.1.2, active-scope prd 3.1.3, active-scope prd 3.1.4,
active-scope prd 3.1.5, active-scope prd 3.4.2, active-scope prd § 5.1;
project architecture § Data model; project architecture § Key technology choices
**Out of scope:** storing a citation anywhere, the review kind, verse text, and any screen. This
task ends with a value and its rules, nothing persisted.
**Prerequisites:** none — the canon's chapter and verse counts are public structural data, embedded
as a static table rather than fetched from anywhere.

**Acceptance criteria**

- [x] **1.1.1** The 66-book canon is declared exactly once — each book, its chapter count, and each
      chapter's verse count — and is the only place in the repository a book name is spelled.
      Verified by `tests/guards/domain-declarations.test.ts`
  - Follows the shape `ROLES`, `PIPELINE_STEPS` and `REVIEW_KINDS` already take in `@thp/shared`.
  - The guard fails the build on a book name written anywhere else.
- [x] **1.1.2** A citation naming a book outside the canon is refused, and the refusal names the
      book it did not recognise — verified by `packages/web/tests/unit/scripture-citation.test.ts`
  - One validator, returning what is wrong rather than a boolean.
- [x] **1.1.3** A citation whose chapter is beyond what that book has, or whose verse is beyond what
      that chapter has, is refused, naming which of the two was wrong — verified by
      `packages/web/tests/unit/scripture-citation.test.ts`
- [x] **1.1.4** A range whose end verse precedes its start is refused; a range whose start and end
      are equal is accepted as a single verse — verified by
      `packages/web/tests/unit/scripture-citation.test.ts`
- [x] **1.1.5** Two citations of the same passage compare equal, so a list can be de-duplicated
      without each caller deciding what "the same" means — verified by
      `packages/web/tests/unit/scripture-citation.test.ts`
- [x] **1.1.6** A list of citations sorts into canon order — Genesis before Exodus, chapter 3 before
      chapter 12, verse 1 before verse 9 — verified by
      `packages/web/tests/unit/scripture-citation.test.ts`
  - The order is the canon's, not alphabetical; the declaration's order is the sort key.
- [x] **1.1.7** A citation renders the way a person says it — `John 3:16`, `Romans 8:1–4`,
      `Psalm 23` for a whole chapter — from one function both surfaces call — verified by
      `packages/web/tests/unit/scripture-citation.test.ts`

**Record** — _updated 2026-08-24_
- **Edge cases:** a book named by an abbreviation or an alternative spelling (`Rom`, `Song of
  Songs`, `Psalms`) is not recognised — the citation is dropped from a draft and counted, and an
  admin adding one by hand later will be refused until they spell the book in full.
- **Edge cases:** a citation covering every verse of a chapter and one written as `1–<last verse>`
  are the same value — an admin who meant "the whole chapter" and one who meant "verses 1 to the
  end" cannot be told apart afterwards.
- **Edge cases:** a range crossing a chapter boundary (`Romans 8:1–9:5`) cannot be expressed — a
  teaching that works across one comes back as two citations or as none.
- **Edge cases:** the verse counts are the traditional English versification; a translation that
  numbers verses differently would have a real citation refused as out of range.
- **Assumptions, major (confirmed):** a book is identified by a stable string id (`romans`,
  `1-john`) rather than by its canon ordinal, so a row and a payload are readable on their own.
- **Assumptions, major (confirmed):** a whole chapter is verses 1 to the chapter's last, not a pair
  of nulls — one code path for compare, sort, render and group 3's verse lookup.
- **Assumptions, minor:** the canon spells the psalms `Psalm`, because that is how a citation is
  written and one name serves both; `Song of Solomon` is the name, and `song-of-songs` is not
  recognised.
- **Assumptions, minor:** the book-name guard checks quoted string literals under `packages/*/src`
  and `tools/` only — tests are exempt, because a test asserting what `formatCitation` returns has
  to spell the answer.
- **Assumptions, minor:** a proposal with no verse numbers reads as the whole chapter, which is the
  only way a whole-chapter citation can reach the product at all in this group.
- **Reworked:** none
- **False positives fixed:** 0
- **Operator steps:** none
- **Notes:** the table is checked by its two public totals — 66 books, 1,189 chapters, 31,102
  verses — so a mistyped verse count fails the guard test rather than refusing one real citation
  forever. Two books (Joshua, Jeremiah) were wrong on the first pass and were caught by exactly
  that check.

### Task 1.2 — The review queue carries a list-shaped draft

**Delivers:** `GET /reviews` returns a scripture item beside a summary item, from the same one
query, with its citations as structured entries rather than as a block of text.
**References:** active-scope prd 3.2.1, active-scope prd 3.2.2, active-scope prd § 4 (*Review item —
existing, extended*); project architecture § Cross-cutting concerns (*The review gate*)
**Out of scope:** anything that produces a scripture draft (task 1.3), the write-through on approve
(task 1.4), and the screen (task 1.5). Items are seeded by the test.
**Prerequisites:** none
**Depends on:** 1.1

**Acceptance criteria**

- [x] **1.2.1** `scripture` is a value of the review-kind enum, with the Postgres enum derived from
      the one declaration rather than restated beside it — verified by
      `packages/db/tests/integration/migrations.test.ts` and `tests/guards/domain-declarations.test.ts`
  - No new table and no new route: the queue, the ordering and the closed-row audit trail are the
    ones that already exist.
- [x] **1.2.2** An artefact kind may declare a **list-shaped** field, and the two existing kinds keep
      their single text field with no change to how they are read or written — verified by
      `packages/web/tests/unit/review-contract.test.ts`
  - The field-per-kind map widens from "one field name" to "one field name and its shape".
- [x] **1.2.3** The pending-reviews query returns a scripture item and a summary item together, in
      the same order the queue already sorts by, with no branch on kind — verified by
      `packages/db/tests/integration/reviews.test.ts`
- [x] **1.2.4** `GET /reviews` returns a scripture item's citations as structured entries, and
      refuses a member — verified by `packages/web/tests/integration/reviews.test.ts`

**Record** — _updated 2026-08-24_
- **Edge cases:** a `fields` entry under a name no kind declares is dropped from the payload
  silently — a row written by a newer worker reads as a draft with a missing field rather than as
  an error.
- **Edge cases:** an entry inside a list-shaped field that is not citation-shaped is dropped on the
  way to the wire, so a malformed row renders as a shorter list rather than saying anything.
- **Assumptions, minor:** the scripture kind's field is called `citations`, and
  `ReviewFieldValue` is `string | ScriptureCitation[]` — tags and mind maps widen that union
  rather than adding a second contract.
- **Reworked:** none
- **False positives fixed:** 0
- **Operator steps:** run `npm run migrate` — migration `0014_scripture_references` adds the
  `scripture` value to the `review_kind` enum, and nothing renders until it has.
- **Notes:** the migration adds the enum value to a live type, so it is the one migration here that
  behaves differently against a database with rows in it; the migration test drives that case with
  a row written before the widening.

### Task 1.3 — The generator drafts a teaching's scripture references

**Delivers:** a transcript completing now leaves a scripture review item waiting, holding the
citations the machine heard — produced by the same provider call that writes the summary.
**References:** active-scope prd 3.1.1, active-scope prd 3.1.2, active-scope prd 3.1.3,
active-scope prd 3.1.4, active-scope prd 3.1.5, active-scope prd 3.1.6, active-scope prd 3.1.7,
active-scope prd 3.1.8, active-scope prd 3.1.11; project architecture § Boundaries & integration
(*Workers ↔ AI providers*); project architecture § Cross-cutting concerns (*Errors and failure
posture*)
**Out of scope:** verse text (group 3), re-drafting scripture alone (task 2.3), and any screen. No
new pipeline step — this is the step that already runs.
**Prerequisites:** none
**Depends on:** 1.1, 1.2

**Acceptance criteria**

- [x] **1.3.1** The run that produces the summary and the description also produces the citations, in
      **one** provider call — verified by `packages/worker/tests/integration/generate-draft.test.ts`
  - The generation port's result widens from one string per kind to one string *or one list* per kind.
- [x] **1.3.2** The citations come back as a structured answer; an answer in prose where the
      structure was required fails the job with a reason and writes nothing — verified by
      `packages/worker/tests/integration/generate-draft.test.ts` and
      `packages/worker/tests/unit/minimax.test.ts`
- [x] **1.3.3** A citation outside the canon, or with numbers its book does not have, is dropped from
      the draft, and how many were dropped is recorded on the job — verified by
      `packages/worker/tests/unit/scripture-draft.test.ts`
- [x] **1.3.4** Two citations of the same passage in one answer collapse to one entry — verified by
      `packages/worker/tests/unit/scripture-draft.test.ts`
- [x] **1.3.5** A teaching the machine finds no scripture in still produces a scripture review item,
      holding an empty list — verified by
      `packages/worker/tests/integration/generate-draft.test.ts`
  - So an admin confirms "none", and so task 2.2's add control has an item to act on.
- [x] **1.3.6** The step writes no reference anywhere a member can reach, and leaves the recording's
      publication state untouched — verified by
      `packages/worker/tests/integration/generate-draft.test.ts`
- [x] **1.3.7** Running the step twice leaves **one** open scripture draft, and closed items are
      untouched — verified by `packages/worker/tests/integration/generate-draft.test.ts`
- [x] **1.3.8** A provider that refuses or times out fails the job with a reason readable on the
      pipeline panel, and writes no partial draft — verified by
      `packages/worker/tests/integration/generate-draft.test.ts`

**Record** — _updated 2026-08-24_
- **Edge cases:** the machine may name a book by an abbreviation and lose a real citation; the
  admin sees only a count on the job row, never which passage went.
- **Edge cases:** how many were dropped and how many repeated is summed across kinds into
  `job.provider_meta` and logged at warn — it is on no screen, so an operator has to read the job
  row or the log to notice a prompt going wrong.
- **Edge cases:** nothing caps the list — a model that proposes two hundred citations writes two
  hundred, and the admin scrolls.
- **Edge cases:** nothing retries; a provider that times out leaves a failed job an operator
  re-runs from the pipeline panel, as every other step already does.
- **Assumptions, minor:** the tool schema asks for the book as words with only `book` and
  `chapter` required, so a whole-chapter citation is expressible and placing the book in the canon
  stays one job, done once, where it is counted.
- **Assumptions, minor:** `citationsDropped` and `citationsDuplicated` are the names on
  `provider_meta`.
- **Reworked:** none
- **False positives fixed:** 0
- **Operator steps:** none. `GENERATE_FAKE_SCRIPT` (`packages/worker/tests/fixtures/draft-script.json`)
  gained a `citations` list so a local run with `GENERATE_PROVIDER=fake` produces a real one.
- **Notes:** the handler refuses a list-shaped field that did not come back as a list, as well as
  the adapter — one is the vendor's shape and the other is the port's contract, and the job fails
  before anything is written either way.

### Task 1.4 — Approving a list makes it the teaching's references

**Delivers:** approving a scripture item writes its citations onto the teaching and closes the item
in one transaction; discarding closes it with nothing written and the proposal intact.
**References:** active-scope prd 3.2.6, active-scope prd 3.2.7, active-scope prd 3.2.8,
active-scope prd 3.2.10, active-scope prd 3.2.11, active-scope prd 3.2.12, active-scope prd § 4
(*Scripture reference — new*), active-scope prd § 6 (Security, Auditability);
project architecture § Cross-cutting concerns (*Authorisation*, *The review gate*, *Audit*)
**Out of scope:** editing, adding or removing a reference before approving (group 2), and anything a
member can read (group 4).
**Prerequisites:** none
**Depends on:** 1.2

**Acceptance criteria**

- [x] **1.4.1** A scripture reference table holds one row per approved citation on a recording, with
      its origin and whether an admin changed it, and **no status column** — verified by
      `packages/db/tests/integration/migrations.test.ts`
  - Suggested-versus-accepted is the review item's state; a second answer to it is what the missing
    column prevents (active-scope prd § 8).
- [x] **1.4.2** Approving writes every reference in the list and closes the review item in one
      transaction — a failure in either leaves neither — verified by
      `packages/web/tests/integration/scripture-review.test.ts`
- [x] **1.4.3** Approving an **empty** list closes the item and records that the teaching has no
      references, distinguishably from a teaching nobody has reviewed — verified by
      `packages/web/tests/integration/scripture-review.test.ts`
- [x] **1.4.4** Approving a later draft **replaces** the recording's references rather than appending
      to them — verified by `packages/web/tests/integration/scripture-review.test.ts`
- [x] **1.4.5** A second resolve of the same item — two admins, or one double press — is refused as
      already closed, and nothing is written twice — verified by
      `packages/web/tests/integration/scripture-review.test.ts`
  - The close is what refuses it, as it already does for a summary: the update touches only rows
    still in draft.
- [x] **1.4.6** Discarding closes the item with no reference written, leaving the proposed citations
      in the closed row with the model, the model version, the prompt version and any steering
      prompt — verified by `packages/web/tests/integration/scripture-review.test.ts`
- [x] **1.4.7** Resolving a scripture item is refused server-side for a member whatever the client
      sends, and every resolve is logged with actor, action, target and timestamp — verified by
      `packages/web/tests/integration/scripture-review.test.ts` and
      `packages/web/tests/unit/policy.test.ts`

**Record** — _updated 2026-08-24_
- **Edge cases:** there is no un-approve — a list approved by mistake is corrected only by asking
  for another draft and approving that, which replaces the set.
- **Edge cases:** "reviewed and found none" is readable only from the closed review item; nothing
  on the recording row says it, so any later caller that wants the answer has to read the review
  table.
- **Edge cases:** deleting a recording takes its references with it, deliberately — a reference to
  a teaching that is gone is not a record of anything.
- **Edge cases:** `origin` is always `machine` and `edited_by_admin` always false until an
  admin can edit or add a reference, which is group 2.
- **Assumptions, minor:** the enum values are `machine` and `person` rather than `ai` and
  `admin` — `admin` is a role literal, which `tools/role-usage.ts` refuses outside `roles.ts`,
  and origin is not a role.
- **Reworked:** 1.4.5 — the first pass wrote the references and then closed the item, and two
  simultaneous approvals raced to delete and re-insert the same passages, answering one of them
  with a 500 instead of a refusal. The close now goes first inside the transaction, so the second
  request blocks on the review item's row and is refused before it writes anything.
- **False positives fixed:** 0
- **Operator steps:** none beyond 1.2's migration.
- **Notes:** a sequential second resolve is refused by the service's open-item check and the
  concurrent one by the close's `status = 'draft'` predicate — two guards, and the deliberate-break
  pass showed only the concurrent test fails when the predicate goes, which is the honest division.

### Task 1.5 — The form shows the list, and the admin approves or discards it

**Delivers:** the Pending Reviews form renders a scripture item as a list of citations and the two
presses work end to end — the first thing in this scope an operator can use.
**References:** active-scope prd 3.2.1, active-scope prd 3.2.2, active-scope prd 3.2.10,
active-scope prd § 5.2; design referencess png/style-guide.md
**Out of scope:** per-row edit, remove and add (group 2), verse text beneath a citation (task 3.3).
Rows are read-only here.
**Prerequisites:** none — no admin design reference exists for this or any admin screen; the style
guide is the reference.
**Depends on:** 1.2, 1.4

**Acceptance criteria**

- [x] **1.5.1** The form renders a scripture item as a list of citations, one row each, chosen by the
      item's **kind** rather than by a branch naming scripture — verified by
      `packages/web/tests/integration/reviews-screen.test.ts`
  - The per-kind rendering seam active-scope prd 1.4 asks for: tags and mind maps later add a
    renderer, not a branch.
- [x] **1.5.2** The two existing kinds still render as the single text box they always did —
      verified by `packages/web/tests/integration/reviews-screen.test.ts`
- [x] **1.5.3** An item whose list is empty says the machine found no scripture in this teaching,
      rather than rendering an empty box — verified by
      `packages/web/tests/integration/reviews-screen.test.ts`
- [x] **1.5.4** Approve and discard act on the whole list, with the second press on discard, exactly
      as the form already does for a summary — verified by
      `packages/web/tests/integration/reviews-screen.test.ts`
- [x] **1.5.5** An item another admin already resolved shows the refusal rather than appearing to
      succeed — verified by `packages/web/tests/integration/reviews-screen.test.ts`

**Record** — _updated 2026-08-24_
- **Edge cases:** rows are read-only — an admin who spots one wrong citation can only discard the
  whole list and ask for another, until task 2.1 adds per-row edit and remove.
- **Edge cases:** no verse text yet, so an admin judges a citation by its reference alone; a
  wrong-but-plausible reference is not catchable here until task 3.3.
- **Edge cases:** a long list grows the row rather than scrolling or paging inside it.
- **Edge cases:** the form's existing **Regenerate** control now reaches a scripture item and
  already re-drafts that kind alone, because the route enqueues the item's own kind. Task 2.3's
  criteria — the steering sentence recorded on the replacement, and the transcript-correction offer
  — are still unbuilt and untested.
- **Assumptions, minor:** the renderer is chosen by the kind's declared field *shape*, so a list is
  captioned by a plain element and named through `aria-labelledby` rather than by a `label`
  pointing at nothing focusable.
- **Assumptions, minor:** approving a list sends no fields at all, because there is nothing an
  admin could have edited; task 2.1 is what makes an edited list arrive at the server.
- **Reworked:** none
- **False positives fixed:** 0
- **Operator steps:** none
- **Notes:** the citation row takes the panel's existing row recipe from `admin.module.css` — no
  new hue and no new shape, because nothing in the list has a state yet.

---

## Group 2 — An admin corrects the list before approving

**Delivers:** an admin can fix what the machine got wrong — edit a citation, remove one, add one it
missed — and, when the whole list is wrong, ask for it again with a sentence saying why.
**Feature:** the correction half of active-scope prd 3.2, plus active-scope prd 3.1.9 and 3.1.10

### Task 2.1 — An admin edits and removes a reference in the draft

**Delivers:** each row in the list is editable as book, chapter and verse, and removable, with an
invalid edit refused against its own row.
**References:** active-scope prd 3.2.3, active-scope prd 3.2.5, active-scope prd § 5.2,
active-scope prd § 6 (Accessibility); design referencess png/style-guide.md
**Out of scope:** adding a reference (task 2.2) and re-drafting (task 2.3).
**Prerequisites:** none
**Depends on:** 1.5

**Acceptance criteria**

- [ ] **2.1.1** A row is edited as book, chapter, verse start and verse end in separate inputs, never
      as one free-text box — verified by `packages/web/tests/integration/reviews-screen.test.ts`
- [ ] **2.1.2** A row is removed without a second press and without touching the other rows —
      verified by `packages/web/tests/integration/reviews-screen.test.ts`
  - Removing is an edit to an unsaved draft, not a destruction; the second press stays on discard.
- [ ] **2.1.3** An invalid edit is refused against its own row, naming what is wrong, with the
      admin's other edits intact — verified by
      `packages/web/tests/integration/reviews-screen.test.ts`
- [ ] **2.1.4** Approving writes the **edited** list through, and the machine's original stays on the
      closed item — verified by `packages/web/tests/integration/scripture-review.test.ts`
- [ ] **2.1.5** The server re-validates every citation on approve and refuses a list holding one the
      client would not have allowed — verified by
      `packages/web/tests/integration/scripture-review.test.ts`
- [ ] **2.1.6** Every per-row control is reachable by keyboard and carries an accessible label —
      verified by `packages/web/tests/integration/reviews-screen.test.ts`

**Record**

### Task 2.2 — An admin adds a reference the machine missed

**Delivers:** a reference can be added by hand to any draft, including one that came back empty, and
what the machine proposed stays distinguishable from what a person did.
**References:** active-scope prd 3.2.4, active-scope prd 3.2.5, active-scope prd 3.2.9,
active-scope prd 3.1.6, active-scope prd § 5.2
**Out of scope:** re-drafting (task 2.3), verse text on an added row (task 3.3).
**Prerequisites:** none
**Depends on:** 2.1

**Acceptance criteria**

- [ ] **2.2.1** A reference can be added to a draft, entered structurally, including to a draft whose
      list came back empty — verified by `packages/web/tests/integration/reviews-screen.test.ts`
- [ ] **2.2.2** An added reference is refused if it is not a valid citation, and refused if the list
      already holds that passage — verified by
      `packages/web/tests/integration/reviews-screen.test.ts`
- [ ] **2.2.3** An approved reference records whether it was proposed by the machine, edited by an
      admin, or added by one — verified by
      `packages/web/tests/integration/scripture-review.test.ts`
- [ ] **2.2.4** That per-reference record survives on the **closed** review item, beside the item's
      model, model version and prompt version — verified by
      `packages/web/tests/integration/scripture-review.test.ts`

**Record**

### Task 2.3 — An admin asks for the scripture references again

**Delivers:** a bad list is recoverable without hand-editing every row — asking again re-drafts the
scripture and nothing else, and a transcript correction now offers it.
**References:** active-scope prd 3.1.9, active-scope prd 3.1.10, active-scope prd 3.1.12;
project architecture § Boundaries & integration (*API ↔ workers*)
**Out of scope:** any change to how the summary is re-drafted; that path already works and is only
widened by 3.1.10's offer.
**Prerequisites:** none
**Depends on:** 1.5

**Acceptance criteria**

- [ ] **2.3.1** Asking again for a scripture draft, with an optional sentence of steering, discards
      the open item and enqueues the step **for scripture alone** — the summary and description are
      not re-drafted — verified by `packages/web/tests/integration/scripture-review.test.ts`
- [ ] **2.3.2** The steering sentence reaches the provider call and is recorded on the replacement
      draft — verified by `packages/worker/tests/integration/generate-draft.test.ts`
- [ ] **2.3.3** The offer made after a transcript correction names scripture references alongside the
      summary, and enqueues both — verified by
      `packages/web/tests/integration/transcript-correction.test.ts`
  - Closes the half of the correction offer the Delivery status table records as missing.
- [ ] **2.3.4** A second re-draft request while one is unfinished is still refused rather than
      answered with the first one's job — verified by
      `packages/web/tests/integration/scripture-review.test.ts`
  - A regression check on the existing one-in-flight rule, not a new rule.

**Record**

---

## Group 3 — Every citation carries its verse text

**Delivers:** an admin reads the passage while deciding whether the citation is right, and the text
is held in our own database rather than fetched again every time anyone looks at it.
**Feature:** active-scope prd 3.3

### Task 3.1 — The Bible text source, behind one door

**Delivers:** the worker and the API both resolve a passage through the same one door, and a
development run resolves it without a byte leaving the machine.
**References:** active-scope prd 3.3.5, active-scope prd 3.3.7, active-scope prd 3.3.10;
project architecture § Boundaries & integration; project architecture § Key technology choices
(*Structured citations + verse text fetched and cached from a Bible text API*);
project architecture § Cross-cutting concerns (*Configuration*)
**Out of scope:** the cache table and anything that calls the port (task 3.2), and every screen.
**Prerequisites:** **the operator names the free-use source and the translation**, and supplies any
base URL or key it needs. Nothing else in this task can be finished without them.

**Acceptance criteria**

- [ ] **3.1.1** The worker and the API resolve a passage through the same port, answered by the same
      adapter, with neither importing the other's package — verified by
      `packages/bible/tests/unit/source.test.ts` and `tests/guards/import-boundary.test.ts`
  - A package beside `@thp/db` and `@thp/media`, for the reason the media store became one: the
    worker may not reach into the web package.
- [ ] **3.1.2** Nothing outside the adapter names the source or its HTTP shape; a module that does
      fails the build — verified by `tests/guards/bible-boundary.test.ts` with a leaky fixture
- [ ] **3.1.3** The translation is read from configuration, and a run with it unset refuses to start
      rather than defaulting to one — verified by `packages/bible/tests/unit/env.test.ts`
- [ ] **3.1.4** `THP_MOCK_EXTERNAL` puts the verse source into a local fake alongside the other
      three, and the fake wins over an explicitly named real source — verified by
      `tests/guards/mock-switch.test.ts`
- [ ] **3.1.5** A source that fails, times out, or has no text for a passage answers with *no text*
      rather than an exception the caller has to interpret — verified by
      `packages/bible/tests/unit/source.test.ts`
  - Which is what lets 3.2.4 keep the pipeline step green.

**Record**

### Task 3.2 — Verse text is fetched once and held

**Delivers:** every citation a draft produces has its passage in our database by the time an admin
opens the item, and a passage already held is never fetched again.
**References:** active-scope prd 3.3.1, active-scope prd 3.3.2, active-scope prd 3.3.3,
active-scope prd 3.3.5, active-scope prd 3.3.9, active-scope prd § 4 (*Verse text — new*);
project architecture § Estimated running costs; project architecture § Cross-cutting concerns
(*Observability*)
**Out of scope:** showing the text anywhere (task 3.3, task 4.2) and resolving a citation an admin
just typed (task 3.3).
**Prerequisites:** none beyond 3.1's
**Depends on:** 3.1, 1.3

**Acceptance criteria**

- [ ] **3.2.1** A verse text table holds one row per translation, book, chapter and verse, with the
      text and when it was fetched — verified by
      `packages/db/tests/integration/migrations.test.ts`
  - Keyed so a verse cited by a second teaching is the same row, not a second copy.
- [ ] **3.2.2** Resolving a citation reads what is already held and calls the source only for what is
      missing — verified by `packages/db/tests/integration/scripture.test.ts`
- [ ] **3.2.3** The draft step resolves every citation it produced, so the passage is held before an
      admin opens the item — verified by
      `packages/worker/tests/integration/generate-draft.test.ts`
- [ ] **3.2.4** A source failure during the draft step leaves the citations in place and the **step
      succeeding**, with the affected reference marked as having no text yet — verified by
      `packages/worker/tests/integration/generate-draft.test.ts`
  - The deliberate exception to the halt-on-failure rule (active-scope prd 3.3.5, § 8).
- [ ] **3.2.5** How many verses were fetched, how many were already held, and the source's own
      identifier for the call are recorded on the job that caused them — verified by
      `packages/worker/tests/integration/generate-draft.test.ts`

**Record**

### Task 3.3 — The admin reads the passage while deciding

**Delivers:** every row in the review form shows its passage beneath its citation, including one the
admin just typed — which is what makes a wrong-but-plausible citation catchable.
**References:** active-scope prd 3.3.4, active-scope prd 3.3.6, active-scope prd 3.3.8,
active-scope prd § 5.2; design referencess png/style-guide.md
**Out of scope:** the member surface (group 4).
**Prerequisites:** none beyond 3.1's
**Depends on:** 3.2, 2.2

**Acceptance criteria**

- [ ] **3.3.1** Each reference row shows its passage beneath its citation — verified by
      `packages/web/tests/integration/reviews-screen.test.ts`
- [ ] **3.3.2** A citation an admin adds or edits resolves its passage **while the form is open** —
      verified by `packages/web/tests/integration/reviews-screen.test.ts`
- [ ] **3.3.3** A reference whose passage could not be loaded still shows its citation, with a quiet
      line where the text would be — verified by
      `packages/web/tests/integration/reviews-screen.test.ts`
- [ ] **3.3.4** Verse text is editable nowhere — no input on any screen and no route that accepts it
      — verified by `packages/web/tests/integration/scripture-review.test.ts`

**Record**

---

## Group 4 — A member reads a teaching's scripture on the recording page

**Delivers:** a member opening a published teaching finds a **Scripture** tab holding the passages
it was built on, in canon order, readable without leaving the page.
**Feature:** active-scope prd 3.4

### Task 4.1 — The API answers a member with a teaching's published scripture

**Delivers:** one member-facing read that returns approved references with their passages, and
returns nothing for everything a member may not see.
**References:** active-scope prd 3.4.2, active-scope prd 3.4.3, active-scope prd 3.4.5,
active-scope prd 3.2.13, active-scope prd § 6 (Content integrity, Security);
project architecture § Boundaries & integration (*Client ↔ API*);
project architecture § Cross-cutting concerns (*Authorisation*, *The review gate*)
**Out of scope:** the tab and the panel (task 4.2).
**Prerequisites:** none
**Depends on:** 1.4, 3.2

**Acceptance criteria**

- [ ] **4.1.1** A member asking for a published teaching's scripture gets its approved references in
      canon order, each with its passage — verified by
      `packages/web/tests/integration/scripture.test.ts`
- [ ] **4.1.2** A member gets nothing for a teaching whose references were never approved, and
      nothing for a teaching that is not published **even when its references were** — verified by
      `packages/web/tests/integration/scripture.test.ts`
  - References ride the recording's publication; there is no second gate.
- [ ] **4.1.3** A discarded draft's citations are never returned to anyone — verified by
      `packages/web/tests/integration/scripture.test.ts`
- [ ] **4.1.4** The read goes through the same one-place authorisation decision every other member
      route uses, and an unauthenticated caller is refused — verified by
      `packages/web/tests/integration/scripture.test.ts` and `packages/web/tests/unit/policy.test.ts`

**Record**

### Task 4.2 — The Scripture tab on the recording page

**Delivers:** the tab the design reference draws, and the panel behind it — the last thing in the
scope, and the first thing a member sees.
**References:** active-scope prd 3.4.1, active-scope prd 3.4.4, active-scope prd 3.4.6,
active-scope prd 3.4.7, active-scope prd 3.4.8, active-scope prd § 5.1, active-scope prd § 6
(Accessibility); design referencess png/pages/recording.png; design referencess png/style-guide.md
**Out of scope:** the four other tabs the reference draws, three of which stay dropped as deferred.
**Prerequisites:** none
**Depends on:** 4.1

**Acceptance criteria**

- [ ] **4.2.1** The tab strip shows **Scripture** in the position the reference draws it, for a
      teaching with published references — verified by
      `packages/web/tests/integration/scripture-screen.test.ts`
- [ ] **4.2.2** The tab is **absent entirely** for a teaching with none — not disabled, not an empty
      panel — verified by `packages/web/tests/integration/scripture-screen.test.ts`
- [ ] **4.2.3** Opening it lists the references in canon order, each with its citation as heading and
      its passage as body — verified by
      `packages/web/tests/integration/scripture-screen.test.ts`
- [ ] **4.2.4** A reference with no passage shows its citation and a quiet line in place of the text
      — verified by `packages/web/tests/integration/scripture-screen.test.ts`
- [ ] **4.2.5** The panel is fetched when first opened, closes on a second press, and opening it
      closes whichever tab was open — verified by
      `packages/web/tests/integration/scripture-screen.test.ts`
- [ ] **4.2.6** A failed load shows one failure line inside the panel and leaves the player, the
      notes and the transcript working — verified by
      `packages/web/tests/integration/scripture-screen.test.ts`
- [ ] **4.2.7** A citation is text, not a link — nothing in the panel navigates anywhere — verified
      by `packages/web/tests/integration/scripture-screen.test.ts`
  - active-scope prd 3.4.8: the destination is cross-referencing, and it does not exist.
- [ ] **4.2.8** The tab is reachable by keyboard and carries an accessible label, as the other tabs
      in the strip do — verified by `packages/web/tests/integration/scripture-screen.test.ts`

**Record**
