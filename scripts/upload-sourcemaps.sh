#!/usr/bin/env bash
#
# `./scripts/upload-sourcemaps.sh vX.Y.Z` — give PostHog the client source maps for this build,
# then delete them from the box (docs/project/observability.md § 5.6).
#
# Runs in scripts/deploy.sh between the build and the restart. `next build` writes a `.map` beside
# every client chunk (`productionBrowserSourceMaps` in packages/web/next.config.ts); the PostHog CLI
# stamps each chunk with a content id, uploads chunk and map as one symbol set tied to the release,
# and — `--delete-after` — removes the maps and the `sourceMappingURL` comments. What the box then
# serves is the stamped chunk and nothing that reveals the source; what PostHog holds is what turns
# a minified frame in a browser exception into a file and a line.
#
# **Optional, and says so.** A box with no CLI credentials in `.env` skips the upload with one
# line; it does not fail the deploy, because readable stack traces are a convenience and a deploy
# is not. The maps are deleted either way: a map nobody uploaded is still the source, and the box
# serves whatever the build left under .next/static. The two variables, `POSTHOG_CLI_API_KEY` and
# `POSTHOG_CLI_PROJECT_ID`, are read by the CLI itself from the environment (see .env.example).
#
# `verify:production`'s `source-maps` check is what notices when this did not run: it fetches the
# served chunks and refuses a map it can download, and — with the credentials set — a chunk the
# CLI never stamped.

set -euo pipefail

TAG="${1:-}"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: ./scripts/upload-sourcemaps.sh vX.Y.Z — the release tag being deployed" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# The same loader the app's npm scripts use, so `.env` is read once and the same way.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

CHUNKS="packages/web/.next/static"
if [[ ! -d "$CHUNKS" ]]; then
  echo "upload-sourcemaps: $CHUNKS does not exist — run the build first" >&2
  exit 1
fi

if [[ -z "${POSTHOG_CLI_API_KEY:-}" || -z "${POSTHOG_CLI_PROJECT_ID:-}" ]]; then
  echo "upload-sourcemaps: POSTHOG_CLI_API_KEY or POSTHOG_CLI_PROJECT_ID is not set — skipping the upload; browser stack traces will be minified"
  echo "upload-sourcemaps: deleting the $(find "$CHUNKS" -name '*.map' | wc -l | tr -d ' ') .map file(s) under $CHUNKS so the box serves none"
  find "$CHUNKS" -name '*.map' -delete
  exit 0
fi

# The app host (where you sign in), not the ingestion host the SDK posts to. Derived from
# NEXT_PUBLIC_POSTHOG_HOST so the region is named once: `eu.i.posthog.com` → `eu.posthog.com`.
HOST="${POSTHOG_CLI_HOST:-${NEXT_PUBLIC_POSTHOG_HOST/.i.posthog.com/.posthog.com}}"

echo "==> Uploading client source maps for $TAG to $HOST (project $POSTHOG_CLI_PROJECT_ID)"
npx posthog-cli --host "$HOST" sourcemap process \
  --directory "$CHUNKS" \
  --release-name thp-web \
  --release-version "$TAG" \
  --delete-after

REMAINING="$(find "$CHUNKS" -name '*.map' | wc -l | tr -d ' ')"
if [[ "$REMAINING" != "0" ]]; then
  echo "upload-sourcemaps: $REMAINING .map file(s) still under $CHUNKS after upload — deleting so the box serves none" >&2
  find "$CHUNKS" -name '*.map' -delete
fi
echo "==> Source maps uploaded and removed from the box"
