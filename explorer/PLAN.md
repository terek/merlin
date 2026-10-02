# Merlin Explorer — plan

Status: released as v0.2.0 on 2026-10-02 (the command is `merlin`; it replaces the earlier
Merlin binary in releases and is installed by install.sh). Core, web UI, incremental live reads
and the release workflow are done and were verified against the real corpus (results in
[docs/validation.md](docs/validation.md); UI design in [docs/ui.md](docs/ui.md)). Open: starting
the daemon at login (`merlin-t8s.26`). Tracked in beads (`bd list`, epic `merlin-t8s`).
Decided: Go; hooks are installed by `merlin serve`; texts are stored whole; scripted runs are
counted and shown only in aggregate; storage and code are split per harness
(`~/.merlin/claude/`, `internal/claude/`) so Codex and Pi can be added later.

## 1. What it is

One binary, `merlin`. You start it; it keeps a summary ("digest") of every Claude Code
session under `~/.merlin/claude/projects`, follows running sessions, and serves the result on a
local port.

Two goals, in priority order:

1. **Cost.** What each session cost, subagents included, and how that rolls up by
   project, day and model.
2. **Finding things.** "Where was the session where I asked X, and which one do I resume?"
   — what I asked, what the agent last said, where it stopped.

Out of scope: any LLM call, task segmentation, concept extraction, remote control, relay,
mobile. Explorer never writes to `~/.claude` except to add its hooks to `settings.json`.

## 2. Language: Go

Agreed. Reasons that matter for this tool specifically:

- **The hook path.** Claude Code runs the hook command on every prompt and stop. A Go
  binary starts in a few milliseconds; a Bun-compiled one takes tens and is ~60–100 MB.
- **A daemon that is always on.** ~15 MB resident versus Bun's 60–100 MB.
- **One static file.** No runtime to keep in sync, and the UI embeds with `go:embed`.
- **Tolerant decoding is the default.** `encoding/json` ignores unknown fields, which is
  the right behaviour for a format with 40+ record types that changes every release.

What TypeScript would have bought: reuse of `packages/processor/src/jsonl-parser.ts` and
`lean-session.ts` (a few hundred lines, and their subagent and compaction handling is what
we are replacing anyway), and shared types with the React UI (the API surface is small;
generate or hand-mirror them when the UI starts). Neither outweighs the above.

Cost of the choice: Go is not installed on this machine. `brew install go` (1.27).

Dependencies: standard library plus `tidwall/gjson` + `tidwall/sjson` for editing
`settings.json` without reformatting it. No SQLite, no cgo, no CLI framework.

## 3. Design principles

1. **The filesystem is the truth; everything else is a hint.** The set of work to do is
   computed by comparing source files with stored digests. There is no persisted queue to
   corrupt. Kill the process at any point and the next start redoes exactly what is stale.
2. **A digest is a pure function of one session's files.** Same files + same parser
   version → same digest. Anything that depends on other sessions (de-duplicating copied
   history, lineage, rollups) is computed in memory at load time, never stored per session.
3. **Hooks only reduce latency.** A lost hook costs a few seconds, never correctness.
4. **Digests outlive transcripts.** If a transcript disappears, the digest stays and is
   marked `sourceMissing`. Explorer becomes the durable ledger.
5. **Tolerate format drift, and make it visible.** Unknown record types and unparseable
   lines are counted per session, never fatal. `merlin doctor` reports them.
6. **Two cost numbers, never blended.** *Attributed* = recomputed from token usage, which
   is what gives the per-agent and per-turn breakdown; it misses calls that leave no trace
   in the transcript. *Reported* = Claude Code's own `cost-state` totals; they include
   those calls but cover only certain time windows of a session. Each stretch of time
   uses one or the other, never a mix of both for the same spend.

## 4. Layout

```
explorer/
  cmd/explorer/                 main, one file per subcommand
  internal/model/               digest schema — the shared contract, harness-neutral
  internal/pricing/             price table (embedded JSON + override), cost(usage, model)
  internal/store/               atomic JSON files under MERLIN_HOME
  internal/catalog/             in-memory view: ownership, lineage, rollups, search
  internal/harness/             the interface the engine drives
  internal/engine/              reconcile loop, work queue, live following
  internal/server/              HTTP JSON API, SSE, embedded UI
  internal/claude/              the Claude Code adapter — the only code that knows ~/.claude
    transcript/                 record structs, line reader
    discover/                   walk ~/.claude/projects → session sources + fingerprints
    digest/                     Builder (per-file reducer) + Assemble (session from its files)
    hooks/                      settings.json install/uninstall, hook client
  web/                          React UI (later)
  testdata/                     synthetic transcripts + golden digests
  docs/
```

```
~/.merlin/                        (MERLIN_HOME; shared with the earlier Merlin, whose files are left alone)
  config.json                     port, source dirs, price overrides
  merlin.lock                     flock — one instance
  merlin.log
  claude/                         one directory per harness; codex/, pi/ … later
    hooks/notify.sh               wrapper the Claude Code hooks call
    projects/<project-key>/
      sessions/<session-id>.json  one digest per session
      project.json                derived listing, rebuildable from the digests
```

`CLAUDE_CONFIG_DIR` (default `~/.claude`) selects the Claude source tree.

### Other harnesses later

Only Claude Code is implemented. The split that keeps Codex, Pi and others cheap to add:

- **The digest is harness-neutral.** Sessions, turns, agents, compactions, messages and
  cost mean the same thing everywhere. Every digest carries `harness`.
- **Everything harness-specific sits behind one small interface** (`internal/harness`):
  name, discover session sources with fingerprints, build a digest from a source, name
  live sessions, map a hook event to a session. The engine, store, catalog, server and
  CLI only see that interface. A new harness is a new `internal/<name>/` package and a
  `~/.merlin/<name>/` directory.
- **Projects are identified by directory path**, not by a harness's storage key, so the
  catalog can show one project across harnesses. `projectKey` stays as the storage key.
- **A session is identified by `(harness, id)`.**
- No plugin system and no registry beyond a list of adapters in `main`. The interface is
  written for one implementation and adjusted when the second one arrives.

## 5. The digest

One JSON file per session. This schema is the contract between every package; it is
written first and changed deliberately (`schemaVersion`).

```
SessionDigest
  schemaVersion, parserVersion
  source          [{path, size, mtimeNs}]  every file read; this is the fingerprint
  sourceMissing   bool
  harness         "claude"
  id, projectKey  projectKey = the harness's storage key for the project
  project         directory path the session was started in — the project's identity
  cwd, cwds[], gitBranches[], harnessVersions[]
  kind            interactive | sdk | background
                  sdk only when every record's entrypoint is sdk-cli; a session that
                  mixes cli and sdk-cli records was picked up by a remote client and
                  is interactive
  title           custom title > AI title > first line of the first prompt
  name, slug
  startedAt, lastActivityAt
  endState        clean | interrupted | mid-turn | unknown   — how the last turn ended
  recaps[]        {at, text}            Claude Code's own away_summary records
  lineage         {forkedFrom?: {sessionId, messageUuid}, inheritedFrom?: [sessionId]}  explicit markers only;
                  the full picture (§7) is worked out by the catalog
  stats           {humanTurns, turns, assistantMessages, toolCalls, toolsByName{}, linesAdded?, linesRemoved?}
  cost            Cost (session own + all agents)
  reported?       {totalUSD, byModel, windows[{from, to, totalUSD, byModel}]}   one window per cost-state run; totals are sums over windows
  compactions[]   Compaction
  turns[]         Turn
  agents[]        Agent                 flat list; tree via parentAgentId
  messages[]      {id, at, model, agentId?, turn?, usd, tokens…}  one per billed API message
  diagnostics     {unknownTypes{}, badLines, unpricedModels[], unresolvedAgents}

Cost        {usd, byModel{model: {input, output, cacheRead, cacheWrite5m, cacheWrite1h, usd}}}

Turn
  index, epoch                which compaction epoch it falls in
  uuid                        uuid of the prompt record — lets the catalog match copied turns across sessions
  abandoned                   bool: the turn is on a branch the session later rewound away from
  startedAt, endedAt, durationMs
  origin          human | command | task-notification | peer | scheduled | sdk | continuation
  userText        the prompt, verbatim and complete
  images          count of pasted images (the image data is not stored)
  command?        slash command name, when origin is command
  finalText       last assistant text of the turn, complete
  interrupted     bool
  assistantMessages, toolCalls, toolsByName{}, filesTouched[]
  contextTokens   context size at the end of the turn
  cost            Cost of the main agent in this turn
  costWithAgents  usd, including agents spawned in this turn
  spawned[]       agentIds

Agent
  id, kind        subagent | teammate | fork | compact
  name?, agentType?, description?, model
  parentAgentId   null = spawned by the main agent
  spawnToolUseId?, spawnTurn?, depth, background
  linkage         meta | tool-result | name | prompt | unresolved
  startedAt, endedAt
  status          completed | killed | open     open = no terminal marker in the files; whether it is actually running is the catalog's call
  prompt          first prompt, complete
  finalText       last assistant text, complete
  inbox[]         {at, from?, text}     later messages it received (teammates)
  assistantMessages, toolCalls, toolsByName{}
  compactions[]
  cost            own
  subtreeUSD      own + descendants

Compaction  {at, turn, trigger, preTokens, postTokens?, durationMs?, summary}
```

**Texts are never truncated.** Prompts, final texts, agent prompts, inbox messages and
compaction summaries are stored whole. Only text blocks count as text: tool calls, tool
results, thinking and image data are not stored. Any shortening is the UI's or the CLI's
job at display time.

`messages[]` is what makes the cross-session rules in §7 possible without re-reading
transcripts. Roughly 110k entries across the whole corpus — a few MB.

### Turn rules

- A turn starts at a main-file `user` record that is a prompt: not a tool result, not
  `isMeta`, not `isCompactSummary`.
- Origin comes from `origin.kind` / `promptSource` when present, otherwise from the text
  prefix (see format notes §4). Slash commands are turns with `origin: command`; their
  `userText` is what was typed (`/review the login page`, `!ls src`), not the tag wrapping
  the harness stores.
- A bare `[Request interrupted by user]` marks the previous turn interrupted and is not a
  turn. With text after it, the marker is stripped and the rest is a turn.
- `finalText` = the text blocks of the last assistant message in the turn that has any. If
  that is under 80 characters, prepend the previous text message (the old
  `pickResponse` heuristic from `packages/processor/src/lean-session.ts`).
- Agent-driven turns (`task-notification`, `peer`) are kept as turns — they cost money —
  and the UI collapses them.

### Compaction

Compaction is append-only: the transcript keeps the whole history and gains a boundary
marker plus a summary (format notes §6). So:

- The session stays one continuous timeline. Turns before the boundary are kept and
  counted like any others.
- Each `compact_boundary` starts a new epoch. Turns carry their epoch; `contextTokens` per
  turn gives the sawtooth.
- The digest records trigger, before/after tokens, duration and the whole summary. The
  summary is not a prompt and not a turn. It is searchable, labelled as a summary hit and
  ranked below prompts.
- A turn's epoch is the number of compactions before it. A file that begins with a boundary has a summary, no earlier turns, and its first turn in epoch 1.
- Order by file position, never by `logicalParentUuid`. Skip records whose uuid was
  already seen in the same file.
- Subagents get the same treatment.

### Branching and forking

Three different things, all recoverable from the files (format notes §9):

| what | how it shows up | how Explorer treats it |
|---|---|---|
| **Rewind inside a session** (edit a prompt, retry) | two records with the same `parentUuid`; the file keeps both branches | turns stay in file order; a turn not on the path from the last record back to the start is flagged `abandoned`; its cost still counts |
| **Fork / continuation into a new session** | a new session file that starts with a copy of another session's records (same uuids and message ids) | catalog links the two sessions, marks the copied turns as inherited, bills each message once (§7) |
| **Fork subagent** | agent meta `isFork`; inherits the parent's context | an agent of kind `fork` in the tree |

The active path is found by walking `parentUuid` (and `logicalParentUuid` across a
compaction) upward from the last conversation record in the file. Where a parent is
missing from the file the walk stops and everything earlier counts as active — a broken
chain must never mark history as abandoned.

## 6. Engine

```
        startup scan ─┐
   periodic rescan ───┼─▶ reconcile: for every session source, compare fingerprint with digest
        hook nudge ───┘                │ stale / missing / parser version changed
                                       ▼
                      in-memory queue, keyed by session (deduped), live sessions first
                                       ▼
                      worker pool: read files → Builder → Assemble → atomic write → catalog update
```

- **Fingerprint** = `(path, size, mtimeNs)` of every file in the session, plus
  `parserVersion`. Bumping the parser version reprocesses everything automatically.
- **Writes** are temp file + fsync + rename. A digest that fails to parse is treated as absent.
- **Failures**: a panic or error in one session is caught, logged, and recorded as an
  error digest stub carrying the fingerprint, so it is retried only when the files change.
- **Rescan** every 10 s (a stat walk of ~4k files takes tens of milliseconds), and
  immediately on a hook.
- **Live sessions**: any session whose files changed in the last few minutes, or that a
  hook or `~/.claude/sessions/<pid>.json` names, is polled every second and reprocessed
  with a debounce (at most once per 3 s; immediately on `Stop` / `SessionEnd`).
- **Incremental reads**: `Builder` is a reducer over records, so the Claude harness keeps,
  for every file of a *followed* session, the Builder plus the reader offset and guard (a hash
  of the 256 bytes before the offset) and the size and mtime the file had when read, and feeds
  it only appended bytes (`internal/claude/incremental.go`). The daemon tells the harness
  which sessions are live (`harness.Follower`: Follow / Release); the engine does not know.
  A file is read whole when it is new, shrank, changed without growing (mtime moved, size
  not larger), fails its guard, or the state is from another parser version; an unchanged
  file is not read. An unterminated last line is never consumed. Because a same-length
  in-place edit is invisible while a file keeps growing, Release (the session left the live
  set) drops the state and, if any appended read fed the stored digest, the daemon rebuilds
  the session once from scratch. Scans and idle rescans keep no state. Kept state is capped
  at 256 MiB of source bytes, least recently built evicted first (the next build is whole).
  Needed because the largest transcript is 52 MB.
- **One instance**: `flock` on `merlin.lock`.
- **First run**: 1.5 GB, parallel across cores; expected well under a minute.

### Hooks

`merlin serve` installs hooks on start (`--no-hooks` to skip); `merlin hooks
install | uninstall | status` does it explicitly.

- Events: `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionEnd`.
- Command: `~/.merlin/claude/hooks/notify.sh`, which runs `merlin hook` if the binary still
  exists and otherwise exits 0 silently. It prints nothing (SessionStart output is
  injected into the model's context) and always exits 0.
- `merlin hook` reads the event from stdin and POSTs it to the daemon with a ~150 ms
  timeout. Daemon not running → drop it; the next scan catches up.
- `settings.json` is edited surgically (existing entries, order and formatting kept),
  idempotently, with a timestamped backup. The existing Merlin hooks are left alone.

## 7. Catalog (in memory)

Loaded from the digests at start, updated as digests are written.

- **Ownership.** A `message.id` is billed once. When several sessions contain it, the owner
  is the session with the earliest `startedAt`; on a tie (a copy keeps the original
  timestamps), the one that has messages of its own dated before the latest shared
  message (format notes §9); then the earliest `lastActivityAt`; then the smallest id. A session's *own* cost counts only messages it owns; the rest is shown
  as "inherited from <session>". Explicit `forkedFrom` / `session_id` markers win over the
  heuristic. The same rule applies between agents inside a session.
- **Lineage.** Sessions that share messages are linked parent → child. The link records
  where in the parent the copy ends (turn index), how many messages are shared, and its
  kind: `fork` when the parent has its own activity after that point or the copy carries
  `forkedFrom`; `continuation` when the parent stops there. Linked sessions form a
  family tree; its leaves are the candidates to resume.
- **Inherited turns.** In a child, a turn whose prompt uuid also exists in the parent is
  marked inherited. Listings and `show` fold inherited turns into one line ("continues
  <parent> from turn 14"). Search matches a copied turn once, in the session that owns
  it, and names the sessions that continue from it.
- **Best cost** for a session = the reported total of its windows + the attributed cost
  of its own messages that fall outside every window (format notes §8). A session is
  `exact` when nothing falls outside, `partial` when some does, `estimated` when it has
  no reported windows at all. Rollups sum best cost and say how much of the total is
  reported and how much attributed.
- **Overhead.** Inside a window, reported − attributed is the cost of calls that are not
  in the transcript. It is shown per session and never spread onto agents or turns.
- **Reported windows are counted once.** If two linked sessions carry a window with the
  same start, it belongs to the earlier session.
- **Rollups** by project, by local-time day (from `messages[]`, so sessions spanning
  midnight split correctly), by model, by kind.
- **Search.** Case-insensitive, all terms must match, over titles, prompts, final texts,
  project and branch. Newest first. In memory — a few thousand prompts.
- **Liveness.** `running (busy|idle)` from `~/.claude/sessions` with a pid check; else
  `recent`; else `ended`.
- **Scripted runs.** `kind: sdk` sessions (one-shot `claude -p` calls — 3,132 files here,
  3,091 of them one eval script, ~$74 in total) are indexed and counted in every cost
  rollup, and shown only in aggregate: one line per project and day ("412 scripted runs,
  $9.80"). They are never listed individually and never searched.

## 8. Commands

```
merlin serve [--port 7433] [--no-hooks]   daemon: index, follow, serve
merlin scan                               index once and exit
merlin sessions [--project P] [--kind interactive|background] [--since 7d]
merlin show <session-id>                  turns, agent tree, compactions, cost
merlin search <terms…>                    matching turns with the resume command
merlin cost [--by project|day|model|session] [--since …]
merlin hooks install|uninstall|status
merlin hook                               called by Claude Code
merlin doctor                             format drift, unpriced models, attributed vs reported
```

The read commands work without the daemon (they load the digests), so the tool is useful
before any UI exists.

HTTP (localhost only): `/api/projects`, `/api/sessions`, `/api/sessions/{id}`,
`/api/search`, `/api/cost`, `/api/events` (SSE), `/hook`.

## 9. Work breakdown

Sized for one worker each. Every task ships with tests against synthetic fixtures; real
transcripts are never committed.

**M0 — contract (sequential, reviewed before fan-out)**

| id | task | done when |
|---|---|---|
| 0.1 | Scaffold: `go.mod`, `cmd/explorer` with dispatch and `version`, `make build test vet` | `make test` passes on an empty tree |
| 0.2 | `internal/model` digest schema and `internal/claude/transcript` record structs, per §5 and the format notes | structs round-trip JSON; schema doc generated |
| 0.3 | Synthetic fixture tree under `testdata/` covering: plain session, multi-line assistant messages, slash command, interruption, compaction ×2, sync subagent, background subagent, nested subagent, teammate, fork, orphan subagents, copied-history pair, SDK one-shot, cost-state, >1 MB line, partial last line, unknown record type | each scenario is a named directory with a README line |

**M1 — leaves (parallel, after M0)**

| id | task | done when |
|---|---|---|
| 1.1 | Line reader: arbitrary line length, complete lines only, offset + tail-guard resume, tolerant decode with counters | fixtures for big, partial and corrupt lines pass |
| 1.2 | Pricing: embedded table, overrides, `[1m]` and date-suffix normalisation, 5m/1h writes, fast multiplier, unpriced reporting | reproduces the worked examples in format notes §8 |
| 1.3 | Discovery: recursive walk, UUID filter, orphans, nested project dirs, fingerprints | fixture tree yields the expected sources |
| 1.4 | Store: layout, atomic write, tolerant read, `MERLIN_HOME` | concurrent-writer and torn-file tests pass |
| 1.5 | Hooks: surgical `settings.json` install/uninstall/status, wrapper script, `merlin hook` client. Verify the hook payload fields against the docs first | install twice = one entry; uninstall restores; unrelated hooks untouched byte for byte |

**M2 — digest (after 1.1, 1.2)**

| id | task | done when |
|---|---|---|
| 2.1 | `Builder`: message grouping by id, turn segmentation, origin classification, final text, per-turn cost and context, compaction epochs, abandoned-branch flag | golden digests for the single-file fixtures |
| 2.2 | `Assemble`: agent files + meta → agents, linkage ladder, kinds, nesting, status, inbox, subtree cost, turn `costWithAgents` | golden digests for all agent fixtures; every linkage rung exercised |
| 2.3 | Session fields: title, kind, end state, recaps, lineage markers, reported cost, stats, diagnostics | golden digests complete |

**M3 — engine and catalog (after M1, M2)**

| id | task | done when |
|---|---|---|
| 3.1 | `internal/harness` interface + Claude adapter; reconciler, queue, worker pool, error stubs; `merlin scan` | kill -9 mid-scan then rescan converges; second scan does no work |
| 3.2 | Catalog: load, ownership, lineage and session families, inherited turns, rollups, search | copied-history fixture is not double counted and is linked as fork or continuation; day rollup splits at local midnight |
| 3.3 | Read commands: `sessions`, `show`, `search`, `cost`, `doctor` | output snapshot tests |
| 3.4 | `serve`: lock, rescan timer, hook endpoint, live following with debounce, liveness, clean shutdown | appending to a fixture file updates the digest within the debounce window |
| 3.5 | Real-corpus validation (read-only): run on `~/.claude`; report attributed vs reported per session; investigate the gap and the >1.0 cases; check the ownership heuristic on the real copied pairs; timings | written report; price table and heuristics corrected |

**M4 — API (after 3.2)**

| id | task | done when |
|---|---|---|
| 4.1 | JSON API and SSE | handler tests |

**M5 — UI** (done, bead `merlin-t8s.18` and its children; design in
[docs/ui.md](docs/ui.md)): React + Vite, built with bun, embedded behind the build tag
`embedui`. Session list with search and filters; session view with turn timeline, agent tree
and compaction markers; cost views.

| Bead | Deliverable | Depends on |
|---|---|---|
| 5.1 | web scaffold, embedding, shell, data layer, shared primitives, mock API | 4.1 |
| 5.2 | API additions: summary previews, cost `split`, `session-state` event | 4.1 |
| 5.3 | Sessions page | 5.1, 5.2 |
| 5.4 | Session page | 5.1, 5.2 |
| 5.5 | Agents card and context chart | 5.1 |
| 5.6 | Cost page | 5.1, 5.2 |
| 5.7 | lead review on the real history | 5.3–5.6 |

**M6 — later**: incremental live reads, launchd agent, rename to Merlin.

## 10. Risks and open questions

| risk | handling |
|---|---|
| Inside reported windows, transcript-derived cost is ~7% under Claude Code's own figure (median 6.6%, 10th percentile 14%) | show reported for the windows and attributed outside them, never a blend; 3.5 investigates what the hidden calls are |
| Reported cost covers only windows: nothing before CC ~2.1.250, nothing after the last write of a live or crashed run, nothing for a run that never wrote one ($146 of $2,630 attributed fell outside in the 74 sessions that have any) | best cost adds attributed spend outside the windows; such sessions are flagged `partial` or `estimated` |
| Whether a copied session carries its parent's `cost-state` records | no real example exists (all copied pairs predate `cost-state`); windows with the same start are counted once; 3.5 re-checks |
| Ownership heuristic can pick the wrong one of two linked sessions | totals are unaffected; lineage is shown; 3.5 checks the real pairs |
| Assumed cache-read prices for older models | 3.5 checks against `cost-state`; `doctor` reports per-model drift |
| Format changes in a future CC release | tolerant parser, `doctor`, parser-version bump reprocesses |
| Transcripts rewritten in place by the redaction script | fingerprint + tail-guard force a full reparse |
| Editing `~/.claude/settings.json` | surgical edit, backup, idempotent, uninstall command |

## 11. Reference points in the old Merlin code

Read for ideas; do not port.

- `packages/processor/src/jsonl-parser.ts` — message merging by id, injected-XML stripping
- `packages/processor/src/lean-session.ts` — `pickResponse`, interruption filtering
- `packages/cc/src/session-lockfiles.ts`, `scripts/session-start.sh` — the hook/lockfile approach being replaced
- `src/cli/setup.ts` — the existing hook installer
- `specs/PROCESSING.md` — the old pipeline, including the parts being dropped

## 12. Releasing

A release is a git tag. `.github/workflows/release.yml` does the rest; `checks.yml` runs the
same checks on every push and pull request.

**Cut a release.** On `main`, with `make test`, `make vet` and `make web-check` green:

```
git tag v0.3.0 && git push origin v0.3.0
```

The tag name is the version: `merlin version` prints `merlin 0.3.0`. The workflow runs the
checks, builds the web UI once, cross-compiles with `scripts/release-build.sh` (CGO off,
`-tags embedui`, version stamped through `-X main.version`), signs and notarizes the two
macOS binaries, smoke-tests what can run natively (`scripts/release-smoke.sh`: version,
`GET /` serves the UI, `GET /api/sessions` is JSON), checks the asset list, and uploads it.

**Test release.** Actions -> Release -> Run workflow, version `0.2.0-rc1`. A version with a
dash is published as a pre-release, which GitHub does not serve as "latest", so
`merlin.dev/install.sh` (a Cloudflare Worker proxying
`releases/latest/download/install.sh`) keeps installing the previous real release. Test it with
`MERLIN_VERSION=0.2.0-rc1 MERLIN_INSTALL_DIR=$(mktemp -d) bash install.sh`, then delete the
release and tag.

**Assets.** `merlin-darwin-arm64`, `merlin-darwin-x64`, `merlin-linux-arm64`, `merlin-linux-x64`,
`SHA256SUMS` (over the binaries) and `install.sh`; the install script must stay an asset.
`merlin-linux-{x64,arm64}-musl` are copies of the static binaries, published only so the
earlier Merlin's `merlin upgrade` (which asks for them on Alpine) keeps working; drop them from
the workflow when nobody runs that binary any more. There is no Windows build (the daemon uses
flock).

**Secrets** (repository settings, Actions): `APPLE_CERT_P12` (base64 Developer ID Application
certificate), `APPLE_CERT_PASSWORD`, `APPLE_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`,
`APPLE_APP_PASSWORD` (app-specific password), `KEYCHAIN_PASSWORD` (any string). Binaries are
signed with the hardened runtime and no entitlements. A bare binary cannot be stapled;
Gatekeeper checks the notarization online on first launch.

**Locally.** `OUT_DIR=/some/dir scripts/release-build.sh 0.2.0 darwin-arm64 linux-x64`, then
`scripts/release-smoke.sh /some/dir/merlin-darwin-arm64 0.2.0`. `install.sh` honours
`MERLIN_BASE_URL` (a directory laid out like a release, served over HTTP) for testing without
GitHub.
