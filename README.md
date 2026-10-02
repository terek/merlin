# Merlin

Merlin keeps a summary of every [Claude Code](https://claude.com/claude-code) session on your
machine: what it cost (subagents included), what you asked, what the agent last said, and where
it stopped. It follows running sessions and serves the result as a web page on a local port,
and as commands in the terminal. Nothing leaves your machine and no model is called.

The Go program in [`explorer/`](explorer/) (Merlin Explorer) is what is built and released as
`merlin`. The TypeScript sources at the top level (`src/`, `packages/`, `scripts/`, `tests/`)
are the earlier Merlin, a remote-control daemon with a relay; they are kept for reference and
are no longer built or released.

## Install

```sh
curl -fsSL https://merlin.dev/install.sh | bash
```

This downloads the binary for your OS and architecture from the latest
[release](https://github.com/terek/merlin/releases/latest), checks its SHA-256 and installs
it as `merlin` in `/usr/local/bin` (if writable) or `~/.local/bin`. It starts nothing and does
not touch `~/.claude`. macOS and Linux, arm64 and x64; Windows is not supported.

`MERLIN_VERSION=0.2.0` pins a version and `MERLIN_INSTALL_DIR=<dir>` chooses the directory.

## First run

```sh
merlin serve
```

Open http://127.0.0.1:7433/. The first start:

- indexes your sessions from `~/.claude` into `~/.explorer` (read-only on `~/.claude`);
- adds five hook entries (SessionStart, UserPromptSubmit, Stop, SubagentStop, SessionEnd) to
  `~/.claude/settings.json`, keeping a backup next to it, so live sessions show up at once.
  `merlin serve --no-hooks` skips this; the page then updates on a periodic rescan.

The server listens on 127.0.0.1 only.

## The UI

- **Sessions** (`/`): every session, newest first, with project, state and cost; search over
  prompts, answers and titles; filters in the URL.
- **Session** (`/s/claude/<id>`): the turns, the subagent tree, compactions and cost, and the
  command to resume it.
- **Cost** (`/cost`): spend by project, day or model over 7, 30 or 90 days, or all time.

## Commands

```
merlin cost [--by B] [--since D]          cost rollups
merlin doctor                             format drift, unpriced models, attributed vs reported
merlin help                               show this help
merlin hook                               called by Claude Code
merlin hooks install|uninstall|status     manage Claude Code hooks
merlin scan                               index once and exit
merlin search <terms...>                  matching turns with the resume command
merlin serve [--port 7433] [--no-hooks]   daemon: index, follow, serve
merlin sessions [--project P] [--kind K] [--since D]   list sessions, newest first
merlin show <session-id>                  turns, agent tree, compactions, cost
merlin upgrade                            how to upgrade (prints the installer command)
merlin version                            print the version
```

The read commands work without the daemon. See [`explorer/docs/`](explorer/docs/) for the
HTTP API and the design.

## Upgrade

Run the installer again. `merlin upgrade` prints the command; it does not update itself.

## Where state lives

- `~/.explorer` (`EXPLORER_HOME`): `config.json`, the lock and log, and one JSON digest per
  session under `claude/projects/`. Everything in it can be rebuilt from `~/.claude`.
- `~/.claude/settings.json`: the five hook entries, and their backups
  (`settings.json.explorer-backup-*`).
- `CLAUDE_CONFIG_DIR` selects another Claude Code directory instead of `~/.claude`.

## Uninstall

```sh
merlin hooks uninstall     # remove the five hook entries from ~/.claude/settings.json
rm "$(command -v merlin)"  # remove the binary
rm -rf ~/.explorer         # remove the index
```

If you ran the earlier Merlin, `~/.claude/settings.json` may also hold two entries running
`~/.merlin/hooks/session-start.sh` and `session-end.sh`; they are harmless and can be removed
by hand, together with `~/.merlin`.

## Building from source

From `explorer/`: `make build` (needs Go and [bun](https://bun.sh); embeds the UI into
`bin/merlin`), `make test`, `make vet`, `make web-check`. Releases are described in
[`explorer/PLAN.md`](explorer/PLAN.md#12-releasing).

## License

[Apache License 2.0](LICENSE) © Zsolt Terek
