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
# **Run it as the service user, from the checkout — not under `sudo`.** It escalates per command,
# and running the whole thing as root would write the receipt as root into a checkout that the
# `secrets` check requires be owned by the service user.
#
# **It never touches production.** The guards below refuse to run if the target directory or port
# is the live one — a drill must not be one typo away from being the incident it rehearses.

set -euo pipefail

cd "$(dirname "$0")/.."

STANZA=thp
SCRATCH_DIR=/var/lib/postgresql/restore-drill
SCRATCH_PORT=5433
RECEIPT=.restore-drill

# On Ubuntu/PGDG the server binaries are not on PATH — only the client ones are.
PG_BIN=/usr/lib/postgresql/17/bin

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
LIVE_PORT=$(sudo -u postgres psql -Atc 'show port')

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
sudo rm -rf "$SCRATCH_DIR"
sudo install -d -o postgres -g postgres -m 700 "$SCRATCH_DIR"
sudo -u postgres pgbackrest --stanza="$STANZA" --pg1-path="$SCRATCH_DIR" --type=default restore

# From here on there is something to clean up, whether or not the scratch cluster ever starts.
cleanup() {
  sudo -u postgres "$PG_BIN/pg_ctl" -D "$SCRATCH_DIR" -m immediate stop > /dev/null 2>&1 || true
  sudo rm -rf "$SCRATCH_DIR"
}
trap cleanup EXIT

# Ubuntu keeps postgresql.conf, pg_hba.conf and pg_ident.conf under /etc/postgresql rather than in
# the data directory, so the backup does not contain them and the restored directory has none.
# Postgres refuses to start without the first two. Minimal ones are written here — **not copied from
# /etc**, whose postgresql.conf pins `data_directory` to the live cluster and would start production
# instead of the scratch copy. On a layout that does keep them in the data directory, the restored
# files are left alone.
if ! sudo -u postgres test -f "$SCRATCH_DIR/postgresql.conf"; then
  sudo -u postgres tee "$SCRATCH_DIR/postgresql.conf" > /dev/null <<CONF
# Written by scripts/restore-drill.sh for the scratch cluster. Everything else is the default.
listen_addresses = ''
CONF
fi
if ! sudo -u postgres test -f "$SCRATCH_DIR/pg_hba.conf"; then
  sudo -u postgres tee "$SCRATCH_DIR/pg_hba.conf" > /dev/null <<CONF
local all postgres peer
CONF
fi
sudo -u postgres touch "$SCRATCH_DIR/pg_ident.conf"

# The scratch cluster must not archive its own WAL back into the repository, and must not take the
# live port. Both are set after the restore, because restore lays down the configuration files.
sudo -u postgres tee -a "$SCRATCH_DIR/postgresql.auto.conf" > /dev/null <<CONF
port = $SCRATCH_PORT
archive_mode = off
CONF

echo "==> Starting the scratch cluster on port $SCRATCH_PORT"
sudo -u postgres "$PG_BIN/pg_ctl" -D "$SCRATCH_DIR" -o "-p $SCRATCH_PORT" -w -t 120 start

# `pg_ctl -w` returns as soon as the server takes connections, and a recovering cluster does that at
# the first consistent point — before it has replayed the WAL that followed the backup. Counting
# then compares production against a copy that is still catching up, and the shortfall looks like a
# broken backup when it is only an early reading. With no recovery target, Postgres promotes itself
# once the archive is exhausted; wait for that.
echo "==> Waiting for WAL replay to finish"
for _ in $(seq 1 300); do
  if [[ "$(sudo -u postgres psql -p "$SCRATCH_PORT" -Atc 'select pg_is_in_recovery()')" == "f" ]]; then
    break
  fi
  sleep 1
done
if [[ "$(sudo -u postgres psql -p "$SCRATCH_PORT" -Atc 'select pg_is_in_recovery()')" != "f" ]]; then
  echo "The scratch cluster is still replaying WAL after five minutes." >&2
  exit 1
fi

# The restored cluster carries production's databases, so the database name is the one in
# DATABASE_URL rather than a guess.
SCRATCH_DB=$(basename "${DATABASE_URL%%\?*}")
RESTORED_COUNTS=$(sudo -u postgres psql -p "$SCRATCH_PORT" -d "$SCRATCH_DB" -At -c "$COUNTS_SQL")

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
