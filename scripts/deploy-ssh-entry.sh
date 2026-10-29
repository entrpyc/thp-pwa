#!/usr/bin/env bash
#
# The forced command behind the deploy key — **the only thing that key can do is deploy a tag.**
#
# On the box, the deploy key's line in ~thp/.ssh/authorized_keys begins with
#
#   command="/home/thp/app/scripts/deploy-ssh-entry.sh",no-port-forwarding,no-agent-forwarding,no-pty,no-X11-forwarding
#
# so sshd runs this script for every connection made with that key, whatever the client asked for.
# What the client asked for arrives in SSH_ORIGINAL_COMMAND; the Deploy workflow sends just the tag.
# Anything that is not exactly a release tag is refused before it reaches a shell. The key leaking
# is then a deploy of an already-published release, not a shell on the box.
#
# **And not an older one** (docs/security-audit-2026-10-29.md, finding 23): the key is a
# repository-level secret, and the one thing a holder could usefully do with it is put back a
# release with a known bug. A tag below the one checked out is refused unless the request says
# `rollback` after it — `v1.6.2 rollback` — which the Deploy workflow never sends, so a rollback is
# a person at a terminal with the key, on purpose.

set -euo pipefail

REQUEST="${SSH_ORIGINAL_COMMAND:-}"
TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'

TAG="${REQUEST%% *}"
MODE="${REQUEST#"$TAG"}"
MODE="${MODE# }"

if [[ ! "$TAG" =~ $TAG_PATTERN ]] || [[ -n "$MODE" && "$MODE" != "rollback" ]]; then
  echo "refused: expected a release tag such as v1.2.3 (optionally followed by 'rollback'), got: ${REQUEST:-<nothing>}" >&2
  exit 2
fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CURRENT="$(git -C "$APP_DIR" describe --tags --exact-match 2>/dev/null || true)"

# `sort -V` orders version strings; the lower of the two sorts first. Equal is a redeploy, allowed.
if [[ "$MODE" != "rollback" && "$CURRENT" =~ $TAG_PATTERN && "$TAG" != "$CURRENT" ]]; then
  LOWER="$(printf '%s\n%s\n' "$TAG" "$CURRENT" | sort -V | head -n 1)"
  if [[ "$LOWER" == "$TAG" ]]; then
    echo "refused: $TAG is older than the deployed $CURRENT. A rollback is deliberate: send '$TAG rollback' from a terminal." >&2
    exit 3
  fi
fi

exec "$APP_DIR/scripts/deploy.sh" "$TAG"
