#!/usr/bin/env bash
#
# Merlin installer.   curl -fsSL https://merlin.dev/install.sh | bash
#
# Detects your OS/arch, downloads the matching signed binary from the latest
# GitHub release, verifies its SHA-256, installs it as `merlin`, and runs
# `merlin setup` to lay down the CC hooks + config under ~/.merlin.
#
# Knobs (env vars):
#   MERLIN_VERSION       pin a version, e.g. 0.2.0   (default: latest release)
#   MERLIN_INSTALL_DIR   install location            (default: /usr/local/bin if
#                        writable, else ~/.local/bin)
#   MERLIN_NO_SETUP=1    install the binary but skip `merlin setup`
#
set -euo pipefail

REPO="terek/merlin"
BIN_NAME="merlin"

# --- pretty output -----------------------------------------------------------
if [ -t 1 ]; then BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
else BOLD=""; RED=""; GRN=""; DIM=""; RST=""; fi
info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
err()  { printf '%s✗ %s%s\n' "$RED" "$*" "$RST" >&2; }
die()  { err "$*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }
need curl
need uname

# --- detect target -----------------------------------------------------------
os_raw="$(uname -s)"
arch_raw="$(uname -m)"

case "$os_raw" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) die "unsupported OS: $os_raw (Windows users: download merlin-windows-x64.exe from the releases page)" ;;
esac

case "$arch_raw" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) die "unsupported architecture: $arch_raw" ;;
esac

# On Linux, pick the musl build for musl-libc systems (Alpine, etc.).
libc=""
if [ "$os" = "linux" ]; then
  if [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; then
    libc="-musl"
  fi
fi

target="${os}-${arch}${libc}"
asset="${BIN_NAME}-${target}"
info "${BOLD}Merlin installer${RST} ${DIM}(target: ${target})${RST}"

# --- resolve version ---------------------------------------------------------
version="${MERLIN_VERSION:-}"
if [ -z "$version" ]; then
  # Follow the /releases/latest redirect to learn the tag — no API token needed.
  latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO}/releases/latest")" \
    || die "could not reach GitHub to find the latest release"
  version="${latest_url##*/}"     # .../tag/v0.2.0 → v0.2.0
fi
case "$version" in v*) tag="$version" ;; *) tag="v$version" ;; esac
[ -n "$tag" ] && [ "$tag" != "v" ] || die "could not determine release version"
info "Installing ${BOLD}${tag}${RST}"

base="https://github.com/${REPO}/releases/download/${tag}"

# --- download + verify -------------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

info "Downloading ${asset}…"
curl -fsSL "${base}/${asset}" -o "${tmp}/${asset}" \
  || die "download failed: ${base}/${asset}"

if curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS" 2>/dev/null; then
  info "Verifying checksum…"
  expected="$(grep " ${asset}\$" "${tmp}/SHA256SUMS" | awk '{print $1}')"
  [ -n "$expected" ] || die "no checksum for ${asset} in SHA256SUMS"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${tmp}/${asset}" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "${tmp}/${asset}" | awk '{print $1}')"
  fi
  [ "$expected" = "$actual" ] || die "checksum mismatch for ${asset}"
  ok "checksum verified"
else
  err "SHA256SUMS not found — skipping checksum verification"
fi

chmod +x "${tmp}/${asset}"

# --- choose install dir ------------------------------------------------------
if [ -n "${MERLIN_INSTALL_DIR:-}" ]; then
  dir="$MERLIN_INSTALL_DIR"
elif [ -w /usr/local/bin ] 2>/dev/null; then
  dir="/usr/local/bin"
else
  dir="$HOME/.local/bin"
fi
mkdir -p "$dir" || die "cannot create install dir: $dir"

dest="${dir}/${BIN_NAME}"
mv -f "${tmp}/${asset}" "$dest" || die "cannot write to ${dest}"
ok "installed ${BOLD}${dest}${RST}"

# --- post-install setup ------------------------------------------------------
if [ "${MERLIN_NO_SETUP:-}" != "1" ]; then
  info ""
  "$dest" setup || err "\`merlin setup\` failed — you can re-run it manually."
fi

# --- PATH hint ---------------------------------------------------------------
case ":${PATH}:" in
  *":${dir}:"*) ;;
  *)
    info ""
    err "${dir} is not on your PATH."
    info "  Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    info "    ${BOLD}export PATH=\"${dir}:\$PATH\"${RST}"
    ;;
esac

info ""
ok "Done. Run ${BOLD}merlin${RST} to start the daemon and pair a client."
