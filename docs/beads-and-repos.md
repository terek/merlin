# Beads and repositories: storage and extraction

Status: built 2026-10-28 (epic `merlin-t8s.48`; validation in [validation.md](validation.md),
"Bead events, registry and repositories"). §1–4 cover what is extracted and stored; §5 how the
catalog, API and UI use it (`merlin-t8s.49`).

**Repositories were redesigned** in [location.md](location.md) (epic `merlin-t8s.53`, built and
validated 2026-11-07): several keys (`dir`, `checkout`, `repo`, `remote`) replace the one `repo`
value. location.md is now the reference for the repository half: §3.2 and the repository rules of §5
below describe the code as it was, apart from the `repos.json` fields and the beads lookup, which
location.md §3 and §5 keep.

**Beads without an export** (§6, designed 2026-11-07, epic `merlin-n1u`): what sessions did is
the primary source and the export one more. §6 supersedes the registry-only rules of §3.3 (the
last bullet) and §5 (which ids count, families); the rest of §3–5 stands.

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

**Replaced by [location.md](location.md) §3–5, built.** The format below is version 1 and the
resolver rules are the old ones; only the `beads` lookup is unchanged and still described here. What
exists only in location.md: `checkout`, `gitCommonDir`, normalised `remote`, `inferred`, the
version 2 file and the migration, and gone-directory inference.

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

## 5. Use: groupings and cost per bead (built 2026-10-28, `merlin-t8s.49`)

The repository rules below (one repository per session, worktrees, `repo` as the main directory) are
superseded by [location.md](location.md) §7–8; the bead and branch rules stand.

The daemon hands the catalog the repository lookups and bead snapshots (`catalog.Places`) at start
and whenever a refresh changes them; only the groupings are recomputed, never the sessions or their
costs. Code: `internal/catalog/places.go`. The rules (repository per session, branch and bead
shares, families) are in [api.md](api.md#groupings-get-apirepos-and-get-apibeads). Choices worth
knowing:

- A session counts under **one** repository, so repository totals add up; every repository it
  touched is listed in its detail only.
- A bead or branch gets a **share of the session's best cost**, in proportion to the attributed cost
  of the messages spent on it. The reported overhead is spread the same way, so every grouping adds
  up to the same total as projects and days.
- A bead call counts only for the session that owns its message (copied history does not), never
  for `show`, and never for an id the databases do not know or one of another database than the
  repository the call ran in. The last rule drops `✓ Closed x-1` lines that a script printed from
  another history (one session here quoted 18 such ids).
- `bead=<id>` matches the bead and everything below it, so a family root selects the family.

On the real history (3,405 sessions): 11 repositories (37 sessions in none), 4 bead databases,
320 families; every grouping adds up to the same $6,538; 56% of spend falls on some bead.

Not done: commit messages citing bead ids; `interactions.jsonl` status history; a CLI view.

## 6. Beads without an export (designed 2026-11-07)

### 6.1 Why, and the stance

On a second machine every bead event was dropped although parsing worked: the database the
worktrees resolve to has no `issues.jsonl` (no `export.auto`; its only readable file is
`interactions.jsonl`), so its registry file holds no issues, and §5 keeps an id only when the
registry knows it. No cost per bead, no families, no prefixes.

**Stance: best effort, recall over precision.** Nothing breaks when a bead is not seen, and every
bead caught from a command is worth showing. The `bd` calls the agents made are the primary source;
an export, when there is one, is one more source that fills and corrects. Every field may be
missing, and every consumer shows what it has (a bead with no title shows its id). Merlin still
never runs `bd` (§3.3).

### 6.2 What this machine's history shows (2026-11-07)

Measured read-only on 3,428 sessions rescanned with the parser of the day (Claude 18, Codex 8) into
a scratch home; scripts and numbers only, nothing copied.

- **Creates:** 523 of 738 (71%) yield the new id from their output (Codex 28/28, Claude 495/710).
  The rest are cut: 191 piped into `tail`/`head`/`grep`, 37 sent to `/dev/null`, 6 captured.
- **Ids still surface:** later claims and closes name 99% of the beads in the exports (merlin
  105/106, chatfw 93/95, yimple 550/555, geocards 27/27). **Titles are the weak field:** events give
  a title for 77/106 merlin beads (chatfw 93/95, yimple 478/555, 441 of them exact).
- **Binding id-less creates (2026-11-07):** of 796 creates (forked or resumed sessions counted
  twice), 271 have no id; the §6.4 rule binds 179 (66%), and 78 of the 178 checkable against an
  export have exactly the create's title (44%; 1 not in any export). With `--parent` 27/47 (57%),
  without 51/131 (39%). By thread events between the create and the naming one: next event 34/37
  (92%), within 5 events 32/64, within 20 71 bound with 9 right, beyond 20 3/7.
- **Hierarchy:** dotted children are 95/95 parents in merlin, 66/71 in chatfw, 253/260 in yimple.
  Of the 12 non-dotted parents, 5 come from `create --deps parent-child:<id>`; 6 were set where no
  call shows it (likely `bd update $id --parent=$P`, a variable), 1 bead's create was never seen.
  `bd update --parent` with a literal value occurs twice, both `--parent ""` (detach: the 2 dotted
  beads with no parent); `dep add --type parent-child` occurs 0 times; `create --deps` 64 times.
  Events alone get 412 of 424 parents right (parser 18, before `--deps` was read).
- **Status:** the last status-setting event matches the export for 668 of 670 beads it covers.
- **JSON snapshots are rare:** 64 of 3,231 `bd` calls use `--json`, mostly piped into python, grep
  or jq; 13 outputs hold parseable issues (11 from `create --json`).
- **Close lines:** with no reason given, bd prints its default: `✓ Closed <id> — <title>: Closed`
  (105 of 105), so the title can be split off.
- **Output-only ✓ lines** (a script that runs no `bd` prints them): 8 calls.
- **The §5 filter** drops 2 confirmed ids here (prefix `zz`, no database): every local database has
  an export. The fallback matters on machines with old databases.
- **Cwd → database:** 2,074 of 2,393 events with ids resolve to a database, all with the ids'
  prefix; 311 do not, mostly `~/work/merlin` since it became a bare container (its `.beads` is in
  `main/`), which a kept `repos.json` answer covers and a fresh one does not.

### 6.3 Digest additions (shared contract, additive)

```
BeadEvent
  type?        create -t/--type
  priority?    create -p/--priority: 0–4 (P0–P4 accepted)
  deps[]?      create --deps: [{id, type}] as written, "type:id,…" (a bare id, depends-on:id and
               blocked-by:id are type blocks: the new bead depends on id; blocks:id reverses the
               direction and is recorded as type blocked-by). The fold reads parent-child only.
  parent?      now also update --parent (op update)
  outputOnly?  true: no bd call in the script names this bead; only a ✓ line of the output does
  seen[]?      beads as the call's JSON output printed them: [{id, title?, type?, status?,
               priority?, parent?}] (show, list, ready, create, update with --json, unpiped)
```

- `title` also from `✓ Closed <id> — <title>: Closed` when the call gave no reason (strip the
  default reason); with a reason the existing rule stands; with an unknown reason (a file, a
  variable) no title is taken from the close line.
- Parser versions: Claude 18 → 19, Codex 9 → 10 (main had taken 9 for `patch_apply_end`), Pi 1 → 2
  (all three call `beads.Parse`).

### 6.4 The fold: what Merlin knows of each bead

Pure and harness-neutral, in `internal/beads` (`Fold`), called by the catalog when it builds its
groupings. Not stored: the digests are the record, the fold is recomputed from them and the
snapshots. Not part of any digest.

**Inputs.** The registry snapshots (export issues, and from now on the status history read from
`interactions.jsonl`, §6.5), and every bead event of every session with the database resolved at
its cwd (repos.json → `.beads` → registry key; `""` when none). Copied history is dropped first (the
catalog's message ownership); failed calls carry no fields. Events are taken in time order, then
session key, then tool use id.

**Which database a bead belongs to** (one function, used everywhere):

1. The database whose export has the id (the first by key, as today).
2. Else the database its prefix is known in: an export's prefixes, else prefixes learned from
   events whose cwd resolved to a database (the one with the most such events; ties by key). This
   fills `prefixes` of a database with no export.
3. Else a database of its own, key `prefix:<prefix>`, holding every such bead of that prefix.

**Fields** of each bead, best source first:

| Field | Sources, in order |
|---|---|
| title | export; else the latest of: create title (positional or `--title`) once the id is known, `--title` on update, ✓ Created/Updated/Closed line, `seen` |
| type, priority | export; else latest `seen`; else the create's `-t`, `-p` |
| parent | export; else latest `update --parent`; else create `--parent`; else a `parent-child` dep (`dep add` or `--deps`); else the dotted id (`x-abc.1.2` → `x-abc.1`). A detach (`--parent ""`) is not recorded: the dotted id still places it (2 beads here) |
| status | export (not gone); else the latest by time of: status-setting events (ok or unknown, not failed: claim → in_progress, `--status`, close → closed, reopen → open), `interactions.jsonl`, `seen`; a bead created and never changed is open |
| createdAt, closedAt, closeReason | export; else the create event, the last close and its reason |
| firstSeen, lastSeen | events (any op, show included) |
| source | `export` when the export has it, else `sessions`; `implied` for a stub (below) |

- **Stubs.** A parent or dotted ancestor that no source describes becomes a bead with its id only
  (`source: implied`), so a family always has its root.
- **Gone** export issues keep their last exported fields, but events after the export's mtime set
  status.
- **Binding id-less creates: dropped.** The idea was to bind a create whose id the output did not
  give to the first id its thread names afterwards that no event named before the create, and that
  is a child of its `--parent`. Measured on this machine (§6.2) it is right for 44% of the
  bindings, far under the 95% bar, and even the next-event case (92% of 37) falls short. An
  id-less create therefore adds nothing: the bead is still found by the later claims and closes
  that name it, with the title those give or none.

### 6.5 Registry: `interactions.jsonl`

`Refresh` also reads `.beads/interactions.jsonl` when its size or mtime changed (a second
`Source`): `field_change` records with `extra.field == "status"` give per issue the latest status,
its time, and for `closed` the reason. Stored apart from the export's issues, so the fold can tell
them from export truth: `statuses: [{id, status, at, reason?}]`, the latest change per issue,
sorted by id; merged on each read (an id missing from a newer read is kept; a later `at` wins).
Other record kinds and unparseable lines are counted (`badLines`), never fatal. `Issue` itself is
unchanged here; `source`, `firstSeen` and `lastSeen` come with the fold (§6.4).

### 6.6 Which calls count for a session (replaces the id rule of §5)

A bd call (not failed, not copied, not `show`) counts for every id it names, whether the
registry knows it or not (for `dep`, the issue only: its target is named, not worked on), with one
guard:

- **Output-only ids** (`outputOnly`) count only when their database (§6.4) is the database at the
  call's cwd. That keeps out a script printing ✓ lines from other histories (§5's 18 quoted ids)
  while a wrapper that runs bd in its own repository still counts. At a cwd with no database
  they count (recall first: there is nothing to tell them from).

`show` still counts for nothing but appears in a bead's timeline. Spans, shares and every grouping
of §5 then run on the folded beads unchanged.

### 6.7 Families

The root is the top of the parent chain (§6.4 parents, stubs included). A family's name is its
root's title; with none, the root id, and `hint`, the title of the family's earliest member (by
firstSeen) that has one.

### 6.8 Uses

- **Grouping keys** in `GET /api/groups?by=`, beside `dir|checkout|repo|remote`: `beadDatabase`,
  `prefix`, `family`, `bead`. A session counts under one value per key, the one with the largest
  share of its cost (ties: the first in sort order); sessions on no bead under `""`. Shares across
  beads stay in `/api/cost?by=bead|family`.
- **A bead's page:** `GET /api/beads/{id}` returns the folded bead (its `BeadRef` with `source`,
  type, priority, createdAt, closedAt, closeReason, firstSeen, lastSeen), its parent chain, its
  children, the sessions that worked on it (harness, id, title, project, `usd` share, `ops`) and its
  **timeline**: every event on it in time order across sessions and agents (at, harness, session,
  agentId, turn, agentTurn, op, status, outcome, title, reason), `show` included. 404 for an id no
  source names.
- **Cost per bead, families, prefixes:** as §5, over the folded beads; `issues` and `closed` count
  what the fold knows. `BeadRef` gains `source`; `FamilyGroup` gains `hint`; a `database` may be
  `prefix:<name>`.
- **A session's detail** (`places.beads`) is unchanged in shape and now fills without an export.
- **Web:** a bead page (`/bead/<id>`): header (id, title or hint, status, type, parent chain), the
  timeline grouped by session (created here by the main agent, claimed by that worker, closed
  there), the sessions with their cost; linked from bead and family rows and the session page's bead
  chips.

### 6.9 Tests

Hand-written commands and outputs for every parser addition (`internal/beads`); a synthetic
database with `metadata.json` and `interactions.jsonl` but no `issues.jsonl`, reproducing the
empty-registry case end to end (registry → fold → catalog groupings and cost per bead); fold tables
for precedence, stubs, prefix databases and the output-only guard.
