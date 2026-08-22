#!/usr/bin/env bash
#
# `sudo ./scripts/restore-drill.sh` — **restore the latest backup and prove it is the database.**
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
# **It never touches production.** The guards below refuse to run if the target directory or port
# is the live one — a drill must not be one typo away from being the incident it rehearses.

set -euo pipefail

cd "$(dirname "$0")/.."

STANZA=thp
SCRATCH_DIR=/var/lib/postgresql/restore-drill
SCRATCH_PORT=5433
LIVE_DIR=$(awk -F= '/^pg1-path/ {gsub(/ /, "", $2); print $2}' /etc/pgbackrest/pgbackrest.conf)
LIVE_PORT=$(sudo -u postgres psql -Atc 'show port')
RECEIPT=.restore-drill

# ------------------------------------------------------------------------------------------------
# The guards. Both of these are the difference between a drill and an outage.
# ------------------------------------------------------------------------------------------------
if [[ "$SCRATCH_DIR" == "$LIVE_DIR" ]]; then
  echo "Refusing: the scratch directory is the live data directory ($LIVE_DIR)." >&2
  exit 1
fi
if [[ "$SCRATCH_PORT" == "$LIVE_PORT" ]]; then
  echo "Refusing: the scratch port is the live port ($LIVE_PORT)." >&2
  exit 1
fi
if [[ -z "$LIVE_DIR" ]]; then
  echo "Refusing: could not read pg1-path from /etc/pgbackrest/pgbackrest.conf." >&2
  exit 1
fi

# Counted before the restore starts, so the comparison is against the database as it was when the
# drill began rather than as it is several minutes later.
echo "==> Reading production"
LIVE_COUNTS=$(sudo -u postgres psql "$DATABASE_URL" -At -c "
  select 'account=' || (select count(*) from account)
      || ' recording=' || (select count(*) from recording)
      || ' transcript=' || (select count(*) from transcript)
      || ' segment=' || (select count(*) from segment)
      || ' migrations=' || (select count(*) from drizzle.__drizzle_migrations)")

echo "==> Restoring the latest backup into $SCRATCH_DIR"
rm -rf "$SCRATCH_DIR"
install -d -o postgres -g postgres -m 700 "$SCRATCH_DIR"
sudo -u postgres pgbackrest --stanza="$STANZA" --pg1-path="$SCRATCH_DIR" --type=default restore

# The scratch cluster must not try to archive its own WAL back into the repository, and must not
# take the live port. Both are set after the restore, because restore lays down postgresql.conf.
sudo -u postgres tee -a "$SCRATCH_DIR/postgresql.auto.conf" > /dev/null <<CONF
port = $SCRATCH_PORT
archive_mode = off
CONF

echo "==> Starting the scratch cluster on port $SCRATCH_PORT"
sudo -u postgres pg_ctl -D "$SCRATCH_DIR" -o "-p $SCRATCH_PORT" -w -t 120 start

cleanup() {
  sudo -u postgres pg_ctl -D "$SCRATCH_DIR" -m immediate stop > /dev/null 2>&1 || true
  rm -rf "$SCRATCH_DIR"
}
trap cleanup EXIT

RESTORED_COUNTS=$(sudo -u postgres psql -p "$SCRATCH_PORT" -d "${PGDATABASE:-thp}" -At -c "
  select 'account=' || (select count(*) from account)
      || ' recording=' || (select count(*) from recording)
      || ' transcript=' || (select count(*) from transcript)
      || ' segment=' || (select count(*) from segment)
      || ' migrations=' || (select count(*) from drizzle.__drizzle_migrations)")

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
