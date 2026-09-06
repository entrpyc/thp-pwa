#!/usr/bin/env bash
#
# Commit messages must start with `feat:`, `fix:` or `chore:` — **CI refuses a push that does not.**
#
# The Deploy workflow builds the release notes from these prefixes (`feat:` → Features, `fix:` →
# Bug fixes; `chore:` is kept out of the notes), so a commit without one is a change the release
# cannot describe. This checks every non-merge commit in a range and names each one that is wrong.
#
#   scripts/check-commits.sh <from>..<to>      the commits a push or pull request adds
#   scripts/check-commits.sh --message <file>  one message, for a local commit-msg hook:
#                                              git config core.hooksPath .githooks
#
# Merge commits are skipped: GitHub writes "Merge pull request #N" itself. A squash merge takes the
# pull request title, so the title has to follow the rule too.

set -euo pipefail

PATTERN='^(feat|fix|chore): .+'
RULE='must start with "feat: ", "fix: " or "chore: "'

if [ "${1:-}" = "--message" ]; then
  subject=$(sed -n '/^[^#]/{p;q;}' "$2")
  if [[ ! "$subject" =~ $PATTERN ]]; then
    echo "commit message $RULE, got: ${subject:-<empty>}" >&2
    exit 1
  fi
  exit 0
fi

RANGE="${1:?usage: check-commits.sh <from>..<to> | --message <file>}"
bad=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  sha="${line%% *}"
  subject="${line#* }"
  if [[ ! "$subject" =~ $PATTERN ]]; then
    echo "::error::commit $sha $RULE, got: $subject"
    bad=$((bad + 1))
  fi
done < <(git log --no-merges --format='%h %s' "$RANGE")

if [ "$bad" -gt 0 ]; then
  echo "$bad commit(s) in $RANGE break the rule. Reword them (git rebase) and push again." >&2
  exit 1
fi
echo "every commit in $RANGE starts with feat:, fix: or chore:"
