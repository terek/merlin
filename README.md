# Merlin

Monitor and steer your [Claude Code](https://claude.com/claude-code) sessions from
anywhere. A local daemon discovers your running CC sessions, builds a live model of
their state, and syncs it — end-to-end encrypted, through a relay — to a web or
mobile client. Answer prompts and approvals without being at the machine.

> ⚠️ **Incomplete / work in progress.** Merlin is under active development, not yet
> feature-complete, and APIs and behavior may change. Expect rough edges.

## Install

```sh
curl -fsSL https://merlin.dev/install.sh | bash
```

Detects your OS/arch, downloads the matching signed binary, verifies its checksum,
installs it as `merlin`, and sets up the Claude Code hooks under `~/.merlin`.

Then add your API keys to `~/.merlin/.env` and start it:

```sh
merlin
```

macOS and Linux (x64/arm64, glibc + musl) are supported. Windows: grab
`merlin-windows-x64.exe` from the [latest release](https://github.com/terek/merlin/releases/latest).

## Update

```sh
merlin upgrade          # update in place if a newer release exists
merlin upgrade --check  # just report whether an update is available
```

If you installed to a system path like `/usr/local/bin`, run `sudo merlin upgrade`.

## License

[Apache License 2.0](LICENSE) © Zsolt Terek
