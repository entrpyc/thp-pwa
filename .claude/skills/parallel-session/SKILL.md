---
name: parallel-session
description: Set up an isolated git worktree for working on a ticket in a parallel Claude Code session — own branch, own .env (DATABASE_URL, NEXT_PUBLIC_API_ORIGIN, MEDIA_BUCKET if needed), own Postgres database, npm ci, then open it in a new VS Code window. The handover at the end of the ticket (copy of main's database, seed, dev server on its own port, Chrome, manual validation checklist) is the companion skill parallel-session-finish. Trigger on "use parallel session to work on <ticket>", "parallel session for <ticket>", "new worktree for <ticket>", "spin up a worktree".
---

# Parallel session: isolated worktree for one ticket

The argument is the ticket: a short description, a branch name, or an issue title. Everything
below runs from the main checkout (`C:\Users\conta\Desktop\thp`). Do the steps in order, do not
ask questions mid-way; decide from the rules here and report what you decided at the end.

## 0. Derive names

- `slug`: kebab-case from the ticket, max ~30 chars, letters/digits/hyphens only
  (e.g. "use parallel session to work on the SOS reply thread" → `sos-reply-thread`).
- `branch` = `<slug>`, `dir` = `C:\Users\conta\Desktop\thp-<slug>`, `db` = `thp_<slug with _>`.
- `port`: 3001, or the lowest port ≥ 3001 not used by another worktree. Find used ports with
  `grep -h NEXT_PUBLIC_API_ORIGIN ../thp-*/.env` (ignore the main checkout, which owns 3000).
- `needs_media`: true only if the ticket mentions uploads, images, media, attachments, audio
  files, or the media store. Then `bucket` = `thp-media-<slug>`.
- `clone_data`: true only if the ticket says "with data", "copy of the database", "real data",
  or "same content as main". Default false (empty database + migrations).

## 1. Preconditions (stop and tell the user if any fails)

### Must be run from the main checkout, on `main`

Before anything else:

```
git rev-parse --show-toplevel          # must be C:/Users/conta/Desktop/thp (not a thp-<slug> worktree)
git rev-parse --abbrev-ref HEAD        # must print `main`
```

If either differs, stop immediately and tell the user where the session actually is (which
folder and which branch) and that the skill only runs from the main checkout on `main`. Do not
switch branches or change directory on their behalf; running from a ticket worktree would branch
the new ticket off that ticket's work, and the compose and `.env` steps assume main's layout.

```
git -C C:\Users\conta\Desktop\thp status --porcelain      # must be clean enough: uncommitted changes are fine, but warn
git worktree prune
git worktree list                                          # refuse if dir or branch already exists
docker ps --format '{{.Names}}'                            # must list thp-postgres (and thp-minio if needs_media)
```

### If Docker is not running, start it

`docker ps` failing with "failed to connect to the docker API at npipe://..." means Docker
Desktop is not up. Launch it (per-user install, not Program Files) and wait for the daemon:

```
Start-Process "C:\Users\conta\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe"
```

Then poll `docker ps` once every 5 seconds for up to 2 minutes until it succeeds (a short
PowerShell loop is fine here; the wait is the task). If it is still down after 2 minutes, stop and
tell the user; do not create a half-set-up worktree.

Once the daemon answers, the containers restart on their own (`restart: unless-stopped`), but give
them a moment: poll `docker ps --format '{{.Names}}'` until `thp-postgres` is listed, up to 60
seconds. If it never appears, bring the stack up from the **main checkout** (this skill always
runs from main, so this is the one place `docker compose` is allowed):

```
docker compose -f C:\Users\conta\Desktop\thp\docker-compose.yml up -d
```

Finally wait until Postgres accepts connections before any `createdb`:

```
docker exec thp-postgres pg_isready -U thp -d thp
```

Poll that until it reports "accepting connections", up to 60 seconds.

## 2. Create the worktree

```
git -C C:\Users\conta\Desktop\thp worktree add ..\thp-<slug> -b <slug> main
```

## 3. Copy and adjust `.env`

Copy `C:\Users\conta\Desktop\thp\.env` to `<dir>\.env`. Then change values **with a Node
one-liner that preserves the file's line endings** (see the repo memory about CRLF files; never
sed/perl multi-line edits). Replace whole lines by key:

- `DATABASE_URL=postgres://thp:thp@127.0.0.1:5432/<db>`
- `NEXT_PUBLIC_API_ORIGIN=http://localhost:<port>`
- `MEDIA_BUCKET=<bucket>` only when `needs_media`; otherwise leave it.

Verify with `grep -n "^DATABASE_URL\|^NEXT_PUBLIC_API_ORIGIN\|^MEDIA_BUCKET" <dir>\.env`.

Example edit (run from `<dir>`):

```
node -e "const fs=require('fs');let s=fs.readFileSync('.env','utf8');const set=(k,v)=>{s=s.replace(new RegExp('^'+k+'=.*$','m'),k+'='+v)};set('DATABASE_URL','postgres://thp:thp@127.0.0.1:5432/<db>');set('NEXT_PUBLIC_API_ORIGIN','http://localhost:<port>');fs.writeFileSync('.env',s)"
```

## 4. Install

```
cd <dir> && npm ci
```

Node must be 22 or newer (`engines` in package.json; the machine has 24, which is fine). If `npm ci` fails on the lockfile, stop and report; do not `npm install`.

## 5. Database

Empty (default):

```
docker exec thp-postgres createdb -U thp <db>
cd <dir> && npm run migrate
```

Clone of main's data (`clone_data`):

```
docker exec thp-postgres createdb -U thp -T thp <db>
```

`-T` fails with "source database is being accessed by other users" if the main dev server or
worker is running. In that case do not kill anything: tell the user to stop them and rerun the
one `createdb` command, and continue with the remaining steps. After a clone, still run
`npm run migrate` in `<dir>` (no-op if the branch has no new migrations).

## 6. Media bucket (only when `needs_media`)

```
docker exec thp-minio mc alias set local http://localhost:9000 thp thp-secret-not-a-real-key
docker exec thp-minio mc mb --ignore-existing local/<bucket>
```

Never run `docker compose up` from the worktree: container names are fixed and it fights the
main checkout's containers.

## 7. Open VS Code

```
code <dir>
```

## 8. Report

Finish with a short summary and a paste-ready opening message for the new session, filled in:

```
You are working on <ticket> in the worktree C:\Users\conta\Desktop\thp-<slug>, branch <slug>.
Rules for this session:
- Your database is <db> (DATABASE_URL in this worktree's .env). Never point at the `thp` database.
- Dev server: `npm run dev -- -p <port>`; NEXT_PUBLIC_API_ORIGIN is already http://localhost:<port>.
- Do not run `docker compose`. Postgres and MinIO are shared containers owned by the main checkout.
- Schema changes: edit packages/db/src/schema.ts freely, but do NOT run `npm run db:generate` or
  commit anything under packages/db/drizzle/ until told. Migrations are generated once, right
  before merge, after rebasing on main, so numbering and snapshots don't collide with other tickets.
- Do not check out or modify main. Rebase with `git rebase main` when asked.
- Integration tests are safe here (throwaway DB, free port); they only rebuild .next in this worktree.
- When the changes are done and typecheck + tests pass, invoke the `parallel-session-finish` skill.
  It commits all changes on this branch (no push: publishing the branch is the operator's call),
  replaces <db> with a fresh copy of main's `thp` database, migrates, runs `npm run seed:admin`,
  starts the dev server on port <port>, opens it in Chrome, and prints a manual validation
  checklist derived from the branch's diff. Do not hand over without it.
- After reading this message, do nothing: no exploring, no planning, no edits, no commands. Reply
  with one line confirming the worktree, branch, database and port, then wait for the operator's
  instructions.
```

Also list the cleanup for later, so it ends up in the user's notes:

```
git -C C:\Users\conta\Desktop\thp merge --ff-only <slug>   # after rebase + typecheck + test in the worktree
npm run migrate                                            # on main, if the ticket added migrations
# Stop the worktree's dev server and worker, and close its VS Code window first: an open file
# handle makes the removal below fail halfway.
git -C C:\Users\conta\Desktop\thp worktree remove --force ..\thp-<slug>
Remove-Item -Recurse -Force C:\Users\conta\Desktop\thp-<slug>   # only if the folder is still there
git -C C:\Users\conta\Desktop\thp worktree prune
git -C C:\Users\conta\Desktop\thp branch -d <slug>
docker exec thp-postgres dropdb -U thp <db>
```
