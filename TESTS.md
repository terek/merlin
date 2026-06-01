# Tests

`bun run test` runs the daemon-level suite: **157 tests across 13 files** under
`tests/unit/` and `tests/integration/`. The workspace packages carry their own
tests, run from each package: `packages/cc/tests/`, `packages/processor/tests/`,
`packages/llm/tests/`, `packages/ignore/tests/`.

> Note: this document predates the monorepo split and still groups some suites by
> their original (pre-`packages/`) location. Several suites described below now
> live under `packages/cc/tests/` (CCSession, ProcessScanner, Discovery,
> SessionLockfileReader, RollingBuffer) and `packages/processor/tests/`.

## Unit tests (no I/O, <1s)

### JSON Patch (`tests/unit/patch.test.ts`)
Round-trip correctness of `generatePatch` / `applyOps` / `snapshot` — addition, removal, replacement, immutability, empty ops.

### RollingBuffer (`tests/unit/rolling-buffer.test.ts`)
Push, capacity eviction, tail, clear, copy semantics.

### CCSession state machine (`tests/unit/cc-session.test.ts`, 69 tests)
Ported from legacy `json-stream-session.test.ts`. All tests feed events via `_handleLine()` without spawning a process.
- State transitions: starting→idle on first event, write()→busy, result→idle, full turn cycles
- Tool approval: `can_use_tool` with 0/1/2+ suggestions → waitingForInput or offeringChoices, writeKey y/n/enter/arrows clears approval and transitions to busy
- AskUserQuestion: detected from assistant tool_use block, state stays busy until result arrives, then waitingForInput; write() answers via control_response and clears pendingQuestion
- AskUserQuestion via control_request (CC 2.1.71+): works with or without prior assistant event, full flow through answer→result→idle
- contextLines rendering: system/assistant/user/tool_use/tool_result/thinking/result all produce correct `[tag]` lines; keep_alive/stream_event produce nothing; CC 2.1.59+ embedded tool events in assistant/user content blocks
- Robustness: non-JSON lines, empty lines, unknown event types, empty content arrays — no crashes
- `start()` with `/bin/cat` as binary transitions to idle immediately (mimics CC JSON mode silence)

### ModelStore (`tests/unit/model-store.test.ts`)
CRUD for projects and active sessions, listener fire/unsubscribe semantics, context line trimming at 2000.

### SyncEngine (`tests/unit/sync-engine.test.ts`)
- Subscribe sends full snapshot immediately (metadata and session scopes)
- Model mutation sends JSON Patch to subscribed clients only
- Unsubscribed and removed clients receive nothing
- Subscribe to nonexistent session sends error
- **Reconnection (CRITICAL)**: client disconnects, model mutates, client reconnects → gets full snapshot with all changes
- **Session reconnection**: same pattern for session scope — reconnected client gets current state, not stale

### ProcessScanner (`tests/unit/process-scanner.test.ts`)
All tests use injected deps (no real pgrep/lsof).
- Finds processes, excludes managed PIDs, groups by cwd
- Cache: lsof only called for new pids; stale pids evicted on next scan; force clears cache
- Graceful handling of lsof failures
- Multiple binary names scanned in parallel
- `--resume <sessionId>` extraction from process args via `psArgs` dep
- No sessionId when `--resume` flag absent; psArgs failure doesn't break scan
- `parseResumeSessionId`: extracts UUID, rejects non-UUID, handles extra spaces

### SessionLockfileReader (`tests/unit/session-lockfiles.test.ts`)
Reads `~/.merlin/sessions/<sessionId>.json` lockfiles written by CC hooks.
- Returns empty for nonexistent/empty dir
- Reads lockfile for alive process (uses own PID)
- Removes lockfile for dead process (PID 999999)
- Removes corrupt lockfile
- Ignores non-json files
- `byCwd` groups locks by working directory
- Multiple alive sessions coexist

### Platform-specific implementations (`tests/unit/process-scanner.test.ts`)
Platform-aware tests — macOS tests skip on Linux and vice versa.
- `lsofCwd` (macOS): resolves own process cwd, null for nonexistent PID
- `procCwd` (Linux): resolves cwd via `/proc/<pid>/cwd`, null for nonexistent PID
- `psArgs` (macOS): resolves own args via `ps`, null for nonexistent PID
- `procArgs` (Linux): resolves args via `/proc/<pid>/cmdline`, null for nonexistent PID
- Scanner with `/proc`-style deps: simulated Linux resolver correctly maps sessionId

### Discovery (`tests/unit/discovery.test.ts`)
Uses temp directories with fixture JSONL files.
- Single session, multiple sessions per project (sorted newest-first), slug/customTitle extraction
- Skips macOS temp directories (`/tmp`, `/private/var/folders/`)
- Skips Linux temp directories (`/snap/`, `/run/user/`)
- Skips sessions with no timestamp; uses filename as fallback sessionId
- `getLatestJsonlPath` returns newest session's path
- Handles corrupt JSONL lines gracefully
- Projects sorted by lastTimestamp descending

### Crypto (`tests/unit/crypto.test.ts`, 13 tests)
All WebCrypto, no I/O.
- base64url encode/decode round-trip
- AES-256-GCM encrypt/decrypt round-trip, envelope structure, unique IV per encryption
- Wrong key → decryption throws
- Tampered ciphertext → decryption throws (GCM auth tag verification)
- Tampered IV → decryption throws
- ECDH P-256: both sides derive same working key, different keypairs produce different shared keys
- Third party with their own keypair cannot decrypt messages between two other parties
- Keypair export/import round-trip (PKCS8/SPKI base64url), re-imported key derives same shared key
- AES key export/import round-trip

## Integration tests — in-process, no real CC (~2s)

### Relay (`tests/integration/relay.test.ts`)
Starts a real Bun WebSocket server on port 0 per test.
- Health check endpoint returns 200
- Rejects WebSocket upgrade with missing/invalid side or token
- **Daemon→client routing**: daemon sends a message, client receives it
- **Client→daemon routing**: client sends a message, daemon receives it
- **Broadcast**: daemon message reaches multiple clients on same token
- **Token isolation**: messages on token-a don't leak to token-b
- **Queue for offline client**: daemon sends while no client connected, client gets queued messages on connect
- **Queue for offline daemon**: client sends while no daemon connected, daemon gets queued messages on connect

### Direct mode — encrypted (`tests/integration/direct-mode.test.ts`)
All relay tests use ECDH-derived shared keys — daemon and client encrypt/decrypt all messages.
- **Encrypted relay round-trip**: relay + daemon + TestClient; client subscribes, receives encrypted snapshot with correct host info
- **Multi-client**: two clients with same shared key both receive metadata
- **SyncEngine without relay**: in-process SyncClient receives snapshot on subscribe, then JSON Patch on mutation
- **Session subscription + patches**: create active session, subscribe, mutate state → client receives session snapshot then patch
- **Periodic refresh detects process exit (CRITICAL)**: mock scanner starts with external CC process → builder.refresh() → model shows `external` owner → process "exits" (empty PIDs) → second refresh → project removed from model → subscribed client receives patch
- **Daemon periodic refresh pushes ownership via relay**: daemon with 500ms refresh interval + mock scanner; client sees external-owned project, then process "exits", client receives patch within next refresh cycle updating model
- **Client reconnection (CRITICAL)**: daemon running → client connects → gets snapshot → model changes → client disconnects → client reconnects → gets fresh snapshot with all changes
- **External CC sets activePid via --resume (CRITICAL)**: mock psArgs returns `--resume <uuid>`, only matching session gets `activePid`
- **Multiple sessions active simultaneously**: two CC processes with different `--resume` UUIDs each set `activePid` on their session
- **No activePid when no external process**: session exists but no CC process running
- **External CC without --resume**: project marked external but no session gets `activePid` (project-level fallback only)

### Pairing flow (`tests/integration/pairing.test.ts`, 2 tests)
Full pairing protocol over real relay + WebSocket connections.
- **Key exchange**: daemon creates code via `/pair/create`, client joins via `/pair/join/:code`, both connect to relay WebSocket, client sends `key_exchange` with public key, daemon derives shared key, sends ack, then encrypted communication works (encrypt with daemon's key, decrypt with client's key)
- **Pairing → daemon → metadata**: full flow from pairing through daemon startup to encrypted metadata snapshot — client receives model with `host.instanceName` matching the daemon

### Security — E2E (`tests/integration/security.test.ts`, 10 tests)
Full pairing + encryption tests using relay on port 0, real WebSocket connections, real crypto.

**Pairing flow:**
- **Full pairing**: `POST /pair/create` → 6-char code + token → `POST /pair/join/:code` → both sides derive shared AES key → daemon and client communicate over encrypted relay
- **Single-use codes**: code consumed on first join, second attempt gets 404
- **Invalid code**: random code → 404
- **Create requires daemonPubKey**: missing field → 400
- **Join requires clientPubKey**: missing field → 400

**Eavesdropping resistance:**
- **Relay sees only ciphertext**: raw WebSocket spy intercepts messages — all have `encrypted`/`iv` fields, none contain `snapshot`/`metadata`/plaintext model data like instance names
- **Wrong key can't decrypt**: eavesdropper with their own keypair receives encrypted blobs, every `decryptEnvelope()` call throws

**Message injection resistance:**
- **Plaintext injection rejected**: attacker sends unencrypted `subscribe` message to daemon's relay room — daemon silently ignores it, legitimate client still works
- **Wrong-key injection rejected**: attacker encrypts message with their own AES key — daemon can't decrypt, ignores it, legitimate client unaffected

**Session isolation:**
- **Cross-pairing isolation**: client from a different pairing (different shared key) connects to same relay token — cannot decrypt any messages, times out waiting for model

**Pairing code security:**
- **Code format**: 6 alphanumeric chars (base-36), all unique across 10 generations
- **Relay never exposes secrets**: `/pair/create` response has only `code`/`sessionToken`/`expiresIn`; `/pair/join` returns only `sessionToken`/`daemonPubKey`/`daemonName` — no private keys or shared keys
- **Public key insufficient**: attacker who knows both public keys but neither private key derives a completely different shared key; cannot decrypt messages

### TUI smoke (`tests/integration/tui-smoke.test.ts`, 16 tests)
End-to-end tests for the TUI client's metadata display path: pairing → daemon → relay → encrypted subscription → render.

**Metadata display (with real daemon + relay + discovery):**
- **No empty-state flicker**: first metadata snapshot already contains discovered projects — client never sees "No projects discovered" flash
- **Render contains project names**: every discovered project's `displayName` appears in the TUI output
- **Session summary lines**: render includes turn counts (`N turns`) from session history
- **Patch updates produce new renders**: each incoming patch triggers a re-render with updated data

**Session disambiguation:**
- **Duplicate slugs get hash suffix**: two sessions with same slug render with `(abc123)` suffix to distinguish them
- **Unique slugs not suffixed**: sessions with distinct slugs render as-is without hash suffix

**Per-session LED indicators:**
- **activePid → yellow LED**: session with `activePid` set shows yellow `●`, others show dim `○`
- **Multiple live sessions**: two sessions in same project both with `activePid` both show yellow `●`, historical session shows dim `○`
- **Daemon green + external yellow**: daemon's `activeSessionId` gets green `●`, external `activePid` session gets yellow `●`, dead session gets dim `○`
- **All dead → all dim**: sessions with no `activePid` and no `activeSessionId` all show dim `○`
- **External project without identified session**: all sessions show yellow half-LED `◑` when CC runs but session unknown

**Render edge cases (pure render function, no I/O):**
- **Null model**: shows "Waiting for data..." with host name and connection status
- **Disconnected state**: shows red "disconnected" indicator
- **Empty projects**: shows "No projects discovered" with helpful message
- **Active session**: project with `activeSessionId` appears under "Active Sessions" section

## Live tests — guarded, require `claude` on PATH (~10s)

### Full message path (`tests/integration/live-cc.test.ts`)
Skipped via `describe.skipIf(!Bun.which('claude'))`. All communication E2E encrypted with ECDH-derived keys.
- **open_project**: spawns CC in a temp directory, session reaches idle, activeSessionId appears in model
- **send_message → busy → idle**: sends "Reply with exactly one word: PONG", asserts busy transition, waits for idle with contextLines containing `[assistant]` line with PONG and `[turn complete]`
- **Second prompt**: sends another prompt, verifies session stays alive and produces a second turn complete
- **ccSessionId captured**: after first turn, the CC session ID (from result event) is non-null on the ActiveSession
- **kill_session**: kills the session, model shows no activeSessionId for the project

### Discovery (`tests/integration/live-cc.test.ts`)
- **Real discovery**: daemon scans `~/.claude/projects/`, client receives metadata snapshot with discovered projects (asserts model structure is valid, logs found projects)

## Containerized Linux tests — require Docker (`bun run test:linux`)

### /proc verification (`tests/linux/verify-proc.test.ts`)
Runs a shell script inside a Linux container to verify the `/proc` assumptions used by process-scanner.ts.
Set `LINUX_TEST_IMAGE` env var to override the container image (default: `alpine:3.20`).
- **/proc/pid/cwd**: symlink resolves to background process's working directory
- **/proc/pid/cmdline**: null-separated args contain `--resume` flag and UUID, extractable after null→space conversion
