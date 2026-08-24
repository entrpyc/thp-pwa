# Teaching Hub — Implementation plan: scripture

_Planned: 2026-08-24_

## Status

71/71 criteria met. Groups complete: Group 1, Group 2, Group 3, Group 4.
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

- [x] **2.1.1** A row is edited as book, chapter, verse start and verse end in separate inputs, never
      as one free-text box — verified by `packages/web/tests/integration/reviews-screen.test.ts`
- [x] **2.1.2** A row is removed without a second press and without touching the other rows —
      verified by `packages/web/tests/integration/reviews-screen.test.ts`
  - Removing is an edit to an unsaved draft, not a destruction; the second press stays on discard.
- [x] **2.1.3** An invalid edit is refused against its own row, naming what is wrong, with the
      admin's other edits intact — verified by
      `packages/web/tests/integration/reviews-screen.test.ts`
- [x] **2.1.4** Approving writes the **edited** list through, and the machine's original stays on the
      closed item — verified by `packages/web/tests/integration/scripture-review.test.ts`
- [x] **2.1.5** The server re-validates every citation on approve and refuses a list holding one the
      client would not have allowed — verified by
      `packages/web/tests/integration/scripture-review.test.ts`
- [x] **2.1.6** Every per-row control is reachable by keyboard and carries an accessible label —
      verified by `packages/web/tests/integration/reviews-screen.test.ts`

**Record** — _updated 2026-08-24_
- **Edge cases:** the book control is a picker, so a book outside the canon cannot be entered from
  the form at all — the "unknown book" refusal 3.2.5 names is reachable only over the API, and an
  admin who wants a book the canon does not list has no way to say so.
- **Edge cases:** a cleared chapter box reads as chapter 0 and is refused in the canon's own words
  — "Romans has 16 chapters, so there is no chapter 0" — rather than as "say which chapter".
- **Edge cases:** clearing both verse boxes silently widens the row to the whole chapter rather
  than asking; an admin who meant to retype a range and stopped halfway approves the chapter.
- **Edge cases:** rows cannot be reordered, so the references are stored in the order the form held
  them. Nothing a member sees depends on that yet — group 4 sorts into canon order at read time.
- **Edge cases:** closing the form, or another admin resolving the item first, throws away every
  unsaved edit with no warning and no way to get them back.
- **Edge cases:** nothing caps how many references one approve may carry; a list of a thousand is
  written as a list of a thousand.
- **Edge cases:** the per-row refusal is a live `role="alert"`, so a screen reader re-announces it
  as an admin types through an invalid chapter rather than once when they stop.
- **Assumptions, major (confirmed):** the approve request carries, per row, the index of the
  proposal that row came from — `from`, or `null` for an addition — and the server derives origin
  and edited-ness from it. A client never asserts its own provenance.
- **Assumptions, minor:** a blank verse box means the whole chapter; a blank chapter box is an
  error. Each is what a blank can honestly mean in that field, and they differ for that reason.
- **Assumptions, minor:** the form sends the whole list on every approve, including an untouched
  one, so there is one approve path rather than a corrected one and an as-it-stands one.
- **Assumptions, minor:** a `from` index naming no proposal reads as a person's addition rather
  than as a refusal — the answer that never claims the machine's authorship for a row.
- **Reworked:** none
- **False positives fixed:** 0
- **Operator steps:** none
- **Notes:** 1.5.1's test was updated rather than weakened. A row is now a group of controls, so
  the citations are read from each row's caption instead of from the list item's text; the
  criterion is unchanged, still asserts three rows in canon order, and its "the only text box on
  this form is the steering sentence" assertion still holds — chapter and verse are number
  controls, and the book is a picker.

### Task 2.2 — An admin adds a reference the machine missed

**Delivers:** a reference can be added by hand to any draft, including one that came back empty, and
what the machine proposed stays distinguishable from what a person did.
**References:** active-scope prd 3.2.4, active-scope prd 3.2.5, active-scope prd 3.2.9,
active-scope prd 3.1.6, active-scope prd § 5.2
**Out of scope:** re-drafting (task 2.3), verse text on an added row (task 3.3).
**Prerequisites:** none
**Depends on:** 2.1

**Acceptance criteria**

- [x] **2.2.1** A reference can be added to a draft, entered structurally, including to a draft whose
      list came back empty — verified by `packages/web/tests/integration/reviews-screen.test.ts`
- [x] **2.2.2** An added reference is refused if it is not a valid citation, and refused if the list
      already holds that passage — verified by
      `packages/web/tests/integration/reviews-screen.test.ts`
- [x] **2.2.3** An approved reference records whether it was proposed by the machine, edited by an
      admin, or added by one — verified by
      `packages/web/tests/integration/scripture-review.test.ts`
- [x] **2.2.4** That per-reference record survives on the **closed** review item, beside the item's
      model, model version and prompt version — verified by
      `packages/web/tests/integration/scripture-review.test.ts`

**Record** — _updated 2026-08-24_
- **Edge cases:** an added row starts as the canon's first book, chapter 1 — a real citation the
  admin corrects rather than a blank the form has to have an opinion about. An admin who presses
  *Add a reference* and then approves without touching the row publishes that citation.
- **Edge cases:** a duplicate is flagged on the *later* of the two rows, so an admin who meant to
  keep the new one has to remove the older one by hand before the refusal clears.
- **Edge cases:** removing a machine row and adding the same passage back by hand records it as a
  person's addition; afterwards the two cannot be told apart on the closed item.
- **Edge cases:** the closed item records what was approved but not what was removed — a reference
  an admin threw out is readable only by reading the draft against the entries beside it.
- **Assumptions, minor:** the per-reference record lives on the closed item's provenance, under
  that field's own entry, beside the model and the two versions — which is where 2.2.4 puts it.
  The draft field itself stays the machine's proposal, so the two are readable side by side.
- **Assumptions, minor:** the whole approve request is refused when one entry in it is not a
  citation, rather than the good entries being written and the bad ones reported.
- **Reworked:** none
- **False positives fixed:** 0
- **Operator steps:** none
- **Notes:** the duplicate refusal is the server's as well as the screen's, because
  `scripture_reference_passage_unique` would otherwise answer a duplicated list with a constraint
  violation rather than with a sentence an admin can act on.

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

- [x] **2.3.1** Asking again for a scripture draft, with an optional sentence of steering, discards
      the open item and enqueues the step **for scripture alone** — the summary and description are
      not re-drafted — verified by `packages/web/tests/integration/scripture-review.test.ts`
- [x] **2.3.2** The steering sentence reaches the provider call and is recorded on the replacement
      draft — verified by `packages/worker/tests/integration/generate-draft.test.ts`
- [x] **2.3.3** The offer made after a transcript correction names scripture references alongside the
      summary, and enqueues both — verified by
      `packages/web/tests/integration/transcript-correction.test.ts`
  - Closes the half of the correction offer the Delivery status table records as missing.
- [x] **2.3.4** A second re-draft request while one is unfinished is still refused rather than
      answered with the first one's job — verified by
      `packages/web/tests/integration/scripture-review.test.ts`
  - A regression check on the existing one-in-flight rule, not a new rule.

**Record** — _updated 2026-08-24_
- **Edge cases:** the transcript-correction offer now asks for both artefacts, so accepting it
  leaves two items in Pending Reviews — an admin who only wanted the summary rewritten gets a
  scripture draft to deal with as well, and there is no way to accept half the offer.
- **Edge cases:** a re-draft refused as one-in-flight says "a draft for this recording is already
  being generated" without naming which kind is running, so an admin cannot tell whether the job
  in the way is theirs.
- **Edge cases:** a transcript correction on a teaching whose scripture was already approved
  enqueues a fresh scripture draft, which replaces the approved references only if the admin
  approves the new one — until then the teaching carries the old list.
- **Assumptions, minor:** the offer's text, its button and the region's accessible name now all
  name both artefacts, and the failure line under it says "a new draft" rather than "a new
  summary".
- **Reworked:** none
- **False positives fixed:** 0
- **Operator steps:** none
- **Notes:** 2.3.1, 2.3.2 and 2.3.4 needed no code — group 1 built the route and the handler
  generically, so the regenerate path already enqueued `[item.kind]` and the worker already carried
  the steer into the provider call. Their tests were therefore green on the first run and earned no
  red, so each was checked by breaking the behaviour on purpose — the wrong kind enqueued, the
  in-flight check disabled, the steer withheld from the provider call — and confirming its test
  went red.
- **Notes:** plan correction. 2.3.3's *names scripture references* half is a screen fact and the
  criterion named only `packages/web/tests/integration/transcript-correction.test.ts`. The enqueue
  is asserted there; the wording is asserted in `transcript-correction-screen.test.ts`, which is
  where the offer is driven.

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

- [x] **3.1.1** The worker and the API resolve a passage through the same port, answered by the same
      adapter, with neither importing the other's package — verified by
      `packages/bible/tests/unit/source.test.ts` and `tests/guards/import-boundary.test.ts`
  - A package beside `@thp/db` and `@thp/media`, for the reason the media store became one: the
    worker may not reach into the web package.
- [x] **3.1.2** Nothing outside the adapter names the source or its HTTP shape; a module that does
      fails the build — verified by `tests/guards/bible-boundary.test.ts` with a leaky fixture
- [x] **3.1.3** The translation is read from configuration, and a run with it unset refuses to start
      rather than defaulting to one — verified by `packages/bible/tests/unit/env.test.ts`
- [x] **3.1.4** `THP_MOCK_EXTERNAL` puts the verse source into a local fake alongside the other
      three, and the fake wins over an explicitly named real source — verified by
      `tests/guards/mock-switch.test.ts`
- [x] **3.1.5** A source that fails, times out, or has no text for a passage answers with *no text*
      rather than an exception the caller has to interpret — verified by
      `packages/bible/tests/unit/source.test.ts`
  - Which is what lets 3.2.4 keep the pipeline step green.

**Record** — _updated 2026-08-24_

- **Edge cases:**
  - A source whose chapter is versified differently from the canon returns the verses it has and
    the row simply reads short — no line says which verses are missing.
  - A translation id the source does not publish answers as *no text* for every citation, so a
    typo in `BIBLE_TRANSLATION` looks exactly like a source that is permanently down.
  - The ten-second timeout is not configurable, so a source that is merely slow reads as one with
    no text for that passage.
  - The guard catches a second door opened by a **known** Bible host or the source's own document
    suffix. A second door at an unlisted vendor's host would pass it.
- **Assumptions, major (confirmed):** the operator named the **Free Use Bible API**
  (`https://bible.helloao.org`) with `BIBLE_TRANSLATION=BSB` — no account, no key, no usage limits,
  commercial use permitted.
- **Assumptions, minor:**
  - The port answers **verse by verse** rather than as one paragraph, because the cache is keyed per
    verse and a paragraph could not be shared between two citations of the same chapter.
  - The adapter asks for the source's `.simple.json` chapter format — plain sentences rather than
    the marked-up one, since § 5.1 says verse text is plain text.
  - The fake reads no script off disk, unlike the ASR and generation fakes: it stands in for a
    sentence, and a file would be a variable, a fixture and a failure mode for a sentence.
  - `x-amz-cf-id` is read as the source's own identifier for a call.
  - The source is named `free-use` in configuration; the host lives only in `.env`.
- **Reworked:** 3.1.4 — the fake first named the *range* it was asked for in its stand-in text, so a
  verse fetched inside a whole-chapter request kept that wording in the cache and disagreed with the
  same verse fetched alone. Renamed per verse. Found by task 3.3's screen test.
- **False positives fixed:** 0
- **Operator steps:**
  1. Run `npm install` once, so the new `@thp/bible` workspace is linked.
  2. Copy the `BIBLE_` block from `.env.example` into `.env` on every machine and every deployment —
     `BIBLE_SOURCE`, `BIBLE_BASE_URL`, `BIBLE_TRANSLATION`. A run with `BIBLE_TRANSLATION` unset
     refuses to resolve any passage, by design.
- **Notes:** `@thp/bible` is a package beside `@thp/db` and `@thp/media` and is listed in
  `SERVER_ONLY_PACKAGES` in tools/import-boundary.ts, so a client that imported it fails the build.
  The suite owns its own verse-source configuration in tests/setup/global.ts rather than inheriting
  `.env` — `.env` names a real source, and 3.3.10 says a test run reaches none.

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

- [x] **3.2.1** A verse text table holds one row per translation, book, chapter and verse, with the
      text and when it was fetched — verified by
      `packages/db/tests/integration/migrations.test.ts`
  - Keyed so a verse cited by a second teaching is the same row, not a second copy.
- [x] **3.2.2** Resolving a citation reads what is already held and calls the source only for what is
      missing — verified by `packages/db/tests/integration/scripture.test.ts`
- [x] **3.2.3** The draft step resolves every citation it produced, so the passage is held before an
      admin opens the item — verified by
      `packages/worker/tests/integration/generate-draft.test.ts`
- [x] **3.2.4** A source failure during the draft step leaves the citations in place and the **step
      succeeding**, with the affected reference marked as having no text yet — verified by
      `packages/worker/tests/integration/generate-draft.test.ts`
  - The deliberate exception to the halt-on-failure rule (active-scope prd 3.3.5, § 8).
- [x] **3.2.5** How many verses were fetched, how many were already held, and the source's own
      identifier for the call are recorded on the job that caused them — verified by
      `packages/worker/tests/integration/generate-draft.test.ts`

**Record** — _updated 2026-08-24_

- **Edge cases:**
  - **Nothing ever refreshes a held verse.** A source that corrects its text is never re-read.
    `fetched_at` is recorded and nothing acts on it.
  - Two jobs resolving the same chapter at the same moment both call the source; the second's rows
    are dropped by `on conflict do nothing`. One wasted call, nothing wrong.
  - A citation that only partly overlaps what is held costs one call for the whole passage — the
    source answers a passage, not a verse.
  - A source that returns **fewer** verses than the citation asks for holds what it gave, and the
    missing verses are asked for again on every later resolution, forever.
  - `versesFetched` / `versesHeld` are per **job**: re-running a recording reports 0 fetched, so the
    number reads as what *this run* cost rather than what the teaching cost.
  - A draft step whose cache write fails records the passages as unresolved and succeeds anyway —
    the admin sees citations with no text and nothing on screen says the database refused a row.
- **Assumptions, major (taken, not confirmed — raised at the checkpoint):** `@thp/bible` depends on
  `@thp/db`, so the cache-aside resolver sits beside the source and the rows stay in the store
  package. The alternative was `@thp/db` importing the port, which would stop the database package
  being a leaf. Flagged because it is a module boundary later work binds to.
- **Assumptions, minor:**
  - Held verses are read **once per resolution**, for every chapter at issue, before anything is
    fetched — so a teaching citing one chapter ten times is one read.
  - `fetched` counts rows actually written rather than verses the source returned.
  - `verseSourceRequestId` is the **last** call's identifier when a run made several.
  - Verses fetched partway through a resolution are added to what is held, so a list citing the same
    chapter twice fetches it once.
- **Reworked:** none
- **False positives fixed:** 0
- **Operator steps:** run `npm run migrate` — migration `0015_verse_text` adds the `verse_text`
  table. Nothing back-fills: teachings drafted before this migration carry citations with no text
  until they are drafted again.
- **Notes:** there is no refresh policy and no expiry. `fetched_at` exists so one can be added later
  without a migration.

### Task 3.3 — The admin reads the passage while deciding

**Delivers:** every row in the review form shows its passage beneath its citation, including one the
admin just typed — which is what makes a wrong-but-plausible citation catchable.
**References:** active-scope prd 3.3.4, active-scope prd 3.3.6, active-scope prd 3.3.8,
active-scope prd § 5.2; design referencess png/style-guide.md
**Out of scope:** the member surface (group 4).
**Prerequisites:** none beyond 3.1's
**Depends on:** 3.2, 2.2

**Acceptance criteria**

- [x] **3.3.1** Each reference row shows its passage beneath its citation — verified by
      `packages/web/tests/integration/reviews-screen.test.ts`
- [x] **3.3.2** A citation an admin adds or edits resolves its passage **while the form is open** —
      verified by `packages/web/tests/integration/reviews-screen.test.ts`
- [x] **3.3.3** A reference whose passage could not be loaded still shows its citation, with a quiet
      line where the text would be — verified by
      `packages/web/tests/integration/reviews-screen.test.ts`
- [x] **3.3.4** Verse text is editable nowhere — no input on any screen and no route that accepts it
      — verified by `packages/web/tests/integration/scripture-review.test.ts`

**Record** — _updated 2026-08-24_

- **Edge cases:**
  - Typing a chapter or verse fires a lookup for **each intermediate citation** — typing `16` over
    `1` asks for verse 1 as well. Cheap once a chapter is held; a first-time chapter is fetched for
    each intermediate value.
  - **"The passage could not be loaded" covers two different things** — the request failed, and the
    source has no text for it. An admin cannot tell which, deliberately: the row says what it cites
    and nothing else.
  - A request that hangs leaves the row saying "Loading the passage…" until the browser gives up;
    there is no client-side timeout.
  - A draft with many references makes one lookup per row when the form opens; they are not batched.
  - Clearing a verse box means "the whole chapter" for an instant, so the row's passage flashes the
    whole chapter before settling on what was typed.
  - **Poetry loses its line breaks.** The source returns the psalms with newlines in the verse text;
    the row renders one paragraph, so `Psalm 23` reads as continuous prose. Correct per § 5.1
    (verse text is plain text) and worth knowing before anybody reports it as a bug.
- **Assumptions, major (taken, not confirmed — raised at the checkpoint):** the passage is read from
  a new `GET /api/v1/scripture/passage` rather than carried on the review payload. That is what makes
  3.3.2 work at all — a row an admin has just typed has no draft to have carried anything — and it
  keeps the machine's rows and the admin's rows resolving by one mechanism. It also means
  `ReviewItemView` did not change.
- **Assumptions, minor:**
  - The route is behind `review.list`, the action the Pending Reviews queue already uses, rather
    than a new policy action.
  - The passage is joined into one paragraph with **no verse numbers in it** (§ 5.1).
  - An in-flight answer for a citation the admin has moved on from is dropped, not rendered.
- **Reworked:** none
- **False positives fixed:** 1 — the passage-lookup test asserted that John 3 held *only* the verse
  it had just read. That passed when the file ran alone and failed in the full run, because the
  screen tests had already resolved the whole chapter into the same app database. Rewritten as a
  before-and-after comparison, which is the actual claim: these calls wrote nothing.
- **Operator steps:** none beyond 3.1's and 3.2's.
- **Notes:** 3.3.4's "no route accepts verse text" is held two ways — the route has only a `GET`, and
  `scripture_reference` has no text column (asserted in the migrations test's deferred list). The
  first was break-checked by adding a `POST`; the second is structural and cannot be broken without
  a migration.

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

- [x] **4.1.1** A member asking for a published teaching's scripture gets its approved references in
      canon order, each with its passage — verified by
      `packages/web/tests/integration/scripture.test.ts`
- [x] **4.1.2** A member gets nothing for a teaching whose references were never approved, and
      nothing for a teaching that is not published **even when its references were** — verified by
      `packages/web/tests/integration/scripture.test.ts`
  - References ride the recording's publication; there is no second gate.
- [x] **4.1.3** A discarded draft's citations are never returned to anyone — verified by
      `packages/web/tests/integration/scripture.test.ts`
- [x] **4.1.4** The read goes through the same one-place authorisation decision every other member
      route uses, and an unauthenticated caller is refused — verified by
      `packages/web/tests/integration/scripture.test.ts` and `packages/web/tests/unit/policy.test.ts`

**Record** — _updated 2026-08-25_

- **Edge cases:** a recording unpublished between the page load and the tab press answers
  `not_found` and the panel shows the failure line — the member sees "could not load" rather than
  "this teaching is no longer published". · A teaching whose references were approved after the
  page loaded has no **Scripture** tab until the page is reloaded; nothing polls. · A very long list
  of references resolves every passage in one request with no ceiling and no pagination — a teaching
  citing hundreds of passages would make the read slow rather than refuse. · A Bible source that is
  down on the very first read of a passage answers `passage: null` and **is not retried on the next
  read** within the same request; the next page load fetches again.
- **Assumptions, major (confirmed):** the recording payload carries `hasScripture`, computed as an
  `exists` subquery inside the visibility module and returned by both the library list and the
  detail read — chosen over a detail-only payload type and over a second request per page load.
- **Assumptions, minor:** "nothing" is two different answers, following the transcript route
  exactly — an empty `references` list for a published teaching with none, and `not_found` for one
  that is not published. · The member's payload carries the citation and its passage only; `origin`
  and `editedByAdmin` are an operator's record and do not cross to a reader. · Passages are joined
  into one paragraph with no verse numbers, the same way the review form's lookup already does it.
- **Reworked:** none
- **False positives fixed:** 1 — the ordering fixture used Genesis/John/Romans, whose canon order
  and alphabetical order coincide, so the test would have passed against the raw database order.
  Replaced with Genesis/Exodus/Romans, which the two orders disagree about.
- **Operator steps:** none — no migration, no new configuration. `scripture_reference` and the
  verse-text cache already exist from Groups 1 and 3.
- **Notes:** the read declares `recording.browse` rather than an action of its own, and
  `policy.test.ts` now pins the *absence* of any `scripture.*` action — that is what makes "the same
  one-place decision" checkable rather than asserted.

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

- [x] **4.2.1** The tab strip shows **Scripture** in the position the reference draws it, for a
      teaching with published references — verified by
      `packages/web/tests/integration/scripture-screen.test.ts`
- [x] **4.2.2** The tab is **absent entirely** for a teaching with none — not disabled, not an empty
      panel — verified by `packages/web/tests/integration/scripture-screen.test.ts`
- [x] **4.2.3** Opening it lists the references in canon order, each with its citation as heading and
      its passage as body — verified by
      `packages/web/tests/integration/scripture-screen.test.ts`
- [x] **4.2.4** A reference with no passage shows its citation and a quiet line in place of the text
      — verified by `packages/web/tests/integration/scripture-screen.test.ts`
- [x] **4.2.5** The panel is fetched when first opened, closes on a second press, and opening it
      closes whichever tab was open — verified by
      `packages/web/tests/integration/scripture-screen.test.ts`
- [x] **4.2.6** A failed load shows one failure line inside the panel and leaves the player, the
      notes and the transcript working — verified by
      `packages/web/tests/integration/scripture-screen.test.ts`
- [x] **4.2.7** A citation is text, not a link — nothing in the panel navigates anywhere — verified
      by `packages/web/tests/integration/scripture-screen.test.ts`
  - active-scope prd 3.4.8: the destination is cross-referencing, and it does not exist.
- [x] **4.2.8** The tab is reachable by keyboard and carries an accessible label, as the other tabs
      in the strip do — verified by `packages/web/tests/integration/scripture-screen.test.ts`

**Record** — _updated 2026-08-25_

- **Edge cases:** closing and re-opening the tab **fetches again** — the panel is unmounted when the
  tab shuts, so a member toggling it repeatedly makes a request each time. · An admin approving an
  empty list while the member has the page open leaves the tab drawn; opening it shows "This
  teaching has no scripture references" rather than an empty box. · A failed load has no retry
  control — the member closes and re-opens the tab, or reloads the page. · The panel has no bounded
  height, so a long list scrolls the page rather than itself, unlike the transcript.
- **Assumptions, major (confirmed):** none beyond 4.1's — the tab's presence is read off
  `recording.hasScripture`, settled there.
- **Assumptions, minor:** the tab carries **no icon**, matching the `Transcript` tab beside it. The
  reference draws an icon on all five tabs, but the built strip gives one only to `Notes`, where the
  style guide's green means notes and nothing else — adding one to `Scripture` alone would make the
  strip less consistent than leaving it out. · Its accessible name is its own text, the way every
  other tab in the strip works; no `aria-label` was added. · The panel is an `ol` of cards rather
  than a bounded scroller: a handful of passages is not a transcript.
- **Reworked:** none
- **False positives fixed:** 0 — the fixture fault was 4.1's and is recorded there; the screen
  fixture was corrected in the same pass.
- **Operator steps:** none
- **Notes:** `Scripture` is **first** in the strip, which is the reference's order once `Chapter` is
  dropped — `Chapter` and `Mindmap` stay dropped rather than disabled, unchanged from Story 4. ·
  Adding `hasScripture` to the recording payload turned three existing key-set guards red —
  `publishing.test.ts` twice and `pipeline.test.ts` once, each pinning the payload's **exact** keys
  so a field added later cannot slip in unnoticed. All three had their expected lists extended, not
  loosened; that is the guard working. · The group's *Delivers* line was walked end to end once in a
  real browser — an admin approving the draft in Pending Reviews, publishing the teaching, and a
  member then reading those exact passages in the tab without leaving the page. It passed, and the
  throwaway file that drove it was removed rather than left as test surface no criterion names.
