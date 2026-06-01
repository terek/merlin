# Running Merlin

How the daemon, relay, and web client fit together at runtime, and the
reasoning behind the choices that aren't obvious from the code.

## The pieces

- **Daemon** — discovers Claude Code sessions, builds the model, syncs state.
- **Relay** — a WebSocket broker. The daemon and each client meet in a
  token-scoped "room" and talk through it. Rooms are created lazily on first
  connect; there is no registration step.
- **Bridge** — an encrypting proxy that serves the web UI and translates between
  the browser (plaintext, local) and the relay (encrypted, possibly remote).

The relay exists so a client never needs a direct connection to the daemon —
they only need to reach a common relay. That's what makes a phone on a different
network, or a hosted client, work without poking holes in the host's firewall.
The cost is an extra hop even when everything is on one machine, which is why
the unified mode below runs the relay locally.

## Unified mode (`daemon -w`)

Historically you started `daemon` and `web` as two processes that had to be
*paired* first — an ECDH handshake that wrote a shared key to `~/.merlin`. That
made sense for a remote phone, but it's pure friction when both halves live in
the same process on the same laptop.

`-w` collapses that. The intent: **one command, zero setup, same security
posture.** We didn't want a second, weaker "local" code path, so unified mode
reuses the exact relay + encryption machinery rather than bypassing it:

- The daemon spins up a **local relay** and joins it as the daemon side.
- It generates an **ephemeral token + AES-256-GCM key in-process** and hands the
  same pair to the bridge, which joins as the client side.
- Traffic is encrypted end-to-end just like the paired case.

The key difference from pairing is deliberate: the ephemeral key is **never
written to disk and never sent over the wire** — it's shared object-to-object
within the one process. So there's nothing to persist, expire, or leak, and no
QR/handshake to perform. When the process dies, the credential dies with it.
This is safe *only* because both sides are in the same process; do not
generalize this shortcut to any cross-process or cross-host client.

A consequence worth knowing: `-w` relaxes the "you must pair before starting"
guard. Without `-w`, a daemon with no pairings has nothing to talk to, so it
forces pairing. With `-w` it always has the in-process web client, so it starts
clean on a fresh machine.

## Shipping it as one binary

The web UI is a separately-built Vite bundle. For a `curl | bash` install we
want a *single* artifact with nothing to fetch at runtime, so the built assets
are **embedded into the executable** rather than served from disk.

The mechanism is a generated module (`web:build` writes it) that imports each
built file with `{ type: 'file' }`. `bun build --compile` follows those imports
and bakes the bytes into the binary; from source the same imports resolve on
disk. The reason it's *generated* rather than hand-maintained is that Vite's
output filenames are content-hashed and change every build — a static list would
rot immediately.

Two intentional fallbacks:

- The bridge loads that asset module **lazily** and degrades to a clear
  "Web UI not built" 503 if it's absent. This keeps the `bun run web` dev loop
  (Vite serves the UI with HMR) working without ever building the embedded copy.
- Cross-compilation targets every OS/arch from any host, **except** that an
  arm64 macOS binary must be built and signed on macOS — unsigned arm64 binaries
  are killed on launch by the OS, so there's no point cross-producing them.

## Ports

Two ports are in play under `-w`: the **web bridge** (what you open in a
browser) and the **local relay** (internal plumbing). The startup banner logs
both, but those lines scroll out of the TUI's fixed dashboard within seconds —
so the live ports are also pinned into the dashboard header. The whole point is
that you can glance at a long-running daemon and still see where the UI is.

**Web port** resolves as `--web-port` flag → `$PORT` env → `4860`. The `$PORT`
fallback is there so the bridge drops into portless / PaaS environments that
inject the port, with no flag plumbing.

**Bind host** follows the same portless convention used for the Vite dev server:
when `PORTLESS_URL` is set we bind dual-stack (`::`) instead of the injected
IPv4 `HOST`. This is not cosmetic — portless registers the upstream as
`localhost`, which resolves IPv6-first on macOS, so binding only the IPv4
address leaves `[::1]` dead and the proxy 404s. Dual-stack keeps both reachable.

The **relay** is intentionally *not* portless-aware: it's localhost-only plumbing
between the in-process daemon and bridge, never the externally-exposed service,
so it stays on a fixed `4857`. The known limitation of that choice is that two
daemons on one host collide on the relay port; if that ever matters, switch
`createRelay` to an OS-assigned port (`0`) — everything downstream already reads
the actual assigned port, so nothing else needs to change.
