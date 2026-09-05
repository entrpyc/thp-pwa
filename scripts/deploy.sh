#!/usr/bin/env bash
#
# `./scripts/deploy.sh vX.Y.Z` — check out the tag, install, migrate, build, restart, verify.
#
# Run on the box, as the service user, from the checkout — normally by the Deploy workflow through
# scripts/deploy-ssh-entry.sh, after someone approved the release. One command, in the order that
# matters: the migration goes before the build and the restart, so the schema is never behind the
# code that reads it.
#
# It deploys a **release tag**, never a branch. What runs on the box is then reproducible from the
# tag alone, and `verify:production`'s `release` check asserts exactly that at the end.
#
# **A deploy is a few seconds of downtime**, deliberately. There is no blue/green and no rollback
# command — a bad migration is fixed by another migration or by the restore drill, and pm2 cluster
# mode is not available to the web process for the same reason it is not available to the worker.
#
# It ends by running the verification script, and a failing check fails the deploy. That is the
# only thing standing between "the commands ran" and "the box is in the state it is supposed to be
# in".

set -euo pipefail

TAG="${1:-}"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: ./scripts/deploy.sh vX.Y.Z — a release tag, made by the Deploy workflow" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# A deploy that silently ships an uncommitted edit produces a running version nobody can reproduce
# — not from the tag, not from the branch, not from anything. Refuse rather than warn.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree has uncommitted changes. Commit, stash or discard them first:" >&2
  git status --short >&2
  exit 1
fi

# Detached at the tag, deliberately: there is no branch on the box to drift from the release.
echo "==> Checking out $TAG"
git fetch --tags origin
git checkout --quiet --detach "refs/tags/$TAG"

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

# The `release` check compares the checkout against this, so "the commands ran" and "the box runs
# the tag that was approved" are the same statement.
echo "==> Verifying"
THP_RELEASE="$TAG" npm run verify:production
