# Step 2 — Sessions and server-side authorisation

> Phase 6 artefact for [implementation-plan.md § Step 2](../implementation-plan.md#L95).
> Sections pulled: [slice-prd.md § In scope → 1](../slice-prd.md#L35);
> [3.1.1](../prd.md#L43), [3.1.2](../prd.md#L44), [3.1.5](../prd.md#L47);
> [slice-architecture.md § Data model (slice)](../slice-architecture.md#L193);
> [slice-architecture.md § Extension points](../slice-architecture.md#L323);
> [architecture.md § Cross-cutting concerns](../architecture.md#L271);
> [style-guide.md](../design%20referencess%20png/style-guide.md), standing in for the absent auth
> design reference by operator decision.

Two things in this step are structural rather than featural, and both are named as expensive to
skip. The **single `(actor, action, resource)` evaluation point** is one of the three structures
[slice-prd.md § Rationale](../slice-prd.md#L241) says makes this slice throwaway if missed. The
**enumerated unauthenticated allowlist** is what turns [3.1.2](../prd.md#L44) from a convention into
something a test can fail on. Everything else here — a form, a cookie, a hash — is ordinary.

## The sign-in screen: composed from the style guide, not from a PNG

Step 2 is the first step with a user-facing screen, and there is no auth PNG — no
`pages/sign-in.png`, and nothing in `top-navigation/*` showing sign-out. **The operator has ruled
that auth screens are designed from
[the style guide](../design%20referencess%20png/style-guide.md) instead**, which is a deliberate
carve-out from [CLAUDE.md § Designing pages](../../CLAUDE.md) for this step, not a precedent for
member-facing screens that do have references.

That makes the style guide the binding reference here, and it changes what "built from its design
reference" is checkable against: tokens, not pixels. Step 2 therefore also lands the **token layer**
every later screen will consume — the `:root` block from the guide's *Quick token block*, as CSS
custom properties in one file. This is the first and only time that layer is built; every screen
from Step 5 on reads it.

The guide specifies a search input, a pill tab, and three button shapes. It does **not** specify a
text field with a label, a form error, or a wide submit button. Those are extrapolated — see
assumption 9 for exactly how, so the extrapolation is reviewed here rather than discovered on screen.

## Requirements (test-covered)

**Accounts and passwords**

- The `user` table exists with `email`, `password_hash`, `display_name` and `role`, and `role` is a
  Postgres enum whose only values are `admin` and `member` — verified by a migration test asserting
  the column set and the enum's value list. `contributor` is simply absent; nothing asserts the
  database rejects it.
- Email is stored normalised and is unique regardless of the case it was typed in — verified by
  inserting `A@b.com` and asserting a second insert of `a@B.com` fails at the database, not in
  application code.
- A password is never stored or logged in plaintext — verified by asserting the persisted column is
  neither the input nor any encoding of it, plus a log-capture assertion that no line emitted during
  sign-in contains the submitted password.
- The same password hashed twice produces different stored values and both verify — verified by
  hashing one password twice and asserting inequality and mutual verification (proves per-password
  salting).
- Verifying a wrong password fails and verifying the right one succeeds against a hash produced by
  the shipped parameters — verified by a unit test over the hash module.

**Sessions**

- A correct email and password establishes a session and returns an HTTP-only cookie — verified by
  an integration test asserting the `Set-Cookie` flags are `HttpOnly`, `SameSite`, `Path=/` and
  `Secure` outside development, and that the cookie value is not the user id, email or role.
- A session cookie authenticates a subsequent request to a protected route — verified by signing in
  and re-using the cookie against a route that requires a session.
- Wrong password, unknown email and malformed input all fail identically to the caller — verified by
  asserting the same status, the same error code and the same message across all three, so the
  response never discloses whether an address has an account.
- Sign-out invalidates the session server-side, not only in the browser — verified by capturing the
  cookie, signing out, then replaying the *same captured cookie* and asserting refusal.
- An expired session is refused — verified by ageing a session past its window in the database and
  asserting the next request fails with the session error code.
- A tampered or forged cookie value is refused and does not throw — verified by sending a mutated
  cookie and asserting a clean refusal in the error envelope rather than a `500`.
- The session record does not store the raw token — verified by asserting the stored value differs
  from the cookie value and that a lookup by raw token finds nothing.
- Role and account state are read per request rather than trusted from the cookie — verified by
  changing a signed-in user's role directly in the database and asserting the next request is
  evaluated under the new role with no re-sign-in.

**The refusal seam** — the checkable half of [3.1.2](../prd.md#L44)

- **Every `/api/v1` route not on the allowlist refuses an anonymous request** — verified by a sweep
  test that *discovers* routes from the filesystem (every `route.ts` under `src/app/api/v1`, every
  HTTP method it exports), subtracts the allowlist, and asserts each remaining route and method
  answers an anonymous request with the unauthenticated error envelope. A hand-maintained list of
  routes to check would re-introduce exactly the review dependency this requirement removes.
- The allowlist is a single named, exported constant — verified by the sweep test importing that
  constant as its only source of exceptions, so adding a public route is an edit to one list.
- Each allowlisted route is reachable anonymously — verified per entry, so the list cannot rot into
  names of routes that no longer exist or already require a session.
- The sweep test fails when deliberately violated — verified by a fixture route declared without
  authorisation and an assertion that the sweep reports it. A guard nobody has seen fail is not a
  guard, the same rule [Step 1](01-project-skeleton.md) applied to the import boundary.
- An unknown path under `/api/v1` refuses an anonymous caller before deciding it does not exist —
  verified by asserting an anonymous request to a nonexistent route returns the unauthenticated
  code, not `not_found`, so route existence is not probeable without a session.
- A route cannot be defined without stating its access — verified by a typecheck-level fixture
  asserting the route wrapper does not compile without the access argument. This is what "refused by
  construction rather than by review" has to mean to be worth anything.

**The policy module**

- All authorisation decisions resolve through one module — verified by a source-level check that no
  module outside it reads `user.role` or compares against a role literal, in the same style as
  Step 1's import-boundary guard.
- The module answers `(actor, action, resource)` and denies by default — verified by asserting an
  unknown action denies rather than throws or permits.
- An admin-only action is permitted for `admin` and refused for `member`, and the refusal is the
  API's, not the client's — verified over a diagnostic admin-only route exercised with each role.
- A refusal for an authenticated caller is distinguishable from a refusal for an anonymous one —
  verified by asserting distinct error codes for unauthenticated and forbidden, since
  [architecture.md § Cross-cutting concerns](../architecture.md#L271) makes error types part of the
  contract.
- Adding a role to the enum does not compile until every policy case handles it — verified by an
  exhaustiveness fixture, which is the property that makes Contributor "one enum value plus four
  widened cases" ([slice-architecture.md § Extension points](../slice-architecture.md#L323)) rather
  than a search of the codebase.
- Every authorisation refusal is logged with actor, action, target and timestamp under the request's
  correlation id — verified by capturing logs across one refused request.

**The sign-in screen and the token layer**

- Every colour, radius, spacing and type value in the guide's *Quick token block* exists as a CSS
  custom property in one file — verified by a test asserting the token names and values in that file
  match the guide's block exactly, so the two cannot drift silently.
- No component declares a raw hex colour, a pixel radius or an ad-hoc spacing value — verified by a
  source-level check over the stylesheets failing on any literal that a token already covers, in the
  same style as Step 1's import-boundary guard. This is the check that makes "built from the style
  guide" mean something once there is no PNG to compare against.
- The sign-in screen renders email, password and submit, and submitting valid credentials lands the
  user on an authenticated view — verified by a browser-level test driving the form.
- A failed sign-in shows the failure on the screen without clearing the email field and without a
  full page reload — verified by the same test asserting the field's value survives and the error
  text is present.
- The screen works at phone, tablet and desktop widths with no horizontal scroll — verified at three
  viewport widths, per the responsive standing constraint of
  [implementation-plan.md § Standing constraints](../implementation-plan.md#L32).
- Sign-out is reachable from an authenticated view and returns the user to sign-in — verified by the
  browser-level test.
- The form is operable by keyboard alone and each field has a programmatic label — verified by a
  test tabbing to submit and asserting accessible names, since the guide's `--color-text-dim`
  placeholders are not labels.

**The seeded first admin**

- A documented command creates the first admin from configuration and that account can sign in —
  verified by an integration test running the command against a fresh database and then signing in.
- Running it twice does not create a duplicate or silently reset the existing password — verified by
  running it twice and asserting one row and an unchanged hash.
- It refuses to run with a weak or absent password rather than seeding a guessable account —
  verified by asserting a non-zero exit and no row created.

## Feel requirements (manual-only) — approved before work starts

The sign-in surface is the first thing anyone sees, and with no PNG to compare it against, these
carry more weight than usual — they are most of what "does it look right" means for this screen.

- **It looks like the rest of the product will.** What to feel for: put the sign-in screen next to
  `pages/dashboard.png` and `pages/player.png`. Same near-black navy, same one purple, same airy
  padding, same rounded-and-outlined feel. Anything that reads as a different product — a lighter
  card, a second accent, a shadow — is the thing to catch.
- **Being refused feels like a plain answer, not an accusation.** What to feel for: type a wrong
  password. The message should tell you what to do next in one line, keep what you typed in the
  email field, and not read as though you did something suspicious.
- **Signing in feels like one action, not a submit-and-wait.** What to feel for: press enter and
  watch. Is there any moment where you do not know whether it took? Does the button visibly commit,
  and does a double-press do anything?
- **The session is invisible until it ends.** What to feel for: navigate, refresh, close the tab and
  come back. You should never be asked to sign in again inside a working session, and you should
  never wonder whether you are still signed in.
- **Signing out is immediate and complete.** What to feel for: sign out, then press the browser back
  button. Nothing that required a session should still be on screen.

## Assumptions to confirm

Implementation does not start until these are settled. **1, 2 and 9 are the ones that matter**; the
rest are cheap defaults.

1. **The allowlist has two entries in this step, not one.**
   [slice-architecture.md § Extension points](../slice-architecture.md#L323) names
   `GET /api/v1/health` as the *only* unauthenticated route. Taken literally that is not
   satisfiable: **the sign-in route cannot require a session.** Assumed: the allowlist ships as
   `GET /api/v1/health` and `POST /api/v1/auth/session`, and that architecture row is amended to say
   "no unauthenticated route *carrying content*" — the property it was actually protecting. Step 3
   (invitation accept) and Step 4 (password reset) each add an entry, and each addition is a
   deliberate edit to that named list, which is the seam working as designed rather than eroding.
2. **Sessions are server-side records, not signed stateless tokens.** Assumed: a `session` table
   (`id`, `user_id`, `token_hash`, `created_at`, `expires_at`, `revoked_at`), an opaque random token
   in the cookie, and only its hash stored. This is what makes sign-out real (requirement above) and
   what lets Step 4's deactivation ([3.1.7](../prd.md#L49)) end a live session instead of waiting
   for an expiry. A stateless token makes both unbuildable without a revocation list, which is the
   session table with extra steps. `session` is therefore an addition to
   [slice-architecture.md § Data model (slice)](../slice-architecture.md#L193), which lists no such
   table — confirm it or overrule it now.
3. **Session lifetime.** Nothing in the PRD or slice architecture fixes one. Assumed: 30 days
   rolling, refreshed on use, on the reading that this is a personal-device teaching library and
   being logged out weekly is friction with no security case behind it.
4. **Password hashing.** Assumed: **argon2id** via `@node-rs/argon2` (prebuilt binaries, no node-gyp
   on the deploy host), with parameters tuned to roughly 100 ms on the target
   [netcup VPS](../architecture.md#L343) — a box that also runs Postgres and the worker, so the
   parameters are a real budget rather than a copied default. bcrypt is the fallback if the native
   package proves awkward.
5. **`user` columns arrive with the steps that use them.** Assumed: this step ships `email`,
   `password_hash`, `display_name`, `role`, `created_at`, `updated_at` only. `deactivated_at` comes
   with Step 4, `preferred_playback_speed` with Step 15 — the same rule Step 1 set for tables.
6. **The first admin is seeded by a command, not by a migration.** Assumed: an idempotent CLI
   reading email, display name and password from environment, so no credential is ever committed in
   a migration file. Running it in production is deployment work and belongs to
   [Step 21](../implementation-plan.md#L341).
7. **Sign-in and sign-out are one resource.** Assumed: `POST /api/v1/auth/session` signs in,
   `DELETE /api/v1/auth/session` signs out, `GET /api/v1/auth/session` returns the current user for
   the client to render with — the last being how the client learns what to hide without holding a
   decision.
8. **The `/api/v1/diagnostics/*` routes become authenticated.**
   [slice-architecture.md § Extension points](../slice-architecture.md#L323) is explicit that they
   are not an exception. Assumed: they require a session like everything else, and Step 1's
   integration tests gain a sign-in helper. Consequence worth stating plainly: **Step 1's suite
   changes in this step**, which is expected, not a regression.
9. **What the style guide does not specify, and what I will do about it.** *Settled that auth
   screens come from the guide;* these four extrapolations are what that leaves open. Each is a
   reading of an existing rule rather than a new invention, and each is cheap to change on sight.
   - **Text fields** follow `.search` — `--color-surface-raised` fill, 1px `--color-border` — but
     take `--radius-sm` rather than the search pill's `--radius-pill`, because the guide assigns
     `--radius-sm` to "small tiles, inputs" and the pill to tabs and search specifically.
   - **The submit button** is the screen's one solid fill (`--color-primary`), full-width, at
     `--radius-sm`. The guide's only filled button is the circular play control, so "solid fills are
     reserved for the one primary action on screen" is the rule being applied, not the shape.
   - **Field labels** are `--fs-meta` in `--color-text-muted`, above the field. Placeholder-only
     labelling is rejected — `--color-text-dim` on a dark field is too faint to carry the meaning,
     and it fails the keyboard/accessible-name requirement above.
   - **The error message** sits under the field in `--fs-body`. The guide has **no error colour**;
     red would be the second accent principle 1 forbids. Assumed: `--color-text` at full weight
     with the field's border switched to `--color-border-strong`, so the error reads by emphasis
     rather than by hue. **This is the one I would most expect you to overrule** — say the word and
     it becomes a named `--color-danger` added to the guide.
   - The **layout** is a single centred card on `--color-bg` using the `.card` recipe, which is the
     only container pattern the guide defines.
10. **No rate limiting or account lockout in this step.** Neither appears in [§3.1](../prd.md#L31)
    and neither has a named home in a later step. Assumed out of scope, with the cheap parts kept
    regardless: constant-time comparison and identical failure responses. Say so if you want it in —
    it is a scope decision, not something to add in passing.

## Scope

**In:** the `user` and `session` tables and their migration; the password hash module; sign-in,
sign-out and current-user routes; the HTTP-only cookie and its server-side session record; the
policy module and its `(actor, action, resource)` evaluation; the route-wrapper change that makes
access a required argument; the enumerated allowlist and the filesystem-discovering sweep test that
enforces it; refusal logging under the correlation id; the seed-admin command; the sign-in helper
Step 1's now-authenticated diagnostics tests need; the CSS token layer built from
[the style guide](../design%20referencess%20png/style-guide.md); and the sign-in screen and a
sign-out control composed from those tokens.

**Out:** invitations, accept, revoke, resend (Step 3). Password reset, deactivation, the last-admin
guard ([3.1.11](../prd.md#L53)) and profile editing (Step 4) — note the last-admin invariant belongs
at the data layer per [architecture.md § Cross-cutting concerns](../architecture.md#L271), so it is
not a policy case this step should anticipate. Admin console and user management (Step 5). Any email
sending. `contributor` in any form. Rate limiting, lockout, 2FA, remember-me, session listing or
"sign out everywhere". Any screen other than sign-in — no dashboard, no navigation chrome, no
component library beyond the two or three elements sign-in actually needs; the tokens land now, the
components land with the screens that need them. Nothing from
[slice-architecture.md § Deliberately deferred](../slice-architecture.md#L341).

---

## Settled during implementation

Written after the code, so the next reader sees what the assumptions above actually became.

**Assumptions taken as written.** 1 (two allowlist entries), 2 (server-side `session` table), 3
(30 days rolling, refreshed at most hourly on use), 5 (`user` columns for this step only), 6
(seed command, not migration), 7 (one auth resource, three methods), 8 (diagnostics become
authenticated), 10 (no rate limiting or lockout; constant-time comparison and identical failures
kept). Assumption 9's four extrapolations shipped as described, including **the error line reading
by emphasis rather than by hue** — no `--color-danger` was added, and that remains the one most
worth overruling on sight.

**Assumption 4 settled with numbers.** argon2id via `@node-rs/argon2`, **64 MiB / 3 passes / 1
lane**. Measured at ~30 ms on the development machine; the ceiling was chosen as memory the target
host can spare while also running Postgres and the worker, not as a copied default. bcrypt was not
needed — the prebuilt binary installed without a toolchain.

**Two documents were amended**, both named in the assumptions as needing it:

- [slice-architecture.md § Data model (slice)](../slice-architecture.md#L193) gains `session`.
- [slice-architecture.md § Extension points](../slice-architecture.md#L323) — the unauthenticated
  surface is now "no route carrying content", with two entries; and the allowlist lives in the
  **route wrapper** rather than a separate middleware, because only the wrapper can make access a
  required argument. A middleware cannot refuse to compile.

**Three decisions the plan did not anticipate.**

1. **The negative control for the sweep is a real route.**
   `/api/v1/diagnostics/unguarded` is written *without* `apiRoute` — the one case the required-access
   argument cannot catch, since a route that never calls the wrapper never has to state anything. It
   answers `200` anonymously only when the request carries a fixture header *and* the diagnostics
   routes are enabled, so the sweep passes against the running server and the same sweep, re-run with
   that header, has something real to catch.
2. **The integration harness picks the primary server's port before the build.**
   `NEXT_PUBLIC_API_ORIGIN` is inlined into the client bundle at build time and the browser suite
   drives that bundle for real; the client has no same-host fallback by design
   ([5.2.2](../prd.md#L706)), so the origin has to be right at build time rather than at start.
3. **`Secure` is set everywhere except `next dev`**, not "in production". The suites run the
   production build over `http://127.0.0.1`, which browsers treat as a secure context, so the flag
   is under test rather than switched off for testing.

**Three defects the new guards found before review did**, each now covered by a test:

- `decodeURIComponent` on a malformed cookie value (`thp_session=%%%`) threw, turning a refusal into
  a `500`.
- The domain-declaration guard read `import { type Role }` as a *declaration* of `Role`, so every
  consumer of the shared vocabulary was reported as duplicating it.
- The import-boundary guard read an API path named in a doc comment as a hardcoded path.

**Deliberately still absent.** Invitations, reset, deactivation, the last-admin guard, the admin
console, any email, `contributor`, rate limiting, lockout, 2FA, remember-me, session listing, and
every screen with a design reference. The authenticated landing at `/` is three lines and a sign-out
control; `pages/dashboard.png` replaces it whole.
