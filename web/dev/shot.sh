#!/usr/bin/env bash
# Screenshot a URL with headless Chrome: shot.sh <url> <out.png> [width] [height] [shot.ts options]
# A thin wrapper over shot.ts (DevTools protocol; see its header for --wait-for, --eval, --delay).
set -eu
exec bun "$(dirname "$0")/shot.ts" "$@"
