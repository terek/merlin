#!/usr/bin/env bash
#
# Build the release binaries: scripts/release-build.sh <version> <target>...
#
#   version   e.g. 0.2.0 (a leading v is stripped); `merlin version` prints it
#   target    darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64
#
# Writes <OUT_DIR>/merlin-<target> (OUT_DIR defaults to explorer/dist). The web UI is
# built once and embedded in every binary; set MERLIN_SKIP_WEB=1 to reuse a UI that is
# already built in internal/webui/dist. The release workflow and local runs both use this.
set -euo pipefail

[ "$#" -ge 2 ] || { echo "usage: $0 <version> <target>..." >&2; exit 2; }
version="${1#v}"
shift

cd "$(dirname "$0")/.."
out="${OUT_DIR:-$PWD/dist}"
mkdir -p "$out"

if [ "${MERLIN_SKIP_WEB:-}" != "1" ]; then
  make web
fi
[ -f internal/webui/dist/index.html ] || { echo "web UI is not built (internal/webui/dist/index.html)" >&2; exit 1; }

for target in "$@"; do
  case "$target" in
    darwin-arm64) goos=darwin; goarch=arm64 ;;
    darwin-x64)   goos=darwin; goarch=amd64 ;;
    linux-arm64)  goos=linux;  goarch=arm64 ;;
    linux-x64)    goos=linux;  goarch=amd64 ;;
    *) echo "unknown target: $target" >&2; exit 2 ;;
  esac
  echo "building merlin-$target ($version)"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -tags embedui -trimpath -ldflags "-s -w -X main.version=$version" \
    -o "$out/merlin-$target" ./cmd/explorer
done
