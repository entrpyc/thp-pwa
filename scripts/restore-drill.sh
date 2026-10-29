#!/usr/bin/env bash
#
# `./scripts/restore-drill.sh` — **restore the latest backup and prove it is the database.**
#
# An unverified backup is not a backup. This is the ticket that proves it rather than the incident
# that disproves it, and it is an acceptance criterion rather than a follow-up: the restore runs
# now, onto a scratch cluster, and the row counts are compared against production.
#
# What it does: restores the newest backup into a scratch data directory, starts it on a spare
# port, compares the migration journal and four row counts against the live database, then stops
# and removes the scratch cluster and writes a dated receipt. `verify:production`'s
# `restore-drill-age` check reads that receipt and fails once it is more than 90 days old.
#
# **Run it as the service user, from the checkout — not under `sudo`.** It escalates per step,
# and running the whole thing as root would write the receipt as root into a checkout that the
# `secrets` check requires be owned by the service user.
#
# Every step that must run as `postgres` goes through `thp-restore-drill-pg`
# (deploy/bin/thp-restore-drill-pg, installed root-owned under /usr/local/sbin), which is the one
# command deploy/sudoers/thp lets this user run as `postgres` for the drill. The helper owns the
# scratch directory, the stanza and the server binaries; this script owns the guards, the
# comparison and the receipt. A bare `psql`/`pg_ctl`/`tee` as `postgres` is deliberately not
# available here — see the sudoers file for why.
#
# **It never touches production.** The guards below refuse to run if the target directory or port
# is the live one — a drill must not be one typo away from being the incident it rehearses.

set -euo pipefail

cd "$(dirname "$0")/.."

# The same values the helper carries; named here for the guards and the messages only.
SCRATCH_DIR=/var/lib/postgresql/restore-drill
SCRATCH_PORT=5433
RECEIPT=.restore-drill

DRILL_PG=/usr/local/sbin/thp-restore-drill-pg
if [[ ! -x "$DRILL_PG" ]]; then
  echo "$DRILL_PG is not installed — see deploy/sudoers/thp for the install line." >&2
  exit 1
fi
as_postgres() { sudo -u postgres "$DRILL_PG" "$@"; }

# The connection string is not exported into every shell, so read it from the same `.env` every
# other command in this repository reads. Falls back to the environment when it is already set.
if [[ -z "${DATABASE_URL:-}" ]]; then
  DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- || true)
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set and .env does not name it." >&2
  exit 1
fi

LIVE_DIR=$(awk -F= '/^pg1-path/ {gsub(/ /, "", $2); print $2}' /etc/pgbackrest/pgbackrest.conf)
LIVE_PORT=$(as_postgres live-port)

# ------------------------------------------------------------------------------------------------
# The guards. These are the difference between a drill and an outage.
# ------------------------------------------------------------------------------------------------
if [[ -z "$LIVE_DIR" ]]; then
  echo "Refusing: could not read pg1-path from /etc/pgbackrest/pgbackrest.conf." >&2
  exit 1
fi
if [[ "$SCRATCH_DIR" == "$LIVE_DIR" ]]; then
  echo "Refusing: the scratch directory is the live data directory ($LIVE_DIR)." >&2
  exit 1
fi
if [[ "$SCRATCH_PORT" == "$LIVE_PORT" ]]; then
  echo "Refusing: the scratch port is the live port ($LIVE_PORT)." >&2
  exit 1
fi

# `user` is a reserved word, hence the quoting — the table really is called that.
COUNTS_SQL="
  select 'user=' || (select count(*) from \"user\")
      || ' recording=' || (select count(*) from recording)
      || ' transcript=' || (select count(*) from transcript)
      || ' segment=' || (select count(*) from segment)
      || ' migrations=' || (select count(*) from drizzle.__drizzle_migrations)"

# Counted before the restore starts, so the comparison is against the database as it was when the
# drill began rather than as it is several minutes later.
echo "==> Reading production"
LIVE_COUNTS=$(psql "$DATABASE_URL" -At -c "$COUNTS_SQL")

echo "==> Restoring the latest backup into $SCRATCH_DIR"
as_postgres restore

# From here on there is something to clean up, whether or not the scratch cluster ever starts.
cleanup() {
  as_postgres stop
}
trap cleanup EXIT

# The minimal configuration the scratch cluster needs (Ubuntu keeps the real one under /etc, which
# the backup does not contain and which must not be copied — it pins `data_directory` to the live
# cluster), the scratch port, and `archive_mode = off` so the copy never archives its own WAL back
# into the repository. The helper writes all of it; the comment there says what and why.
as_postgres prepare "$SCRATCH_PORT"

echo "==> Starting the scratch cluster on port $SCRATCH_PORT"
as_postgres start "$SCRATCH_PORT"

# `pg_ctl -w` returns as soon as the server takes connections, and a recovering cluster does that at
# the first consistent point — before it has replayed the WAL that followed the backup. Counting
# then compares production against a copy that is still catching up, and the shortfall looks like a
# broken backup when it is only an early reading. With no recovery target, Postgres promotes itself
# once the archive is exhausted; wait for that.
echo "==> Waiting for WAL replay to finish"
for _ in $(seq 1 300); do
  if [[ "$(as_postgres in-recovery "$SCRATCH_PORT")" == "f" ]]; then
    break
  fi
  sleep 1
done
if [[ "$(as_postgres in-recovery "$SCRATCH_PORT")" != "f" ]]; then
  echo "The scratch cluster is still replaying WAL after five minutes." >&2
  exit 1
fi

# The restored cluster carries production's databases, so the database name is the one in
# DATABASE_URL rather than a guess. The helper runs the same COUNTS_SQL as above — the two queries
# are held equal by hand, which is what the string comparison below relies on.
SCRATCH_DB=$(basename "${DATABASE_URL%%\?*}")
RESTORED_COUNTS=$(as_postgres counts "$SCRATCH_PORT" "$SCRATCH_DB")

echo
echo "production: $LIVE_COUNTS"
echo "restored:   $RESTORED_COUNTS"
echo

# Equal, or trailing by whatever landed inside the WAL window — never ahead, and never short of the
# migrations, because a restore missing a migration is a restore of a different schema.
if [[ "$LIVE_COUNTS" != "$RESTORED_COUNTS" ]]; then
  echo "The restored counts differ from production." >&2
  echo "Equal is expected on an idle database; a shortfall is only acceptable if it is explained by" >&2
  echo "writes inside the archive-timeout window (300s). Read the two lines above and decide." >&2
  exit 1
fi

date -u +"%Y-%m-%dT%H:%M:%SZ restored $RESTORED_COUNTS" > "$RECEIPT"
echo "Restore verified. Receipt written to $RECEIPT."

# Tell Healthchecks.io the drill happened (docs/project/observability.md § 2.4, alert A7: a receipt
# older than 90 days). Only after the receipt, so a drill that failed above pings nothing. The URL
# is in /etc/thp/healthchecks.env, readable by the service user; a box without the file, or without
# that line in it, drills exactly as before and `verify:production`'s `backup-pings` check is what
# says so.
HEALTHCHECKS_ENV=/etc/thp/healthchecks.env
if [[ -r "$HEALTHCHECKS_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$HEALTHCHECKS_ENV"
fi
if [[ -n "${HEALTHCHECK_RESTORE_DRILL_URL:-}" ]]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$HEALTHCHECK_RESTORE_DRILL_URL" \
    || echo "The drill passed but the Healthchecks.io ping did not get out." >&2
fi
