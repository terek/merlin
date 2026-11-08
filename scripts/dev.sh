#!/usr/bin/env bash
#
# One-command dev loop: scripts/dev.sh [merlin serve args...]   (or `make dev`)
#
# Builds the daemon (no embedded UI), then runs it and the Vite dev server together.
# Open http://127.0.0.1:$VITE_PORT/ (Vite proxies /api to the daemon). Ctrl+C stops both,
# with their descendants, and nothing is left running. If either exits on its own, the
# other is stopped and the script exits with that child's status.
#
# Env:
#   MERLIN_PORT  daemon port (default 7433)
#   VITE_PORT    Vite port (default 5173)
# Arguments are passed through to `merlin serve`, e.g. scripts/dev.sh -no-hooks.
# CLAUDE_CONFIG_DIR, MERLIN_HOME and the rest of the environment pass through unchanged.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

MERLIN_PORT="${MERLIN_PORT:-7433}"
VITE_PORT="${VITE_PORT:-5173}"

for port in "$MERLIN_PORT" "$VITE_PORT"; do
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' || true)"
  if [ -n "$pids" ]; then
    echo "dev: port $port is already in use (PID ${pids% }); stop it or pick another port (MERLIN_PORT / VITE_PORT)" >&2
    exit 1
  fi
done

go build -o bin/merlin ./cmd/explorer
[ -d web/node_modules ] || (cd web && bun install --frozen-lockfile)

# Job control gives each background job its own process group, so a group kill reaches
# everything it spawned (bun -> vite) and a terminal Ctrl+C reaches only this script.
set -m
daemon_pid=""
vite_pid=""

stop_tree() { # signal the group (and direct children, in case one left the group)
  local pid="$1" sig="$2"
  [ -n "$pid" ] || return 0
  pkill "-$sig" -P "$pid" 2>/dev/null || true
  kill "-$sig" -- "-$pid" 2>/dev/null || kill "-$sig" "$pid" 2>/dev/null || true
}

alive() { # any process left in the group, or the pid itself
  kill -0 -- "-$1" 2>/dev/null || kill -0 "$1" 2>/dev/null
}

cleaned=0
cleanup() {
  [ "$cleaned" -eq 0 ] || return 0
  cleaned=1
  trap '' INT TERM
  stop_tree "$daemon_pid" TERM
  stop_tree "$vite_pid" TERM

  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    alive "${daemon_pid:-0}" || alive "${vite_pid:-0}" || break
    sleep 0.1
  done
  stop_tree "$daemon_pid" KILL
  stop_tree "$vite_pid" KILL
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bin/merlin serve -port "$MERLIN_PORT" ${1+"$@"} </dev/null &
daemon_pid=$!

(cd web && VITE_PORT="$VITE_PORT" EXPLORER_API="http://127.0.0.1:$MERLIN_PORT" exec bun run dev) </dev/null &
vite_pid=$!

echo "dev: daemon on :$MERLIN_PORT (pid $daemon_pid), vite on :$VITE_PORT (pid $vite_pid)"
echo "dev: open http://127.0.0.1:$VITE_PORT/   (Ctrl+C stops both)"

status=0
while :; do
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    wait "$daemon_pid" || status=$?
    echo "dev: daemon exited (status $status); stopping vite" >&2
    break
  fi
  if ! kill -0 "$vite_pid" 2>/dev/null; then
    wait "$vite_pid" || status=$?
    echo "dev: vite exited (status $status); stopping daemon" >&2
    break
  fi
  sleep 0.5
done
exit "$status"
