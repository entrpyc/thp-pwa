# Teaching Hub

A TypeScript monorepo. Slice 01, step 2 — **a person can sign in, and can be refused.** On top of
step 1's versioned `/api/v1` boundary (one JSON envelope, a correlation id on every request and log
line, migrations applied by command, a health route) there is now an account, an HTTP-only session,
a sign-in screen, and a single place where `(actor, action, resource)` is decided. Nothing else
exists yet — no invitations, no uploads, no library.

## Requirements

- **Node 22 LTS** — pinned in [.nvmrc](.nvmrc). `nvm use` picks it up.
- **PostgreSQL 17 with the `vector` extension installed** — see **Database** below. The extension
  must be *available* and **not enabled**; the test suite asserts both.
- **Docker** (for the development database only). Any Postgres 17 with pgvector installed works.
- **Chromium for Playwright** — `npx playwright install chromium`, once. The sign-in screen is
  tested in a real browser.

## Getting started from a clean checkout

```bash
cp .env.example .env      # then edit if your Postgres is not the compose one
docker compose up -d      # PostgreSQL 17 + pgvector, on 127.0.0.1:5432
npm install
npm run migrate

# The first admin. Set SEED_ADMIN_* in .env first — see .env.example.
npm run seed:admin

npm run dev               # http://localhost:3000
```

Then open <http://localhost:3000> and sign in as the account you just seeded.

Check the API is up: `curl http://localhost:3000/api/v1/health` — the one route that answers
without a session.

## Commands

| Command              | What it does                                                                  |
| :------------------- | :---------------------------------------------------------------------------- |
| `npm install`        | Install every workspace package.                                              |
| `npm run typecheck`  | Typecheck **the whole workspace as one program**, from the repository root.   |
| `npm run migrate`    | Apply every pending migration. Idempotent — running it twice is a no-op.      |
| `npm run seed:admin` | Create the first admin from `SEED_ADMIN_*`. Idempotent, and **never** resets an existing password. |
| `npm test`           | Unit and integration tests. Integration needs a real Postgres.                |
| `npm run dev`        | Next.js development server (UI and `/api/v1`).                                |
| `npm run worker`     | The worker stub. Polls nothing yet.                                            |
| `npm run build`      | Production build.                                                             |
| `npm start`          | Serve the production build.                                                   |
| `npm run db:generate`| Regenerate SQL migrations after changing the Drizzle schema.                  |

Every command reads one `.env` at the repository root — [scripts/with-env.mjs](scripts/with-env.mjs)
loads it before handing off, so there is no second env file inside a package.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs install → typecheck → migrate →
test → build on a fresh runner, which is what keeps this table honest. The test step covers *run*
too: the integration suite starts real Next.js servers and talks to them over HTTP.

## Packages

| Package                              | Role                                                                         |
| :----------------------------------- | :--------------------------------------------------------------------------- |
| [packages/shared](packages/shared)   | Domain vocabulary — role enum, pipeline-step enum, segment shape, the `/api/v1` wire contract. Imported by client, API, worker and database layer alike. |
| [packages/db](packages/db)           | **Server-only.** Drizzle schema, migrations, and the single module the API reaches Postgres through. |
| [packages/web](packages/web)         | Next.js App Router — the React client *and* the `/api/v1` route handlers.     |
| [packages/worker](packages/worker)   | The pipeline worker. A stub polling nothing until the job ledger arrives.     |

## The `/api/v1` contract

Every response is JSON in one shape. **Success** puts the payload at the top level. **Failure** is
always the envelope:

```json
{ "error": { "code": "not_found", "message": "…", "correlationId": "…" } }
```

`code` is machine-readable and stable; `message` is for a human and is never parsed. An unhandled
exception becomes `500` with a generic message — the detail is logged server-side and never put on
the wire. An unknown path under `/api/v1` is a JSON `404`, not an HTML page.

`GET /api/v1/health` always answers `200`: the check itself succeeded, and its verdict is in
`status` (`ok` | `degraded`). `database.reachable` reflects a real round-trip query.

### Correlation id

Every request carries `x-correlation-id`, returned on the response and stamped on every log line
emitted while handling it. A caller-supplied id is **adopted**, not replaced, so one id can later
span API request → job → provider call. To trace a request, take the id off the response and grep
the logs for it:

```bash
grep '"correlationId":"<id>"' <logfile>
```

### The client/API boundary

The client calls an **absolute origin** read from `NEXT_PUBLIC_API_ORIGIN`. There is deliberately no
same-host fallback: the packaged mobile build later changes that one value and nothing else. A
client module may not import a server module, the database package or a database driver — enforced
by a guard ([tools/import-boundary.ts](tools/import-boundary.ts)) that runs in the test suite and
fails the build, not by convention.

## Accounts, sessions and authorisation

**Every `/api/v1` route requires a session**, with exactly two enumerated exceptions:
`GET /api/v1/health` (it must answer while the database is down, which is when a session lookup
cannot) and `POST /api/v1/auth/session` (signing in is how a session comes to exist). The list is
[packages/web/src/server/auth/allowlist.ts](packages/web/src/server/auth/allowlist.ts), and it is
the *only* source of exceptions — a route declared public that is not on it refuses anonymous
callers like any other.

Three things make that checkable rather than reviewed:

- **A route cannot be defined without stating its access.** `apiRoute(access, handler)` takes it as
  a required first argument; the one-argument form does not compile.
- **A filesystem sweep.** The test suite discovers every `route.ts` and every method it exports,
  subtracts the allowlist, and asserts the rest refuse an anonymous request — so a new route is
  covered without anybody adding it to a list.
- **One policy module.** [policy.ts](packages/web/src/server/auth/policy.ts) is the only file in the
  application allowed to read a role, enforced by
  [tools/role-usage.ts](tools/role-usage.ts). It answers `(actor, action, resource)` and denies by
  default; its rules table is `Record<Action, Record<Role, boolean>>`, so adding a role stops the
  build until every case answers for it.

Refusals come in three distinguishable codes: `unauthenticated` (no session — also the answer for
an unknown path, so the API cannot be mapped anonymously), `forbidden` (a session, refused by
policy) and `invalid_credentials` (sign-in failed). Wrong password, unknown address and malformed
input all answer `invalid_credentials` with the same status and the same message, so the response
never discloses whether an address has an account. Every refusal is logged with actor, action and
target under the request's correlation id.

### Sessions

An opaque 32-byte token in an HTTP-only, `SameSite=Lax`, `Path=/` cookie — `Secure` everywhere but
`next dev`. Only the SHA-256 of the token is stored, so the `session` table cannot leak one. The
window is **30 days, rolling**, refreshed at most hourly on use.

Sessions are server-side records rather than signed stateless tokens, which is what makes sign-out
real: `DELETE /api/v1/auth/session` revokes the row, and replaying the captured cookie is refused.
The account is re-read on every request, so a role change takes effect immediately.

Passwords are **argon2id** (`@node-rs/argon2`, 64 MiB / 3 passes / 1 lane), salted per password by
the library. An unknown address is verified against a decoy hash so it costs the same as a known
one.

### The first admin

`npm run seed:admin` reads `SEED_ADMIN_EMAIL`, `SEED_ADMIN_DISPLAY_NAME` and
`SEED_ADMIN_PASSWORD`. A command rather than a migration, because a credential in a migration file
is a credential in version control forever. It refuses a weak or absent password, and running it
again against an existing account leaves the password **unchanged** — a seeder that silently
re-seeds is a back door.

### Design

There is no PNG for the sign-in screen. By operator decision, auth screens are composed from
[the style guide](docs/design%20referencess%20png/style-guide.md) instead, so
[packages/web/src/app/tokens.css](packages/web/src/app/tokens.css) is the guide's *Quick token
block* and nothing else. Two tests hold that: one asserts the token file and the guide match name
for name, and one ([tools/style-tokens.ts](tools/style-tokens.ts)) fails any stylesheet that spells
a colour, a radius or a spacing value the tokens already cover. Every screen from here on reads
this layer.

## Database

The development database is [docker-compose.yml](docker-compose.yml): `pgvector/pgvector:pg17`,
which ships PostgreSQL 17 with the `vector` extension installed as a package but **not enabled**.
That is the required state — enabling it (`CREATE EXTENSION vector`) belongs to a later slice, and
`packages/db/tests/integration/pgvector.test.ts` fails if either half of that is wrong.

Any Postgres 17 works as long as pgvector is installed on the instance. On Debian/Ubuntu:
`apt install postgresql-17-pgvector`.

Migrations are plain checked-in SQL in [packages/db/drizzle](packages/db/drizzle), generated by
`drizzle-kit` from [packages/db/src/schema.ts](packages/db/src/schema.ts) and applied in journal
order. Read the diff, not the ORM.

## Tests

- `npx vitest run --project unit` — no database, no server. Guards and pure logic.
- `npx vitest run --project integration` — builds the app once, starts **two** production servers
  (one on a working database, one on a deliberately broken one) and talks to them over HTTP,
  against a real Postgres. Nothing here is mocked: the migration and pgvector checks would be
  meaningless against a fake. Server logs land in `.tmp/logs/`.

  It runs against a **throwaway database created on your instance and dropped afterwards**, not the
  one in `.env`. The suite writes accounts and sessions, and those must not end up in the database
  you sign into; it also means every run starts from an empty `user` table, so no test can quietly
  depend on what the last run left behind.

  The sign-in screen is driven in a real Chromium via Playwright — layout overflow at a phone width,
  keyboard order, and "the page did not reload" are not answerable in a DOM simulation. Run
  `npx playwright install chromium` once.

  It tests the production build rather than `next dev` for two reasons: Next refuses a second
  `next dev` for one project directory, and the artefact under test should be the one that ships.
  The `/api/v1/diagnostics/*` routes used by those tests are `404` in production unless
  `ENABLE_DIAGNOSTIC_ROUTES=true` is set, which only the test harness does.
