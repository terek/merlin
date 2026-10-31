# Merlin Explorer — working notes for agents

Go program that indexes Claude Code and Codex sessions. Start with [PLAN.md](PLAN.md); read
[docs/transcript-format.md](docs/transcript-format.md) before touching anything that
parses transcripts.

**Names.** The project is Merlin Explorer; the command it builds is `merlin` (it replaced the
old Bun/TS Merlin binary in releases). Its state is under `~/.merlin`
(`MERLIN_HOME`; `EXPLORER_HOME` still works), in `claude/`, `codex/`, `beads/`, `repos.json`,
`merlin.lock`, `merlin.log` and `config.json` only. The old program kept its own files in the
same directory: never read, change or remove anything else there.

## Commands

Run from the repository root.

```
make build      # bin/merlin with the web UI embedded (needs bun)
make build-go   # bin/merlin without the UI (no bun)
make test       # go test ./...
make vet        # go vet ./...
make web-check  # web/: tsc, Biome, bun test
```

Go 1.27 at `/opt/homebrew/bin/go`. Module `github.com/terek/merlin`.

## Rules

- **Dependencies:** standard library, plus `tidwall/gjson` and `tidwall/sjson` in
  `internal/claude/hooks` only. Do not add others; if you think one is needed, say so in the
  bead and stop short of adding it.
- **Harness boundary.** Only `internal/claude/**` may know the layout of `~/.claude` or
  the shape of Claude Code transcripts, and only `internal/codex/**` that of `~/.codex` and
  Codex rollouts ([docs/codex-format.md](docs/codex-format.md)). `internal/model`, `store`,
  `catalog`, `engine`, `server`, `harness` and `hookfile` are harness-neutral and must not import
  `internal/claude/*` or `internal/codex`; other harnesses (Pi) go beside them.
  Storage is per harness: `<MERLIN_HOME>/claude/...`, `<MERLIN_HOME>/codex/...`.
- **Parallel work.** Other agents edit other packages in this tree at the same time. If
  `make test` or `make vet` fails in a package you do not own, do not fix it: run the
  checks for your own packages (`go test ./internal/<yours>/...`) and note the failure.
- **Stay in your packages.** A bead names the packages it owns. `internal/model` and
  `internal/claude/transcript` are the shared contract: additive changes only, and mention them
  in your closing note.
- **A digest is a pure function of the session's files.** No wall-clock time, no
  hostname, no map-iteration order in output. Slices are ordered by time, then id.
- **Tolerant parsing.** Unknown record types, unknown fields and unparseable lines are
  counted, never fatal. Lines can exceed 1 MB — do not use `bufio.Scanner` with its
  default buffer.
- **Texts are stored whole.** Do not truncate prompts, final texts or summaries.
- **Tests never touch the real machine.** No reads of `~/.claude` or `~/.codex`, no writes to
  `~/.merlin`. Use `t.TempDir()`, `MERLIN_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. The one
  exception is the validation bead, which reads `~/.claude` read-only.
- **Fixtures are synthetic.** Never copy content from a real transcript into `testdata/`
  or into any committed file. Write fixture text by hand.
- **JSON conventions:** camelCase keys, RFC 3339 UTC timestamps, USD as float64, token
  counts as int64, `omitempty` on optional fields.
- **Do not commit or push.** Leave changes in the working tree.

## Web UI (`web/`)

The design is [docs/ui.md](docs/ui.md); the API it reads is [docs/api.md](docs/api.md). Read both
before touching `web/`.

- **bun only.** `bun install`, `bun run <script>`, `bunx <tool>`. Never `npm`, `npx` or `node`
  (`node` is broken on this machine).
- **Dependencies** are the ones listed in docs/ui.md §1. Do not add others.
- **Ownership.** A bead owns its directory under `web/src/features/`. `web/src/api`, `lib` and
  `ui` are shared: additive changes only, named in your closing note. Do not restyle a shared
  primitive to suit one view; if it falls short, extend it with a prop.
- **Never serve the real history.** Run the daemon only against the fixtures, with a scratch
  home, without hooks, on the port your bead gives you:
  `CLAUDE_CONFIG_DIR=$PWD/testdata/claude MERLIN_HOME=<scratch dir> ./bin/merlin serve --no-hooks --port <port>`.
  Start it as a background command and stop it when you are done.
- **Look at what you build.** `web/dev/shot.sh <url> <out.png> [width] [height]` screenshots a
  page with headless Chrome (a wrapper over `web/dev/shot.ts`, DevTools protocol, no dependency);
  read the PNG. It waits for the network to go idle (the event stream does not count), so
  scrolled deep links (`#t300`, `#a<id>`) and pages with the event stream on capture fine. Options:
  `--wait-for <css>`, `--eval <js>` (click or press a key first; awaited, value printed),
  `--delay <ms>`, `--port <n>` (Chrome debugging port, default 9333). Check both `?theme=light`
  and `?theme=dark`. Put screenshots in your scratch directory, never in the repository.
- **Dev server and mock.** `VITE_PORT=<p> EXPLORER_API=http://127.0.0.1:<mock or daemon> bun run dev`
  has React fast refresh. `MOCK_PORT=<p> bun run mock`; `MOCK_DAYS=200` stretches the mock's
  history (default 90).
- **Checks.** `make web-check` (TypeScript, Biome, `bun test`) and `make build` must pass, as well
  as `make test` and `make vet`. The repository's Stop hook formats changed `.ts`/`.tsx`/`.json`
  files with Biome (root `biome.json`: 2 spaces, single quotes, no semicolons, 120 columns), so
  write in that style from the start.
- macOS has no `timeout` command, and a bare foreground `sleep` is refused by the harness: run
  servers as background commands and poll with a loop.

## Beads

```
bd show <id>                    # the task, its acceptance criteria and dependencies
bd update <id> --claim          # when you start
bd comment <id> --file note.md  # long notes go through a file, not the command line
bd close <id> --reason "..."    # when acceptance criteria are met and make test passes
```

Close a bead only when its acceptance criteria hold and `make test` and `make vet` pass.
If you cannot finish, leave it open and comment with what is done and what blocks you.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
