#!/usr/bin/env bash
#
# `./scripts/deploy.sh` — pull, install, migrate, build, restart, verify.
#
# Run on the box, as the service user, from the checkout. One command, in the order that matters:
# the migration goes before the build and the restart, so the schema is never behind the code that
# reads it.
#
# **A deploy is a few seconds of downtime**, deliberately. There is no blue/green and no rollback
# command — a bad migration is fixed by another migration or by the restore drill, and pm2 cluster
# mode is not available to the web process for the same reason it is not available to the worker.
#
# It ends by running the verification script, and a failing check fails the deploy. That is the
# only thing standing between "the commands ran" and "the box is in the state it is supposed to be
# in".

set -euo pipefail

cd "$(dirname "$0")/.."

# A deploy that silently ships an uncommitted edit produces a running version nobody can reproduce
# — not from the tag, not from the branch, not from anything. Refuse rather than warn.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree has uncommitted changes. Commit, stash or discard them first:" >&2
  git status --short >&2
  exit 1
fi

echo "==> Pulling"
git pull --ff-only

echo "==> Installing (npm ci — the lockfile, exactly)"
npm ci

# Before the build, because a build that succeeds against a schema the database does not have yet
# is a site that starts and then fails on its first query.
echo "==> Migrating"
npm run migrate

# `.env` is read here, and NEXT_PUBLIC_API_ORIGIN is inlined into the client at this point and
# nowhere later. A build made before .env held the production origin produces a site that looks
# perfectly correct on the box and calls localhost from every visitor's browser.
echo "==> Building"
npm run build

echo "==> Checking the built client calls the right origin"
npm run check:origin

echo "==> Restarting"
pm2 restart ecosystem.config.cjs --update-env
# So a reboot brings back what is running now, rather than what was running at the last save.
pm2 save

echo "==> Verifying"
npm run verify:production
