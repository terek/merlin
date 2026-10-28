# Beads and repositories: storage and extraction

Status: built 2026-10-28 (epic `merlin-t8s.48`; validation in [validation.md](validation.md),
"Bead events, registry and repositories"). This covers what is extracted and stored.
How the data is used (cost per bead, grouping in the API and UI) comes later; the storage below is
designed so that it needs no further parser bump.

## 1. Why

Two ways to tie sessions together beyond "the directory it started in":

- **Beads.** When a project uses `bd`, sessions claim, update and close beads. Knowing which
  session (and which agent inside it) worked on which bead gives cost per bead, and the bead
  hierarchy (`merlin-t8s.18.3` → `merlin-t8s.18` → `merlin-t8s`) connects sessions that look
  unrelated.
- **Repositories.** People who start every session from the same folder (or a random one) get
  nothing from the starting directory. The git repository, the worktree and the branch a session
  worked in are better groupings.

**Rule: groupings are facets.** A session's identity stays `(harness, id)` and its `project` stays
the directory it started in. Repository, worktree, `(repository, branch)` and bead family are
facets on top: a session can belong to several of each, and none of them becomes a primary key.

## 2. What the corpus shows (2026-10-28)

- 383 Claude Code transcripts and 40 Codex rollouts run a writing `bd` command (`create`,
  `update`, `close`, `dep`, `comment`, `reopen`); much of it inside sub-agents (workers claim and
  close their own bead).
- `bd` confirms a write with a line per bead: `✓ Closed <id> — <title>: <reason>`,
  `✓ Updated issue: <id> — <title>`, `✓ Created issue: <id> — <title>`,
  `✓ Added dependency: <a> (<title>) depends on <b> (<title>) (<type>)`, `✓ Comment added to <id>`,
  `✓ Note added to <id>`, `✓ Reopened <id>`. With `--json` it prints the issue as JSON. `bd q`
  prints the new id alone.
- Failures: `Error claiming <id>: …`, `Error updating <id>: …`, `cannot close epic <id>: …`,
  `Error: unknown flag: …`.
- About a third of writing calls print no `✓` line: output sent to `/dev/null`, cut with
  `| tail -1`, or `bd q`. The command's arguments are then the only evidence.
- Commands are chained (`bd update X --claim && … && bd close X`), prefixed (`cd /repo && bd …`),
  and capture output (`A=$(bd create …)`), so the created id is in the output only.
- Claude Code: a `Bash` tool_use holds the command; the matching tool_result (same id, a later
  record) holds the output. Codex: one `event_msg/item_completed` item of type `CommandExecution`
  holds `command` (argv; the script is the last element), `cwd` (a `file://` URL),
  `aggregated_output` and `exit_code`.
- A beads database has a stable identity: `.beads/metadata.json` `project_id` (a UUID), the same
  across clones and worktrees. `.beads/issues.jsonl` is a full export (`export.auto`), with id,
  title, type, status, priority, assignee, labels, timestamps, `close_reason` and `dependencies`
  (type `parent-child` names the parent).
- Worktrees come and go (`yimple-wt-*` project directories whose worktrees are deleted), so a
  path that once resolved must keep resolving.

## 3. Storage

### 3.1 In the digest (pure: a function of the session's files)

```
SessionDigest
  beads[]   BeadEvent       ordered by at, then toolUseId, then position in the command

BeadEvent
  at, turn?, agentId?, agentTurn?   as on Message: turn = main turn; for an agent, its spawn turn
  messageId                         the API message holding the call: dedupes copied history
  toolUseId                         the tool call (Codex: the CommandExecution id)
  op        create | claim | update | close | reopen | comment | dep | show
  ids[]     the beads the call names: confirmed by the output when it has a ✓ line or JSON
  status?   the status it sets (update --status, close → closed, claim → in_progress)
  parent?   --parent on create
  depType?  dep: the dependency type (blocks, parent-child, …); ids = [issue, dependsOn]
  title?    from a ✓ Created / ✓ Updated line, --title on create, or JSON output
  reason?   close reason, whole, when given inline (--reason, -r) or printed
  cwd?      the directory it ran in: a leading `cd X &&`, else the harness's cwd for the call
  outcome   ok | failed | unknown
```

- One event per `bd` invocation that names a bead, so a chained tool call gives several.
- `outcome`: `ok` when a ✓ line (or JSON) names the bead; `failed` when an error line names it,
  or the call failed and nothing confirms it; `unknown` when there is no output yet (a live or
  interrupted call) or the output does not say.
- Not recorded: `prime`, `list`, `ready`, `search`, `stats`, `memories`, `remember`, `dolt`,
  `config`, help, and anything that names no bead. `show` is recorded (op `show`, no cost meaning)
  as a weak link between a session and a bead.
- Mentions of bead ids in prompts are **not** stored separately: typed prompts and agent prompts
  are already in the digest whole, and only the registry (§3.3) can tell a real id from a lookalike
  (`claude-code`). Commit messages that cite ids (`… (yimple-srvc.1)`) are a later option.
- An event inside copied history (a fork agent's copy of its parent, a forked session) keeps the
  original `messageId`. Inside one session only events of messages the agent owns are kept; across
  sessions the catalog applies message ownership (PLAN §7) to events as it does to cost.

```
Turn
  gitBranch?   the branch at the turn's prompt (Claude: the record's gitBranch; Codex: the thread's)
```

`gitBranches[]` already lists every branch a session saw; `turn.gitBranch` is what lets spend be
split by branch. Both fields come in the same parser bump (Claude 15 → 16, Codex 5 → 6).

### 3.2 Repository resolver: `<MERLIN_HOME>/repos.json`

Maps a directory to the repository it belongs to. Not pure (it reads the disk), so it is a cache
beside the digests, harness-neutral, in `internal/repos`.

```
{ "version": 1,
  "paths": { "<abs dir>": { "top": "<worktree top>", "repo": "<main repository dir>",
                            "worktree": true?, "remote": "<origin url>"?,
                            "beads": "<.beads dir>"?, "gone": true? } } }
```

- Resolution reads files only, never runs `git`: walk up to the nearest `.git`. A directory is a
  plain repository (`repo = top`); a file `gitdir: X` is a worktree or submodule, and `X/commondir`
  leads to the main repository's git directory (`repo` = its parent). `remote` is
  `[remote "origin"] url` in the common git directory's `config`.
- `beads` is the nearest `.beads/` with a `metadata.json`, walking up from the directory, else
  the main repository's (a worktree shares its repository's database). A `.beads/redirect` file is
  followed.
- A directory that no longer exists keeps its last answer, marked `gone`. Nothing is ever
  dropped, the way digests outlive transcripts.
- Inputs: every session's `project`, `cwds[]`, the `cwd` of its bead events, and the directories
  of its `filesTouched` (resolved up to the repository, then deduplicated).

### 3.3 Bead registry: `<MERLIN_HOME>/beads/<project_id>.json`

A snapshot of each beads database a session touched, for titles, status and hierarchy. Not pure,
harness-neutral, in `internal/beads`.

```
{ "version": 1, "projectId", "database"?, "dirs": ["<.beads dir>", …], "prefixes": ["merlin"],
  "source": {"path", "size", "mtimeNs"},
  "issues": [{ "id", "title", "type", "status", "priority", "parent"?, "deps"?: [{id, type}],
               "assignee"?, "labels"?, "createdAt", "startedAt"?, "closedAt"?, "closeReason"?,
               "gone"? }] }
```

- Read from `.beads/issues.jsonl` (the export), never by running `bd`: the embedded Dolt
  database has a process lock, and a daemon calling `bd` could stall the user's own agents. The
  export can lag the database a little; the session events are the record of what sessions did,
  the registry only adds titles and hierarchy.
- Refreshed when the export's size or mtime changes. Merged, not replaced: an issue missing from
  a newer export is kept with `gone: true`.
- Descriptions, notes, design and comments are not copied.
- `project_id` missing (an old database): the key is `path-` plus a hash of the `.beads` dir.
- A bead prefix seen in events with no database found (a deleted repository) still groups by
  prefix in the catalog; there is no registry file for it.

## 4. Extraction

1. **`internal/beads` recognizer** (pure, harness-neutral):
   `Parse(script, cwd string, res *Result) []model.BeadEvent`. Splits the script into simple
   commands (`&&`, `||`, `;`, `|`, newlines, `$( … )`, backticks; here-document bodies skipped;
   `for X in a b; do …; done` over literal words unrolled), tracks `cd` (`~` expanded to the home
   the working directory is under), tokenises with shell quoting,
   finds `bd <sub>` invocations, reads their flags (`--claim`, `--status`/`-s`, `--reason`/`-r`,
   `--reason-file`, `--parent`, `--title`, `--type`, `--json`), and matches the output's ✓ and
   error lines (and JSON) to each call's ids. Global flags before the subcommand (`bd --actor x
   update …`) are skipped. Table tests with hand-written commands and outputs.
2. **Claude extraction** (`internal/claude/digest`): on a `Bash` tool_use whose command contains
   `bd `, keep it pending by tool_use id with its message; on the tool_result, parse with the
   output and `is_error`; at `Result()`, still-pending calls are parsed with no output
   (`unknown`). `Assemble` stamps `agentId`, `turn`, `agentTurn` from the owning message and drops
   events whose message the file does not own. Also `turn.gitBranch`.
3. **Codex extraction** (`internal/codex`): `CommandExecution` items, cwd from the item, failed =
   non-zero exit code. Message id: the turn's API message closest before the item. Also
   `turn.gitBranch` from `session_meta.git.branch`.
4. **Resolver and registry refresh** (`internal/links`; daemon and `merlin scan`): after a
   reconcile, collect the
   directories (§3.2 inputs) from the catalog, resolve new ones and re-check known ones at most
   every few minutes, then refresh the registry of every beads database found. Loaded at startup.
   Errors are logged and never stop the daemon.
5. **Validation** on the real history (read-only, scratch `MERLIN_HOME`): share of `bd` calls
   recognised, outcomes, events by main vs sub-agent, prefixes with no database, registry
   closes with no session event, resolver results for the worktree projects. Results go into
   docs/validation.md.

## 5. Later (not in this epic)

- Catalog: cost per bead (an agent that claims and closes one bead → its subtree; on the main
  thread, claim to close, split while several are open; the rest "no bead"), bead families keyed by
  `(projectId, root id)`, groupings by repository, worktree and `(repository, branch)`.
- API and UI for those.
- Commit messages citing bead ids; `interactions.jsonl` status history.
