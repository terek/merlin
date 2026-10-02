#!/usr/bin/env bash
# Screenshot a URL with headless Chrome: shot.sh <url> <out.png> [width] [height] [wait-ms]
# Chrome does not always exit after writing the file, so it is run in the background and
# stopped once the screenshot exists (or after 30 s).
set -u
url=$1 out=$2 width=${3:-1440} height=${4:-900} budget=${5:-4000}
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
profile=$(mktemp -d "${TMPDIR:-/tmp}/explorer-shot.XXXXXX")
rm -f "$out"
"$chrome" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --user-data-dir="$profile" --window-size="$width,$height" --virtual-time-budget="$budget" \
  --screenshot="$out" "$url" >/dev/null 2>&1 &
pid=$!
for _ in $(seq 1 150); do
  [ -s "$out" ] && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done
sleep 0.3
kill "$pid" 2>/dev/null
pkill -f -- "--user-data-dir=$profile" 2>/dev/null
wait "$pid" 2>/dev/null
rm -rf "$profile"
[ -s "$out" ] && echo "wrote $out" || { echo "no screenshot written" >&2; exit 1; }
