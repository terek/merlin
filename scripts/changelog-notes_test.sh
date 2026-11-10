#!/usr/bin/env bash
# Self-test for changelog-notes.sh against a fixture changelog. Run: scripts/changelog-notes_test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/CHANGELOG.md" <<'MD'
# Changelog

## Unreleased

- Pending thing.

## 1.2.0 — 2026-01-02

### New
- Thing A.

- Thing B.

## 1.1.0 — 2026-01-01

## 1.0.0 — 2025-12-01

- First.
MD
export CHANGELOG="$tmp/CHANGELOG.md"
run() { "$here/changelog-notes.sh" "$@"; }
fail=0
check() { # name, expected, actual
  if [ "$2" != "$3" ]; then echo "FAIL $1: expected [$2] got [$3]" >&2; fail=1; else echo "ok   $1"; fi
}

check found "$(printf '### New\n- Thing A.\n\n- Thing B.')" "$(run 1.2.0)"
check v-prefix "$(run 1.2.0)" "$(run v1.2.0)"
check rc-unreleased "- Pending thing." "$(run 1.3.0-rc1)"
check rc-base-section "- First." "$(run 1.0.0-rc2)"
if run 9.9.9 >/dev/null 2>"$tmp/err"; then echo "FAIL missing: succeeded" >&2; fail=1
else check missing-msg yes "$(grep -q "no '## 9.9.9'" "$tmp/err" && echo yes)"; fi
if run 1.1.0 >/dev/null 2>"$tmp/err"; then echo "FAIL empty: succeeded" >&2; fail=1
else check empty-msg yes "$(grep -q empty "$tmp/err" && echo yes)"; fi
if run 1.1 >/dev/null 2>&1; then echo "FAIL 1.1 matched 1.1.0" >&2; fail=1; fi
exit $fail
