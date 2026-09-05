# Teaching Hub

A TypeScript monorepo. Epic core-listening, ticket 2 — **a person can sign in, and can be refused.** On top of
ticket 1's versioned `/api/v1` boundary (one JSON envelope, a correlation id on every request and log
line, migrations applied by command, a health route) there is now an account, an HTTP-only session,
a sign-in screen, and a single place where `(actor, action, resource)` is decided. Nothing else
exists yet — no invitations, no uploads, no library.

## Requirements

- **Node 22 LTS** — pinned in [.nvmrc](.nvmrc). `nvm use` picks it up.
- **PostgreSQL 17 with the `vector` extension installed** — see **Database** below. The extension
  must be *available* and **not enabled**; the test suite asserts both.
- **Docker** (for the development database and the object store). Any Postgres 17 with pgvector
  installed works, and any S3-compatible bucket — see **Media store** below.
- **Chromium for Playwright** — `npx playwright install chromium`, once. The sign-in screen is
  tested in a real browser.

## Getting started from a clean checkout

```bash
cp .env.example .env      # then edit if your Postgres is not the compose one
docker compose up -d      # PostgreSQL 17 + pgvector on :5432, MinIO on :9000 + its bucket
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
| `npm run worker`     | The pipeline worker — polls the job ledger and runs `transcribe`. A second terminal, beside `npm run dev`. |
| `npm run build`      | Production build.                                                             |
| `npm start`          | Serve the production build.                                                   |
| `npm run db:generate`| Regenerate SQL migrations after changing the Drizzle schema.                  |
| `npm run check:origin`| Assert the built client calls the origin it was built for. Runs in CI after the build — see **Deployment**. |
| `npm run verify:production`| Read the deployed box and report one PASS/FAIL line per check. Run on the host; `-- --remote-only` works from anywhere. |

Every command reads one `.env` at the repository root — [scripts/with-env.mjs](scripts/with-env.mjs)
loads it before handing off, so there is no second env file inside a package. (`THP_SKIP_DOTENV=1`
suppresses that load; only the seed-admin suite sets it, because a test that observes how the
command handles a given environment has to be the thing that supplies it.)

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs install → typecheck → migrate →
test → build on a fresh runner, which is what keeps this table honest. The test step covers *run*
too: the integration suite starts real Next.js servers and talks to them over HTTP.

## Packages

| Package                              | Role                                                                         |
| :----------------------------------- | :--------------------------------------------------------------------------- |
| [packages/shared](packages/shared)   | Domain vocabulary — role enum, pipeline-step enum, segment shape, the `/api/v1` wire contract. Imported by client, API, worker and database layer alike. |
| [packages/db](packages/db)           | **Server-only.** Drizzle schema, migrations, and the single module the API reaches Postgres through. |
| [packages/media](packages/media)     | **Server-only.** The object-store port and its S3 adapter. Depended on by both the API and the worker, which is why it is not a folder inside either. |
| [packages/bible](packages/bible)     | **Server-only.** The Bible-text port, its one adapter, and the cache-aside resolver that holds a verse in our own database once. Depended on by both the API and the worker, for the same reason the media port is. |
| [packages/web](packages/web)         | Next.js App Router — the React client *and* the `/api/v1` route handlers.     |
| [packages/worker](packages/worker)   | The pipeline worker — polls the job ledger, transcribes, and will generate drafts. Holds the ASR port and its one adapter. |

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

**Every `/api/v1` route requires a session**, with exactly four enumerated exceptions:
`GET /api/v1/health` (it must answer while the database is down, which is when a session lookup
cannot), `POST /api/v1/auth/session` (signing in is how a session comes to exist), and the two
invitation-accept routes `GET` and `POST /api/v1/invitations/accept` (an invitee has no account
yet, and a dead link has to be able to say so before anybody chooses a password). None of the four
carries account content. The list is
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

Invitations add six more, and the splits between them are deliberate: `invalid_input` (the request
could not be read), `weak_password` (it could, and the password was refused on its merits),
`email_taken`, `invitation_exists` (use resend), and — separated so a dead link can say which —
`invitation_expired` versus `invitation_invalid`.

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

### Invitations

New accounts exist only by invitation. An admin `POST /api/v1/invitations` with an email and a
role; the invitee gets a message, opens `/accept-invitation?token=…`, chooses a password, and is
signed in by the same response that creates the account — there is no sign-in form in between.

- The token is 32 random bytes, **stored only as its SHA-256**, exactly like a session token.
- The window is **7 days**. Resend revokes the old token and issues a new one on a new window, so
  after a resend exactly one link works.
- **At most one live invitation per address**, enforced by a partial unique index rather than by a
  check somebody has to remember. Revoking or accepting frees the address again, which is what
  makes resend legal.
- Status (`pending | expired | revoked | accepted`) is **derived** from the timestamps, never
  stored — a stored status is a second source of truth a clock can make wrong.
- Issue, accept, revoke and resend are each logged with actor, action and target under the
  request's correlation id. No log line, error message or payload ever carries a raw token.

There is no interface for issuing or managing them yet; that is the admin console, and it is the
next ticket. Until then it is the API.

### Email

One module sends everything: [packages/web/src/server/mail](packages/web/src/server/mail).
[tools/mail-boundary.ts](tools/mail-boundary.ts) fails the build if anything outside it imports a
mail library, for the same reason only `packages/db` may import a database driver.

The adapter speaks **SMTP and names no vendor**, so moving between providers is four environment
values rather than a change of code. `.env.example` ships **Resend**'s settings, which is what this
deployment sends through: host `smtp.resend.com`, port `465`, user `resend`, password an API key.

> **Deliverability is yours to configure, not the adapter's.** Whoever `MAIL_FROM` claims to be, the
> domain has to be verified with the provider and carry SPF and DKIM records, or invitations will be
> filed as spam or rejected outright. Resend walks you through both when you add a domain. Sending
> from a domain you have not verified is the single most likely reason a person never receives their
> invitation — and nothing in the application can detect it, because SMTP accepted the message.

`MAIL_TRANSPORT` selects the adapter:

| Value | What it does |
| :--- | :--- |
| `smtp` | Sends. The only value a deployment should ever use. |
| `capture` | Appends each message — headers, HTML and text — to `MAIL_CAPTURE_PATH` as JSON lines and sends nothing. What `npm test` uses, and what development uses. |
| `failing` | Refuses every message. Exists so the suite can drive a send failure. |

To read a captured invitation during development, pull the HTML out of the last line and open it:

```sh
node -e "const l=require('fs').readFileSync('.tmp/mail/outbox.jsonl','utf8').trim().split('\n');require('fs').writeFileSync('.tmp/mail/last.html',JSON.parse(l.at(-1)).html)"
```

A **send failure does not destroy the invitation**: the row is written first, a transport failure
returns `service_unavailable`, and the invitation stays pending and resendable. Rolling back would
throw away an intent the admin already expressed, and resend exists precisely for this.

### Bug reports and feedback

*Report a bug* in the member navigation menu opens [`/feedback`](packages/web/src/app/(member)/feedback):
a title, a description, and a bug/feedback toggle. Submitting mails it through the same adapter as
everything else, to `FEEDBACK_MAIL_TO` — the only recipient in `.env.example` with a **default**,
because a deployment that never set one should still deliver reports rather than refuse them. Point
it somewhere else to redirect them, which is what staging wants.

**Nothing is stored.** There is no table, no id and no screen listing past reports — the message is
the record. That is the one place the paragraph above does not apply: with no row to retry from, a
transport failure is reported to the member as `service_unavailable` rather than swallowed, and the
form keeps their text so trying again costs a press. The reporter is taken from the session and never
from the body, so the route cannot be used to send mail as somebody else; the message carries their
display name and address, and **not their role**, because nothing outside the policy module reads
`actor.role`.

### Passwords

One statement of the rules, in [packages/shared/src/passwords.ts](packages/shared/src/passwords.ts),
read by the seed command, by the invitation-accept screen and by the API that refuses. The screen
prints the rule *before* anyone can fail it — a rule you learn by being refused is an exam.

### Design

There is no PNG for the sign-in screen, and none for the accept-invitation screen. By operator
decision, auth screens are composed from
[the style guide](docs/design%20referencess%20png/style-guide.md) instead, so
[packages/web/src/app/tokens.css](packages/web/src/app/tokens.css) is the guide's *Quick token
block* and nothing else. Two tests hold that: one asserts the token file and the guide match name
for name, and one ([tools/style-tokens.ts](tools/style-tokens.ts)) fails any stylesheet that spells
a colour, a radius or a spacing value the tokens already cover. Every screen from here on reads
this layer, and the accept-invitation screen composes its card, field, button and error line from
the sign-in stylesheet rather than restating them.

**The invitation email is the one exception, and it is a named one.** Mail clients do not support
CSS custom properties and several strip `<style>` blocks, so the template inlines literal values
from [server/mail/theme.ts](packages/web/src/server/mail/theme.ts) — the only file in the codebase
allowed to spell a colour out. A test asserts every value there equals the token it copies, and the
guard that forbids colour literals in source exempts that one path **by name**, not by pattern.

## Database

The development database is [docker-compose.yml](docker-compose.yml): `pgvector/pgvector:pg17`,
which ships PostgreSQL 17 with the `vector` extension installed as a package but **not enabled**.
That is the required state — enabling it (`CREATE EXTENSION vector`) belongs to a later epic, and
`packages/db/tests/integration/pgvector.test.ts` fails if either half of that is wrong.

Any Postgres 17 works as long as pgvector is installed on the instance. On Debian/Ubuntu:
`apt install postgresql-17-pgvector`.

Migrations are plain checked-in SQL in [packages/db/drizzle](packages/db/drizzle), generated by
`drizzle-kit` from [packages/db/src/schema.ts](packages/db/src/schema.ts) and applied in journal
order. Read the diff, not the ORM.

## Media store

Original audio uploads live in an S3-compatible bucket. Development runs against the MinIO
container in [docker-compose.yml](docker-compose.yml), which also creates the bucket `.env` names
on the way up — `docker compose up -d` leaves you with a store you can upload to; a deployment points the five `MEDIA_` values
in `.env` at its own bucket — Cloudflare R2 is what this one uses. **The test suite reads neither**:
it talks only to the container, with the container's own credentials held in
[tests/setup/media-bucket.ts](tests/setup/media-bucket.ts), because `.env` may point at a real bucket
and a bucket this product can never delete from is not somewhere a test run may write. **Nothing in the
source names a vendor**: the adapter speaks plain S3, and
[tools/media-boundary.ts](tools/media-boundary.ts) fails the build if anything outside
[packages/media/src/s3-store.ts](packages/media/src/s3-store.ts) imports the
SDK.

Three properties, none of them optional:

1. **The bucket is never publicly readable.** Every read is a short-lived signed URL minted after an
   authorisation check. The suite proves this against MinIO; on the real bucket it is a setting you
   apply, and the one manual check worth doing after the first upload.
2. **The bucket needs a CORS rule** permitting `PUT` and its preflight from the application origin,
   with `content-type` on the allowed headers. Without it the browser cannot make the upload at all
   — the preflight fails and no `PUT` is ever sent. The container is configured for this in
   `docker-compose.yml`; on R2 it is a rule on the bucket.
3. **Nothing is ever deleted.** The original is the input transcription reads, and every later
   re-transcription depends on it, so the media store port has **no delete operation** — a guard test
   asserts the interface declares none. The cost is that an upload whose finalisation is refused
   leaves an orphan object nobody can see, and that is the cheap side of the trade.

Uploads go **straight from the browser to the bucket** on a presigned `PUT`; bytes never pass
through the application. The API mints the key, signs the grant, and afterwards asks the store what
actually arrived — which is what "re-checked server-side" means when the API never sees the file.

**200 MB, as MP3, M4A, AAC, WAV or FLAC.** A 90-minute teaching fits comfortably as MP3 or M4A and
does **not** fit as WAV or FLAC; the upload screen says so before a file is chosen.

## Transcription

The worker's `transcribe` step reads the original object, calls a speech-to-text provider, and
writes a `transcript` row plus one `segment` row per sentence, each carrying `start_ms`, `end_ms`
and `text`. **The timestamped segment is the atom of the whole system** — notes, highlights, search
and everything later resolves through `(recording_id, timestamp_ms)`.

**The bytes never pass through the worker.** It mints a short-lived signed `GET` and hands the
provider that URL; the provider fetches the object itself, which is the same boundary the presigned
`PUT` holds on the way in. The grant expires after two hours.

**Nothing in the source names a vendor** outside one file:
[tools/asr-boundary.ts](tools/asr-boundary.ts) fails the build if anything but
[packages/worker/src/asr/deepgram.ts](packages/worker/src/asr/deepgram.ts) imports a provider SDK
*or names its API host*. Swapping providers is that file and the `ASR_` block in `.env`.

- `ASR_PROVIDER=deepgram` is the real one — Nova-3 pre-recorded, monolingual English, $0.0043/min
  ($0.258/hr; a 90-minute teaching is ~$0.39). Needs `ASR_API_KEY`.
- `ASR_PROVIDER=fake` reads a fixed script off `ASR_FAKE_SCRIPT` and returns it, spending nothing
  and reaching no network. **That is what the test suite runs against** — the provider is
  configuration, so the test double is a value of the same setting rather than a mock.

**Local development runs on the fake, and has to.** The provider fetches the object from the signed
URL itself, so it must be able to *reach* the bucket — and the MinIO container on `127.0.0.1:9000`
is not routable from the internet. Pointing the real provider at a local upload fails with
`REMOTE_CONTENT_ERROR: URL for media download must be publicly routable`, which is the design
working rather than failing: a deployment's bucket is a public R2 endpoint and the same URL works
unchanged. To exercise the real provider from a developer machine you need a bucket it can reach —
a tunnel in front of MinIO, or the `MEDIA_` values pointed at the real bucket.

```bash
# the whole pipeline, locally, spending nothing
ASR_PROVIDER=fake ASR_FAKE_SCRIPT=packages/worker/tests/fixtures/teaching-script.json npm run worker
```

Three things worth knowing before the first real recording:

1. **English is pinned, not detected.** The monolingual model is both the more accurate one and the
   one the cost table is built on. `transcript.language` is still written and reads `en`, so a
   second language later is an adapter change rather than a migration. A recording in another
   language is transcribed badly as English and still reads `en`.
2. **A transcript the provider is not confident in fails the job.** Below 0.6 the transcript is
   *written* — so an admin can read it and judge it — and then the job fails, so nothing downstream
   is generated from it. 0.6 is a first setting, not a measured one.
3. **Re-running the step replaces the transcript**, deleting the old one and its segments. That is
   what makes the handler safe under at-least-once dispatch, and it means a re-run will discard any
   corrections a later story lets an admin make.

## Tests

- `npx vitest run --project unit` — no database, no server. Guards and pure logic.
- `npx vitest run --project integration` — builds the app once, starts **three** production
  servers (one healthy, one on a deliberately broken database, one whose mail transport refuses
  everything) and talks to them over HTTP, against a real Postgres. Nothing here is mocked: the
  migration and pgvector checks would be meaningless against a fake. Server logs land in
  `.tmp/logs/`, and captured mail in `.tmp/mail/`.

  It runs against a **throwaway database created on your instance and dropped afterwards**, not the
  one in `.env`. The suite writes accounts and sessions, and those must not end up in the database
  you sign into; it also means every run starts from an empty `user` table, so no test can quietly
  depend on what the last run left behind.

  It also needs the **MinIO container** (`docker compose up -d minio`) and uses a bucket of its own
  on it — reached with the container's credentials, never with what `.env` names. That bucket is
  *not* dropped afterwards: emptying it would mean deleting objects, and there is no delete path
  against a bucket anywhere in this repository, not even in the harness. Every key is a uuid, so
  runs cannot collide.

  The sign-in and accept-invitation screens are driven in a real Chromium via Playwright — layout overflow at a phone width,
  keyboard order, and "the page did not reload" are not answerable in a DOM simulation. Run
  `npx playwright install chromium` once.

  It tests the production build rather than `next dev` for two reasons: Next refuses a second
  `next dev` for one project directory, and the artefact under test should be the one that ships.
  The `/api/v1/diagnostics/*` routes used by those tests are `404` in production unless
  `ENABLE_DIAGNOSTIC_ROUTES=true` is set, which only the test harness does.

## Deployment

The one deployment: **`https://thp.indepthwebsolutions.com`**, on a Contabo Ubuntu VPS at
`167.86.71.60` — 4 vCPU, 8 GB RAM, 100 GB SSD, running the app, the worker and Postgres together.
Co-location is a deployment fact, not a structural one; the three stay separate processes.

Two commands matter after the first setup:

| Command                      | What it does                                                                         |
| :--------------------------- | :----------------------------------------------------------------------------------- |
| `./scripts/deploy.sh vX.Y.Z` | Check out the tag, install, migrate, build, check the origin, restart, verify. The whole deploy. The Deploy workflow runs it — see **Releasing**. |
| `npm run verify:production`  | Reads the box and prints one PASS/FAIL line per check. Repairs nothing.               |

`npm run verify:production -- --remote-only` runs just the checks that need nothing but HTTP, so
they can be run from a laptop. `-- --kill-drill` kills the worker and watches pm2 bring it back.
`-- --smoke --audio=<file>` drives a real upload through the real pipeline and **spends real money**.

### Releasing

Nothing reaches the box by `git pull`. A deploy is a **release tag**, cut and shipped by the
[Deploy workflow](.github/workflows/deploy.yml) once a person approves it:

1. **Actions → Deploy → Run workflow**, on `main`, choosing `patch`, `minor` or `major`.
2. The `gate` job refuses unless CI has passed on that exact commit (ticking **skip_ci_gate** on the
   form gets past it, and marks the run summary and the release notes), then shows the next tag in the
   run summary (`v0.1.0` when there is none yet).
3. The run pauses at the **production** environment. Approving it is the deploy decision.
4. `release` tags the commit, pushes the tag and publishes a GitHub Release with generated notes.
5. `deploy` connects to the box over SSH and sends just the tag. The deploy key is bound to
   [scripts/deploy-ssh-entry.sh](scripts/deploy-ssh-entry.sh), which accepts nothing but a release
   tag and runs `scripts/deploy.sh` with it — so the key can deploy a published release and do
   nothing else.

The box ends detached at the tag, and `verify:production`'s `release` check fails the deploy if it
is anywhere else. Deploying by hand is the same command over an ordinary SSH session:
`./scripts/deploy.sh v1.2.3`.

The workflow needs, in the repository's **Settings**:

| Where                      | Name                   | Value                                                                        |
| :------------------------- | :--------------------- | :--------------------------------------------------------------------------- |
| Environments → production  | Required reviewers     | Whoever may approve a deploy.                                                |
| Secrets → Actions          | `DEPLOY_SSH_KEY`       | The private half of the deploy key, generated in **First setup — 8**.        |
| Variables → Actions        | `DEPLOY_HOST`          | `167.86.71.60`                                                               |
| Variables → Actions        | `DEPLOY_USER`          | `thp`                                                                        |
| Variables → Actions        | `DEPLOY_KNOWN_HOSTS`   | The output of `ssh-keyscan -t ed25519 167.86.71.60`, so the runner pins the host. |

### Two things that bite silently

**Build after `.env`, never before.** `NEXT_PUBLIC_API_ORIGIN` is inlined into the client at build
time. A build made before `.env` holds the production origin produces a site that looks perfectly
correct on the box and calls `localhost` from every visitor's browser. `npm run check:origin` is
what catches it — it runs in CI after `npm run build`, and again inside `deploy.sh`.

**The certificate already exists.** Let's Encrypt issued for this host on 14 Aug 2026, and certbot
manages the nginx TLS lines. Do **not** re-run `certbot --nginx -d thp.indepthwebsolutions.com`;
confirm with `certbot certificates` and prove renewal with `certbot renew --dry-run`.
[deploy/nginx/thp.conf](deploy/nginx/thp.conf) is the shape to diff the live block against — take
the proxy headers and `client_max_body_size` from it, and leave certbot's lines alone. This box
serves other sites, so nothing here edits an existing nginx file and the block never claims
`default_server`.

### First setup

Everything below is done once, on the box, over SSH.

**1 — The host.** Create a service user, disable SSH password and root login, turn on the firewall.

```bash
sudo adduser --disabled-password thp
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl reload ssh          # keep this session open until a second one logs in
sudo ufw allow 22,80,443/tcp && sudo ufw enable
```

Contabo images commonly ship with root password login enabled, so both `sed` lines are changes
rather than confirmations. Check `/etc/ssh/sshd_config.d/` too — a cloud image often sets
`PasswordAuthentication` in a drop-in, and a drop-in wins over the main file.

**2 — PostgreSQL 17 with pgvector available.** Ubuntu 20.04 and 22.04 both ship nginx 1.18 and
**neither ships PostgreSQL 17**, so it comes from PGDG:

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt install -y postgresql-17 postgresql-17-pgvector pgbackrest
sudo -u postgres createuser thp --pwprompt
sudo -u postgres createdb thp --owner=thp
```

The `vector` extension must be **installed and available but not enabled** — the state
[epic architecture § Primary datastore](docs/epics/epic-core-listening/architecture.md#L177) requires,
and `verify:production` asserts both halves. Then bind Postgres to localhost in
`/etc/postgresql/17/main/postgresql.conf`:

```
listen_addresses = 'localhost'
```

**3 — nginx.** Diff the live block against [deploy/nginx/thp.conf](deploy/nginx/thp.conf), copy
across the `proxy_set_header` lines and `client_max_body_size`, then
`sudo nginx -t && sudo systemctl reload nginx`. `X-Forwarded-Proto` is the one that matters most:
without it every request looks like plain HTTP to the process behind the proxy.

**4 — Buckets and keys.** In the Cloudflare dashboard, two buckets and two tokens:

- **Media** — public access off, and a **CORS rule allowing `PUT` and its preflight from
  `https://thp.indepthwebsolutions.com`, with `content-type` on the allowed headers.** Without that
  rule the browser cannot upload at all, and the screen genuinely cannot say why — a browser is not
  told the reason a cross-origin `PUT` was refused.
- **Backups** — its own token, **scoped to that bucket only**. Retention deletes from this one every
  night by design, and the media bucket is the one nothing may ever delete from.

Production keys for Deepgram, MiniMax and Resend belong here too, separate from any development key.
The Resend sending domain must be verified, or the first invitation is filed as spam.

**5 — The checkout and its secrets.**

```bash
sudo -u thp git clone <repo> /home/thp/app && cd /home/thp/app
cp .env.example .env && chmod 600 .env      # then fill it in
```

Production `.env` differs from the template in: `NEXT_PUBLIC_API_ORIGIN=https://thp.indepthwebsolutions.com`,
`THP_MOCK_EXTERNAL=false`, `MEDIA_*` pointing at R2, real `ASR_API_KEY`, `GENERATE_API_KEY` and
`MAIL_*`, and `SEED_ADMIN_*`. `ENABLE_DIAGNOSTIC_ROUTES` stays unset.

**6 — Build and supervise.**

```bash
npm ci && npm run migrate && npm run build
pm2 start ecosystem.config.cjs
pm2 startup systemd            # run the command it prints
pm2 save                       # after both are online, not before
pm2 install pm2-logrotate
npm run seed:admin
npm run verify:production
```

`pm2 save` records what is *running*, not what the config file says — saving before both apps are up
gives you a reboot that comes back missing one. And the worker is `exec_mode: 'fork'` with
`instances: 1` in [ecosystem.config.cjs](ecosystem.config.cjs) for a reason that is not stylistic:
cluster mode runs a second worker, and the boot sweep reclaims every job a dead worker left
`running` — so a second copy would reclaim jobs the first one is still running.

`pm2-logrotate` is not optional on a 100 GB disk. Media lives in object storage and never touches
this disk; pm2's logs are the thing that grows.

**7 — Prove it.** Reboot the box, wait, and run `npm run verify:production` again without touching
anything. Then `-- --kill-drill`, then `-- --smoke --audio=<a short file>`. The smoke run is the
only thing that exercises a presigned `PUT` from the real origin through the real CORS rule, and an
ASR provider fetching the object *itself* from a bucket it can reach — the boundary that makes MinIO
unusable for real transcription, and therefore the one thing no local run has ever tested.

**8 — The deploy key.** A keypair the Deploy workflow uses and nothing else, bound on the box to the
one script it may run:

```bash
ssh-keygen -t ed25519 -N '' -C 'thp deploy' -f /tmp/thp-deploy      # on your machine
ssh-keyscan -t ed25519 167.86.71.60                                   # → DEPLOY_KNOWN_HOSTS
```

Then, as `thp` on the box, one line in `~/.ssh/authorized_keys` — the public key prefixed with the
forced command and no other capability:

```
command="/home/thp/app/scripts/deploy-ssh-entry.sh",no-port-forwarding,no-agent-forwarding,no-pty,no-X11-forwarding ssh-ed25519 AAAA… thp deploy
```

Put the private key in the `DEPLOY_SSH_KEY` secret, delete it locally, and check the binding holds:
`ssh -i /tmp/thp-deploy thp@167.86.71.60 whoami` must print `refused: expected a release tag`,
not `thp`.

### Backups

`pgBackRest` takes a nightly full backup at 02:00 UTC and archives WAL continuously to the backups
bucket. About **$0.10/month**: under 1 GB of database, so 1–3 GB stored at $0.015/GB-month, plus
roughly 8,700 WAL pushes at $4.50 per million Class A operations.

```bash
sudo install -o root -g postgres -m 640 deploy/pgbackrest/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
# fill in the endpoint, bucket and key, then:
sudo -u postgres pgbackrest --stanza=thp stanza-create
```

In `postgresql.conf`, then restart Postgres:

```
archive_mode = on
archive_command = 'pgbackrest --stanza=thp archive-push %p'
archive_timeout = 300
```

`archive_timeout = 300` bounds worst-case data loss to five minutes on an idle database, and is what
the cost estimate above is built on.

```bash
sudo cp deploy/systemd/thp-backup.service deploy/systemd/thp-backup.timer /etc/systemd/system/
sudo cp deploy/systemd/thp-backup-check.service deploy/systemd/thp-backup-check.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thp-backup.timer thp-backup-check.timer
sudo -u postgres pgbackrest --stanza=thp --type=full backup   # don't wait for 02:00
sudo ./scripts/restore-drill.sh
```

**An unverified backup is not a backup.** [scripts/restore-drill.sh](scripts/restore-drill.sh)
restores the newest backup onto a scratch cluster on port 5433, compares its migration journal and
four row counts against production, then removes the scratch cluster and writes a dated receipt. It
refuses to run if its target directory or port is the live one — a drill must not be one typo away
from being the incident it rehearses. `verify:production` fails once that receipt is more than 90
days old, because a backup verified once in 2026 is an unverified backup in 2027.

The morning after setup, confirm the 02:00 timer actually fired: `pgbackrest info` should show two
full backups, not one. A timer that never fires is the only failure here that cannot be detected on
the day it ships.
