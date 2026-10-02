# Merlin Explorer — working notes for agents

Go program that indexes Claude Code sessions. Start with [PLAN.md](PLAN.md); read
[docs/transcript-format.md](docs/transcript-format.md) before touching anything that
parses transcripts. The rest of this repository is the old Bun/TS Merlin: reference
only, never edit it.

## Commands

Run from `explorer/`.

```
make build      # bin/explorer
make test       # go test ./...
make vet        # go vet ./...
```

Go 1.27 at `/opt/homebrew/bin/go`. Module `github.com/terek/merlin/explorer`.

## Rules

- **Dependencies:** standard library, plus `tidwall/gjson` and `tidwall/sjson` in
  `internal/claude/hooks` only. Do not add others; if you think one is needed, say so in the
  bead and stop short of adding it.
- **Harness boundary.** Only `internal/claude/**` may know the layout of `~/.claude` or
  the shape of Claude Code transcripts. `internal/model`, `store`, `catalog`, `engine`,
  `server` and `harness` are harness-neutral and must not import `internal/claude/*`
  subpackages; other harnesses (Codex, Pi) will be added beside `internal/claude` later.
  Storage is per harness: `<EXPLORER_HOME>/claude/...`.
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
- **Tests never touch the real machine.** No reads of `~/.claude`, no writes to
  `~/.explorer`. Use `t.TempDir()`, `EXPLORER_HOME` and `CLAUDE_CONFIG_DIR`. The one
  exception is the validation bead, which reads `~/.claude` read-only.
- **Fixtures are synthetic.** Never copy content from a real transcript into `testdata/`
  or into any committed file. Write fixture text by hand.
- **JSON conventions:** camelCase keys, RFC 3339 UTC timestamps, USD as float64, token
  counts as int64, `omitempty` on optional fields.
- **Do not commit or push.** Leave changes in the working tree.

## Beads

```
bd show <id>                    # the task, its acceptance criteria and dependencies
bd update <id> --claim          # when you start
bd comment <id> --file note.md  # long notes go through a file, not the command line
bd close <id> --reason "..."    # when acceptance criteria are met and make test passes
```

Close a bead only when its acceptance criteria hold and `make test` and `make vet` pass.
If you cannot finish, leave it open and comment with what is done and what blocks you.
