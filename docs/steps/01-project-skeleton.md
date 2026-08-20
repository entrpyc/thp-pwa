# Step 1 — Project skeleton and the `/api/v1` boundary

> Phase 6 artefact for [implementation-plan.md § Step 1](../implementation-plan.md#L59).
> Sections pulled: [slice-architecture.md § Overview](../slice-architecture.md#L7),
> [slice-architecture.md § Next.js application — API half](../slice-architecture.md#L123),
> [slice-architecture.md § Primary datastore](../slice-architecture.md#L177),
> [slice-architecture.md § Key choices](../slice-architecture.md#L244),
> [architecture.md § Key technology choices](../architecture.md#L209),
> [5.2.2](../prd.md#L706).

This step ships no product behaviour. Its whole value is that two boundaries — the client/API
contract and the single-datastore choice — are correct on the first commit, because
[implementation-plan.md § Step 1](../implementation-plan.md#L59) marks both hard to walk back.

## Requirements (test-covered)

**The `/api/v1` contract**

- A health route responds `200` with a JSON body under `/api/v1` — verified by an integration test
  hitting the running route over HTTP, not by importing the handler function.
- Every `/api/v1` response — success and failure alike — is JSON in one envelope shape, so no route
  can invent its own — verified by a test asserting the envelope on a success, a handled error and
  an unhandled throw.
- An unhandled exception inside a route handler returns the error envelope with `500` and never
  leaks a stack trace or internal message to the client — verified by a route that throws
  deliberately, asserting the response body contains neither.
- An unknown path under `/api/v1` returns the error envelope with `404`, not an HTML page — verified
  by requesting a nonexistent route and asserting `content-type: application/json`.
- The envelope carries a machine-readable error code distinct from the human-readable message —
  verified by asserting both fields exist and the code is stable across two identical failures.

**Correlation id**

- Every request is assigned a correlation id and it is returned on the response — verified by
  asserting the response header is present and non-empty on both a success and an error.
- A caller-supplied correlation id is adopted rather than replaced, so the id can later span
  API → job → provider ([slice-architecture.md § Key choices](../slice-architecture.md#L244)) —
  verified by sending a known id and asserting the same id comes back.
- Two concurrent requests get distinct ids, and no log line from one carries the other's id —
  verified by firing overlapping requests against a route that logs, then asserting the captured log
  lines partition cleanly by id.
- Every log line emitted while handling a request carries that request's correlation id — verified
  by capturing the logger during one request and asserting no line lacks the field.

**The client/API boundary** — the [5.2.2](../prd.md#L706) requirement, and the reason this step
exists at all

- The client calls an absolute API origin read from configuration, not a relative path — verified by
  a test asserting the configured origin is used to build a request URL, plus a source-level check
  that no client module hardcodes `/api/v1` against the current host.
- No client module imports a server module, a database module, or a database driver — verified by an
  automated import-boundary check (lint rule or dependency-cruiser-style test) that fails the build
  on violation, not by convention.
- The check fails when deliberately violated — verified by a fixture importing across the boundary
  and asserting the check reports it. A guard nobody has seen fail is not a guard.
- Domain types (role enum, pipeline step enum, segment shape) live in a shared package imported by
  client, API and worker alike, with no duplicate local definition — verified by a source-level check
  that each enum is declared exactly once in the repository. The database layer's enum declarations
  are **derived from** these, not restated alongside them, which is what keeps that check honest once
  assumption 4's schema exists.

**Database and migrations**

- Migrations apply to an empty database by one command and leave a recorded, ordered migration state
  — verified by an integration test running the command against a throwaway database and asserting
  the migration table contents.
- Running the migration command twice is a no-op the second time — verified by running it twice and
  asserting no error and no state change.
- The API reaches Postgres through a single database module, and the health route reports the
  connection is live — verified by an integration test asserting the health body reflects a real
  query, and asserting it reports unhealthy when the connection is broken.
- The `vector` extension is **available but not enabled** on the target instance
  ([slice-architecture.md § Primary datastore](../slice-architecture.md#L177)) — verified by a test
  asserting `pg_available_extensions` contains `vector` **and** `pg_extension` does not. This is the
  test that catches an instance chosen wrongly, which is the expensive half of this step.

**The repository runs**

- Install, migrate, run, test and typecheck each work from a clean checkout by a documented command —
  verified by a CI job doing exactly that sequence on a fresh runner.
- Typecheck passes across every package in the monorepo, not per-package in isolation — verified by
  the CI typecheck covering the workspace root.

## Feel requirements (manual-only) — approved before work starts

Step 1 has **no member-facing surface**, so there is no application feel to judge and no design
reference is consulted. What exists to feel is the developer loop — worth naming once, because every
one of the remaining nineteen steps is built inside it.

- **The dev loop feels immediate.** What to feel for: save a file and see the change without
  restarting anything; note any hesitation between save and result, and whether you ever reach for
  the terminal to recover.
- **A failure tells you where to look on the first read.** What to feel for: a deliberately broken
  route, a wrong database URL and a type error each produce a message you can act on without opening
  a stack trace or grepping the codebase.
- **The correlation id is usable, not merely present.** What to feel for: take an id off a response,
  find every log line for that request with one search, and get nothing belonging to another request.

## Assumptions to confirm

Operator decisions. Implementation does not start until they are settled — all are cheap now and
annoying later; assumption 2 is the hard-to-reverse one.

1. **Postgres instance.** *Settled.* Postgres is self-hosted on the application host
   ([architecture.md § Estimated running costs](../architecture.md#L343)), so the `vector` extension
   is a package we install rather than a provider feature we have to shop for — which is what
   [slice-architecture.md § Primary datastore](../slice-architecture.md#L177) requires be
   *available* while staying unenabled. This used to be the one choice in the step a later slice
   could not route around; self-hosting removed that. Assumed: PostgreSQL 17 with the pgvector
   package installed, a local container for dev, the host's instance for production, no read
   replica. Still an assumption worth stating rather than a question worth asking.
2. **The API origin in development.** The client must call an absolute origin, so dev needs one even
   though UI and API are the same Next.js app. Assumed: an env var (`NEXT_PUBLIC_API_ORIGIN`) set to
   `http://localhost:3000` in dev and to the deployed origin in production — the client never
   defaults to "same host", so the Capacitor build later changes one value.
3. **Monorepo tooling.** Assumed: npm workspaces, no Turborepo/Nx — three packages (`shared`, `web`,
   `worker`, the last a stub until step 7) do not need a build orchestrator. Adding one later is a
   config file.
4. **Migration tool and data-access layer.** *Settled.* **Drizzle ORM with `drizzle-kit`.** The
   readable-schema property this assumption originally protected is kept rather than traded:
   `drizzle-kit generate` emits plain, checked-in SQL migration files with an ordered journal, so the
   schema is still read in a diff — and typed queries come *with* it rather than instead of it. Four
   things in the architecture decided it against the alternatives. `SELECT … FOR UPDATE SKIP LOCKED`
   is the dispatch mechanism for the job ledger
   ([architecture.md § Key technology choices](../architecture.md#L209)), and Drizzle expresses it
   directly instead of through a raw-SQL escape hatch. pgvector arrives in a later slice under a
   single-datastore decision marked *expensive to reverse*, and Drizzle has first-class `vector`
   columns and HNSW index DDL. Hybrid ANN-plus-full-text search is CTE work that composes into the
   typed builder rather than around it. And Drizzle is a library, not a per-process query engine,
   which matters on a host running the app, the worker and Postgres together on four shared vCPU
   ([architecture.md § Estimated running costs](../architecture.md#L343)). It changes **no line in
   that cost table**: `drizzle-orm` and `drizzle-kit` are MIT-licensed, and `drizzle-kit` runs at
   migrate time, not inside either long-lived process. Two constraints this places on the step, both
   already covered by requirements above — the Drizzle schema lives in a **server-only package, never
   in `shared`**, so the import-boundary guard has nothing to catch; and the `pgEnum`s are **derived
   from** the shared TypeScript enums rather than restated beside them, so "declared exactly once in
   the repository" still holds. It does not touch the `vector`-available-but-unenabled requirement:
   declaring a `vector` column in a later slice is independent of `CREATE EXTENSION`.
5. **Test runner and integration-test database.** Assumed: Vitest, with integration tests running
   against a real Postgres (a local container or a scratch database), not a mock — the pgvector and
   migration requirements above are meaningless against a fake.
6. **Node version.** Assumed: Node 22 LTS, pinned in `.nvmrc` and matched in CI.
7. **CI.** Assumed: GitHub Actions running install → typecheck → migrate → test on every push. If CI
   is not wanted yet, three requirements above lose their verification and become manual checks —
   say so and they will be re-scoped rather than silently dropped.
8. **Error envelope shape.** Assumed: `{ error: { code, message, correlationId } }` on failure, the
   payload at the top level on success. Cheap to change now; touched by every route later.
9. **Hosting target.** *Settled.* One netcup VPS 1000 G12 in Europe running the Next.js app, the
   worker and Postgres together ([architecture.md § Estimated running costs](../architecture.md#L343)).
   This is not needed to build the step, and the property that mattered before it was decided still
   holds: nothing in the code depends on a specific platform, so the box is a deploy target rather
   than an architectural input. What it does settle is assumption 1. Provisioning, TLS, process
   supervision and `pgBackRest` backups are deployment work and belong to
   [implementation-plan.md § Step 21](../implementation-plan.md#L324), not here.

## Scope

**In:** the monorepo and its packages; the shared domain-types package with the role and
pipeline-step enums; the Next.js App Router app; the `/api/v1` route-handler layer with its JSON
error envelope, its `404`/`500` behaviour and its correlation-id middleware; structured logging
carrying that id; the Postgres connection module and the server-only Drizzle schema package it
reads; `drizzle-kit` generating and applying an initial empty migration; the health route; the
import-boundary guard; test setup; documented commands; CI running them.

**Out:** every table in [slice-architecture.md § Data model](../slice-architecture.md#L193) — no
`user`, no `recording`, no `job`, no `review_item`; each arrives with the step that uses it. No
sessions, no password hashing, no role enforcement (step 2 — so this step's routes are not yet
behind the "every route requires a session" rule of [3.1.2](../prd.md#L44), and the health route is
the one route that will stay outside it). No object storage, no presigned URLs, no worker process
running — the package may exist as an empty stub polling nothing. No UI beyond what Next.js needs to
boot: **no page is designed in this step.** No auth provider, no email sending, no error-tracking
SaaS. And nothing from
[slice-architecture.md § Deliberately deferred](../slice-architecture.md#L330) — in particular no
Redis, no CDN, and **no `CREATE EXTENSION vector`**: the requirement above asserts it is available
and *unenabled*, and enabling it belongs to a later slice.
