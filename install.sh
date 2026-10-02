#!/usr/bin/env bash
#
# Merlin installer.   curl -fsSL https://merlin.dev/install.sh | bash
#
# Detects your OS/arch, downloads the matching binary from the latest GitHub release,
# verifies its SHA-256 and installs it as `merlin`. It starts nothing and does not
# touch ~/.claude: `merlin serve` adds its Claude Code hooks when you first run it.
#
# Knobs (env vars):
#   MERLIN_VERSION       pin a version, e.g. 0.2.0   (default: latest release)
#   MERLIN_INSTALL_DIR   install location            (default: /usr/local/bin if
#                        writable, else ~/.local/bin)
#   MERLIN_NO_SETUP      accepted and ignored (there is no setup step any more)
#   MERLIN_BASE_URL      download files from this URL instead of GitHub (testing)
#
# All the work is in functions and runs from the last line, so a truncated download
# of this script does nothing.
set -euo pipefail

REPO="terek/merlin"
BIN_NAME="merlin"
tmp=""     # scratch download dir, removed on exit
staged=""  # file staged next to the destination, removed on exit

cleanup() { rm -rf "${tmp:-}" "${staged:-}"; }

if [ -t 1 ]; then BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
else BOLD=""; RED=""; GRN=""; DIM=""; RST=""; fi
info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
err()  { printf '%s✗ %s%s\n' "$RED" "$*" "$RST" >&2; }
die()  { err "$*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }

# sha256_of FILE: print the SHA-256 of FILE.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# detect_target: print <os>-<arch> (darwin|linux, arm64|x64).
detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *) die "unsupported OS: $(uname -s) (macOS and Linux only)" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

# download_base: print the URL the release files are under.
download_base() {
  local version latest_url tag
  if [ -n "${MERLIN_BASE_URL:-}" ]; then
    printf '%s\n' "${MERLIN_BASE_URL%/}"
    return
  fi
  version="${MERLIN_VERSION:-}"
  if [ -z "$version" ]; then
    # Follow the /releases/latest redirect to learn the tag: no API token needed.
    latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
      "https://github.com/${REPO}/releases/latest")" \
      || die "could not reach GitHub to find the latest release"
    version="${latest_url##*/}"     # .../tag/v0.2.0 -> v0.2.0
  fi
  case "$version" in v*) tag="$version" ;; *) tag="v$version" ;; esac
  [ "$tag" != "v" ] || die "could not determine release version"
  printf 'https://github.com/%s/releases/download/%s\n' "$REPO" "$tag"
}

# choose_dir: print the install directory.
choose_dir() {
  if [ -n "${MERLIN_INSTALL_DIR:-}" ]; then printf '%s\n' "$MERLIN_INSTALL_DIR"
  elif [ -w /usr/local/bin ] 2>/dev/null; then printf '/usr/local/bin\n'
  else printf '%s/.local/bin\n' "$HOME"
  fi
}

main() {
  need curl
  need uname
  need awk
  need grep

  local target asset base expected actual dir dest found
  target="$(detect_target)"
  asset="${BIN_NAME}-${target}"
  info "${BOLD}Merlin installer${RST} ${DIM}(target: ${target})${RST}"

  base="$(download_base)"
  info "Installing from ${base}"

  tmp="$(mktemp -d)"
  trap cleanup EXIT

  info "Downloading ${asset}..."
  curl -fsSL "${base}/${asset}" -o "${tmp}/${asset}" || die "download failed: ${base}/${asset}"
  curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS" || die "download failed: ${base}/SHA256SUMS"

  info "Verifying checksum..."
  expected="$(grep " ${asset}\$" "${tmp}/SHA256SUMS" | awk '{print $1}' | head -n 1 || true)"
  [ -n "$expected" ] || die "no checksum for ${asset} in SHA256SUMS"
  actual="$(sha256_of "${tmp}/${asset}")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for ${asset}: refusing to install"
  ok "checksum verified"

  dir="$(choose_dir)"
  mkdir -p "$dir" || die "cannot create install dir: $dir"
  dest="${dir}/${BIN_NAME}"

  # Stage next to the destination so the final mv is an atomic same-filesystem rename,
  # and prove the binary runs here before it replaces anything.
  staged="${dir}/.${BIN_NAME}.install.$$"
  cp "${tmp}/${asset}" "$staged" || die "cannot write to ${dir}"
  chmod 755 "$staged"
  "$staged" version >/dev/null 2>&1 || die "the downloaded binary does not run on this machine"

  if [ -e "$dest" ]; then info "Replacing existing ${dest}"; fi
  mv -f "$staged" "$dest" || die "cannot write to ${dest}"
  ok "installed ${BOLD}${dest}${RST} ($("$dest" version))"

  # A different `merlin` earlier on PATH would shadow this one.
  found="$(command -v "$BIN_NAME" 2>/dev/null || true)"
  if [ -n "$found" ] && [ "$found" != "$dest" ]; then
    info ""
    err "another ${BIN_NAME} is on your PATH at ${found} and comes first; it was left alone."
    info "  Use ${dest} or remove the other one."
  fi
  case ":${PATH}:" in
    *":${dir}:"*) ;;
    *)
      info ""
      err "${dir} is not on your PATH."
      info "  Add this to your shell profile (~/.zshrc or ~/.bashrc):"
      info "    ${BOLD}export PATH=\"${dir}:\$PATH\"${RST}"
      ;;
  esac

  if [ -e "$HOME/.merlin/hooks/session-start.sh" ]; then
    info ""
    info 'Note: the earlier Merlin left two entries in ~/.claude/settings.json.'
    info 'They run ~/.merlin/hooks/session-start.sh and session-end.sh, are harmless, and can be removed by hand.'
  fi

  info ""
  ok "Done. Nothing was started and ~/.claude was not touched."
  info "  Next:  ${BOLD}merlin serve${RST}   then open ${BOLD}http://127.0.0.1:7433/${RST}"
  info "  The first start adds five hook entries to ~/.claude/settings.json (a backup is kept)."
  info "  To skip that, run ${BOLD}merlin serve --no-hooks${RST}; to remove them later: ${BOLD}merlin hooks uninstall${RST}."
}

main "$@"
