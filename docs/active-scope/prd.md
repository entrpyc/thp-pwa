# Teaching Hub — Active scope: notes

_Defined: 2026-08-23_

Refines **project prd 3.12 Timestamp notes**. Nothing here is new product surface: every
requirement below narrows a numbered requirement that full scope already carries.

---

## 1. Scope decisions

### 1.1 What's in

| # | Feature | Refines |
| :---- | :---- | :---- |
| 3.1 | Writing a note at a moment in a teaching, public or private | project prd 3.12.1, 3.12.3–3.12.5 |
| 3.2 | Reading a recording's notes, in time order and as markers on the transport | project prd 3.12.2, 3.12.11, 3.12.12 |
| 3.3 | Replying to a public note, one level deep | project prd 3.12.6–3.12.8 |
| 3.4 | Reacting to a public note from a fixed set of six | project prd 3.12.13, 3.12.14 |
| 3.5 | Editing and deleting your own notes | project prd 3.12.9 |
| 3.6 | Moderating public notes — admin delete and pin | project prd 3.12.10, 3.12.15 |

**Carved out, deliberately:** project prd 3.12.16 (reply notification) and 3.12.17 (pin a note to
Highlights). Each is the only line in 3.12 that reaches into a feature nothing has built —
3.12.16 into project prd 3.17 Notifications, 3.12.17 into project prd 3.15 Highlights. Both attach
to what this scope builds without changing it. See 7.1 and 7.2.

### 1.2 Requirements depth

**Full** — error, empty and permission cases are specified here rather than decided during
implementation. Every requirement in section 3 is written to be testable as stated, and 3.7 carries
the complete permission matrix. Phase 5 reads this.

### 1.3 Architecture reach

**Generalise threads, reactions and moderation.** Phase 4 designs the one-level thread, the
one-reaction-per-member record, the admin-moderation-with-audit path and the author-owned-content
policy rule as primitives that notes are the _first_ user of rather than the only user of.

The named beneficiary is **project prd 3.16 SOS signals**, which is the same shape line for line:
one-level replies (3.16.6 ≙ 3.12.6), one acknowledgement per member (3.16.5 ≙ 3.12.14), admin
removal logged for audit (3.16.11 ≙ 3.12.10), author-owned close/edit (3.16.8 ≙ 3.12.9). Building
these twice is the duplication this answer exists to prevent.

This does **not** extend to offline-ready writes. Project prd 3.18.15 (notes written offline sync on
return) is out — see 7.4.

The existing policy module already anticipates this: `packages/web/src/server/auth/policy.ts`
carries `requiresOwnership` on a rule and names "a note, a highlight, a progress row" as the shapes
it was built for. This scope is the first thing to use it.

### 1.4 Interface detail

**Screens, states and copy.** Section 5 pins down the Notes panel, the composer, the reply and
reaction affordances, the pinned-notes treatment, marker rendering on the transport, and the exact
copy for every empty and error state.

References that cover this scope:

- `docs/design referencess png/pages/recording.png` — the recording tab strip, which already draws a
  **Notes** tab between Scripture and Transcript. That tab is this scope's home.
- `docs/design referencess png/bottom-navigation/default.png` — the docked transport, whose progress
  track already draws tick marks. Those are 3.2.4's markers.
- `docs/design referencess png/bottom-navigation/menu-opened.png` — the transport's opened menu,
  carrying a speech-bubble icon. That is the composer's second entry point (3.1.2).
- `docs/design referencess png/style-guide.md` — which reserves **green** (`--color-notes` `#22C55E`,
  `--color-notes-bg` `#03352B`) as a category colour meaning _notes and nothing else_, under
  principle 5. Notes are the only feature in the product entitled to it.

**No reference draws the inside of the Notes panel.** Everything below the tab is designed here from
the style guide, and section 5 says what it decided rather than leaving it to whoever builds it.

---

## 2. What this scope delivers

A member listening to a teaching can stop at the exact moment something lands and write it down —
privately, as their own study record, or publicly, where the rest of the group sees it at that
moment in the recording. Every note anyone can see becomes a green tick on the transport track, so
the annotated moments of a teaching are visible before a word of the notes is read and reachable in
one press. Public notes carry one level of reply and a reaction from a fixed set of six, so a
teaching becomes a conversation attached to its own timeline rather than a thread somewhere else.
Authors control their own notes; admins can remove any public note or reply and raise any number of
notes above the rest. None of this waits on anything else being built.

- **As a member, I can** write a note anchored to the moment I am hearing, and choose whether the
  group sees it.
- **As a member, I can** see everything the group has noted on a teaching in time order, and jump
  straight to any noted moment from the transport.
- **As a member, I can** reply to another member's note and react to it, and see who reacted how.
- **As a member, I can** edit or delete anything I wrote, at any time, with no admin involved.
- **As a member, I can** keep private notes on a teaching that no other member and no admin ever
  sees — including in the pinned notes, the reply threads, and every response the API returns.
- **As an admin, I can** remove a public note or reply that should not stand, with the removal logged
  against me.
- **As an admin, I can** pin as many notes on a recording as the teaching warrants, so the group
  reads them first.

---

## 3. Features

### 3.1 Writing a note at a moment

_Refines: project prd 3.12.1, 3.12.3, 3.12.4, 3.12.5_

**Functional requirements**

- **3.1.1** A member writing a note on the recording page anchors it to the position the player is at
  **when the composer opens**, not when it is submitted. The position is frozen at that instant,
  displayed in the composer as `mm:ss` (or `h:mm:ss` past an hour), and cannot be changed by the
  author. Playback is not paused or altered by opening the composer, so a note written about a moment
  does not drift to a moment thirty seconds later while it is being typed. _(refines 3.12.1)_
- **3.1.2** The composer is reachable from two places: the Notes tab on the recording page, and the
  transport's opened menu (`bottom-navigation/menu-opened.png`), which anchors to the recording
  currently loaded in the transport regardless of which screen the member is on. Both produce the
  same note. _(refines 3.12.1)_
- **3.1.3** When nothing has played yet, the anchor is the position the player currently holds —
  which is the restored resume position (project prd 3.2.5) where one exists and `00:00` where none
  does. A note can be written on a teaching that has never been played. _(refines 3.12.1)_
- **3.1.4** The composer carries an explicit visibility control with two states, **Private** and
  **Public**, and it opens on **Private**. A member who submits without touching the control has not
  published anything. _(refines 3.12.4)_
- **3.1.5** Visibility is fixed once the note is created. It cannot be changed by the author or by an
  admin, in either direction: raising a private note to public would publish text written in
  confidence, and lowering a public note to private would strand replies (3.3) written to it in the
  open. A member who chose wrongly deletes the note (3.5.2) and writes it again. _(refines 3.12.4)_
- **3.1.6** A note is plain text of at most **1,000 characters**, counted after leading and trailing
  whitespace are stripped. Line breaks are preserved and count as characters. No markup is
  interpreted: text that looks like markdown, HTML or a URL renders as the characters it is.
  _(refines 3.12.5)_
- **3.1.7** The character count is displayed from **900 characters onward** and not before. At over
  1,000 the submit control is disabled and the count is shown in the error treatment. The limit is
  enforced again server-side, so a submission that reaches the API over the limit is refused rather
  than truncated. _(refines 3.12.5)_
- **3.1.8** A note whose text is empty or entirely whitespace is refused, on the client with the
  submit control disabled and on the server with a refusal. _(refines 3.12.5)_
- **3.1.9** A private note is visible to its author alone. It never appears in a response to any other
  member or to an admin, in any surface this scope builds — the notes list, the marker set, the
  pinned notes, a thread, or a reaction count. This is enforced by the query that reads notes, not by
  the interface that renders them. _(refines 3.12.3)_
- **3.1.10** A member can write any number of notes at the same position on the same recording. Notes
  are not deduplicated and a second note at an already-noted moment is an ordinary write.
  _(refines 3.12.1)_
- **3.1.11** Submitting a note while the recording has been unpublished underneath the member
  (project prd 3.2.11) is refused, with the message at 5.1.4. The composer's contents are preserved
  rather than cleared, so the text is not lost to a refusal the member could not have anticipated.
  _(refines 3.12.1)_
- **3.1.12** Both roles that exist — Admin and Member — write notes on the same terms. Nothing about
  writing a note differs by role. _(refines 3.12.1)_

### 3.2 Reading a recording's notes

_Refines: project prd 3.12.2, 3.12.11, 3.12.12_

**Functional requirements**

- **3.2.1** The Notes tab on the recording page lists, in one list ordered by **timestamp ascending**:
  every public note on that recording, plus the reading member's own private notes on it. Ties at the
  same timestamp are broken by creation time, oldest first, so the order is total and stable across
  reloads. _(refines 3.12.11)_
- **3.2.2** The two kinds are interleaved rather than separated, so a member studying reads their own
  annotations in place against the group's. Each of the member's own private notes carries a visible
  **Private** marker (5.2.3) distinguishing it from everything else in the list, which is public by
  definition. _(refines 3.12.2, 3.12.3)_
- **3.2.3** The list carries a filter with three states — **All**, **Public**, **Mine** — defaulting
  to All. **Mine** narrows to the reading member's own notes of both visibilities. The filter changes
  what is listed and never what is reachable: the transport markers (3.2.4) are unaffected by it.
  _(refines 3.12.11)_
- **3.2.4** Every note the reading member can see renders as a marker on the transport progress track
  (project prd 3.2.9) for the recording currently loaded, in the notes green the style guide reserves.
  The marker set therefore differs per member: it is every public note plus that member's own private
  ones. _(refines 3.12.12)_
- **3.2.5** Pressing a marker seeks the audio to that note's position and opens the Notes tab scrolled
  to that note, which is briefly highlighted so it is findable in a long list. Seeking from a marker
  **does not start playback** — the same rule project prd 3.5.4 sets for the transcript, for the same
  reason. _(refines 3.12.12)_
- **3.2.6** Notes closer together than **1% of the recording's duration** collapse into a single
  marker, so a heavily annotated passage does not render as an unpressable smear. Pressing a collapsed
  marker seeks to the earliest note in it and opens the list at that note, from where the rest are the
  next rows. _(refines 3.12.12)_
- **3.2.7** Markers appear on the docked transport wherever it is shown, not only on the recording
  page, because the transport travels with the member (project prd 3.2.14). Changing the loaded
  recording replaces the marker set. _(refines 3.12.12)_
- **3.2.8** Each note in the list shows its timestamp, its author's display name (project prd 3.1.12),
  the time it was written, its text, its reactions (3.4) and its replies (3.3). A note whose text has
  been edited (3.5.1) additionally shows an **edited** indicator; the previous text is not retained or
  viewable. _(refines 3.12.2)_
- **3.2.9** A note authored by a deactivated account (project prd 3.1.7) continues to render exactly
  as it did, under the same display name. Deactivation ends access, not authorship. _(refines 3.12.2)_
- **3.2.10** A recording with no notes the reading member can see shows the empty state at 5.2.6 and
  no markers. A recording with public notes but none of the member's own is not an empty state.
  _(refines 3.12.11)_
- **3.2.11** If the notes list fails to load, the tab shows the error state at 5.2.7 with a retry
  control, and the transport renders no markers rather than stale ones. A notes failure never prevents
  the recording from playing — the Availability NFR's graceful degradation applies to notes as it does
  to AI generation. _(refines 3.12.2)_
- **3.2.12** Notes are read only by a member with an authenticated session, and only on a recording
  that member is entitled to see. A request for the notes of an unpublished recording from a member is
  refused, not answered with an empty list. _(refines 3.12.2)_

### 3.3 Replying to a public note

_Refines: project prd 3.12.6, 3.12.7, 3.12.8_

**Functional requirements**

- **3.3.1** Any member can reply to any public note on a recording they can see. A reply is a note
  carrying a parent (project prd 4.10) and is subject to every rule in 3.1 that governs text: plain
  text, 1,000 characters, no empty submission. _(refines 3.12.6)_
- **3.3.2** A reply has **no timestamp anchor of its own**. It belongs to its parent note's moment,
  renders under the parent rather than at its own position in the list, and produces **no marker** on
  the transport. Only top-level notes are moments. _(refines 3.12.6, 3.12.12)_
- **3.3.3** A reply is always public. There is no private reply and no visibility control on the reply
  composer: a reply to a note everyone can see, that only its author could see, would be a message to
  nobody. _(refines 3.12.6)_
- **3.3.4** Threads are one level deep. A reply carries no reply affordance, and the API refuses a
  create whose parent already has a parent rather than silently re-pointing it at the grandparent.
  _(refines 3.12.7)_
- **3.3.5** A private note carries no reply affordance and the API refuses a reply to one, for any
  actor including its own author. _(refines 3.12.8)_
- **3.3.6** Replies under a note are ordered by creation time, oldest first, and are shown in full
  rather than collapsed behind a count. _(refines 3.12.6)_
- **3.3.7** A note with no replies shows the reply affordance and no thread area at all — not an empty
  thread. _(refines 3.12.6)_
- **3.3.8** Replying to a note deleted underneath the member (by its author at 3.5.2 or by an admin at
  3.6.1) is refused with the message at 5.3.4, and the list refreshes so the member sees the tombstone
  (3.2.8, 5.3.3) rather than a note that is no longer there. _(refines 3.12.6)_
- **3.3.9** When a note with replies is deleted, the replies survive and stay readable under a
  tombstone standing in for the parent (5.3.3). Deleting a parent does not delete a conversation other
  members wrote. _(refines 3.12.6, 3.12.7)_
- **3.3.10** Deleting a reply removes that reply alone and leaves its parent and its sibling replies
  untouched. _(refines 3.12.6)_

### 3.4 Reacting to a public note

_Refines: project prd 3.12.13, 3.12.14_

**Functional requirements**

- **3.4.1** The reaction set is exactly six, fixed, and the same everywhere in the product:
  🙏 **praying**, ❤️ **loved**, 🔥 **convicting**, 💡 **insight**, 👏 **encouraged**, 😢 **moved**.
  There is no free emoji entry and no per-recording or per-member customisation. _(refines 3.12.13)_
- **3.4.2** The set is defined in one named place. If it later changes, a reaction already stored under
  an emoji that has left the set still renders and still counts, and is simply no longer offered — a
  member's past response is not rewritten by a product decision taken after it. _(refines 3.12.13)_
- **3.4.3** A member holds at most one reaction per note. Selecting a different emoji replaces the
  existing one rather than adding to it. _(refines 3.12.14)_
- **3.4.4** Selecting the emoji the member has already chosen **clears** their reaction, so a reaction
  given can be taken back. _(refines 3.12.14 — which specifies replacement and is silent on removal;
  see the refinement audit)_
- **3.4.5** Reactions render as a row under the note showing only those emoji with at least one
  reaction, each with its count. An emoji nobody has chosen is absent from the row rather than shown at
  zero. The reading member's own choice is visibly marked in the row. _(refines 3.12.13)_
- **3.4.6** A note with no reactions shows no reaction row, only the affordance that opens the picker.
  _(refines 3.12.13)_
- **3.4.7** Replies can be reacted to on the same terms as top-level notes, because a reply is a note
  with a parent (project prd 4.10) and 3.12.13 grants the reaction to _any public note_.
  _(refines 3.12.13)_
- **3.4.8** Private notes take no reactions. The picker is absent and the API refuses a reaction to
  one, including from its author. _(refines 3.12.13)_
- **3.4.9** A member may react to their own public note. _(refines 3.12.13)_
- **3.4.10** Reacting to a note deleted underneath the member is refused with the message at 5.4.3 and
  the list refreshes. Reactions on a deleted note are not shown on its tombstone. _(refines 3.12.13)_
- **3.4.11** Two members reacting at the same moment both succeed and both counts are correct. One
  member reacting twice in rapid succession settles on their last selection rather than recording two.
  _(refines 3.12.14)_

### 3.5 Editing and deleting your own notes

_Refines: project prd 3.12.9_

**Functional requirements**

- **3.5.1** An author can edit the **text** of their own note or reply at any time, with no time limit
  and no admin involvement. The edit is subject to every rule at 3.1.6–3.1.8. Editing sets the
  **edited** indicator at 3.2.8 permanently; there is no undo and no history. _(refines 3.12.9)_
- **3.5.2** An author can delete their own note or reply at any time. Deletion is confirmed first
  (5.5.2), because it is not reversible. _(refines 3.12.9)_
- **3.5.3** Editing changes text alone. A note's timestamp (3.1.1) and its visibility (3.1.5) are not
  editable, and neither is offered in the edit form. _(refines 3.12.9)_
- **3.5.4** Deleting a note with no replies removes it from the list entirely and removes its marker
  from the transport. Deleting a note **with** replies leaves the tombstone at 3.3.9 in place, keeping
  its marker so the replies stay reachable from the moment they belong to. _(refines 3.12.9)_
- **3.5.5** Deleting a private note always removes it entirely, since it can have no replies (3.3.5).
  _(refines 3.12.9)_
- **3.5.6** A member can edit and delete only what they authored. The API refuses an edit or a delete of
  another member's note to a member, and refuses an **edit** of another member's note to an admin too —
  moderation is deletion, never rewriting somebody's words (3.6.2). _(refines 3.12.9)_
- **3.5.7** Editing or deleting a note another actor has already deleted is refused with the message at
  5.5.4 rather than failing silently or resurrecting it. _(refines 3.12.9)_
- **3.5.8** An author whose note has been deleted by an admin (3.6.1) sees the tombstone like everyone
  else. The product does not tell the author who removed it; the record of who did lives in the log
  (3.6.4). _(refines 3.12.9, 3.12.10)_
- **3.5.9** A deleted note's text is no longer returned by the API to any actor, including its author
  and including an admin. The tombstone carries no text. _(refines 3.12.9)_

### 3.6 Moderating public notes

_Refines: project prd 3.12.10, 3.12.15_

**Functional requirements**

- **3.6.1** An admin can delete any **public** note or reply, authored by anyone. The result is the
  same tombstone-or-removal behaviour as an author's own deletion (3.5.4). _(refines 3.12.10)_
- **3.6.2** An admin cannot edit any note they did not author, and cannot read, delete, pin or react to
  a private note. Private notes are absent from every admin surface this scope builds, which refines
  the Privacy NFR from a promise into an enforced query condition. _(refines 3.12.10)_
- **3.6.3** Moderation is available from the note itself in the notes list, not from a separate console.
  There is no moderation queue in this scope. _(refines 3.12.10)_
- **3.6.4** Every admin deletion of a note or reply the admin did not author is logged with the acting
  admin, the action, the note id and the request's correlation id — following the established
  `audit(actor, action, id)` structured-log convention already used for recording publish and
  unpublish. This is what the Auditability NFR requires, and it names 3.12.10 explicitly.
  _(refines 3.12.10)_
- **3.6.5** An admin can pin **any number** of public notes on a recording. Pinned notes are shown
  above the notes list, each with a visible pinned indicator (5.6.2), and each is **not repeated** at
  its position in the chronological list, so every note is read once. Their transport markers are
  unaffected. Pinned notes are ordered among themselves by **timestamp ascending**, tie-broken by
  creation time — the same total order 3.2.1 gives the list, so the product has one answer to what
  order notes read in and pinning does not invent a second. There is no cap: nothing in full scope
  limits how much of a teaching an admin may raise. _(refines 3.12.15)_
- **3.6.6** Pinning a note while others are already pinned **adds** to the pinned set rather than
  replacing anything. Pinning a note that is already pinned succeeds and changes nothing rather than
  being refused — an admin acting on a stale screen has still got what they asked for.
  _(refines 3.12.15)_
- **3.6.7** An admin can unpin any pinned note, returning it to its chronological position and leaving
  every other pin in place. Unpinning the last one leaves the recording with no pinned notes — the
  ordinary state, and the one every recording starts in. _(refines 3.12.15)_
- **3.6.8** Only a top-level public note can be pinned. Pinning a reply or a private note is refused and
  no pin affordance is offered on either. _(refines 3.12.15)_
- **3.6.9** Deleting a pinned note clears **its** pin and leaves every other pin in place, whether the
  delete comes from its author (3.5.2) or an admin (3.6.1). A recording never shows a pinned
  tombstone. _(refines 3.12.15)_
- **3.6.10** A pin is a property of one recording–note pair, and a note is pinned at most once. A
  recording's pinned notes are visible to every member who can see the recording, and pinning is
  refused on an unpublished recording. _(refines 3.12.15)_

### 3.7 Permission matrix

_Refines: project prd 3.1 (role table), 3.12.9, 3.12.10, 3.12.15_

Every row is enforced server-side through one policy action, evaluated against actor, action and
resource, denying by default — the Security NFR's requirement, and the shape
`packages/web/src/server/auth/policy.ts` already implements. **Absence from an interface is not
enforcement**: each refusal below is refused by the API whether or not a control was rendered.

| Action | Author | Other member | Admin (not author) |
| :---- | :---- | :---- | :---- |
| Write a note on a visible recording | ✅ | ✅ | ✅ |
| Read a public note | ✅ | ✅ | ✅ |
| Read a private note | ✅ | ❌ | ❌ |
| Reply to a public note | ✅ | ✅ | ✅ |
| Reply to a private note | ❌ | ❌ | ❌ |
| Reply to a reply | ❌ | ❌ | ❌ |
| React to a public note | ✅ | ✅ | ✅ |
| React to a private note | ❌ | ❌ | ❌ |
| Edit a note's text | ✅ | ❌ | ❌ |
| Edit a note's timestamp or visibility | ❌ | ❌ | ❌ |
| Delete a public note or reply | ✅ | ❌ | ✅ (logged, 3.6.4) |
| Delete a private note | ✅ | ❌ | ❌ |
| Pin or unpin a public note | ❌ | ❌ | ✅ |

**On Contributor.** Project prd 3.1 defines three roles; the codebase has two — `ROLES` in
`packages/shared/src/roles.ts` is `['admin', 'member']`. This costs 3.12 nothing: per project prd
3.1's own permission table, a Contributor's note capabilities are a Member's exactly, and every
moderation capability (pin, delete any) is Admin-only. When Contributor arrives it takes the Member
column above unchanged.

---

## 4. Data detail

Refines **project prd 4.10 Timestamp note**. Conceptual — Phase 4 owns the schema.

### 4.1 Note

| Field | Set by | New? | Notes |
| :---- | :---- | :---- | :---- |
| Recording | Auto-set | New | The teaching the note belongs to. Existing entity. |
| Author | Auto-set | New | The member who wrote it. Existing entity — display name is already on it. |
| Timestamp | Auto-set at creation | New | Composer-open position (3.1.1). Absent on replies (3.3.2). |
| Text | User-set | New | Plain text, ≤1,000 characters (3.1.6). Not returned once deleted (3.5.9). |
| Visibility | User-set at creation | New | Public or private. Immutable after creation (3.1.5). |
| Parent note | Auto-set | New | Replies only; one level (3.3.4). |
| Created at | Auto-set | New | The list's tie-break (3.2.1) and the thread's order (3.3.6). |
| Edited at | Auto-set | New | Drives the **edited** indicator (3.2.8). **Not in project prd 4.10** — see audit. |
| Deleted at | Auto-set | New | Refines 4.10's `Status`. Presence is what makes a note a tombstone. |
| Deleted by | Auto-set | New | Refines 4.10's `Status`. Who removed it — required by 3.6.4's audit line. |

Project prd 4.10 additionally lists `Reactions` and `Pinned` as fields on the note. Both are one
member's or one admin's act against one note rather than a property of the note's text, so each is
described below as its own record; the conceptual model 4.10 states is unchanged.

### 4.2 Reaction

| Field | Set by | New? | Notes |
| :---- | :---- | :---- | :---- |
| Note | Auto-set | New | The public note or reply reacted to (3.4.7). |
| Member | Auto-set | New | One reaction per member per note (3.4.3). |
| Emoji | User-set | New | One of the six at 3.4.1. |
| Reacted at | Auto-set | New | Not displayed in this scope; the row is ordered by count. |

Uniqueness on (note, member) is what makes 3.4.3 and 3.4.11 true by construction rather than by a
read-then-write the interface has to get right.

### 4.3 Pin

| Field | Set by | New? | Notes |
| :---- | :---- | :---- | :---- |
| Recording | Auto-set | New | Any number of pins per recording (3.6.5). |
| Note | Admin-set | New | Must be a public top-level note on that recording (3.6.8), and is pinned at most once (3.6.10). |
| Pinned by | Auto-set | New | The admin who pinned it. |
| Pinned at | Auto-set | New | When this note was pinned. **Not** the order pinned notes read in — that is 3.6.5's timestamp order. |

### 4.4 What this scope does not add

No new fields on `user`, `recording` or `series`. Notes attach to the recording and the user as they
already exist; `display_name` on `user` is already present and NOT NULL, which is what makes 3.2.8's
author line renderable without touching project prd 3.1.12.

---

## 5. Interface detail

Design references are named at 1.4. Everything below the Notes tab is designed here from
`style-guide.md`, because no reference draws it. Copy is given verbatim in **bold**.

### 5.1 The composer

- **5.1.1** The Notes tab (`pages/recording.png`, pill tab strip, `--radius-pill`) opens the notes
  surface. Following the pattern the recording page already sets, the tab starts closed and pressing it
  is what asks for the notes; pressing it again puts them away. The tab's icon and its active state use
  the notes green, the one place in the product entitled to it under style-guide principle 5.
- **5.1.2** The composer is a `--color-surface-raised` panel with `--radius-md`, pinned to the top of
  the notes surface above the list. It holds: the frozen timestamp as a small `--color-text-dim` label;
  a multi-line text field; the visibility control; the character count; and one filled primary submit.
  Placeholder: **"What landed at this moment?"**
- **5.1.3** The visibility control is a two-state segmented pill, **Private** / **Public**, opening on
  Private with Private selected in `--color-primary-soft`. Under it, one line of `--color-text-dim`
  explaining the current choice, switching with the selection: **"Only you will see this."** /
  **"Everyone in the group will see this at this moment."**
- **5.1.4** States:
  - _Over the limit_ — count in the error treatment, submit disabled. **"1,000 characters maximum."**
  - _Empty_ — submit disabled, no message. An empty composer is not an error.
  - _Submitting_ — submit shows a busy state and is not pressable twice.
  - _Save failed_ — inline under the composer, text preserved, retry available.
    **"Couldn't save your note. Your text is still here — try again."**
  - _Recording unpublished underneath (3.1.11)_ —
    **"This teaching isn't available any more, so the note can't be saved."**
- **5.1.5** From the transport menu (`bottom-navigation/menu-opened.png`), the speech-bubble icon opens
  the same composer as a sheet over the current screen, with the recording's title above the timestamp
  so it is unambiguous which teaching is being annotated.

### 5.2 The notes list

- **5.2.1** One column of note cards, `--color-surface` fill, `--color-border` hairline, `--radius-md`,
  `--space-4` gaps — the style guide's standard card.
- **5.2.2** Each card: the timestamp as a pressable `--color-primary-strong` link on the first row
  (pressing it seeks without playing, per 3.2.5); then author display name in `--color-text` and the
  written time in `--color-text-dim`; then the text in `--color-text` at `--fs-body`, wrapped in full
  rather than truncated; then the reaction row (5.4) and the thread (5.3).
- **5.2.3** A private note carries a small **Private** pill in `--color-notes` / `--color-notes-bg` on
  its first row. Nothing else about the card differs.
- **5.2.4** Author identity is the display name plus a circular monogram of its initials in
  `--color-surface-raised` (`--radius-circle`). **Avatars are not rendered** — project prd 3.1.12's
  avatar is not built, and this scope does not build it (7.3).
- **5.2.5** The filter (3.2.3) is a three-state pill row — **All** / **Public** / **Mine** — directly
  under the composer, in the same tab-pill treatment as the recording tab strip.
- **5.2.6** Empty states, one per filter:
  - _All_ — **"No notes on this teaching yet. Write the first one."**
  - _Public_ — **"Nobody has shared a note on this teaching yet."**
  - _Mine_ — **"You haven't written a note on this teaching yet."**
- **5.2.7** Load failure — **"Couldn't load notes."** with a **Try again** control. The player above is
  untouched (3.2.11).

### 5.3 Threads

- **5.3.1** Replies are indented one step under their parent inside the same card, separated by a
  `--color-border` hairline rather than a gap — the style guide's list-row rule. Each reply carries
  author, written time and text; no timestamp link, because a reply has no moment (3.3.2).
- **5.3.2** The reply affordance is a text control at the foot of a public note card, reading
  **"Reply"**. Pressing it opens an inline field with placeholder **"Write a reply"**, a character count
  on the same rule as 5.1.4, and no visibility control (3.3.3).
- **5.3.3** A tombstone replaces a deleted note's author line and text with one `--color-text-dim`
  italic line and keeps its timestamp and its replies: **"This note was removed."** No reaction row, no
  reply affordance, no indication of who removed it (3.5.8).
- **5.3.4** Replying to a note deleted underneath the member —
  **"This note was removed while you were writing."** The reply text is preserved in the field so it can
  be copied out before the list refreshes.

### 5.4 Reactions

- **5.4.1** The reaction row sits below the note text: only emoji with a count, each as a small pill
  showing emoji and number. The reading member's own is outlined in `--color-primary-strong`; the rest
  carry `--color-border`. Each pill has an accessible label naming the emoji and its count —
  **"praying, 3"** — since a bare emoji is unreadable to a screen reader.
- **5.4.2** The picker opens from an outlined circular control at the end of the row, showing all six of
  3.4.1 in a single row with their names as accessible labels. Selecting closes it. The current
  selection is marked in the picker so 3.4.4's toggle-off is discoverable rather than a guess.
- **5.4.3** Reacting to a removed note — **"This note was removed."**, and the list refreshes.

### 5.5 Author controls

- **5.5.1** A note the reading member authored carries an overflow control (`···`, the outlined circular
  icon button the transport already uses) opening **Edit** and **Delete**.
- **5.5.2** Delete confirms first: **"Delete this note? This can't be undone."** with **Delete** and
  **Cancel**. Where the note has replies, the confirmation says so:
  **"Delete this note? The replies to it will stay. This can't be undone."**
- **5.5.3** Edit turns the card into the composer with the existing text loaded, the timestamp and
  visibility shown but not editable (3.5.3), and **Save** / **Cancel**.
- **5.5.4** Acting on a note already deleted — **"This note has already been removed."**

### 5.6 Moderation

- **5.6.1** For an admin, the overflow on any public note additionally offers **Delete** and **Pin** —
  or **Unpin** on a note that is already pinned. The confirmation for deleting somebody else's note
  names what it is:
  **"Delete this member's note? This can't be undone, and the removal is logged."**
- **5.6.2** Pinned notes render above the list, each in a `--color-surface-raised` card with a
  `--color-border-strong` outline and a **Pinned** pill in `--color-primary-soft`. Each is otherwise
  an ordinary note card — its timestamp link, replies and reactions all work in place. Where more
  than one is pinned they stack in 3.6.5's order under one `--color-text-dim` heading, **"Pinned"**,
  so the group can see where the raised notes end and the teaching's own order begins.
- **5.6.3** Pinning and unpinning both act without a prompt (3.6.6, 3.6.7), and the interface simply
  moves the note between the pinned group and its chronological position. Neither is destructive and
  both are one press to undo.

### 5.7 Transport markers

- **5.7.1** Markers are thin vertical ticks in `--color-notes` on the progress track, at the position
  drawn in `bottom-navigation/default.png`. They sit behind the purple fill and the thumb, so neither
  the played portion nor the scrub handle is obscured.
- **5.7.2** Each marker is keyboard-reachable and carries an accessible label naming its position and
  what it is — **"Note at 12:45"**, or **"3 notes from 12:45"** for a collapsed marker (3.2.6) — which
  is what the Accessibility NFR requires of a media control.
- **5.7.3** A recording with no visible notes renders a plain track, identical to today's.

---

## 6. Non-functional requirements

Only what this scope is held to now. Full-scope NFRs it is not held to are in section 7.

| Category | Requirement | Refines |
| :---- | :---- | :---- |
| Security | Every note action — write, read, reply, react, edit, delete, pin — is one named policy action evaluated against actor, action and resource, denying by default. Ownership is a flag on the rule, never an `actor.id === note.authorId` comparison written at a route. No note route is on the unauthenticated surface. | project prd 6 Security |
| Privacy | A private note is excluded by the query that reads notes, not by the interface that renders them. No API response returns a private note, its text, its existence or its marker position to any actor but its author — including an admin, and including via a pinned note, a thread or a reaction count. | project prd 6 Privacy |
| Auditability | Every admin deletion of a note the admin did not author is logged with acting admin, action, note id and the request's correlation id, through the same `audit(actor, action, id)` convention already carrying recording publish and unpublish. Project prd 6 names 3.12.10 by number. | project prd 6 Auditability |
| Accessibility | Transport markers are keyboard-reachable and labelled with their position (5.7.2); reaction pills and the picker carry emoji names rather than bare emoji (5.4.1); the composer's visibility control is a labelled two-state control, not a colour difference. | project prd 6 Accessibility |
| Availability | A notes failure never blocks listening. The recording page plays with the notes tab in its error state and the transport rendering no markers (3.2.11). | project prd 6 Availability |
| Storage | Notes, replies and reactions are retained permanently. Deletion is a status, not a row removal — which is what lets 3.3.9's replies survive their parent. Deleted text is unreadable through the API (3.5.9). | project prd 6 Storage |
| API-first | Every capability in section 3 is reachable through the API layer, so the store-packaged build and the browser PWA work against one contract. No note behaviour lives only in the web interface. | project prd 6 API-first |
| Performance | The notes list and the marker set for a recording carrying 200 notes render within 1 second of the tab opening. Notes load independently of the recording and never delay first playback, which project prd 6 holds to 2 seconds. | project prd 6 Performance |

---

## 7. Out of scope

- **7.1 Reply notifications (project prd 3.12.16, 3.17.6).** The author of a public note is not notified
  when someone replies. Delivering it means building the notification entity (project prd 4.16), the
  in-app centre and its unread count (3.17.2, 3.17.3) — a feature, not a hook. Notes ship without it; a
  reply is found by opening the teaching.
- **7.2 Pinning a note to Highlights (project prd 3.12.17, 3.15.3).** Requires the Highlight entry
  (project prd 4.14) and a Highlights list to see one in, neither of which exists. A pin control with
  nowhere to land is not shippable.
- **7.3 Avatars on note authors (project prd 3.1.12).** Notes show display name and an initials
  monogram. Avatar upload and a member-facing profile edit surface are not built and are not built here.
- **7.4 Offline notes (project prd 3.18.4, 3.18.15).** Notes are neither readable offline nor writable
  offline with later sync. This scope's writes assume connectivity, and 1.3 deliberately stops short of
  client-generated ids and idempotent creates.
- **7.5 Notes in search (project prd 3.10.9, 3.10.10).** Notes are not searchable, and a member cannot
  restrict a search to their own notes. Search itself is unbuilt.
- **7.6 Rich text, mentions and attachments.** 3.1.6 is plain text by requirement, not by omission.
- **7.7 Paging the notes list.** The list is complete rather than paged. At 100 members and a weekly
  teaching the volume per recording does not warrant it; the Scalability NFR's re-architecture bar is
  what to re-read when a recording's note count makes the list unwieldy.
- **7.8 Rate limiting note creation.** Nothing in full scope caps note volume the way project prd 3.16.12
  caps open SOS signals, so nothing is capped here.
- **7.9 A moderation queue or reported-note flow.** Project prd 3.12.10 grants deletion from the note
  itself; nothing in full scope describes reporting, and no admin-dashboard surface is added (3.6.3).
- **7.10 Re-attribution of a deleted account's notes (project prd 3.1.10).** Depends on self-service
  account deletion (3.1.8), which is unbuilt. Notes by a _deactivated_ account render normally (3.2.9);
  a deleted account is not a state that exists yet.
- **7.11 Notes on anything but a recording.** No notes on videos, summaries, mind maps or series.
- **7.12 Exporting or printing notes.**
- **7.13 The Contributor role.** Not created here; see the note under 3.7.
