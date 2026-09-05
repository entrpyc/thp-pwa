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

set -euo pipefail

REQUEST="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$REQUEST" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "refused: expected a release tag such as v1.2.3, got: ${REQUEST:-<nothing>}" >&2
  exit 2
fi

exec "$(dirname "$0")/deploy.sh" "$REQUEST"
