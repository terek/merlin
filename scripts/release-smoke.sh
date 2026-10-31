#!/usr/bin/env bash
#
# Smoke-test a binary that runs on this machine: scripts/release-smoke.sh <binary> <version> [port]
#
# `merlin version` must print the version; `merlin serve --no-hooks` against the
# fixtures (scratch MERLIN_HOME, nothing under ~/.claude) must serve the embedded UI at /
# and JSON at /api/sessions.
set -euo pipefail

[ "$#" -ge 2 ] || { echo "usage: $0 <binary> <version> [port]" >&2; exit 2; }
bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
version="${2#v}"
port="${3:-7461}"
fixtures="$(cd "$(dirname "$0")/.." && pwd)/testdata/claude"

got="$("$bin" version)"
[ "$got" = "merlin $version" ] || { echo "version: got '$got', want 'merlin $version'" >&2; exit 1; }

home="$(mktemp -d)"
log="$home/serve.log"
pid=""
cleanup() {
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  rm -rf "$home"
}
trap cleanup EXIT

CLAUDE_CONFIG_DIR="$fixtures" MERLIN_HOME="$home" "$bin" serve --no-hooks --port "$port" >"$log" 2>&1 &
pid=$!

up=""
for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$port/api/sessions" -o "$home/sessions.json" 2>/dev/null; then up=1; break; fi
  kill -0 "$pid" 2>/dev/null || { echo "serve exited early:" >&2; cat "$log" >&2; exit 1; }
  sleep 0.2
done
[ -n "$up" ] || { echo "serve did not answer on port $port:" >&2; cat "$log" >&2; exit 1; }

status="$(curl -sS "http://127.0.0.1:$port/" -o "$home/index.html" -w '%{http_code}')"
grep -qi "UI was not built" "$home/index.html" && { echo "/ is the 'UI was not built' page" >&2; exit 1; }
[ "$status" = 200 ] || { echo "/ answered HTTP $status" >&2; exit 1; }
grep -qi "<html" "$home/index.html" || { echo "/ is not an HTML page" >&2; exit 1; }
ctype="$(curl -fsS -o /dev/null -w '%{content_type}' "http://127.0.0.1:$port/api/sessions")"
case "$ctype" in application/json*) ;; *) echo "/api/sessions content-type: $ctype" >&2; exit 1 ;; esac
first="$(head -c1 "$home/sessions.json")"
case "$first" in '{'|'[') ;; *) echo "/api/sessions is not JSON" >&2; exit 1 ;; esac
echo "smoke ok: $("$bin" version), UI at /, JSON at /api/sessions"
