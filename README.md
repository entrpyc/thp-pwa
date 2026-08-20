# Teaching Hub

A TypeScript monorepo. Slice 01, step 1 — the repository runs: a versioned `/api/v1` boundary with
one JSON envelope and a correlation id on every request and log line, a self-hosted Postgres with
migrations applied by command, and a health route. Nothing else exists yet.

## Requirements

- **Node 22 LTS** — pinned in [.nvmrc](.nvmrc). `nvm use` picks it up.
- **PostgreSQL 17 with the `vector` extension installed** — see **Database** below. The extension
  must be *available* and **not enabled**; the test suite asserts both.
- **Docker** (for the development database only). Any Postgres 17 with pgvector installed works.

## Getting started from a clean checkout

```bash
cp .env.example .env      # then edit if your Postgres is not the compose one
docker compose up -d      # PostgreSQL 17 + pgvector, on 127.0.0.1:5432
npm install
npm run migrate
npm run dev               # http://localhost:3000
```

Check it: `curl http://localhost:3000/api/v1/health`

## Commands

| Command              | What it does                                                                  |
| :------------------- | :---------------------------------------------------------------------------- |
| `npm install`        | Install every workspace package.                                              |
| `npm run typecheck`  | Typecheck **the whole workspace as one program**, from the repository root.   |
| `npm run migrate`    | Apply every pending migration. Idempotent — running it twice is a no-op.      |
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

  It tests the production build rather than `next dev` for two reasons: Next refuses a second
  `next dev` for one project directory, and the artefact under test should be the one that ships.
  The `/api/v1/diagnostics/*` routes used by those tests are `404` in production unless
  `ENABLE_DIAGNOSTIC_ROUTES=true` is set, which only the test harness does.
