# Ticket 5 — Admin console shell and user management

Sources pulled for this ticket, and nothing else:
[implementation plan § Ticket 5](docs/epics/epic-core-listening/implementation-plan.md#L134),
[epic prd § In scope → 7](docs/epics/epic-core-listening/prd.md#L146),
[3.19.9](docs/project/prd.md#L447), [3.19.1](docs/project/prd.md#L439),
[epic prd § Epic flows → A](docs/epics/epic-core-listening/prd.md#L210), and the standing constraints at
[implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L32).

This ticket writes **no new API**. Tickets 3 and 4 shipped all nine routes it drives — issue, list,
revoke and resend an invitation; list accounts, deactivate, reactivate, assign a role — and each is
already refused server-side by the policy module. Ticket 5 is the first operator interface over them,
and the last ticket of Story 1.

---

## The console has no design reference

`pages/dashboard.png` is the **member** dashboard — resume recording, view all series, my notes. It
is not this screen, and it belongs to [Ticket 13](docs/epics/epic-core-listening/implementation-plan.md#L257).
`top-navigation/menu-opened.png` lists four member destinations (Dashboard, All series, All
recordings, All chapters) and carries **no admin entry**, so it does not describe how the console is
reached either.

Under [CLAUDE.md § Designing pages](CLAUDE.md) a missing reference is a stop-and-ask, so it is
[assumption 1](#assumptions-to-confirm), proposing the same carve-out tickets 2, 3 and 4 received:
compose from [style-guide.md](docs/design%20referencess%20png/style-guide.md) and the token layer.
Two consequences worth stating up front, because they are the difference between a shell and a
rewrite:

- The **member top navigation is not built here.** It has references, it is member chrome, and it
  arrives with the member surface in Story 4. The console gets its own header.
- The shell is a **layout plus a panel list**, not a registry. One entry today. Later panels are a
  file and a line, which is all "the shell is where every later panel hangs" has to mean.

---

## Requirements (test-covered)

Test vehicle is the one tickets 2–4 established: Playwright against the same production build the API
suite drives, in `packages/web/tests/integration/admin-console.test.ts`, at phone (390), tablet
(768) and desktop (1440).

### The shell and its gate

- **`/admin` renders the console for an admin** — header, panel navigation, and the User management
  panel — verified by signing in as an admin and asserting the level-1 heading and the panel.
- **A member asking for `/admin` never sees it** — verified by signing in as a member, navigating to
  `/admin`, and asserting the browser ends up somewhere that is not the console, with no console
  markup having rendered. See [assumption 2](#assumptions-to-confirm) for *where* it ends up.
- **An anonymous request for `/admin` lands on sign-in** — verified with a fresh context and no
  cookie.
- **The gate is a render decision, not the authorisation** — verified by driving
  `GET /api/v1/users` directly from a member's session and asserting `forbidden`, so the refusal is
  demonstrably the API's and not the page's
  ([implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L32)).
- **The console is reachable without typing a URL** — an entry point rendered for admins only, and
  absent for members. See [assumption 3](#assumptions-to-confirm).
- **Nothing overflows horizontally at 390px** — verified by comparing `scrollWidth` to the viewport
  at each of the three widths, on a console populated with a long display name and a long address.

### Member list — [3.19.9](docs/project/prd.md#L447)

- **Every account is listed with name, address, role and whether it is active** — verified against a
  seeded set of admins and members, one of them deactivated.
- **A deactivated account is visibly distinct and says when** — `deactivatedAt` is already on
  `AccountSummary`; verified by asserting the deactivated row carries a state marker the active rows
  do not.
- **Order is stable and is the API's** — `listUsers` orders by `createdAt` ascending; verified that
  the rendered order matches the payload order rather than a re-sort in the client.
- **The list refreshes after a mutation** — verified by deactivating a row and asserting the row's
  state changes without a manual reload ([assumption 6](#assumptions-to-confirm)).

### Role assignment — [3.1.5](docs/project/prd.md#L47)

- **Changing a role updates the row** — verified by promoting a member and asserting both the
  rendered role and a re-fetched `GET /api/v1/users`.
- **Re-assigning the role an account already holds is not an error** — the API answers with the
  current state on purpose; verified that the console reports success rather than a failure.
- **Demoting the last active admin is refused and the reason is on screen** — verified against a
  database with exactly one admin, asserting the API's `last_admin` message text is rendered, not a
  generic failure.

### Deactivation and reactivation — [3.1.7](docs/project/prd.md#L49)

- **Deactivating takes a confirming press, and the confirmation names the account** — verified by
  asserting the first press changes nothing over the API and the second one does.
- **Reactivating restores the account** — verified by round-tripping one row and asserting `active`
  in a re-fetched listing.
- **Deactivating the last active admin is refused with the `last_admin` message on screen** —
  the same guardrail as the demotion above, reached by the other control.
- **`account_state_conflict` is shown as what it is** — verified by acting on a row whose state
  changed underneath (deactivate an already-deactivated account), asserting the console reports the
  conflict rather than a success it did not achieve.

### Invitations — [3.1.3](docs/project/prd.md#L45), [3.1.4](docs/project/prd.md#L46)

- **Issuing an invitation from the console creates it and it appears in the list** — verified by
  filling address and role, submitting, and asserting the new row plus a matching
  `GET /api/v1/invitations`.
- **Each of the three refusals is shown against the form, in the API's own words** — `email_taken`,
  `invitation_exists` and `invalid_input`, each verified by provoking it.
- **A pending invitation shows its status and its expiry**, and an expired one is distinguishable
  from a pending one — the status is derived by the API, so this asserts rendering, not a second
  clock in the client.
- **Revoke moves the invitation out of the actionable set** — verified by revoking and asserting the
  row reads as revoked rather than disappearing.
- **Resend replaces it with a fresh invitation on a fresh window** — the API answers `201` with a
  **new** id and a later expiry; verified that the console shows the new expiry and does not leave
  the old row behind.
- **Revoke and resend are offered only where they apply** — verified that a revoked invitation
  offers no revoke ([assumption 5](#assumptions-to-confirm) settles what is listed at all).

### Failure and empty states

- **A refusal never clears what was typed and never reloads the page** — the property ticket 2 pinned
  for sign-in, verified the same way: a DOM mark that only survives if the document is not replaced.
- **An unreachable API says so** — verified by asserting the console renders a stated failure rather
  than an empty list, so "nothing to show" and "could not load" are never the same screen.
- **Empty states read as empty, not broken** — verified with zero invitations.

### Guards still hold

- **No role literal and no `.role` access outside the two permitted files** — the existing
  `tests/guards/role-usage.test.ts` covers it; this ticket adds a console full of role rendering, so
  it is the first real pressure on that rule. See [assumption 4](#assumptions-to-confirm).
- **No raw colour, radius or spacing value** — existing `tests/guards/style-tokens.test.ts`.
- **The client imports no server module** — existing `tests/guards/import-boundary.test.ts`. The
  panel is a client component and reads its data over the absolute API origin.

---

## Feel requirements (manual-only) — approved before work starts

The first operator surface in the product. These are the difference between a console somebody runs
a church from and a CRUD table.

- **The console feels like the same product as the sign-in screen, not an admin bolt-on.** What to
  feel for: sign in, open the console, go back. Same navy, same purple, same roundness, same
  airiness. Nothing that looks like it came from a different decade of the internet.
- **Inviting somebody is one motion.** What to feel for: type an address, pick a role, press once.
  It should be the most obvious thing on the panel, not something reached by finding a "new" button,
  opening a dialog, and then filling a form.
- **"Who can get in right now" is readable at a glance.** What to feel for: scan the panel without
  reading it. Active, deactivated and pending-invitation should separate by shape and tone before
  you read a single word.
- **Deactivation feels deliberate.** What to feel for: try to deactivate somebody. The confirming
  press should say whose access is ending. Ending a person's access should never be one stray tap on
  a phone.
- **The last-admin refusal reads as a guardrail on screen, not just in a log.** What to feel for:
  demote the only admin. Ticket 4 made the API say *why*; here you should read that reason where you
  pressed, and immediately know the fix is to promote someone first.
- **Resend and revoke belong to their row.** What to feel for: act on one pending invitation among
  several. It must be unmistakable which address you just acted on, and the row should visibly
  settle into its new state rather than the whole list blinking.
- **It works from a phone, standing up, after a service.** What to feel for: invite somebody at
  390px with one thumb. No horizontal scrolling, no field hidden behind the keyboard, no control
  smaller than a thumb.

---

## Assumptions to confirm

Implementation does not start until these are settled. **1, 2 and 4 are the ones that change the
build.**

1. **No design reference, so compose from the style guide** — the carve-out tickets 2–4 received.
   `pages/dashboard.png` is the member dashboard and belongs to Ticket 13; the top-navigation
   references are member chrome with no admin entry and are **not** built here.

2. **A member who reaches `/admin` is redirected to `/`**, and an anonymous one to `/sign-in`. The
   alternative is `notFound()`, which does not disclose that the console exists. I propose the
   redirect: the API already answers `forbidden` — not `not_found` — to a member who calls
   `GET /api/v1/users`, so a 404 page would be the only place in the product pretending the console
   is not there, and a member with somewhere to be is better sent there than shown a dead end.

3. **The console is reached from a temporary admin-only link on `/`.** `/` is still ticket 2's
   placeholder and Ticket 13 replaces it wholesale. A link there is the smallest thing that makes the
   console reachable without inventing member navigation a later ticket owns, and it disappears with
   the placeholder.

4. **Role labels move into `packages/shared/src/roles.ts` as `ROLE_LABEL: Record<Role, string>`.**
   `tools/role-usage.ts` refuses a role literal or a `.role` access anywhere outside `roles.ts` and
   `policy.ts`, and this console has to print a role and offer a picker. Declaring the labels beside
   the enum keeps the guard absolute and makes the picker an iteration over `ROLES` rather than a
   second list. Two mechanical consequences: read a role by destructuring (`const { role } =
   account`), and never name a CSS-module class exactly `role`, because `styles.role` matches the
   guard's pattern — `styles.roleTag` does not.

5. **The invitation panel lists everything except accepted invitations.** An accepted invitation is
   an account now and is already in the member list above it; listing it twice is noise on the one
   panel that has to answer "who is still outstanding". Pending, expired and revoked are all shown,
   with their status.

6. **Every mutation re-fetches the list it affected. No optimistic UI.** Two small lists and a local
   API — a refetch is imperceptible, and optimism here means a console that can display a state the
   database refused. Optimistic UI is named as something the client owns in
   [epic architecture § Next.js application — client half](docs/epics/epic-core-listening/architecture.md#L109); it
   earns its place at the player, not here.

7. **The console hides deactivate and role-change on your own row**, with a short note saying why.
   This is the client *hiding*, not deciding — the API still permits both, exactly as the standing
   constraint requires. Adding a server-side self-guard would change ticket 4's rules and is out of
   scope here.

8. **`ADMIN_PAGE_PATH` is declared in `packages/shared/src/accounts.ts`**, beside the other page-path
   constants, rather than in a new module for one string.

---

## Scope

**In:** the `/admin` shell — layout, header carrying the signed-in identity and sign-out, and a
panel list with one entry; the server-side render gate on the console route; the User management
panel over tickets 3 and 4's existing routes — member list with role, active state and deactivation
date, role assignment, deactivate and reactivate behind a confirming press, invitation issue, revoke
and resend with derived status and expiry; the API's own refusal messages rendered where the action
was taken; empty, loading and unreachable states; responsive layout at phone, tablet and desktop;
the admin-only entry point on `/`; `ROLE_LABEL` and `ADMIN_PAGE_PATH` in `shared`; the Playwright
suite.

**Out:** **any new API route, and any change to tickets 3 and 4's behaviour** — if the console needs
something the API does not do, that is a scope decision, not a route added in passing. The member
top and bottom navigation ([Ticket 13](docs/epics/epic-core-listening/implementation-plan.md#L257) onward) and anything from
`pages/dashboard.png`. Every other dashboard panel — upload
([Ticket 6](docs/epics/epic-core-listening/implementation-plan.md#L146)), pipeline status
([Ticket 8](docs/epics/epic-core-listening/implementation-plan.md#L184)), Pending Reviews
([Ticket 10](docs/epics/epic-core-listening/implementation-plan.md#L215)), series ([Ticket 19](docs/epics/epic-core-listening/implementation-plan.md#L319)) —
each arrives with its feature, and no placeholder for any of them is rendered now. Per-role
dashboard gating ([3.19.1](docs/project/prd.md#L439)) — one flat surface until Contributor exists. Search,
filtering, sorting, pagination or bulk actions over the member list: five accounts, and every one of
those is a feature nobody has asked for. An audit-log view — the gate transitions are logged, and
reading them back is not in this epic. Editing another person's display name, avatars,
email-address changes, account deletion ([3.1.8](docs/project/prd.md#L50)). A component library extracted "for
later panels" — components land with the second screen that needs them, as `globals.css` already
says. Anything in
[epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341).

---

## Settled at implementation

The operator confirmed **1** (compose from the style guide; no member navigation built here) and
**2** (a member reaching `/admin` is redirected to `/`, an anonymous one to `/sign-in`). **3, 5, 6
and 8** were built exactly as proposed.

**4 — `ROLE_LABEL` — built as proposed, with one addition.** `ROLE_LABEL: Record<Role, string>` is
declared in [roles.ts](packages/shared/src/roles.ts) beside the enum, and the picker iterates
`ROLES`. The addition is that the picker is a **segmented pill control** rather than a `select`:
pressing the role an account already holds has to be a reachable press, because the API answering
with the current state is a behaviour this ticket has to render, and a `select` fires nothing when you
re-choose the current value.

**7 — narrowed, because as written it contradicted two of this ticket's own requirements.** The
proposal was to hide deactivate and role-change on your own row. The last-admin guard only fires
when the target *is* the only active admin, and only an admin can reach these routes — so
`last_admin` is reachable **only on your own row**. Hiding those controls there would have made
*"Demoting the last active admin is refused and the reason is on screen"*, *"Deactivating the last
active admin is refused with the `last_admin` message on screen"* and the feel requirement *"demote
the only admin … you should read that reason where you pressed"* unreachable through the console.

So the controls stay. What survives of the proposal is its intent: your own row is labelled
**"This is you."**, and the deactivation confirmation names you and says you would be signed out
immediately. The guardrail is the API's, which is where
[implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L32) puts it — and the
console's job is to show it, not to duplicate it.
