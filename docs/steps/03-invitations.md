# Step 3 — Invitations: issue, accept, revoke, resend

> Phase 6 artefact for [implementation-plan.md § Step 3](../implementation-plan.md#L111).
> Sections pulled: [3.1.3](../prd.md#L45); [3.1.4](../prd.md#L46);
> [slice-prd.md § Slice flows → A](../slice-prd.md#L212);
> [slice-architecture.md § Data model (slice) → Accounts](../slice-architecture.md#L229);
> [slice-architecture.md § Key choices → Two inputs](../slice-architecture.md#L270), item 1.
> Carried from step 2 because this step edits them:
> [slice-architecture.md § Extension points](../slice-architecture.md#L323) (the allowlist) and
> [architecture.md § Cross-cutting concerns](../architecture.md#L271) (gate logging).

This is the first step that hands a token to someone who is not signed in, and the first that
depends on a third party for a flow to complete at all. Two things follow. **The unauthenticated
surface grows** — deliberately, by editing the named list, which is the seam
[step 2](02-sessions-and-authorisation.md) built for exactly this. And **the mail adapter is a port
before it is a provider**, because [architecture.md § Estimated running
costs](../architecture.md#L343) budgets "a few dozen/month" and names no vendor — see assumption 1.

Everything else here is ordinary: a table, a hashed token, four routes and one screen.

## The accept screen has no design reference

Step 3's only user-facing screen is where an invitee sets a password. There is no
`docs/design referencess png/pages/accept-invitation.png`, and none of the existing PNGs show it.
Under [CLAUDE.md § Designing pages](../../CLAUDE.md) that is a stop-and-ask — so it is
**assumption 8**, proposing the same carve-out step 2 already received: auth screens are composed
from [the style guide](../design%20referencess%20png/style-guide.md), on the token layer step 2
landed. The invitation **email** is a second designed surface with no reference and its own
constraint (assumption 9): email clients cannot read CSS custom properties, so it is the one place
the style-token guard has to be answered rather than obeyed.

## Requirements (test-covered)

**The `invitation` table**

- `invitation` exists with `email`, `role`, `token_hash`, `expires_at`, `revoked_at`,
  `accepted_at`, plus `id`, `invited_by` and `created_at` — verified by a migration test asserting
  the column set, and that `role` uses the existing `user_role` enum rather than a second copy of
  it.
- Email is stored normalised and at most one *live* invitation can exist per address — verified by
  inserting a live invitation for `A@b.com` and asserting a second insert for `a@B.com` fails at the
  database, while an insert succeeds once the first is revoked or accepted.
- The raw token is never stored — verified by asserting the persisted value differs from the issued
  token and that a lookup by raw token finds nothing, in the same style as `session`.
- An invitation to an address that already has an account is refused — verified by seeding a user
  and asserting the issue route refuses with a distinct error code rather than creating a row.

**Issuing** — [3.1.3](../prd.md#L45)

- An admin can invite an email with a role, and the response reports the pending invitation without
  the token — verified by an integration test asserting the payload carries `email`, `role`,
  `expiresAt` and `status`, and contains no token or hash under any key.
- A member cannot issue, revoke, resend or list invitations, and the refusal is the API's — verified
  by exercising every route with a member session and asserting `forbidden` on each.
- Issuing sends exactly one message, to the invited address, containing a link to the accept screen
  carrying the token — verified against the capture transport (assumption 2) by asserting one
  message, its recipient, and that the link's token accepts.
- The invitation expires 7 days from issue — verified by asserting `expires_at` against the issue
  time within tolerance, and by a unit test over the window constant.
- Only `admin` and `member` are acceptable roles — verified by asserting a request naming
  `contributor` is refused as invalid input.
- Issue, accept, revoke and resend are each logged with actor, action, target and timestamp under
  the request's correlation id — verified by capturing logs across one of each, per
  [architecture.md § Cross-cutting concerns](../architecture.md#L271).
- No log line, error message or API payload contains a raw invitation token — verified by a
  log-capture assertion across the full issue → accept path.

**Accepting** — [3.1.3](../prd.md#L45), and the two allowlist entries

- A held token previews the invitation without a session, returning the invited email and role and
  nothing else — verified anonymously against the preview route, asserting the payload has no other
  account fields.
- Setting a password on a valid token creates the account with the invited email and role, and
  returns a session cookie — verified end to end by accepting and then calling an authenticated
  route with the returned cookie, with no separate sign-in.
- The created account's password verifies and the invitation is marked accepted — verified by
  signing in fresh with the chosen password and asserting `accepted_at` is set.
- A token cannot be accepted twice — verified by replaying the same accept request and asserting a
  refusal, with exactly one `user` row for that email.
- An expired token is refused with a code distinct from an invalid one — verified by ageing an
  invitation past its window and asserting the expired code, so the screen can say "expired" rather
  than "wrong".
- A revoked token is refused — verified by revoking then accepting.
- An unknown, malformed or empty token is refused cleanly rather than throwing — verified by sending
  each and asserting the error envelope, not a `500` (the same defect class step 2's cookie decoding
  produced).
- A password below the shipped minimum is refused and no account is created — verified by asserting
  the refusal and an empty `user` table for that email.
- Accepting when the address has since gained an account is refused — verified by seeding a user
  between issue and accept.

**Revoke and resend** — [3.1.4](../prd.md#L46)

- An admin can revoke a pending invitation, after which its token no longer accepts — verified by
  revoking and then attempting to accept.
- Resend issues a fresh token and revokes the old one — verified by capturing both messages,
  asserting the tokens differ, that the **old** token no longer accepts, and that the new one does.
- Resend restarts the 7-day window — verified by asserting the new `expires_at` moves forward.
- Neither revoke nor resend is possible after acceptance — verified by accepting and then attempting
  each, asserting a refusal and that the accepted invitation is unchanged.
- An admin can list pending invitations with their status and expiry, and the listing carries no
  tokens — verified over a fixture set covering pending, expired, revoked and accepted.

**The mail port**

- Every outbound message goes through one module — verified by a source-level check that nothing
  outside it imports the mail transport, in the same style as step 1's import-boundary guard.
- A send failure leaves the invitation in place and reports a distinct, retryable failure — verified
  by a transport stubbed to fail, asserting the row exists, the caller sees the retryable code, and
  a resend then succeeds.
- The message is sent as HTML with a plain-text alternative, and the plain-text part contains the
  same accept link — verified by asserting both parts and extracting the link from the text part.

**The accept screen**

- The screen renders the invited email as read-only context, a password field and a submit, and a
  valid submission lands the user on an authenticated view — verified by a browser-level test
  driving the form.
- An expired, revoked or unknown token shows a dead-end explanation with no password field —
  verified per state, asserting the field is absent so nobody types a password into nothing.
- A rejected password shows the reason on the screen without a full page reload — verified by the
  same test.
- The screen works at phone, tablet and desktop widths with no horizontal scroll — verified at three
  viewport widths, per
  [implementation-plan.md § Standing constraints](../implementation-plan.md#L32).
- The form is operable by keyboard alone and every field has a programmatic label — verified as in
  step 2.
- No component declares a raw hex colour, pixel radius or ad-hoc spacing — the existing style-token
  guard, extended to the new stylesheets and answered for the email template per assumption 9.

**The refusal seam still holds**

- The allowlist gains exactly the entries named in assumption 3 and nothing else — verified by the
  existing filesystem-discovering sweep, which now has two more routes to subtract and must still
  fail against the unguarded fixture.
- Each new allowlisted route is reachable anonymously and carries no account content beyond the
  invited address — verified per entry.

## Feel requirements (manual-only) — approved before work starts

The admin half of this step has no interface yet ([Step 5](../implementation-plan.md#L134) builds
it), so these are the invitee's path and the email — which is the first thing this product ever
sends to a person.

- **The email reads like an invitation, not a system notification.** What to feel for: open it in a
  real client, on a phone. Does it say who invited you and what this is, in a sentence you would
  actually write? Is there exactly one obvious thing to press? Does it survive dark mode and
  images-off without becoming a wall of blue links?
- **Arriving from the mail feels like continuing, not starting over.** What to feel for: press the
  link. You should see your own address and know immediately that you are one field away from being
  in — never a screen that looks like the sign-in page and asks you to remember something.
- **Choosing a password feels like a decision, not an exam.** What to feel for: type something too
  short. The rule should be visible before you fail it, and failing it should not clear the field or
  read as a scolding.
- **Accepting lands you inside in one motion.** What to feel for: submit. There should be no moment
  where you have an account but are looking at a sign-in form, and no second where you cannot tell
  whether it took.
- **A dead invitation is a dead end that tells you what to do.** What to feel for: open an expired
  link. It should say the invitation expired and that an admin can send a new one — not "invalid
  token", and not a form that will fail when you fill it in.

## Settled before implementation

Confirmed by the operator at the start of the build. The rest were taken as written.

| # | Decision |
| :-- | :--- |
| 1 | **Resend, over SMTP.** The adapter names no vendor; `.env.example` ships `smtp.resend.com:465`, user `resend`, password an API key. The README carries the deliverability caveat: the `MAIL_FROM` domain must be verified with SPF and DKIM, and nothing in the application can detect that it is not. |
| 3 | **Two allowlist entries**, as proposed — `GET` and `POST /api/v1/invitations/accept`. The preview is what lets a dead link say "expired" before anybody chooses a password. |
| 8 | **The step-2 carve-out extends to the accept screen.** Composed from the style guide; its card, field, button and error line `composes` from `sign-in.module.css` rather than restating them, so the four extrapolations documented there are stated once. |
| 9 | **The email template inlines literal token values** from `server/mail/theme.ts`, the only file allowed to spell a colour out. A unit test asserts every value equals the token it copies, and the source-colour guard exempts that one path **by name**. |

## Assumptions to confirm

Implementation does not start until these are settled. **1, 3, 8 and 9 are the ones that matter;**
the rest are cheap defaults.

1. **The email provider — the one genuine vendor decision in this step.** Nothing in the PRD or
   either architecture names one; [architecture.md § Estimated running
   costs](../architecture.md#L343) budgets $0 at launch, $15 at scale for "a few dozen/month".
   Assumed: **a `Mailer` port with one SMTP adapter (`nodemailer`)**, configured by `MAIL_*`
   environment variables, on the reasoning that SMTP is the one interface every candidate speaks —
   so choosing between Resend, Postmark, Fastmail or a self-hosted relay becomes a change of four
   env values rather than a change of code, and it matches the self-hosting posture the rest of this
   slice took. The alternative is committing now to one vendor's HTTP API. **Say which provider you
   intend to actually use** even if the adapter stays SMTP, because it decides what goes in
   `.env.example` and what the deliverability caveat in the README says.
2. **How tests and development observe an outgoing mail.** Assumed: a second transport, `capture`,
   selected by `MAIL_TRANSPORT=capture`, appending each message to a JSON-lines file under a
   gitignored path. Integration tests read it; in development the developer opens the captured HTML
   in a browser, which is what makes feel requirement 1 checkable. **No Mailpit container** — that
   is infrastructure for something a file already does, and this project does not add infrastructure
   by reflex. Overrule it if you want to eyeball real rendering in a real client during development.
3. **The allowlist gains two entries this step, not one.**
   [slice-architecture.md § Extension points](../slice-architecture.md#L323) anticipates step 3
   adding *one*. Assumed: **two** — `GET /api/v1/invitations/accept` (preview) and
   `POST /api/v1/invitations/accept`. The preview is what lets an expired link say "expired" before
   someone chooses a password, and it discloses only the address the token was mailed to. Neither
   carries account content beyond that, so the property the row protects holds. The one-entry
   fallback is real and cheap: drop the preview, and the invitee learns the invitation is dead only
   after submitting a password. I think that is the wrong trade, but it is yours.
4. **Invitation token shape.** Assumed: 32 random bytes, base64url, SHA-256 hashed at rest —
   identical to the session token, for the same reasons and with the same helpers.
5. **At most one live invitation per address, enforced at the database.** Assumed: a partial unique
   index on `lower(email)` where `revoked_at is null and accepted_at is null`, mirroring the
   `user.email` precedent. Consequence: inviting an address that already has a pending invitation is
   refused with a message pointing at resend, rather than quietly creating a second live token.
6. **Accepting signs you in.** [slice-prd.md § Slice flows → A](../slice-prd.md#L212) says the
   invitee "sets a password → signs in and lands on the library". Assumed: accept issues a session
   in the same response, so there is no sign-in form between the two. (The library does not exist
   yet; the landing is step 2's authenticated placeholder.)
7. **A send failure does not destroy the invitation.** Assumed: the row is written, then the message
   is sent; a transport failure returns `service_unavailable` and leaves the invitation pending and
   resendable. The alternative — roll back on send failure — loses the record of an intent the admin
   already expressed, and resend exists precisely for this.
8. **The accept screen is composed from the style guide, not from a PNG.** Assumed: the step-2
   carve-out extends to it, since it is an auth screen and the token layer already exists. The file
   I would otherwise be asking for is
   `docs/design referencess png/pages/accept-invitation.png`. It reuses step 2's field, button,
   error line and centred-card recipes unchanged — this step invents no new component.
9. **The email template cannot use tokens, so it uses their values.** Email clients do not support
   CSS custom properties, and several strip `<style>` blocks entirely. Assumed: the template is
   mostly-text, inline-styled with the *literal values* from the guide's *Quick token block*,
   generated from the same source the token layer reads so the two cannot drift — and the
   style-token guard exempts that one file by name rather than by pattern. This is the only place in
   the codebase allowed a literal colour, and it should be the only one.
10. **Password rules are set here and reused by step 4.** Nothing in [§3.1](../prd.md#L31) states
    one. Assumed: the same minimum the seed-admin command already enforces, extracted into one
    shared module so the invite-accept screen, the seed command and step 4's reset cannot disagree.
11. **The listing route lands here, not in step 5.**
    [implementation-plan.md § Step 5](../implementation-plan.md#L134) is described as "the UI over
    steps 3 and 4", so the pending-invitations *query* belongs to this step and step 5 renders it.
12. **No rate limiting, still.** Carried from step 2's assumption 10 — neither the accept routes nor
    the issue route are throttled, and no lockout exists. Constant-time comparison and uniform
    failures are kept. This is the second step where it is worth a deliberate "still no", because
    accept is now an unauthenticated route that takes a guess.

## Scope

**In:** the `invitation` table and its migration; the token module; the `Mailer` port with an SMTP
adapter and a capture transport; the invitation email template and its plain-text alternative; the
issue, list, revoke and resend routes with their admin-only policy actions; the two public accept
routes and the allowlist edits that permit them; the shared password-rules module; the
accept-invitation screen and its expired/revoked/unknown dead ends; gate logging for all four
transitions; `.env.example` and README entries for the mail configuration.

**Out:** the admin console and any interface for issuing, listing, revoking or resending
([Step 5](../implementation-plan.md#L134)) — the admin half of this step is exercised over the API
only. Password reset ([3.1.6](../prd.md#L48)), deactivation, the last-admin guard
([3.1.11](../prd.md#L53)) and profile editing ([Step 4](../implementation-plan.md#L123)). Changing
an existing user's role ([3.1.5](../prd.md#L47)) — an invitation is for an address with no account.
Any email other than the invitation: no reset mail until step 4, no summary-ready notification
([§3.17](../prd.md#L361) is deferred), no digests. Bounce, complaint or delivery-status handling.
Magic-link or passwordless sign-in. Bulk or CSV invitation. `contributor` in any form. Rate
limiting, lockout, 2FA. Anything in
[slice-architecture.md § Deliberately deferred](../slice-architecture.md#L341).
