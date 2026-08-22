# Ticket 01–03 — The host, the supervised services, and backups with a proven restore
_Story: Run it in production_

> Phase 6 artefact for [implementation plan § Ticket 01](docs/epics/epic-core-listening/implementation-plan.md#L464),
> [§ Ticket 02](docs/epics/epic-core-listening/implementation-plan.md#L480) and
> [§ Ticket 03](docs/epics/epic-core-listening/implementation-plan.md#L495) — **all three tickets of the story
> planned as one doc at the operator's instruction.** The plan cuts them into three; this doc puts them back
> together. The criteria stay in three groups, in the plan's order, so the thirds can still be run apart —
> and here that matters more than it did in earlier stories, because each group ends at a state the box is
> actually left in overnight.
>
> Sections pulled, Ticket 01: [project architecture § Estimated running costs](docs/project/architecture.md#L343)
> — the deployment-topology paragraph; [epic architecture § Overview](docs/epics/epic-core-listening/architecture.md#L7);
> [epic architecture § Primary datastore](docs/epics/epic-core-listening/architecture.md#L177);
> [01-project-skeleton.md § Assumptions to confirm](docs/epics/epic-core-listening/stories/get-a-person-in/01-project-skeleton.md#L99)
> — item 1; [§6](docs/project/prd.md#L724) Security.
> Ticket 02: [project architecture § Estimated running costs](docs/project/architecture.md#L343) — where worker
> concurrency 1 comes from; [epic architecture § Worker process](docs/epics/epic-core-listening/architecture.md#L139);
> [epic architecture § Next.js application — API half](docs/epics/epic-core-listening/architecture.md#L123);
> [01-project-skeleton.md § Assumptions to confirm](docs/epics/epic-core-listening/stories/get-a-person-in/01-project-skeleton.md#L99)
> — item 2, the API origin; [5.2.2](docs/project/prd.md#L706).
> Ticket 03: [epic architecture § Primary datastore](docs/epics/epic-core-listening/architecture.md#L177);
> [project architecture § Key technology choices](docs/project/architecture.md#L209) — the single-datastore row;
> [project architecture § Estimated running costs](docs/project/architecture.md#L343) — the *Database backups* row;
> [§6](docs/project/prd.md#L724) — *Storage*, "nothing expires".
>
> Carried in because this story touches them: [epic prd § In scope → 8](docs/epics/epic-core-listening/prd.md#L161),
> the platform baseline this story is the whole of; [3.4.9](docs/project/prd.md#L102) and
> [epic architecture § Media store](docs/epics/epic-core-listening/architecture.md#L164), the never-deleted original
> that decides the backup bucket is a *second* bucket;
> [epic architecture § Job ledger](docs/epics/epic-core-listening/architecture.md#L157) and
> [3.21.2.4](docs/project/prd.md#L486), the at-least-once contract that makes killing the worker a safe drill;
> [epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341);
> [implementation plan § Standing constraints](docs/epics/epic-core-listening/implementation-plan.md#L48);
> [implementation plan § Summary](docs/epics/epic-core-listening/implementation-plan.md#L553) — the *Recovery is a
> startup sweep* and *the provider is handed a location* decisions, both of which this story's configuration
> depends on.

**This is the last story of the epic and the only one that ships no member-visible behaviour.** Its payoff is
that every other story stops being true only on a laptop.

**Six things worth naming before the criteria.**

**Almost none of this is work Claude can perform.** There is no SSH access to the box from here. What this
story produces from the repository side is *artefacts*: an nginx server block, a pm2 ecosystem file, a deploy
script, a production verification script, a pgBackRest configuration and its timers, a restore-drill script,
the single development mock switch and its tests, and a Deployment section in the README. Every one of them is
then run by the operator, on the box, by hand. That split is why *User steps* below is longer than the
acceptance criteria, and it is the correct shape for this story rather than a gap in it.

**"Verified by" mostly means one checked-in script, run on the box.** `npm run verify:production` is the test
for the infrastructure criteria: it runs **on the host**, reads the host's `.env`, and prints one pass/fail
line per named check. Anything a CI runner could assert is not what this story is about — the thing under
test is a machine that does not exist in CI. Two criteria are exceptions and are provable by `npm test` and
the existing CI build: the mock switch, and the absence of a same-host fallback anywhere in the client.

**The host is not the one the cost table priced, and one dimension of that matters.** The table assumes a
netcup VPS 1000 G12 — 4 vCPU, 8 GB, 256 GB NVMe. The box is an existing Contabo Ubuntu VPS at 4 vCPU, 8 GB,
**100 GB** SSD. CPU and RAM are like-for-like, so the contention argument in
[project architecture § Estimated running costs](docs/project/architecture.md#L343) — worker concurrency pinned to
1 — carries over unchanged. Disk is 39% of what was assumed, and the reason that is fine is that the only
unbounded store in this product is object storage: media never touches this disk. What *does* grow on it is
Postgres, its WAL, and pm2's logs, which is why log rotation is configured rather than left to be discovered.

**nginx already serves other things on this box, and this story must not disturb them.** The vhost is a new
file under `sites-available` symlinked into `sites-enabled`; no existing file is edited, and the new server
block does not claim `default_server`. certbot is already installed with its renewal timer, so TLS renewal is
a property the box already has rather than something this story introduces — which is why the criterion below
is that renewal is *proven*, not that it is *set up*.

**pm2 replaces the systemd units the plan assumed, and one pm2 default would break the worker.** The plan's
Ticket 02 says "supervised services"; `pm2 startup systemd` plus `pm2 save` is what makes that start-on-boot,
and `autorestart` is what makes it restart-on-failure. The trap is `exec_mode`: pm2's cluster mode runs N
copies of a process, and the worker's crash-recovery sweep
([implementation plan § Summary](docs/epics/epic-core-listening/implementation-plan.md#L553), the *Recovery is a
startup sweep* decision) assumes a **single** worker process — a second copy would reclaim jobs the first one
is actively running. So the worker is `fork` mode, `instances: 1`, and that is the same pin the cost table's
concurrency-1 line asks for, arriving by a different route.

**The backup line costs about ten cents a month, not one dollar.** Checked against
[Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/): $0.015/GB-month storage, $4.50 per
million Class A operations, egress free. This database is metadata, transcripts and segments — comfortably
under 1 GB for years — so two retained full backups plus a WAL archive is roughly 1–3 GB, about $0.02–0.05.
With `archive_timeout` at 300 seconds the archive pushes at most ~8,700 WAL segments a month, about $0.04 in
Class A operations. Call it **$0.10/month** against the $1 the table budgets. The account's 10 GB free storage
tier is already consumed by media, so this prices at standard rates rather than free — the estimate assumes no
free tier at all.

## Goal

The epic runs on the box it will live on, at its real domain, over TLS, survives a reboot with no manual step,
and has a database backup that has been restored at least once and verified.

- As an operator I want the application reachable at its real domain over HTTPS, with the certificate renewing
  itself, so nobody has to remember a 90-day deadline
- As an operator I want the app and the worker to come back on their own — after a crash, and after a reboot —
  without me logging in
- As an operator I want one command to deploy a new version, and one command that tells me whether the box is
  in the state it is supposed to be in
- As an operator I want to know the database can be restored, because I have restored it, not because a backup
  file exists
- As an operator I want production spend to be distinguishable from my own testing, so a bill tells me
  something
- As a developer I want to run the whole product locally without reaching any paid provider, from one switch

## Out of scope

**Deferred infrastructure this story must not reach for.** Everything in
[epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341): no CDN in front of
media, no Redis or broker in front of the ledger, no `CREATE EXTENSION vector`, no second host, no read
replica, and no move of any role off this box. The topology decision is
[project architecture § Estimated running costs](docs/project/architecture.md#L343)'s, and this story executes it
rather than revisiting it.

**Operational surface a reasonable implementer would add here and should not.** Error tracking, log shipping,
metrics, dashboards, alerting or an uptime monitor — the cost table's launch line for all of that is $0, and
the first of them is a decision for whoever is on call, which is nobody yet. A status page. A staging
environment or a second deployed origin of any kind. Automated deployment on push: CI stays install →
typecheck → migrate → test → build, and deploying is a command a person runs.

**Deploy sophistication.** Zero-downtime deploys, blue/green, a rollback command, or pm2 cluster mode for the
web process — a deploy is a `pm2 restart` and a few seconds of downtime, settled with the operator. Migration
rollback: `npm run migrate` goes forward, and a bad migration is fixed by a new migration or by the restore
this story proves.

**Containerising anything.** Postgres is installed from packages, not run from `docker-compose.yml` — that
file stays exactly what it is, the development database and MinIO. The application is not containerised
either.

**Backup scope.** No backup of the media bucket — the original upload is the one thing this product never
deletes ([3.4.9](docs/project/prd.md#L102),
[epic architecture § Media store](docs/epics/epic-core-listening/architecture.md#L164)), object storage is already
durable, and a copy of 95 GB would cost more than every other line in the table combined. No second backup
destination outside R2. No rehearsed *production* restore procedure beyond the scratch drill — restoring over
the live cluster is an incident decision, not a script this story ships.

**Data.** Nothing migrates development data to production. The production database starts empty.

**Not this story.** Any change to what the application does. If the smoke run surfaces a bug, that is a finding
for story validation, not a fix folded in here — with one exception named as a criterion below, because it is
the exact failure the absolute-origin rule was held eighteen tickets to catch.

## User prerequisites

Every one of these is on the box or in a provider console, and none of them can be done from here.

- **SSH access to `167.86.71.60`** with a key, and `sudo`. Confirm the Ubuntu release (`lsb_release -a`) — it
  decides whether PostgreSQL 17 comes from the distribution or from the PGDG apt repository.
- **Confirm what nginx already serves on the box** — `ls /etc/nginx/sites-enabled/`, and whether any block is
  `default_server`. The new vhost must not collide on `server_name` and must not take the default.
- **Confirm certbot's renewal timer is active** — `systemctl status certbot.timer` (or `snap.certbot.renew`).
- **Node ≥ 22 and pm2 on the box.** `package.json` sets `engines.node >= 22`; confirm `node -v` and `pm2 -v`,
  and that pm2 belongs to the user that will own the checkout rather than to root.
- **A production R2 bucket for media**, with public access **off**, a **CORS rule permitting `PUT` and its
  preflight from `https://thp.indepthwebsolutions.com` with `content-type` on the allowed headers**, and its
  **own** API token. Without the CORS rule the browser cannot upload at all and the screen genuinely cannot say
  why — see README, *Media store*.
- **A second R2 bucket for backups**, with its own API token **scoped to that bucket only**. Not the media
  bucket, and not the media bucket's credentials: retention deletes from this one by design, and the media
  bucket is the one nothing may ever delete from.
- **Production API keys, separate from any development key**: Deepgram, MiniMax and Resend. Separate keys are
  what make the provider consoles able to answer "what did production spend".
- **The Resend sending domain verified**, and a `MAIL_FROM` on it — an unverified domain is rejected or filed
  as spam, and the first thing production sends is an invitation.
- **The production `SEED_ADMIN_EMAIL`, `SEED_ADMIN_DISPLAY_NAME` and `SEED_ADMIN_PASSWORD`** decided. The seed
  command refuses a weak password rather than seeding a guessable account.
- **A short real audio file (~60 seconds)** for the production smoke run. It spends about half a cent of ASR
  and proves the pipeline against real providers, from the real bucket.

## Acceptance criteria

### Group 1 — The host, Postgres and TLS (plan Ticket 01)

This group ends with **the platform answering and the application not yet deployed** — the vhost proxies to
`127.0.0.1:3000`, nothing is listening there, and a `502` behind a valid certificate is the correct end state.

- **`https://thp.indepthwebsolutions.com` terminates TLS with a valid certificate, plain HTTP redirects to it,
  and the certificate renews without anyone acting** — verified by `npm run verify:production` checks `tls` and
  `http-redirect`, which fetch the origin and assert the chain validates and the leaf expires more than 20 days
  out, assert `http://` answers a 301 to the `https://` origin, and assert `certbot renew --dry-run` exits 0.
  - A new server block checked into the repository as `deploy/nginx/thp.conf` and symlinked on the box; no
    existing nginx file is edited, and the block does not claim `default_server`.
  - It proxies to `127.0.0.1:3000` and sets `X-Forwarded-Proto`, `X-Forwarded-For` and `Host`, so the
    application sees the real scheme and origin rather than the proxy's.
  - Renewal is certbot's existing timer. The dry run is the criterion because a certificate that has never
    proven it renews is a 90-day outage with a start date.

- **PostgreSQL 17 runs on the host with the `vector` extension installed and available but *not* enabled** —
  verified by `npm run verify:production` check `pgvector`, which asserts `vector` appears in
  `pg_available_extensions` and does **not** appear in `pg_extension`.
  - `postgresql-17` and `postgresql-17-pgvector` from packages, PGDG apt repository if the release does not
    carry 17.
  - Both halves are asserted, which is the same pair `packages/db/tests/integration/pgvector.test.ts` already
    asserts in development — the property
    [epic architecture § Primary datastore](docs/epics/epic-core-listening/architecture.md#L177) requires, kept true on
    the box that will still be running when a later epic needs it.
  - A dedicated database and role for the application; the role owns its database and nothing else.

- **Postgres is not reachable from outside the box, and only 22, 80 and 443 are** — verified by
  `npm run verify:production` check `network`, which asserts `listen_addresses` is localhost, asserts a TCP
  connect to `167.86.71.60:5432` is refused, and asserts `ufw` is active with exactly those three ports open.
  - `listen_addresses = 'localhost'` in `postgresql.conf`, and `ufw` default-deny inbound.
  - The refused connection to the *public* address is the check that means it, because a configuration value
    and a reachable port are two different claims.

- **The application runs as a non-root user that owns its checkout, and SSH accepts keys only** — verified by
  `npm run verify:production` check `hardening`, which asserts the checkout's owner is not root, that the
  process user is that owner, and that `PasswordAuthentication` and `PermitRootLogin` are both off in the
  effective `sshd` configuration.
  - A dedicated service user, with the checkout under its home directory.
  - Contabo images commonly ship with root password login enabled, so this is a change to make rather than a
    setting to confirm.

- **Every secret lives in one `.env` on the box, readable only by the service user, and nothing secret is in
  the repository** — verified by `npm run verify:production` check `secrets`, which asserts the file's mode is
  `0600` and its owner is the service user, asserts `git status --porcelain` in the checkout is empty, and
  asserts `.env` is ignored by git.
  - One `.env` at the repository root, exactly as `scripts/with-env.mjs` already requires — production is the
    same file with production values, so there is no second mechanism to learn.
  - The check reads the file's metadata only, and never prints a value.

### Group 2 — App and worker as supervised services (plan Ticket 02)

- **The app and the worker run under pm2, and the worker runs as exactly one process in fork mode** — verified
  by `npm run verify:production` check `services`, which reads `pm2 jlist` and asserts both are `online`, that
  the worker's `exec_mode` is `fork` and `instances` is 1, and that no second worker process exists in the
  process table.
  - A checked-in `ecosystem.config.cjs` declaring `thp-web` (`npm start`) and `thp-worker` (`npm run worker`).
  - Fork mode with one instance is the concurrency pin
    [project architecture § Estimated running costs](docs/project/architecture.md#L343) asks for, and it is also what
    the worker's boot sweep requires: a second copy would reclaim jobs the first is still running.
  - `pm2-logrotate` configured with a size cap and a retention count, because the box has 100 GB and pm2's logs
    are otherwise unbounded.

- **A crash brings the process back** — verified by `npm run verify:production --kill-drill`, which records the
  worker's pid, kills it, waits, and asserts pm2 reports it `online` again under a different pid with an
  incremented restart count.
  - `autorestart: true` with a restart delay, so a process that cannot start at all does not spin.
  - Killing the worker is safe to do as a drill precisely because dispatch is at-least-once and the boot sweep
    reclaims what a dead worker left `running` — the drill exercises the recovery path rather than working
    around it.

- **A reboot brings everything back with no manual step** — verified by `npm run verify:production` check
  `boot`, which asserts the pm2 systemd unit is `enabled`, asserts the saved process list contains both apps,
  and asserts `postgresql` and `nginx` are `enabled`; and by the operator rebooting the box and re-running the
  whole script, which is the User step that proves it rather than describes it.
  - `pm2 startup systemd` installs the unit; `pm2 save` writes the list it restores.
  - The list is saved *after* both apps are running, because pm2 restores what was saved and not what the
    config file says.

- **`npm run migrate` applies migrations to production, and running it twice changes nothing** — verified by
  `npm run verify:production` check `migrations`, which asserts no journal entry is unapplied and that a second
  run reports zero applied.
  - The same command development uses, with the production `DATABASE_URL` — no production-only migration path
    exists, which is the point of the plan's wording.
  - The deploy script runs it before the restart, so the schema is never behind the code that reads it.

- **Nothing in the client falls back to a same-host origin, and the deployed build carries the real one** —
  verified by a new `tests/guards/origin-boundary.test.ts`, which asserts `NEXT_PUBLIC_API_ORIGIN` is read in
  exactly one module and that no source anywhere supplies a default, relative or same-host value for it; by a
  new `npm run check:origin` step added to CI after `npm run build`, which scans the build output and fails if
  `http://localhost` appears in it; and by `npm run verify:production` check `origin`, which asserts the real
  origin literal is present in the build actually on the box.
  - The value is inlined at build time, so this is a property of the artefact rather than of the environment —
    which is why it is asserted against files and not against a running process.
  - **If anything in the client turns out to assume same-host, fixing it is in scope here.** This is the
    criterion the absolute-origin rule has been held for since the first ticket of the epic
    ([5.2.2](docs/project/prd.md#L706)), and fixing it here rather than in the packaging epic is the cheap
    version.

- **The diagnostic routes are off in production** — verified by `npm run verify:production` check
  `diagnostics`, which asserts `ENABLE_DIAGNOSTIC_ROUTES` is not `true` in the host's environment and that
  `GET /api/v1/diagnostics/unguarded` against the real origin does not answer with a payload.
  - Nothing is added; the existing guard is asserted from outside, which is the only place it matters.

- **One command deploys a new version and leaves the box in a state the verification script passes** —
  verified by `scripts/deploy.sh` running to completion and ending by invoking `npm run verify:production`,
  whose non-zero exit fails the deploy.
  - `git pull → npm ci → npm run migrate → npm run build → pm2 restart ecosystem.config.cjs → verify`.
  - The restart is a few seconds of downtime, accepted rather than engineered around.
  - The script refuses to run on a dirty working tree, because a deploy that silently ships an uncommitted edit
    is a version nobody can reproduce.

- **The whole epic works on the box, against real providers** — verified by
  `npm run verify:production --smoke`, which signs in as the seeded admin, creates a recording, uploads the
  operator's short audio file through a real presigned `PUT` to the production bucket, polls the pipeline until
  `transcribe` and `generate_draft` both report success, publishes the result, and asserts a member request can
  read it and mint a playable URL.
  - This is the run that proves the parts no local environment can: a presigned `PUT` from the real origin
    through the real CORS rule, and an ASR provider **fetching the object itself** from a bucket it can reach —
    the boundary that makes MinIO unusable for real transcription and is therefore untested until now.
  - It spends real money — roughly half a cent — and is re-runnable.
  - The recording it creates is left in place, or unpublished by hand afterwards. The script does not delete,
    because nothing in this product deletes media.

- **One environment variable puts development on mocks for every external provider at once** — verified by a
  new `tests/guards/mock-switch.test.ts`, which asserts that with `THP_MOCK_EXTERNAL=true` the ASR provider,
  the generation provider and the mail transport all resolve to their fake or capture implementations even when
  a real provider is named alongside, and that with it unset each reads its own variable exactly as it does
  today.
  - One helper in `@thp/shared`, read by the three existing readers — `readAsrProvider`, `readGenerateProvider`
    and `readTransportName` — so "mocked" has one definition rather than three.
  - **The mock wins over an explicitly named real provider**, because the switch's promise is that no external
    call happens, and a switch with exceptions cannot make that promise.
  - This is what makes MinIO viable for development at all: the ASR provider is handed a signed URL and fetches
    the object itself, and a bucket on `127.0.0.1` is not reachable from a provider — so a MinIO development
    environment *cannot* use real transcription, and the switch is the honest version of that rather than a
    convenience.
  - `.env.example` documents it and leaves development on MinIO with the switch on and no real keys present.
  - `npm run verify:production` check `not-mocked` asserts the variable is **not** set on the box.

### Group 3 — Backups with a proven restore (plan Ticket 03)

- **pgBackRest archives a nightly full backup and a continuous WAL stream to the backups bucket, and its own
  self-check passes** — verified by `npm run verify:production` check `backup`, which asserts `pgbackrest
  check` exits 0, parses `pgbackrest info` to assert a full backup exists whose age is under 26 hours, and
  asserts the WAL archive status is `ok`.
  - `deploy/pgbackrest/pgbackrest.conf` checked into the repository, with the bucket and credentials read from
    the host, an S3-compatible repository pointed at R2, and `repo1-retention-full=2`.
  - `archive_mode = on`, an `archive_command`, and `archive_timeout = 300` in `postgresql.conf` — bounding
    worst-case data loss to five minutes on an idle database.
  - A systemd timer at 02:00 UTC runs the full backup; a second timer runs `pgbackrest check` daily, because an
    archive that silently stopped is the failure this whole group exists to prevent.
  - The threshold is 26 hours rather than 24 so that a check run shortly before the nightly timer does not
    report a false failure.

- **The backups bucket is separate from the media bucket, under its own credentials, and is not publicly
  readable** — verified by `npm run verify:production` check `backup-isolation`, which asserts the configured
  backup bucket name differs from `MEDIA_BUCKET`, asserts the two access key ids differ, and asserts an
  unsigned `GET` of a known backup object is refused.
  - Retention deletes from this bucket by design, and the media bucket is the one nothing may ever delete from
    — one credential across both would put a delete capability exactly where the epic's single non-negotiable
    says there is none.

- **A restore has actually been performed onto a scratch database, and the restored data matches production** —
  verified by `scripts/restore-drill.sh` exiting 0: it restores the latest backup into a scratch data
  directory, starts it on a spare port, and asserts the restored cluster's migration journal matches
  production's and its row counts for accounts, recordings, transcripts and segments match production's,
  printing the comparison it asserted on.
  - The script **refuses to run if its target directory is the live data directory or its port is the live
    port** — the drill must not be one typo away from being the incident.
  - The scratch cluster is stopped and removed at the end, and the script writes a dated receipt the
    verification script can read.
  - Counts may legitimately differ by whatever landed inside the WAL window; the assertion is that the restored
    counts equal production's or trail them by at most that window, not that they are frozen.

- **The verification script fails when the last restore drill is stale** — verified by
  `npm run verify:production` check `restore-drill-age`, which asserts a drill receipt exists and is younger
  than 90 days.
  - An unverified backup is not a backup, and a backup verified once in 2026 is an unverified backup in 2027.

## User steps

Ordered. Everything here is on the box or in a provider console.

**Group 1 — the platform**

1. Harden the box: create the service user, disable SSH password and root login, enable `ufw` with 22/80/443.
2. Install PostgreSQL 17 and `postgresql-17-pgvector`; create the application database and role; set
   `listen_addresses = 'localhost'`.
3. Symlink `deploy/nginx/thp.conf` into `sites-enabled`, run `nginx -t`, reload.
4. **Confirm** the certificate rather than issuing it — `certbot certificates` — then prove renewal
   with `certbot renew --dry-run`. It was already issued for this host on 14 Aug 2026 and certbot
   manages the nginx TLS lines; re-running `certbot --nginx` would rewrite a block it owns.
5. Create the two R2 buckets and their two tokens; set the media bucket's CORS rule, and confirm public access
   is off on both.
6. Clone the repository as the service user and write `.env` from `.env.example` with the production values;
   `chmod 600`.

**Group 2 — the services**

7. `npm ci && npm run migrate && npm run build`.
8. `pm2 start ecosystem.config.cjs`, `pm2 startup systemd`, `pm2 save`, and install `pm2-logrotate`.
9. `npm run seed:admin`, then sign in at the real origin.
10. `npm run verify:production` — every check green before going further.
11. `npm run verify:production --kill-drill`.
12. **Reboot the box**, wait, and run `npm run verify:production` again without touching anything. This is the
    criterion; the configuration is only the claim.
13. `npm run verify:production --smoke` with your short audio file, and watch it through `/admin/pipeline`.

**Group 3 — the backups**

14. Install pgBackRest, place `deploy/pgbackrest/pgbackrest.conf`, add the R2 credentials, and run
    `pgbackrest stanza-create`.
15. Set `archive_mode`, `archive_command` and `archive_timeout`, and restart Postgres.
16. Install the two systemd timers, and take the first full backup by hand rather than waiting for 02:00.
17. Run `scripts/restore-drill.sh`, read the comparison it prints, and keep the receipt.
18. **The next morning, confirm the 02:00 backup landed** — `pgbackrest info` should show two fulls, not one.
    A timer that never fired is the only failure in this story that cannot be detected on the day it ships.

## Assumptions

### Major (confirmed with the operator)

- The host is an existing Contabo Ubuntu VPS at `167.86.71.60` — 4 vCPU, 8 GB RAM, 100 GB SSD — not the netcup
  box the cost table names; CPU and RAM are like-for-like and the disk difference does not bind, because media
  lives in object storage.
- The origin is `https://thp.indepthwebsolutions.com`, already resolving by a CNAME to
  `indepthwebsolutions.com` and an A record to the box. The apex is therefore in the path: moving it moves
  this.
- The application, the worker and Postgres share the one host, and Postgres is installed from packages rather
  than run in a container — which is what pgBackRest's WAL access and systemd supervision want.
- TLS is nginx plus certbot, both already installed and running on the box, with a new vhost added beside the
  existing sites and none of them edited.
- Supervision is **pm2**, not systemd units: `pm2 startup` for boot, `autorestart` for crashes, and fork mode
  with one instance for the worker.
- Code reaches the box by `git clone`, and deploys are a checked-in `scripts/deploy.sh` — pull, install,
  migrate, build, restart, verify — accepting a few seconds of downtime, with no rollback automation.
- "Verified by" for the infrastructure criteria means one checked-in `scripts/verify-production.mjs`, run on
  the box, printing a pass/fail line per named check, plus `scripts/restore-drill.sh` for the restore.
- Backups go to a **second** R2 bucket under its own scoped token: nightly full at 02:00 UTC, continuous WAL,
  two full backups retained — about $0.10/month against the table's $1 line.
- Development runs against MinIO and production against R2, with separate credentials and separate provider API
  keys for every external service, so production spend is distinguishable from testing.
- Development additionally gets a **single mock switch** that puts ASR, generation and mail on their fakes at
  once, and it overrides an explicitly named real provider.
- Production starts with an empty database: the operator seeds the first admin and uploads real recordings. No
  development data is migrated.

### Minor

- The service user, the checkout path, and the two spare ports the restore drill uses are named in `deploy/`
  and the README rather than being parameters anyone passes.
- `archive_timeout = 300` and `repo1-retention-full=2` are the two numbers the cost estimate above is built on;
  both are single-line changes if the recovery window should be tighter.
- The nightly timer is 02:00 UTC, and the backup freshness threshold is 26 hours.
- The restore-drill receipt is a dated file under the checkout, and 90 days is the staleness threshold.
- `pm2-logrotate` caps log size and retention; no log shipping accompanies it.
- The mock switch is named `THP_MOCK_EXTERNAL`, matching the `THP_SKIP_DOTENV` prefix already in use.
- The verification script exits non-zero on any failing check but still prints every check's line, so one run
  diagnoses rather than bisects.
- `client_max_body_size` on the vhost is set well above the 200 MB upload ceiling even though audio never
  passes through nginx.
- The smoke run's recording is left in the production database rather than deleted.

## Edge cases

- `verify:production` shells out to `sudo` for certbot, ufw, sshd and pgBackRest — without
  passwordless sudo for those, the checks hang on a password prompt rather than failing with a
  message.
- The `secrets` check fails on **any** uncommitted change in the checkout, including a legitimate
  in-progress edit — it reads as a deployment fault when it is a working-tree fault.
- The `tls` check shells out to `openssl`; a box without it on `PATH` reports the certificate as
  failing rather than as unmeasurable.
- The `network` check resolves the origin's hostname and probes 5432 there. If a proxy or CDN is
  ever put in front of the origin, it silently probes that instead of the box.
- The `boot` check finds the pm2 unit by grepping systemd for `pm2` — a unit installed under another
  name reads as absent.
- `restore-drill.sh` requires the restored row counts to match production **exactly**; any write
  during the drill fails it, and the operator has to judge acceptability from the printed table.
- `restore-drill.sh` reads the scratch database name from `PGDATABASE` or falls back to `thp` — a
  differently-named production database makes the comparison query fail rather than compare nothing.
- The smoke run leaves a published recording in production. Nothing cleans it up, because nothing in
  this product deletes media.
- The smoke run gives up after 15 minutes and reports a failure that may only be a slow provider.
- `check:origin` skips its localhost scan when the configured origin *is* localhost, so a locally
  built artefact cannot be checked for the leak the rule exists to catch — only a production-origin
  build can.
- pm2 has `restart_delay` but no `max_restarts` cap, so a permanently broken process restarts every
  five seconds forever, filling the logs until `pm2-logrotate` trims them.
- `deploy/nginx/thp.conf` is a reference to diff against, not a file anything applies — a divergence
  between it and the live block is invisible to every check here.
- `THP_MOCK_EXTERNAL` does not touch the media store: MinIO versus R2 is still the five `MEDIA_`
  variables, so a mocked environment pointed at a real bucket still writes to it.
- `backup-isolation` reads `/etc/pgbackrest/pgbackrest.conf` at that exact path; a configuration
  placed elsewhere reads as absent.
- A deploy whose final verification fails leaves the **new** version running — there is no rollback,
  by decision, so the operator is the recovery path.

## Implementation notes

**Scope built so far: the repository half only.** Everything in this section is about artefacts that
now exist in the checkout — the runbook, the deploy and verification scripts, the nginx, pm2,
pgBackRest and systemd configuration, the mock switch and the origin guard. **No acceptance
criterion in any of the three groups is met yet**, because every one of them is a statement about
the box, and the box work is the operator's. The ticket stays open until those run.

### Assumptions — major (confirmed with the operator)

- The deployment scripts are **TypeScript run under `tsx`**, matching `npm run migrate` and
  `npm run worker` rather than introducing a second script style. The consequence is that
  `npm ci` on the box must install devDependencies — which `npm run build` already required, so this
  adds no new constraint, but setting `NODE_ENV=production` before `npm ci` would break the build
  and the verification together.
- `verify:production` **reports and never repairs.** A script that fixed what it found would be a
  second, undocumented way of configuring the host, and the README runbook is meant to be the only
  one.
- The mock switch **overrides an explicitly named real provider** rather than deferring to it, and
  refuses an unrecognised value instead of reading it as `false` — the failure being prevented is
  `THP_MOCK_EXTERNAL=yes` silently billing a real transcription.

### Assumptions — minor

- `THP_MOCK_EXTERNAL` accepts `true`/`1` and `false`/`0`/unset, trimmed and case-insensitive.
- The mock resolves mail to `capture` rather than `failing`, so a mocked environment still renders a
  readable invitation.
- `isExternalMocked` takes its environment as an argument and never reads `process.env`, because
  `@thp/shared` is importable by the client and a client bundle should not carry that read.
- The origin guard permits **two** readers of `NEXT_PUBLIC_API_ORIGIN` — the client config and the
  mail module, which needs an origin for invitation links and must not use the `Host` header.
- `verify:production` exits non-zero on any failure but runs every check first, so one run diagnoses
  rather than bisects.
- The `backup` check's freshness threshold is 26 hours, so a run shortly before the 02:00 timer is
  not a false failure.
- The backup timers carry `Persistent=true` and five minutes of jitter, so a box that was off at
  02:00 still takes the backup and the two timers never contend.
- `pgbackrest.conf` sets `repo1-cipher-type=none` explicitly rather than by default, because where a
  repository passphrase would live has not been decided.
- `process-max=2` on pgBackRest, so a 02:00 backup does not starve the site on four shared vCPU.
- The restore drill uses port 5433 and `/var/lib/postgresql/restore-drill`, both named in the script
  rather than passed in.
- `.restore-drill` is gitignored, because the `secrets` check requires a clean working tree and the
  receipt lives in the checkout.
- `tests/unit/` was added to the vitest unit project's include list, for repository-level tests that
  belong to no package.
- `scripts/**/*.ts` was added to the tsconfig include list.
- The nginx reference sets `client_max_body_size 25m` and `proxy_read_timeout 60s`; neither is on a
  path audio travels.

### Other notes

- **Group 1's TLS half is already done, and was before this ticket started.** Probed live: a Let's
  Encrypt certificate for exactly `thp.indepthwebsolutions.com`, issued 14 Aug 2026, with
  `http://` answering 301 and nginx 1.18.0 (Ubuntu) returning 502 for the app that is not deployed
  yet — which is precisely the state Group 1 is defined to end in. `verify:production --remote-only`
  run against the box passes `tls`, `http-redirect` and `diagnostics` today.
- **nginx 1.18.0 dates the box to Ubuntu 20.04 or 22.04, and neither ships PostgreSQL 17** — so the
  PGDG apt repository is required, not optional. The runbook has it. If it is 20.04, that release is
  past end of standard support, which is worth deciding about before this becomes the production box.
- **The certificate already existing makes the ticket's own User step 4 wrong as written**, and it
  has been amended: confirm and dry-run, never re-issue.
- `check:origin` was proven both ways rather than assumed: it exits 0 against a build whose origin
  matches, 1 against a mismatched origin — naming the exact bundles carrying `http://localhost` —
  and 2 when the variable is unset. Ten of twenty-five client bundles carry the inlined origin.
- The verification script's parsers are unit-tested against captured command output, and the script
  guards its own entry point so importing it runs no check.
- **The `origin` check is the one worth watching on first deploy.** It is the first time anything has
  asserted that no part of the client assumes same-host, and the ticket puts fixing that in scope.
- **`packages/web/next-env.d.ts` is now gitignored and untracked, and it had to be.** Next rewrites
  it on every build, pointing it at `.next/types` after `next build` and `.next/dev/types` after
  `next dev` — so a tracked copy means `npm run build` dirties the working tree. Combined with
  `deploy.sh` refusing a dirty tree and the `secrets` check asserting a clean one, that made **every
  deploy after the first one refuse to run.** Found by building locally, not by reasoning about it.
