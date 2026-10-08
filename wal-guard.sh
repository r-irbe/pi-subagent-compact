#!/usr/bin/env bash
# wal-guard.sh -- cron-style WAL checkpoint guard for pi's shared SQLite stores.
#
# Why this exists: several long-lived pi sessions share a handful of SQLite
# databases (the hermes locks coordinator, the session index, the fetch
# cache). When one session runs a long indexing transaction, WAL checkpoints
# starve and the -wal file grows without bound; other sessions' writes then
# fail with SQLITE_BUSY ("database is locked"). This guard truncating-
# checkpoints any WAL that has grown past a threshold. Safe by construction:
# PRAGMA wal_checkpoint(TRUNCATE) only folds already-committed frames into
# the main database and never discards data; worst case it returns busy.

set -u

THRESHOLD_BYTES=${WAL_GUARD_THRESHOLD:-1048576}
LOG_FILE=${WAL_GUARD_LOG:-"$HOME/.pi/agent/wal-guard.log"}
TIMEOUT_SECS=${WAL_GUARD_TIMEOUT:-30}

DEFAULT_DBS=(
  "$HOME/.pi/agent/.pi-hermes-locks.sqlite"
  "$HOME/.pi/agent/pi-hermes-memory/sessions.db"
  "$HOME/.pi/agent/magpi-cache/index.db"
)

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log_line() { printf '%s %s\n' "$(stamp)" "$*" >> "$LOG_FILE"; }

# checkpoint_if_bloated <db-path> <threshold-bytes>
# Returns 0 when a checkpoint ran and truncated the WAL,
# 1 when skipped (no WAL, under threshold), 2 on checkpoint failure.
checkpoint_if_bloated() {
  local db=$1 threshold=$2 wal size out rc after
  wal="$db-wal"
  [ -f "$wal" ] || return 1
  size=$(stat -c %s "$wal" 2>/dev/null) || return 1
  [ "$size" -ge "$threshold" ] || return 1
  out=$(timeout "$TIMEOUT_SECS" sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" 2>&1)
  rc=$?
  # after: 0 = truncated in place; -1 = the checkpointing connection was the
  # last one and SQLite deleted the WAL on close. Both are full success.
  after=$(stat -c %s "$wal" 2>/dev/null || echo -1)
  log_line "db=$(basename "$db") wal_before=$size checkpoint_rc=$rc out=$out wal_after=$after"
  if [ "$rc" -eq 0 ] && { [ "$after" = "0" ] || [ "$after" = "-1" ]; }; then
    return 0
  fi
  return 2
}

rotate_log_if_huge() {
  [ -f "$LOG_FILE" ] || return 0
  local size
  size=$(stat -c %s "$LOG_FILE" 2>/dev/null) || return 0
  if [ "$size" -gt 1048576 ]; then
    tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
}

run_guard() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null
  local db
  for db in "${DEFAULT_DBS[@]}"; do
    [ -f "$db" ] || continue
    checkpoint_if_bloated "$db" "$THRESHOLD_BYTES" || true
  done
  rotate_log_if_huge
  return 0
}

self_test() {
  local tmpdir db threshold fails=0
  tmpdir=$(mktemp -d) || return 1
  LOG_FILE="$tmpdir/test.log"
  db="$tmpdir/test.db"
  threshold=65536

  sqlite3 "$db" "PRAGMA journal_mode=WAL; CREATE TABLE t (b BLOB);" >/dev/null

  # Pin a reader with an open read transaction so the WAL persists after the
  # writer exits -- a cleanly closed last-connection database checkpoints and
  # removes its own WAL. python's sqlite3 holds the transaction
  # deterministically; the CLI background-holder proved unreliable.
  python3 - "$db" <<'PYEOF' &
import sqlite3, sys, time
conn = sqlite3.connect(sys.argv[1])
conn.execute("BEGIN")
conn.execute("SELECT count(*) FROM t").fetchone()
time.sleep(20)
PYEOF
  local reader_pid=$!
  sleep 0.5

  sqlite3 "$db" "INSERT INTO t VALUES (randomblob(20000)); INSERT INTO t VALUES (randomblob(20000)); INSERT INTO t VALUES (randomblob(20000)); INSERT INTO t VALUES (randomblob(20000));" >/dev/null

  local wal="$db-wal"
  local size
  size=$(stat -c %s "$wal" 2>/dev/null || echo 0)
  if [ "$size" -ge "$threshold" ]; then
    echo "SELF-TEST OK: sandbox WAL grew to $size bytes while a reader held it open"
  else
    echo "SELF-TEST FAIL: sandbox WAL is $size bytes, expected >= $threshold before checkpoint"
    fails=$((fails + 1))
  fi

  kill "$reader_pid" 2>/dev/null
  wait "$reader_pid" 2>/dev/null

  if checkpoint_if_bloated "$db" "$threshold"; then
    echo "SELF-TEST OK: checkpoint ran on bloated sandbox WAL ($size bytes)"
  else
    echo "SELF-TEST FAIL: checkpoint did not report success on bloated sandbox WAL"
    fails=$((fails + 1))
  fi

  size=$(stat -c %s "$wal" 2>/dev/null || echo -1)
  if [ "$size" = "0" ] || [ "$size" = "-1" ]; then
    echo "SELF-TEST OK: sandbox WAL truncated/deleted by checkpoint"
  else
    echo "SELF-TEST FAIL: sandbox WAL is $size bytes after TRUNCATE checkpoint"
    fails=$((fails + 1))
  fi

  if checkpoint_if_bloated "$db" "$threshold"; then
    echo "SELF-TEST FAIL: guard checkpointed a WAL already under threshold (should skip)"
    fails=$((fails + 1))
  else
    echo "SELF-TEST OK: small WAL skipped without checkpoint"
  fi

  rm -rf "$tmpdir"
  if [ "$fails" -eq 0 ]; then
    echo "wal-guard self-test: PASSED"
    return 0
  fi
  echo "wal-guard self-test: FAILED ($fails assertion(s))"
  return 1
}

case "${1:-}" in
  --self-test)
    WAL_GUARD_LOG="${WAL_GUARD_LOG:-/tmp/wal-guard-selftest.log}" \
      WAL_GUARD_TIMEOUT="${WAL_GUARD_TIMEOUT:-10}" \
      self_test
    ;;
  *)
    run_guard
    ;;
esac
