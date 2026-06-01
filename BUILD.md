# Build & Run — command reference

The runnable commands live in `package.json` (`bun run <name>`) — that's the
single source of truth, always in sync with what actually executes. This file is
the map: **which command to reach for, and the non-obvious reason it behaves the
way it does.** Deep architectural "why" lives in [specs/RUN.md](specs/RUN.md).

Convention: scripts are grouped by prefix (`test:`, `web:`, `build:`). Running
`bun run` with no name lists them all.

## Dev loop

| Command | When you reach for it |
|---|---|
| `bun run daemon` | Run the daemon against your already-paired client(s). The everyday "is it working" command. |
| `bun run daemon -w` | Daemon **+ web client in one process**, zero pairing. This serves the *embedded/built* UI (no HMR) — it's the "run it like a user would" path, not the UI-edit path. Add `--web-port N` or set `$PORT`. |
| `bun run web` | The **UI iteration loop**: bridge + Vite dev server with HMR. Requires a daemon running separately and an existing disk pairing — it connects the same encrypted way a real client does. Use this, not `-w`, when editing the frontend. |
| `bun run web:dev` | Vite alone, no bridge. Pure layout/styling work with no live daemon data behind it. |
| `bun run bridge` | The bridge by itself (against a disk pairing). Rarely needed directly; `web` wraps it. |
| `bun run tui` | The terminal client. Note: currently unmaintained — kept for reference. |

Why two UI paths exist: `-w` embeds the built bundle so the shipped binary needs
nothing on disk, which is great for running but gives no hot reload. `web` runs
the real Vite server for HMR. Same encryption on both — see specs/RUN.md.

## Build & ship

| Command | When you reach for it |
|---|---|
| `bun run web:build` | Build the Vite bundle **and** regenerate the embedded-asset module. Run before `daemon -w` if you want it to serve fresh UI, and always before compiling a binary. The asset module is regenerated (not hand-edited) because Vite's filenames are content-hashed and change every build. |
| `bun run build:bin` | Cross-compile shippable single-file binaries into `bin/`. Runs `web:build` first automatically. No args = default targets (darwin/linux × arm64/x64). |
| `bun run build:bin <targets…>` | Specific targets, e.g. `linux-arm64 darwin-arm64`. |
| `bun run build:bin all` | Every target, including musl (Alpine) and windows-x64. |

The one cross-compile caveat that isn't in the flags: an **arm64 macOS** binary
must be built *and signed on macOS* — the OS kills unsigned arm64 binaries on
launch, so producing them from another host is pointless. Everything else
cross-compiles from any host.

Binaries embed their version (`merlin --version`): CI sets `$MERLIN_VERSION` from
the release tag, and a local `build:bin` falls back to the `version` in
`package.json`.

## Release & install

| What | How |
|---|---|
| Cut a release | Push a tag: `git tag v0.2.0 && git push origin v0.2.0`. The `Release` workflow builds, signs, notarizes, and publishes a GitHub Release with all binaries + `SHA256SUMS` + `install.sh`. |
| Ad-hoc build | The same workflow has a **Run workflow** button (`workflow_dispatch`) taking a version string — for builds without tagging. |
| User install | `curl -fsSL https://merlin.dev/install.sh \| bash` — detects OS/arch, downloads the matching binary from the latest release, verifies its SHA-256, installs it as `merlin`, and runs `merlin setup`. |
| Host install.sh | `install.sh` lives at the repo root and ships as a release asset. Serve it from Cloudflare at `merlin.dev/install.sh` (point the route at the raw repo file or the release asset). |

`merlin setup` (run automatically by the installer; safe to re-run) lays down the
files the binary can't carry inline: the CC session hooks at
`~/.merlin/hooks/`, a `~/.merlin/.env` config (from the bundled template), and the
`SessionStart`/`SessionEnd` entries merged into `~/.claude/settings.json`. The
canonical copies of those hook scripts + env template live in `src/cli/setup.ts`.

**Why a macOS *and* a Linux job:** see the arm64 signing caveat above. The macOS
job (arm64 runner) builds + Developer-ID-signs + notarizes the two darwin
binaries; the Linux job cross-compiles linux (glibc + musl) and windows.

The macOS job needs these **repository secrets** (Settings → Secrets and
variables → Actions):

| Secret | What it is |
|---|---|
| `APPLE_CERT_P12` | base64 of the exported *Developer ID Application* cert (`.p12`) |
| `APPLE_CERT_PASSWORD` | password set when exporting that `.p12` |
| `APPLE_SIGN_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_TEAM_ID` | 10-char Apple Developer Team ID |
| `APPLE_APP_PASSWORD` | app-specific password for that Apple ID (notarytool) |
| `KEYCHAIN_PASSWORD` | any string — password for the ephemeral CI keychain |

A bare Mach-O executable can't be *stapled* (stapling targets `.app`/`.dmg`/`.pkg`),
so Gatekeeper does an online notarization check on first launch instead — which is
why notarizing still matters even though we ship a plain binary.

## Test & quality

| Command | When you reach for it |
|---|---|
| `bun run test` | Full unit + integration suite. The pre-commit gate. |
| `bun run test:unit` / `test:integration` | One half only, for a faster loop. |
| `bun run test:no-llm` | Everything except `@llm`-tagged tests — fast, and no API keys / cost. Use when iterating without touching LLM code. |
| `bun run test:llm` | Only the `@llm` integration tests. Hits real models (slow, costs money) — run deliberately, not on every save. |
| `bun run test:clerk` | Just the Clerk subsystem. |
| `bun run test:linux` | Containerized Linux `/proc` verification. Needs Docker; skipped elsewhere because the process-scanning path is platform-specific. |
| `bun run check` | Biome format + lint with autofix. Run before committing. |
| `bun run format` / `format:check` / `lint` | Narrower Biome passes when you want only one of the two. |

## Utilities

| Command | When you reach for it |
|---|---|
| `bun run schema` | Regenerate the JSON Schema files under `schema/` from the Zod sources. Run after changing the protocol/model types so the exported schema stays truthful. |
| `bun run organizer:inspect` | Pretty-print the payload sent to the organizer LLM — for debugging what the model actually saw. |
| `bun run organizer:detailed` | Build a richer organizer-input dump. A debugging/analysis one-off, not part of any normal flow. |
