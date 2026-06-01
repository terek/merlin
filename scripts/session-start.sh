#!/bin/sh
# Merlin Go — SessionStart hook
# Creates a lockfile: ~/.merlin/sessions/<pid>.json
# PID as filename makes liveness checks trivial (no need to read file).
# On /resume or compaction, CC fires SessionStart again with a new session_id
# but the same PID — so we just overwrite the same file.
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p')
CWD=$(echo "$INPUT" | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p')
LOCK_DIR="$HOME/.merlin/sessions"
mkdir -p "$LOCK_DIR"
echo "{\"sessionId\":\"$SESSION_ID\",\"cwd\":\"$CWD\",\"startedAt\":$(date +%s)}" > "$LOCK_DIR/$PPID.json"
