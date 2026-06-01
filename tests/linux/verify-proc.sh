#!/bin/sh
# Verify /proc assumptions used by process-scanner.ts on Linux.
# Runs inside a Linux container — see verify-proc.test.ts.
# Uses only POSIX sh + basic coreutils (no bash, no grep -P).
set -eu

PASS=0
FAIL=0

assert_eq() {
  label="$1"; expected="$2"; actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

# --- Test 1: /proc/<pid>/cwd resolves to the process working directory ---
echo "TEST 1: /proc/<pid>/cwd"

mkdir -p /tmp/test-cwd
(cd /tmp/test-cwd && sleep 60) &
BG_PID=$!
sleep 0.2

CWD=$(readlink /proc/$BG_PID/cwd)
assert_eq "/proc/pid/cwd is working directory" "/tmp/test-cwd" "$CWD"

kill $BG_PID 2>/dev/null || true
wait $BG_PID 2>/dev/null || true

# --- Test 2: /proc/<pid>/cmdline contains null-separated args ---
echo "TEST 2: /proc/<pid>/cmdline"

TEST_UUID="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
# Simulate a process with --resume <uuid> in its args.
# We use a small perl/python-free trick: write a script that just sleeps,
# then exec it with the desired argv[0] and args.
cat > /tmp/fake-claude <<'SCRIPT'
#!/bin/sh
sleep 60
SCRIPT
chmod +x /tmp/fake-claude
/tmp/fake-claude --resume "$TEST_UUID" &
BG_PID=$!
sleep 0.2

# Read cmdline, convert null bytes to spaces
CMDLINE=$(tr '\0' ' ' < /proc/$BG_PID/cmdline)

# Check --resume is present
case "$CMDLINE" in
  *--resume*) assert_eq "cmdline contains --resume" "true" "true" ;;
  *)          assert_eq "cmdline contains --resume" "true" "false" ;;
esac

# Check UUID is present
case "$CMDLINE" in
  *"$TEST_UUID"*) assert_eq "cmdline contains UUID" "true" "true" ;;
  *)              assert_eq "cmdline contains UUID" "true" "false" ;;
esac

kill $BG_PID 2>/dev/null || true
wait $BG_PID 2>/dev/null || true

# --- Summary ---
echo ""
echo "$PASS passed, $FAIL failed"
exit $FAIL
