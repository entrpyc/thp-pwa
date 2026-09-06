#!/usr/bin/env bash
#
# Release notes from commit messages — **`feat:` under Features, `fix:` under Bug fixes.**
#
#   scripts/release-notes.sh <from> <to>        commits in <from>..<to>; <from> may be empty for the
#                                               first release (everything up to <to>)
#
# Markdown on stdout. The Deploy workflow puts it on both the annotated tag and the GitHub Release,
# so the tag says what changed even without GitHub. `chore:` commits are left out on purpose: the
# notes are for people using the site, not for people maintaining it. Merge commits are skipped.
# The prefixes are guaranteed by scripts/check-commits.sh in CI, so anything else here is history
# from before that rule and lands under neither heading.
#
# Set REPO_URL (https://github.com/owner/repo) to link each commit and add a compare link.

set -euo pipefail

FROM="${1-}"
TO="${2:?usage: release-notes.sh <from> <to>}"
RANGE="$TO"
[ -n "$FROM" ] && RANGE="$FROM..$TO"

features=""
fixes=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  sha="${line%% *}"
  subject="${line#* }"
  if [ -n "${REPO_URL:-}" ]; then
    ref="([${sha}](${REPO_URL}/commit/${sha}))"
  else
    ref="(${sha})"
  fi
  case "$subject" in
    "feat: "*) features+="- ${subject#feat: } ${ref}"$'\n' ;;
    "fix: "*)  fixes+="- ${subject#fix: } ${ref}"$'\n' ;;
  esac
done < <(git log --no-merges --reverse --format='%h %s' "$RANGE")

if [ -n "$features" ]; then
  printf '## Features\n\n%s\n' "$features"
fi
if [ -n "$fixes" ]; then
  printf '## Bug fixes\n\n%s\n' "$fixes"
fi
if [ -z "$features$fixes" ]; then
  printf 'No features or bug fixes in this release.\n\n'
fi
if [ -n "${REPO_URL:-}" ] && [ -n "$FROM" ]; then
  printf '**Full changelog**: %s/compare/%s...%s\n' "$REPO_URL" "$FROM" "$TO"
fi
