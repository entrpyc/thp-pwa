# Step 4 — Account lifecycle: reset, deactivation, last-admin guard, profile

> Phase 6 artefact for [implementation-plan.md § Step 4](../implementation-plan.md#L123).
> Sections pulled: [3.1.6](../prd.md#L48); [3.1.7](../prd.md#L49); [3.1.11](../prd.md#L53);
> [3.1.12](../prd.md#L54) — display name only, avatar deferred;
> [slice-prd.md § In scope → 1](../slice-prd.md#L35).
> Carried in because this step edits them: [3.1.5](../prd.md#L47) (role change — see the scope note
> below), [slice-architecture.md § Data model (slice) → Accounts](../slice-architecture.md#L229),
> [slice-architecture.md § Extension points](../slice-architecture.md#L323) (the allowlist), and
> [architecture.md § Cross-cutting concerns](../architecture.md#L271) (gate logging).

Four things that look unrelated and are not. Each one is a way an account **stops being what it
was** — its password, its ability to sign in, its role, its name — and all four have to hold against
a live session issued before the change. That is the property this step is really about, and it is
cheap only because step 2 made sessions server-side records and re-reads the account row on every
request.

Three seams built ahead get their first real use here:

- **`PolicyResource`.** Step 2 shipped `can(actor, action, resource)` with the resource ignored
  (`_resource`). Editing your own display name is the first **owned** resource in the product, so
  `can` starts reading it. Every later owned thing — a note, a highlight, a progress row — is that
  same shape.
- **The allowlist.** Reset is the second unauthenticated flow, and it grows the named list
  deliberately ([assumption 3](#assumptions-to-confirm)).
- **The `Mailer` port.** Reset is the second message, and the first proof that step 3 built a mail
  *port* rather than an invitation mailer with a general-sounding name.

## One thing this step has to absorb from step 3's scope edge

[03-invitations.md](03-invitations.md) puts *"changing an existing user's role
([3.1.5](../prd.md#L47))"* out of step 3, and [Step 5](../implementation-plan.md#L134) is described
as *"the UI over steps 3 and 4"* — a renderer, not a place new API behaviour lands. So **no route
that changes a role exists yet**, and [3.1.11](../prd.md#L53) says the system *"prevents removal or
demotion of the last remaining admin"*. A guard against demotion with nothing that demotes is
untestable, and shipping demotion in step 5 would mean shipping it unguarded for one step.

**This step therefore ships the role-change route** and guards it. That is a deliberate widening of
Step 4 as written in the plan, and it is [assumption 7](#assumptions-to-confirm).

## Two screens with no design reference

`/forgot-password` and `/reset-password` have no PNG under
[docs/design referencess png/](../design%20referencess%20png/), and none of the existing references
show them. Under [CLAUDE.md § Designing pages](../../CLAUDE.md) that is a stop-and-ask — so it is
[assumption 9](#assumptions-to-confirm), proposing the same carve-out steps 2 and 3 already
received. The **reset email** is the second designed mail surface and inherits step 3's settled
answer for it (`theme.ts`, literal token values, the style guard's one exemption by name).

---

## Requirements (test-covered)

### The `user.deactivated_at` column and the `password_reset` table

- `user` gains `deactivated_at` (nullable, timestamptz) and nothing else — verified by a migration
  test asserting the new column set, that existing rows migrate to `null`, and that
  `preferred_playback_speed` is still absent (it is step 15's).
- `password_reset` exists with `user_id`, `token_hash`, `expires_at`, `used_at`, `revoked_at`, plus
  `id` and `created_at` — verified by a migration test asserting the column set and the cascade on
  `user_id`.
- The raw reset token is never stored — verified by asserting the persisted value differs from the
  issued token and that a lookup by raw token finds nothing, in the same style as `session` and
  `invitation`.
- Status is derived from the three timestamps, never stored — verified by a unit test over
  pending / expired / used / revoked, mirroring `invitationStatus`.
- Deactivation is a timestamp, not a deleted row — verified by asserting the `user` row, its
  `password_hash` and every `invitation` it issued (`invited_by`) survive deactivation intact, which
  is [3.1.7](../prd.md#L49)'s "its authored content is retained" with the only authored content this
  slice yet has.

### Password reset — [3.1.6](../prd.md#L48)

**Requesting**

- Requesting a reset for an address with an active account sends exactly one message to that
  address, containing a link to the reset screen carrying a token — verified against the capture
  transport by asserting one message, its recipient, and that the link's token completes.
- Requesting a reset for an unknown address, for a deactivated account, and for a malformed address
  all answer **identically** to the success case — same status, same code, same body — and send no
  message; verified by asserting byte-equal payloads across all four and an empty capture file for
  the three that must not send. This is the enumeration rule sign-in already holds, and it is why
  the route cannot report success or failure honestly.
- Requesting a second reset revokes the outstanding one, so exactly one link works — verified by
  requesting twice, capturing both messages, and asserting the first token no longer completes and
  the second does.
- A second request inside the re-send interval answers identically but sends no second message —
  verified by requesting twice in succession and asserting one captured message
  ([assumption 6](#assumptions-to-confirm)).
- The reset window is 1 hour from issue — verified by asserting `expires_at` against the request
  time within tolerance, and by a unit test over the window constant.
- A transport failure answers with the same uniform payload and leaves no usable token behind —
  verified with a transport stubbed to fail, asserting the response is indistinguishable from
  success and that a later request still works.

**Completing**

- A held token previews the reset without a session, returning only the address it was mailed to —
  verified anonymously against the preview route, asserting the payload has no role, no id and no
  other account field.
- Setting a new password on a valid token changes the password and returns a session cookie —
  verified end to end by completing and then calling an authenticated route with the returned
  cookie, with no separate sign-in.
- The old password no longer signs in and the new one does — verified by attempting both after a
  completed reset.
- Completing a reset revokes **every other live session** for that account — verified by opening two
  sessions, resetting from a third context, and asserting both original cookies are refused on their
  next request ([assumption 5](#assumptions-to-confirm)).
- A token cannot be used twice — verified by replaying the same complete request and asserting a
  refusal, with the password unchanged from the first reset.
- An expired token is refused with a code distinct from an invalid one — verified by ageing a reset
  past its window, so the screen can say "expired" rather than "wrong".
- A revoked, unknown, malformed or empty token is refused cleanly rather than throwing — verified by
  sending each and asserting the error envelope, not a `500`.
- A password below the shipped rules is refused and the password is unchanged — verified by
  asserting the refusal and then signing in with the original password.
- A reset for an account deactivated between request and completion is refused — verified by
  deactivating in between, asserting the refusal and that no session is issued.
- No log line, error message or API payload contains a raw reset token — verified by a log-capture
  assertion across the full request → complete path, as step 3 does for invitations.
- Request and completion are each logged with actor, action, target and timestamp under the
  request's correlation id — verified by capturing logs across one of each, per
  [architecture.md § Cross-cutting concerns](../architecture.md#L271).
- The reset reads the *same* password-rules module the accept screen and the seed command read —
  verified by a test asserting an identical refusal sentence for the same input across all three
  paths, so the three cannot disagree about what a usable password is.

### Deactivation — [3.1.7](../prd.md#L49)

- An admin can deactivate an account and a member cannot — verified by exercising the route with a
  member session and asserting `forbidden`, per
  [implementation-plan.md § Standing constraints](../implementation-plan.md#L32).
- A deactivated account cannot sign in — verified by deactivating and then signing in with the
  correct password.
- The sign-in refusal for a deactivated account is a distinct code returned **only after the
  password verifies** — verified by asserting `invalid_credentials` for a wrong password against a
  deactivated account and the distinct code for the right one, so the response never tells an
  attacker that an address exists ([assumption 4](#assumptions-to-confirm)).
- Deactivating revokes every live session for that account immediately — verified by opening a
  session, deactivating, and asserting the next request with that cookie is refused. Not at the next
  expiry: this is the behaviour
  [slice-architecture.md § Data model (slice)](../slice-architecture.md#L229) says server-side
  sessions exist to make possible.
- A session that survives revocation by any route still cannot act — verified by leaving a `session`
  row live in the database and asserting `actorForToken` refuses because the account is deactivated.
  Belt and braces, because "no deactivated account acts" must not rest on remembering to revoke.
- A deactivated account cannot accept an invitation, complete a reset, or be issued one — verified
  per path.
- An admin can reactivate an account, after which it signs in again with its existing password —
  verified end to end ([assumption 8](#assumptions-to-confirm)).
- Deactivating an already-deactivated account, and reactivating an active one, are refused as a
  conflict rather than silently succeeding — verified per direction, so the admin console cannot
  report an action it did not take.
- Deactivation and reactivation are each logged with actor, action, target and timestamp — verified
  by log capture.

### The last-admin guard — [3.1.11](../prd.md#L53)

The invariant is **at least one active admin exists at all times**, and every requirement below is
asserted against the **API**, not an interface — it has to hold against a direct request
([slice-architecture.md § Next.js application — API half](../slice-architecture.md#L123)).

- Deactivating the last active admin is refused and the account stays active — verified with exactly
  one admin in the fixture, asserting the refusal code and re-reading the row.
- Demoting the last active admin to member is refused and the role is unchanged — verified the same
  way.
- The last active admin cannot deactivate or demote **themselves** — verified with the admin's own
  session, because the interface is not what stops this.
- A *deactivated* admin does not count toward the invariant — verified by seeding two admins,
  deactivating one, and asserting the second is then refused both deactivation and demotion.
- The guard permits the operation when another active admin exists — verified by seeding two admins
  and successfully deactivating and demoting one, so the guard is not a blanket refusal.
- The count is taken and the write applied so that two concurrent requests cannot both pass —
  verified by a concurrency test issuing two demotions of the two remaining admins at once and
  asserting exactly one succeeds and one active admin remains
  ([assumption 10](#assumptions-to-confirm)).
- A refused deactivation or demotion is logged as a refusal with actor, action and target — verified
  by log capture.

### Role change — [3.1.5](../prd.md#L47), and see [assumption 7](#assumptions-to-confirm)

- An admin can change another account's role, and the change takes effect on that account's **next
  request** without a re-sign-in — verified by promoting a member holding a live session and
  asserting an admin-only route then admits it. This is what step 2's per-request re-read bought.
- A member cannot change any role, including their own — verified with a member session against
  their own id and against another's.
- Only roles this product has are acceptable — verified by asserting `contributor` is refused as
  invalid input, in the same style as the invitation route.
- Setting an account to the role it already holds is a no-op reporting the current state rather than
  an error — verified by repeating a promotion.

### Profile: display name — [3.1.12](../prd.md#L54)

- A signed-in user can change their own display name, and the new name appears in the session
  payload on the next request — verified end to end.
- A user cannot change **another** user's display name, and neither can an admin — verified with
  both an admin and a member session against a different id, asserting `forbidden`. This is the
  first **ownership** rule, so it is refused by the policy module and not by the route
  ([assumption 2](#assumptions-to-confirm)).
- The refusal comes from `can` reading the resource — verified by a unit test over the policy module
  asserting the same `(actor, action)` answers `true` for the actor's own resource and `false` for
  another's, with no route involved.
- A display name that is empty, whitespace-only or over the length ceiling is refused and the stored
  name is unchanged — verified per case.
- A display name is stored as typed apart from trimming — verified by round-tripping a name with
  internal spacing and non-ASCII characters.
- No avatar field exists anywhere in the schema, the payloads or the screens — verified by asserting
  the column set and a source-level check, because [3.1.12](../prd.md#L54)'s avatar is deferred and
  a nullable column "for later" is how deferral quietly stops being deferral.

### The account listing — see [assumption 11](#assumptions-to-confirm)

- An admin can list accounts with display name, email, role and active/deactivated status, and a
  member cannot — verified over a fixture set covering both roles and both states.
- The listing carries no password hash and no token of any kind — verified by asserting the absence
  of both under any key, in the same style as the invitation listing.

### The refusal seam still holds

- The allowlist gains exactly the entries named in [assumption 3](#assumptions-to-confirm) and
  nothing else — verified by the existing filesystem-discovering sweep, which now has three more
  routes to subtract and must still fail against the unguarded fixture.
- Each new allowlisted route is reachable anonymously and carries no account content beyond the
  address the token was already mailed to — verified per entry.
- Every new authenticated route declares its access as `apiRoute`'s first argument — carried by the
  existing type-level guard; no new test needed, named here so it is not assumed away.

### The screens

- `/forgot-password` renders an email field and a submit, and any submission lands on the same
  neutral confirmation — verified by a browser-level test driving the form with a known and an
  unknown address and asserting identical screens.
- `/reset-password` renders the address as read-only context, a password field and a submit, and a
  valid submission lands the user on an authenticated view — verified by a browser-level test.
- An expired, revoked, used or unknown token shows a dead-end explanation with **no password
  field** — verified per state, asserting the field is absent so nobody types a new password into
  nothing.
- A rejected password shows the reason on the screen without a full page reload — verified by the
  same test.
- Both screens work at phone, tablet and desktop widths with no horizontal scroll — verified at
  three viewport widths, per
  [implementation-plan.md § Standing constraints](../implementation-plan.md#L32).
- Both forms are operable by keyboard alone and every field has a programmatic label — verified as
  in steps 2 and 3.
- The sign-in screen offers a route to `/forgot-password` — verified by the sign-in screen test,
  because a reset flow nobody can reach from where they failed is a flow that does not exist.
- No component declares a raw hex colour, pixel radius or ad-hoc spacing — the existing style-token
  guard, extended to the new stylesheets, with the reset email answered exactly as step 3's settled
  decision 9 answers the invitation email.

### The reset email

- It goes through the same `Mailer` port with no new transport — verified by the existing
  mail-boundary guard, which must still pass with a second message type.
- It is sent as HTML with a plain-text alternative, and the plain-text part contains the same reset
  link — verified by asserting both parts and extracting the link from the text part.
- Every literal colour in the template equals the token it copies — verified by the unit-test
  pattern step 3 established for `theme.ts`.
- It names no role and discloses nothing about the account beyond that a reset was requested —
  verified by asserting the rendered parts against a denylist of account fields.

---

## Feel requirements (manual-only) — approved before work starts

The admin half of this step has no interface again ([Step 5](../implementation-plan.md#L134) builds
it), so these are the reset journey, the reset mail, and the one moment a deactivated person meets
the product.

- **Reaching the reset from a failed sign-in feels like the obvious next move.** What to feel for:
  get your password wrong. The way out should already be on the screen — not something you go
  looking for, and not phrased as an admission that you have forgotten something.
- **The neutral confirmation reassures rather than stonewalls.** What to feel for: submit an address
  you know is wrong. The screen cannot tell you it was wrong — that is the security rule — so read
  what it *does* say. Does it feel like care ("if that address has an account, the link is on its
  way — check spam") or like a shrug? This is the one screen in the product that must be
  deliberately unhelpful, and it should not feel it.
- **The reset email reads as something you asked for, seconds ago.** What to feel for: open it on a
  phone. It should say plainly that someone asked to reset this account's password, how long the
  link lasts, and what to do if it was not you. One obvious thing to press. It should survive dark
  mode and images-off.
- **Setting a new password feels like finishing, not starting again.** What to feel for: press the
  link, type a password, submit. You should be inside in one motion, with no sign-in form between
  having a new password and using it, and no second where you cannot tell whether it took.
- **An expired reset link is a dead end that tells you what to do.** What to feel for: open one an
  hour late. It should say the link expired and offer to send another *from that screen* — not
  "invalid token", and not a form that will fail after you fill it in.
- **Being deactivated is explained, not stonewalled.** What to feel for: sign in with the right
  password to a deactivated account. You should learn the account is no longer active and who to
  ask — never a generic "wrong email or password" that sends a real person hunting for a typo that
  does not exist.
- **The last-admin refusal reads as a guardrail, not a bug.** What to feel for: exercise it over the
  API and read the message. It should say *why* — this is the only admin — so an operator
  immediately knows the fix is to promote someone first, rather than that the product is broken.

---

## Assumptions to confirm

Implementation does not start until these are settled. **3, 4, 5, 7 and 9 are the ones that
matter;** the rest are cheap defaults.

1. **A `password_reset` table, not a second life for `invitation`.** Assumed: its own table —
   `password_reset (id, user_id, token_hash, created_at, expires_at, used_at, revoked_at)`, unique
   on `token_hash`, `user_id` cascading. The two flows look alike and are not: an invitation is
   keyed by an *address with no account* and creates one; a reset is keyed by an *existing account*
   and changes it. Sharing a table means a nullable `user_id`, a `kind` column and two sets of rules
   in one place — which is the "reviewable entity abstraction"
   [implementation-plan.md § What this plan deliberately does not include](../implementation-plan.md#L372)
   rules out. Token shape is identical: 32 random bytes, base64url, SHA-256 at rest, the same
   `tokens.ts` helpers.

2. **`can` starts reading its resource, and ownership is the rule.** Assumed: `profile.update` is
   permitted when `resource.ownerId === actor.id`, evaluated **inside the policy module** — the rule
   table gains an optional ownership predicate per action rather than routes comparing ids. This is
   the first use of the parameter step 2 built ahead, and getting it wrong here is what would make
   every later owned resource compare ids at the call site. The alternative — a `/users/me`-only
   route with no id to check — is simpler today and does not generalise to a note or a highlight, so
   I would not take it.

3. **The allowlist gains three entries, where the architecture anticipated one.**
   [slice-architecture.md § Extension points](../slice-architecture.md#L339) says step 4 adds *one*.
   Assumed: **three** — `POST /api/v1/auth/password-reset` (request),
   `GET /api/v1/auth/password-reset` (preview), and
   `POST /api/v1/auth/password-reset/complete`. The preview is the same argument step 3 made and
   you accepted: it lets a dead link say "expired, ask for another" *before* somebody chooses a
   password, and it discloses only the address the token was already mailed to, to a caller already
   holding that token. The two-entry fallback is real and cheap — drop the preview, and the person
   learns the link is dead only after typing a new password. I think that is the wrong trade. It is
   worth noticing separately that this is the third consecutive step to grow the list: **seven
   entries after this one.** Every entry still holds the property the row protects, but the list is
   no longer short, and step 5 should add none.

4. **A deactivated account is told so — but only after the password verifies.** Assumed: sign-in
   verifies the password first; a wrong password against a deactivated account answers
   `invalid_credentials` exactly as any other wrong password, and only a **correct** password
   against a deactivated account gets the distinct `account_deactivated` code. There is no
   enumeration leak, because a caller who knows the password already knows the account exists. The
   alternative — one uniform refusal — is marginally safer and lies to a real person who is about to
   spend twenty minutes hunting for a typo and then email an admin anyway. Say if you want the
   uniform refusal instead; it is a one-line difference, and feel requirement 6 changes with it.

5. **Completing a reset revokes every other live session.** Assumed: yes — a reset is what somebody
   does when they think their password is known, and leaving alive the sessions it was used to open
   makes the reset cosmetic. The completing request gets a fresh session so the person is not signed
   out of the browser they are standing in. Cheap only because sessions are server-side rows.

6. **One live reset per account, and a re-send interval instead of a rate limiter.** Assumed:
   requesting a reset revokes any outstanding one, and a second request for the same address inside
   **60 seconds** answers identically but sends no second message. **Still no general rate
   limiting** — third step running, carried from step 2's assumption 10 and step 3's assumption 12.
   But it is worth naming that reset is a different exposure from accept: it is an unauthenticated
   route that causes **mail to be sent to an arbitrary address**, which is a nuisance vector and a
   billed one. The 60-second interval is a database check, not infrastructure, and it removes the
   cheapest version of that abuse. It is not a rate limiter and does not pretend to be.

7. **Role change ships here, guarded, rather than in step 5 unguarded.** As argued above. Assumed:
   `PATCH /api/v1/users/:id` carrying `role`, admin-only, with the last-admin guard on the demotion
   path. If you would rather step 5 own it, then [3.1.11](../prd.md#L53)'s demotion half is
   untestable this step and the guard ships half-covered — say so and I will plan it that way
   explicitly rather than leave it implied.

8. **Reactivation is included.** [3.1.7](../prd.md#L49) names only deactivation. Assumed: an admin
   can clear `deactivated_at`, because deactivation is a nullable timestamp and the inverse is the
   same write — and a console that can only ever disable accounts is one mis-click from a support
   ticket nobody can close. Cost is one route and one policy action.

9. **The two reset screens are composed from the style guide, not from a PNG.** Assumed: the step-2
   and step-3 carve-out extends to them. The files I would otherwise be asking for are
   `docs/design referencess png/pages/forgot-password.png` and `reset-password.png`. They `compose`
   from `sign-in.module.css` exactly as `accept-invitation.module.css` does, inventing no new
   component — a field, a button, an error line, a centred card, and the dead-end state the accept
   screen already established.

10. **The last-admin guard is enforced in the write, not around it.** Assumed: the deactivation and
    demotion writes are conditional — applied only where the resulting count of active admins is at
    least one, evaluated in the same statement — rather than a `SELECT count(*)` followed by an
    `UPDATE`. Read-then-write has a window in which two admins demote each other and both succeed,
    and this is an invariant with no way back once broken: nobody left can promote anyone. The
    concurrency test above is what makes the difference observable.

11. **The account listing lands here, not in step 5.** Same reasoning step 3's assumption 11 used
    and you accepted: [Step 5](../implementation-plan.md#L134) is "the UI over steps 3 and 4", so
    the query belongs to the step that owns the data and step 5 renders it.

12. **Profile editing is API-only this step.** There is no console and no navigation until
    [Step 5](../implementation-plan.md#L134), and the only authenticated screen is step 2's
    placeholder. Assumed: display-name editing is exercised over the API only, and step 5 renders
    the profile panel — consistent with how step 3 left its admin half. Overrule it if you want a
    `/profile` screen now; it is one small screen and one more feel requirement.

13. **`displayNameFor` stays.** Step 3 derives a display name from the invited address as a
    placeholder "until step 4 ships profile editing". Assumed: it stays as the *initial* value and
    this step adds the ability to change it — accept still asks for one field, because asking an
    invitee for a name before they have an account is the exam step 3 deliberately avoided.

---

## Scope

**In:** the `deactivated_at` column and the `password_reset` table with their migration; the reset
request / preview / complete flow with its 1-hour window, re-send interval and uniform
enumeration-proof response; the reset email template and its plain-text alternative; the three
allowlist edits; session revocation on reset and on deactivation; the deactivated check in
`actorForToken` and in sign-in; admin deactivate and reactivate; the role-change route; the
last-admin guard as a conditional write covering both deactivation and demotion; self-service
display-name editing with the policy module's first ownership rule; the admin account-listing query;
the `/forgot-password` and `/reset-password` screens with their dead ends; the link to reset from
the sign-in screen; gate logging for every transition above; new error codes and shared payload
types.

**Out:** the admin console and any interface for listing accounts, deactivating, reactivating or
changing a role ([Step 5](../implementation-plan.md#L134)) — the admin half of this step is
exercised over the API only, as step 3's was. Self-service account **deletion**
([3.1.8](../prd.md#L50)) and the content rules that follow it
([3.1.9](../prd.md#L51)–[3.1.10](../prd.md#L52)) — deactivation is not deletion, and deletion is not
in [slice-prd.md § In scope → 1](../slice-prd.md#L35). Avatars ([3.1.12](../prd.md#L54), explicitly
deferred by [implementation-plan.md § Step 4](../implementation-plan.md#L123)). Changing your own
password while signed in — no requirement asks for it, and reset covers the case that matters. Email
address changes. `preferred_playback_speed` (step 15). Any second factor, lockout, general rate
limiting or password-history rule. Bounce, complaint or delivery-status handling. `contributor` in
any form. Anything in
[slice-architecture.md § Deliberately deferred](../slice-architecture.md#L341).
