#!/usr/bin/env bash
# Print the body of a version's section of CHANGELOG.md (without its heading), for release notes.
#   scripts/changelog-notes.sh 0.7.1        # the "## 0.7.1 - date" section; a leading v is fine
#   scripts/changelog-notes.sh 0.7.2-rc1    # "## 0.7.2" if present, else "## Unreleased"
# A release without a section, or with an empty one, fails. CHANGELOG=path overrides the file.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <version>" >&2
  exit 2
fi
version="${1#v}"
file="${CHANGELOG:-$(cd "$(dirname "$0")/.." && pwd)/CHANGELOG.md}"
[ -f "$file" ] || { echo "changelog-notes: $file not found" >&2; exit 1; }

# section <name>: print the lines under "## <name>" (or "## <name> - ...") up to the next "## ",
# without leading or trailing blank lines.
section() {
  awk -v want="$1" '
    /^## / {
      if (on) exit
      split(substr($0, 4), w, " ")
      if (w[1] == want) on = 1
      next
    }
    on { print }
  ' "$file" | awk '
    NF { for (i = 0; i < n; i++) print blank[i]; n = 0; started = 1; print; next }
    started { blank[n++] = $0 }'
}

has_section() {
  awk -v want="$1" '/^## / { split(substr($0, 4), w, " "); if (w[1] == want) f = 1 } END { exit !f }' "$file"
}

case "$version" in
  *-*)
    base="${version%%-*}"
    if has_section "$base"; then name="$base"; else name="Unreleased"; fi
    ;;
  *) name="$version" ;;
esac

if ! has_section "$name"; then
  echo "changelog-notes: no '## $name' section in $file" >&2
  exit 1
fi
notes="$(section "$name")"
if [ -z "$notes" ]; then
  # An empty Unreleased is fine for a pre-release build; a real release needs notes.
  case "$version" in *-*) exit 0 ;; esac
  echo "changelog-notes: the '## $name' section in $file is empty" >&2
  exit 1
fi
printf '%s\n' "$notes"
