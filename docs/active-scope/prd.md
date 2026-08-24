# Teaching Hub — Active scope: scripture

_Defined: 2026-08-24_

Scripture connects each teaching to its biblical foundation. This scope builds that connection
end to end for one teaching at a time: the machine proposes the citations, an admin corrects them,
and a member reads them with the verse text in front of them. It deliberately stops before the
citations start connecting teachings *to each other* — that is cross-referencing, and it is a
later scope.

## 1. Scope decisions

**1.1 What's in.** Four features, all refining `project prd 3.7`:

- **Scripture references are drafted from the teaching** — `project prd 3.7.1`, `project prd 4.17.1`
- **An admin reviews, edits and approves them** — `project prd 3.7.2`, `project prd 4.17.2`
- **Every citation carries its verse text** — `project prd 3.7.3`, `project prd 3.7.4`
- **A member reads a teaching's scripture on the recording page** — `project prd 3.7.5`

`project prd 3.7.6` (a reference links into the cross-referencing layer) and `project prd 3.7.7`
(finding teachings by citation through search) are **carved out by dependency, not by choice**:
they hand off to `project prd 3.9` and `project prd 3.10`, and the Delivery status table has both
as `not started`. Structured citations are exactly what those two later read, which is why this
scope's data model is the thing that unblocks them.

**1.2 Requirements depth.** Full — error, empty, permission and concurrent cases are specified here
rather than left to be decided in a task. Every group below names what happens when the provider
refuses, when a teaching cites nothing, when a member asks for something they may not have, and
when two admins act on the same item. Phase 4 may leave open only what this document does not name.

**1.3 What reaches the user.** The full surface, with its states pinned here. A member gets the
**Scripture** tab that `pages/recording.png` already draws in the strip and that the current strip
drops as deferred; its panel contents have no reference, so the style guide fills them. An admin
gets the reference list inside the existing Pending Reviews form, with accept, edit, remove and add
per reference; no admin design reference exists anywhere in the product, so the style guide fills
that too. § 5 names every state both surfaces have.

**1.4 Carried forward — architecture reach.** Not this document's business, and recorded here
because the operator settled it while defining the scope: **seam it for what is queued behind.** The
review contract widens so an artefact kind may carry a *list-shaped* field, and the review form
gains a per-kind rendering seam — because scripture references are the first of four artefacts
(tags, mind maps at `project prd 3.8`, video scripts at `project prd 3.11.3.1`) that are not one
string, and `project prd 4.17.6` is explicitly betting on all of them being values of one kind
rather than queues of their own. Verse text sits behind a named port with one adapter and one fake
behind it, the same shape the ASR, generation, mail and media boundaries already take. Whoever
writes this scope's architecture is bound by that answer rather than by their own judgment.

## 2. What this scope delivers

A teaching that finishes transcribing now arrives at the review queue with a list of the scriptures
it taught from — book, chapter and verse, each with the verse text beside it. An admin works down
that list the way they already work down a draft summary: keep the ones that are right, correct the
ones that are close, remove the ones the machine imagined, and add the ones it missed. When they
approve, and when the teaching is published, a member opening that teaching finds a **Scripture**
tab holding those passages in full, readable without leaving the page.

- **As a member, I can** see which scriptures a teaching was built on, and read each passage in full
  without leaving the recording page.
- **As an admin, I can** review a machine-proposed list of citations, correct or remove any one of
  them, add ones it missed, and approve the list — with the verse text in front of me while I decide.
- **As an admin, I can** ask for the scripture references again, with a sentence saying what was
  wrong, without disturbing the summary or the description.
- **As an admin, I can** see, on the pipeline panel, that scripture drafting ran — and read why it
  failed when it did.

## 3. Features

### 3.1 Scripture references are drafted from the teaching

_Refines: `project prd 3.7.1`, `project prd 4.17.1`, `project prd 3.21.1` step 5_

- **3.1.1** The run that produces the summary and the description also produces the scripture
  references — **one provider call, not a second one**. `project prd 3.21.1` step 5 groups the three
  in one step, and the transcript is the expensive half of the request. (refines 3.21.1 step 5)
- **3.1.2** The draft is a list of structured citations — book, chapter, and a verse or a verse
  range — taken as a forced structured answer. A model that answers in prose fails the step visibly
  rather than having its prose stored as if it were citations. (refines 3.7.3)
- **3.1.3** A citation naming a book outside the 66-book canon is **dropped from the draft rather
  than stored**, and the number dropped is recorded against the job that produced it. The admin
  reviews what the machine got right; they do not spend the review deleting things that cannot
  exist. (refines 3.7.3)
- **3.1.4** A citation whose chapter or verse numbers fall outside what that book actually contains
  is dropped the same way and counted the same way. (refines 3.7.3)
- **3.1.5** Two citations of the same passage in one draft collapse to one entry. (refines 3.7.3)
- **3.1.6** A teaching the machine finds no scripture in still produces a review item, holding an
  empty list. **An admin confirms "none" rather than the item silently never arriving** — and it is
  the only way they can reach 3.2.4 to add by hand what the machine missed entirely. (refines 4.17.2)
- **3.1.7** Nothing this step writes is member-visible. No reference is published, and the
  recording's own publication state is untouched. (refines 3.21.2.2)
- **3.1.8** Running the step twice leaves **one open scripture draft** for that recording: the write
  replaces open drafts of this kind and never touches closed ones. (refines 3.21.2.6)
- **3.1.9** An admin can ask for the scripture references again — with an optional sentence of
  steering — **without the summary or the description being re-drafted**. (refines 3.6.9)
- **3.1.10** The offer made after a transcript correction now names scripture references alongside
  the summary, rather than naming the summary alone. This closes the half of `project prd 3.5.6`
  the Delivery status table records as missing. (refines 3.5.6)
- **3.1.11** A provider that refuses, times out, or answers in a shape that is not the structured
  one **fails the job with a reason readable on the pipeline panel and writes no partial draft**.
  Nothing retries by itself. (refines 3.21.2.3, 3.21.2.5)
- **3.1.12** Concurrency is unchanged and deliberately not re-specified: one generation in flight per
  recording, per `project prd 3.6.9`, and scripture drafting is that same step.

### 3.2 An admin reviews, edits and approves the references

_Refines: `project prd 3.7.2`, `project prd 4.17.2`, `project prd 3.19.2`_

- **3.2.1** A scripture draft arrives in the **existing** Pending Reviews queue as one item of a new
  kind — same queue, same screen, same ordering, no second queue and no per-recording admin page.
  This closes the scripture half of what the Delivery status table records as missing from
  `project prd 3.19.2`. (refines 4.17.6, 3.19.2)
- **3.2.2** The item renders as a **list of references** rather than as a block of text. This is the
  first artefact whose draft is not one string, and the form renders it by kind rather than by
  branching on scripture specifically. (refines 4.17.6, 3.7.2)
- **3.2.3** Per reference, an admin can **accept it as it stands, edit it, or remove it**. Removing
  one does not touch the others. (refines 3.7.2)
- **3.2.4** An admin can **add a reference by hand**, entered as book, chapter and verse or verse
  range — never as free text, so a hand-added reference is the same kind of thing as a proposed one.
  (refines 3.7.2, 3.7.3)
- **3.2.5** An added or edited citation is checked against the canon before it can be saved. An
  invalid one is refused with what is wrong with it — an unknown book, a chapter that book does not
  have, a range that ends before it starts — and the admin's other edits are not lost. (refines 3.7.3)
- **3.2.6** Approving writes the whole list through to the recording's references and closes the
  review item **in one transaction**. There is no state in which the references exist and the item
  that produced them is still waiting. (refines 4.17.2, 4.17.3)
- **3.2.7** Approving an **empty** list is legal, and records that this teaching has no scripture
  references — a different fact from "nobody has looked yet". (refines 4.17.2)
- **3.2.8** Discarding closes the item with nothing published, and **leaves what the machine proposed
  in the closed row**. A rejected draft leaves a record rather than nothing. (refines 3.6.14, 4.17.5)
- **3.2.9** What the machine proposed is retained after approve, edit or discard — with the model,
  the model version, the prompt version and any steering prompt — and **per reference**, whether it
  was AI-suggested, edited by an admin, or added by one. (refines 4.17.5, 3.6.14)
- **3.2.10** A second resolve of the same item — two admins at once, or one double press — is
  **refused as already closed** rather than writing through twice. (refines 4.17.3)
- **3.2.11** Approving a later draft **replaces** the recording's references rather than appending to
  them. The approved list is what the last approval said, in full. (refines 3.7.2)
- **3.2.12** Reading the queue, resolving an item and asking for a re-draft are each refused
  server-side for anyone without the right, whatever the screen offers. A member calling the API
  directly is refused. (refines § 6 Security)
- **3.2.13** Approved references become member-visible only once the **recording** is published.
  Approving before publication publishes nothing. There is no separate return-to-draft for
  references — that is the summary's shape, and nothing in `project prd 3.7` asks for it. (refines
  3.7.5, 3.21.2.2)

### 3.3 Every citation carries its verse text

_Refines: `project prd 3.7.4`, `project architecture § Key technology choices`_

- **3.3.1** Verse text is **fetched from a free-use Bible text source and saved in our own
  database**, keyed by translation, book, chapter and verse. Citations stay structured regardless;
  the text is a cache beside them. (refines 3.7.4)
- **3.3.2** Text already held is never fetched again. A verse cited by a second teaching is a read of
  what we have, not a second call. (refines 3.7.4, `project architecture § Estimated running costs`)
- **3.3.3** The fetch happens **when the draft is produced**, so an admin reads the verse text while
  deciding rather than after publishing. A citation that looks right and reads wrong is the whole
  reason the text is on the review screen. (refines 3.7.4, 4.17.2)
- **3.3.4** A citation an admin adds or edits resolves its verse text **while the form is open**, so
  they see what they just typed turn into a passage before they approve it. (refines 3.7.4, 3.7.2)
- **3.3.5** A source that fails, times out, or has no text for a citation **does not fail the
  pipeline step**. The reference keeps its citation and is marked as having no text yet. This is a
  deliberate exception to `project prd 3.21.2.3`: the artefact is the citation, and verse text is a
  convenience on top of it. (refines 3.7.4)
- **3.3.6** A reference with no text still displays its citation — on the review form and on the
  member surface both. This is the degradation `project architecture § Key technology choices`
  already names as the worst case. (refines 3.7.4)
- **3.3.7** **One translation**, named in configuration rather than in code, and free to use. Which
  one is a deployment's answer, not a code change. (refines 3.7.4)
- **3.3.8** Verse text is **never editable by an admin**. It is what the source says. Correcting a
  passage means correcting the citation. (refines 3.7.4)
- **3.3.9** Every lookup is recorded against the job that caused it — how many verses were fetched,
  how many were served from what we already held, and the source's own identifier for the call.
  A free source spends nothing and is recorded as spending nothing. (refines § 6 Cost accountability)
- **3.3.10** A development or test run reaches **no** Bible source. The one switch that mocks every
  external provider mocks this one too. (refines § 6 Cost accountability)

### 3.4 A member reads a teaching's scripture on the recording page

_Refines: `project prd 3.7.5`, `pages/recording.png`_

- **3.4.1** The recording page's tab strip gains **Scripture**, in the position the design reference
  draws it. The strip currently drops it as deferred; this scope is what un-defers it. (refines 3.7.5)
- **3.4.2** Opening the tab lists the teaching's published references **in canon order** — Genesis
  before Exodus, chapter 3 before chapter 12 — never in the order the machine happened to propose
  them. (refines 3.7.5)
- **3.4.3** Each reference shows its citation and its full verse text, readable without leaving the
  page. (refines 3.7.4, 3.7.5)
- **3.4.4** The tab is **not rendered at all** for a teaching with no published references — the same
  line the strip already draws for a destination with no data behind it, rather than an empty panel
  or a disabled tab. (refines 3.7.5)
- **3.4.5** A member never sees an unapproved reference, a discarded one, or any reference belonging
  to an unpublished teaching. (refines 3.21.2.2, § 6 Content integrity)
- **3.4.6** The strip's existing behaviour governs the new tab and is not re-specified: single-select,
  starting closed, fetched when first opened.
- **3.4.7** A failed load shows a failure line inside the panel and leaves the rest of the page —
  player, notes, transcript — working. (refines § 6 Operability)
- **3.4.8** A reference is **text, not a link**. `project prd 3.7.6` makes each one navigable into the
  cross-referencing layer, and that layer does not exist; a link to nowhere is worse than no link.
  (refines 3.7.6 — deliberately partial)

## 4. Data detail

Refines `project prd 4.6`, which defines the scripture reference conceptually.

**Scripture reference — new.** One row per citation on one recording.

| Field | Set by | Notes |
| :---- | :---- | :---- |
| Recording | Auto-set | Which teaching cites it (`project prd 4.6`, *Source recording*) |
| Book | AI-suggested, admin-editable | From the fixed 66-book canon, stored as a canonical identity rather than as the words the model wrote |
| Chapter | AI-suggested, admin-editable | |
| Verse start / verse end | AI-suggested, admin-editable | Equal for a single verse; a whole chapter is expressible (3.7.3) |
| Origin | Auto-set | Whether this reference was proposed by the machine or added by an admin (3.2.9) |
| Edited by admin | Auto-set | Whether an admin changed it before approving (4.17.5) |

`project prd 4.6`'s *Status* field is **not** a field here. Suggested-versus-accepted is the state of
the review item that holds the draft, not of a reference — a reference exists only once an admin has
approved the list it belongs to. That is a deliberate refinement of 4.6 and appears in the audit
table below.

**Verse text — new.** The cache 3.3.1 describes. Keyed by translation, book, chapter and verse, one
row per verse, holding the text and when it was fetched. Shared across every recording that cites
it, which is what makes 3.3.2 true and what keeps the lookup volume near
`project architecture § Estimated running costs`'s assumption.

**Review item — existing, extended.** A new value of its kind enum, and its draft field becomes
list-shaped for that kind. Nothing about the queue, the ordering or the closed-row audit trail
changes. Refines `project prd 4.17.6`.

**Pipeline job — existing, unchanged.** No new step: scripture drafting is part of the step that
already produces the summary and the description, per `project prd 3.21.1` step 5. What widens is
what that step's record carries about what it spent (3.3.9), which `project prd 4.18`'s *Provider
metadata* field already allows for.

## 5. Interface detail

### 5.1 The member's Scripture panel

Reference: `pages/recording.png` draws the tab. **Nothing draws the panel** — the style guide fills
it, following the transcript and notes panels already in the strip.

| State | What the member sees |
| :---- | :---- |
| Tab absent | No **Scripture** tab in the strip at all, for a teaching with no published references (3.4.4) |
| Closed | The tab, unselected, beside the others |
| Loading | The panel open with a loading line, the way the transcript panel does it |
| Loaded | The references in canon order, each a card: the citation as its heading, the verse text as its body |
| A reference with no text | The citation alone, with a quiet line saying the passage could not be loaded (3.3.6) |
| Failed | One failure line inside the panel; the page's other tabs and the player unaffected (3.4.7) |

The citation heading is the reference read the way a person says it — `Romans 8:1–4`, `John 3:16`,
`Psalm 23`. Verse text is plain text; no verse numbers rendered inside the passage, no markup, no
copy control, no share control.

### 5.2 The admin's reference list in the review form

Reference: **none exists**, for this or for any admin screen. The style guide fills it, following the
Pending Reviews form as built.

| State | What the admin sees |
| :---- | :---- |
| Draft with references | The list, one row per reference: the citation, its verse text, and the row's controls |
| Draft with none found | The item present, saying the machine found no scripture in this teaching, with the add control (3.1.6) |
| Editing a reference | The citation's book, chapter and verse range as separate inputs, not one text box (3.2.4) |
| Invalid citation | The reason it is refused, against that row, with the rest of the list untouched (3.2.5) |
| Verse text pending | The row with its citation, resolving (3.3.4) |
| Verse text unavailable | The row with its citation and a quiet line where the passage would be (3.3.6) |
| Resolved elsewhere | The refusal `project prd 4.17.3` requires when the item was already closed (3.2.10) |

Removing a reference is a per-row control; **approving and discarding keep the form's existing
shape** — approve, approve-my-edit, ask again, discard, with the second press on the one that
destroys. Removing a single row does not take a second press: it is an edit to a draft, and the
draft is not saved until the admin approves.

## 6. Non-functional requirements

| Category | Requirement | Refines |
| :---- | :---- | :---- |
| Content integrity | No reference reaches a member without an admin having approved the list it is in, and the teaching being published | `project prd § 6` Content integrity, `project prd 4.17.3` |
| Content integrity | Citations are stored structured; nothing derives a reference by parsing prose the model wrote | `project prd 3.7.3` |
| Security | Every read and write of a reference goes through the same one-place authorisation decision every other route uses, and denies by default | `project prd § 6` Security |
| Cost accountability | Verse lookups and the drafting call are both measured against the job that made them; one switch puts both sources into a local mock | `project prd § 6` Cost accountability |
| Auditability | Approving, editing, adding, removing and discarding are logged with actor, action, target and timestamp, and carry the correlation id of the request | `project prd § 6` Auditability |
| Operability | A Bible source that is down degrades the feature to citations without text; it never fails a pipeline step or a page load | `project prd § 6` Operability |
| Accessibility | The Scripture tab and the review form's per-row controls are keyboard-reachable and labelled | `project prd § 6` Accessibility |

## 7. Out of scope

- **`project prd 3.7.6`** — a reference navigating into cross-referencing. Needs `project prd 3.9`.
- **`project prd 3.7.7`** — finding teachings by citation. Needs `project prd 3.10`.
- **Topics and tags** (`project prd 4.7`), even though `project prd 3.21.1` step 5 and
  `project prd 4.17.1` group them with scripture in the same automated step. They are a different
  artefact with a different review shape, and the operator named scripture.
- **More than one translation.** One, from configuration (3.3.7). Holding two means deciding which a
  member sees, and nothing in `project prd 3.7` asks that.
- **A separate publish gate for references.** They ride the recording's, per 3.2.13.
- **Editing verse text** (3.3.8), and any rendering of it beyond plain text.
- **Bulk review across recordings** — `project prd 3.21.3.4`'s batch path, which belongs to
  back-catalogue processing.
- **An in-app notification when a scripture draft is ready.** `project prd 3.17` is not started, and
  the summary already waits on the same missing feature.
- **The Contributor role.** Reviewing is admin-only in this scope, as every other review is.

## 8. Refinement audit

One pass over the finished draft. Clean refinements do not get rows.

| Active-scope statement | Full-scope parent | Relationship | Action |
| :---- | :---- | :---- | :---- |
| prd 4, *Scripture reference* — no `Status` field | `project prd 4.6` lists *Status: suggested or accepted* | contradicts | Deliberate: suggested-ness is the review item's state (`project prd 4.17.6`), so a status column would be a second answer to the same question. **Ask whether 4.6 should drop the field** |
| prd 3.3.5 — a Bible source failing does not fail the step | `project prd 3.21.2.3` halts the pipeline on any automated-step failure | contradicts | Deliberate: verse text is a cache on the citation, not the artefact. **Ask whether 3.21.2.3 should say "a failure to produce the step's artefact"** |
| prd 3.3.1 — verse text saved in our own database | `project prd 3.7.4`, `project architecture § Key technology choices` | refines, and settles an open question | `project architecture § Open questions` #4 (Bible text licensing) is answered *for this scope* as a free-use source and one configured translation. **The north star's open question should be closed or narrowed** |
| prd 3.4.8 — a reference is text, not a link | `project prd 3.7.6` | uncovered *in this scope* | Not a gap in full scope; 3.7.6 is deferred with `project prd 3.9`. Recorded so nobody reads the omission as an oversight |
| prd 3.1.6 / 3.2.7 — an empty list is a reviewable, approvable result | — | uncovered | Nothing in `project prd 3.7` or `4.17` says what happens when a teaching cites no scripture. **Ask whether this belongs in full scope** |
| prd 3.3.7 — one translation, from configuration | — | uncovered | `project prd 3.7` never says how many translations exist. Named here as a limit rather than invented as a feature |
