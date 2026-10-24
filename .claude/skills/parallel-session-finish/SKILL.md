---
name: parallel-session-finish
description: Hand a finished parallel-session ticket over for manual validation — from inside a thp-<slug> worktree, commit all changes on the ticket branch (never push; publishing is the operator's), refresh the worktree's database from a copy of main's `thp` database, migrate, seed the admin, start the dev server on the worktree's own port, open it in Chrome, and print a manual validation checklist derived from the branch's diff. Trigger on "done with the changes", "finish the ticket", "hand over for validation", "ready for manual validation", "parallel session finish", or at the end of a parallel-session ticket once typecheck and tests pass.
---

# Parallel session: finish and hand over for validation

Runs **inside a ticket worktree** (`C:\Users\conta\Desktop\thp-<slug>`), never from the main
checkout. Do the steps in order and do not ask questions mid-way; decide from the rules here and
report what you decided at the end.

## 0. Read the worktree's facts

```
git rev-parse --show-toplevel                # must be C:/Users/conta/Desktop/thp-<slug>; stop if it is the main checkout
git rev-parse --abbrev-ref HEAD              # the ticket branch
grep -n "^DATABASE_URL\|^NEXT_PUBLIC_API_ORIGIN\|^MEDIA_BUCKET\|^SEED_ADMIN_EMAIL" .env
```

From `.env`: `db` is the last path segment of `DATABASE_URL`, `port` is the port of
`NEXT_PUBLIC_API_ORIGIN`. If `db` is `thp` or `port` is `3000`, stop: this is not a worktree
`.env`, and continuing would clobber main's data.

## 1. Preconditions

- `npm run typecheck` and `npm test` pass in the worktree. If not, stop and report; the handover
  is for finished work.
- `docker ps --format '{{.Names}}'` lists `thp-postgres`. If Docker is down, start it exactly as
  the `parallel-session` skill describes in its step 1 and wait for `pg_isready`.
- Any dev server or worker **of this worktree** must be stopped before the database is replaced
  (they hold connections to `db`). Find them with
  `Get-NetTCPConnection -LocalPort <port> -State Listen` and stop that process only. Never stop
  anything on port 3000 or any other worktree's port.

## 1b. Commit everything on the ticket branch — do not push

The validator tests what is on the branch, so the branch must hold all of it.

```
git status --porcelain
git add -A
git commit -m "<message>"
```

- Stage everything in the worktree except files the repo gitignores (`git add -A` already honours
  `.gitignore`; `.env` and `.next/` never enter). If `git status` shows a file that should not be
  committed, such as a stray dump or a screenshot, delete it or add it to `.gitignore` in the same
  commit and say so in the report.
- The message: one subject line under 72 characters in the repo's style (imperative, lowercase
  prefix such as `feat:` or `fix:`, PRD number in brackets when the ticket has one), then a blank
  line and a short body saying what changed and why. **No AI attribution lines** of any kind: no
  `Co-Authored-By`, no "Generated with". That is the operator's standing rule for this repo.
- If the tree is already clean, say so and skip the commit; do not create an empty one.
- Commit **once**, on the ticket branch, and stop there. **Never `git push`**, never create a
  remote branch or a pull request, never touch `main`. Publishing the branch is the operator's
  decision; the report tells them the command.

## 2. Replace the worktree's database with a copy of `thp`

Use dump-and-restore, not `createdb -T`: the template form fails whenever main's dev server or
worker is connected to `thp`, and the handover must not depend on the user stopping main.

```
docker exec thp-postgres dropdb -U thp --if-exists <db>
docker exec thp-postgres createdb -U thp <db>
docker exec thp-postgres pg_dump -U thp --no-owner --no-acl thp | docker exec -i thp-postgres psql -U thp -q -v ON_ERROR_STOP=1 <db>
```

Run the pipe from PowerShell or Git Bash; both pass stdin through `docker exec -i`. Then bring the
copy up to the branch's schema:

```
npm run migrate
```

If the branch adds migrations and `npm run migrate` fails because `packages/db/drizzle/` was not
generated yet (the setup skill forbids generating until merge), stop and report it: the validator
cannot exercise a schema change that has no migration. Do not generate migrations here.

## 3. Seed

```
npm run seed:admin
```

Idempotent: the copied `thp` data already holds main's admin, so this normally reports the
account exists and changes nothing. It is here so a worktree whose `.env` names a different
`SEED_ADMIN_EMAIL` still has a known sign-in. The sign-in to hand over is `SEED_ADMIN_EMAIL` from
the worktree's `.env` with its `SEED_ADMIN_PASSWORD`; print the email, never the password.

## 4. Start the server on the worktree's port

Run in the background and keep it running after the turn ends:

```
npm run dev -- -p <port>
```

If the ticket touches the pipeline (transcription, chapters, summaries, embeddings,
cross-references, push, mail), also start the worker in the background: `npm run worker`. It reads
the same `.env`, so it works against `db`.

Wait for the server: poll `http://localhost:<port>/api/v1/health` every 2 seconds for up to 90
seconds until it answers 200. If it never does, stop, show the last 40 lines of the server output,
and skip step 5.

## 5. Open Chrome

```
Start-Process chrome "http://localhost:<port>/"
```

If the ticket has one obvious entry page (a route the diff adds or changes), open that URL instead
of the root. If Chrome is not resolvable, fall back to `Start-Process "http://localhost:<port>/"`
(the default browser) and say so.

## 6. Manual validation checklist

Derive it from the branch, not from memory:

```
git log --oneline main..HEAD
git diff --stat main...HEAD
git diff main...HEAD -- packages/web/src packages/worker/src packages/db/src
```

Write the checklist for a person sitting at the browser who did not watch the work. Rules:

- Start with where to go and how to sign in: `http://localhost:<port>/`, the admin email, and
  that the password is `SEED_ADMIN_PASSWORD` in `<dir>\.env`.
- One numbered item per behaviour the ticket changed or added. Each item is: the page or action
  (a URL on `localhost:<port>` where one exists), the exact steps, and the expected result in one
  sentence. Where the change is a fix, include the old wrong behaviour so the validator knows what
  "fixed" looks like.
- Add the feel checks the tests cannot make: timing, animation, focus, what the screen looks like
  at phone width, what the empty state and the error state look like. Mark them as feel checks.
- Add one regression item per neighbouring feature the diff touches, phrased as "still works".
- If a step needs data the copied database may not have (a recording in a certain state, a second
  member, a note with an image), say what to create first and where.
- Ten items is plenty. If the diff is bigger than that, group by screen.

## 7. Report

Finish with, in this order:

1. One line each: the commit made (short hash and subject, or "tree was already clean"), database
   replaced from `thp` (and whether migrations ran), seed result, server URL, whether the worker
   runs, what opened in Chrome.
2. Anything skipped or failed, with the output.
3. The validation checklist from step 6.
4. How to stop the server when done, the command to publish the branch if the operator wants it
   (`git push -u origin <slug>`, run by them, not by you), and the merge cleanup from the
   `parallel-session` skill:

```
git -C C:\Users\conta\Desktop\thp merge --ff-only <slug>   # after rebase + typecheck + test in the worktree
npm run migrate                                            # on main, if the ticket added migrations
git worktree remove ..\thp-<slug> && git branch -d <slug>
docker exec thp-postgres dropdb -U thp <db>
```
