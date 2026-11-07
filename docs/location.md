# Where sessions worked: location keys

Status: built 2026-11-07 (epic `merlin-t8s.53`) and validated on this machine the same day
([validation.md](validation.md), "Location keys"); `merlin-t8s.53.8` still has to run it on the machine with
the bare layout. Replaces the repository half of
[beads-and-repos.md](beads-and-repos.md) (§3.2 and the repository rules of §5). Beads stay there.

## 1. Why

"One project = one repository = one client" is the trivial case. A session can start in one place,
edit files in a worktree, and belong to a repository that several clones and worktrees share. The
old `repo` value tried to answer all of that with one directory, and on a bare repository with
worktrees it split one repository in two.

So Merlin extracts several keys and the user picks the grouping. The keys overlap most of the time.
That is fine: they come apart exactly where the layout is ambiguous.

**Rule: groupings are facets.** A session's identity stays `(harness, id)` and its `project` stays
the directory it started in.

## 2. The keys

| key | meaning | read from |
|---|---|---|
| `dir` | the directory a session started in (`project` in the existing API) | the digest |
| `checkout` | top of the working tree; none in a bare repository | the nearest valid `.git` |
| `repo` | the object store: the canonical git common dir | `.git` and `commondir` |
| `remote` | the normalised origin URL | `[remote "origin"]` in the common dir's `config` |
| `branch` | per turn | the digest (`turn.gitBranch`) |

Expected values per layout, checked against what real git (2.54) writes:

| layout | checkout | repo | remote |
|---|---|---|---|
| plain clone, session in a subdirectory | clone top | `clone/.git` | origin |
| `git worktree add ../wt` (absolute or relative paths) | `wt` | `clone/.git` | same |
| tool-made worktree (`.claude/worktrees/x`, Codex worktrees) | that directory | main's `.git` | same |
| bare + worktrees: `<root>/<name>` | `<root>/<name>` | `<root>/.bare` | same |
| bare + worktrees: `<root>`, or a plain directory under it | none | `<root>/.bare` | same |
| inside the bare store (`<root>/.bare/hooks`) | none | `<root>/.bare` | same |
| pure bare `x.git`, no `.git` entry | none | `x.git` | its own |
| two clones of one remote | each clone | each clone's `.git` | same |
| submodule | submodule top | `.git/modules/<path>` | its own |
| submodule inside a linked worktree | submodule top | `.git/worktrees/<wt>/modules/<path>` | same as its siblings |
| `git init --separate-git-dir` | the working directory | the store | origin |
| vendored clone inside another checkout | the vendored top | its own `.git` | its own, maybe a local path |
| worktree whose main repository was deleted | the worktree | `<X>` from `gitdir: <X>/worktrees/<n>` | none |
| empty or invalid `.git` directory | as if it were not there | as if it were not there | same |
| no git | none | none | none |

## 3. The resolver

`internal/repos`. It reads files only and never runs git or bd. Harness-neutral: it knows nothing of
`.claude` or `.codex`, because tool-made worktrees are ordinary linked worktrees.

Walking up from the directory, at each `d`:

1. **`d/.git` is a directory** (following a symlink). Without a `HEAD` file it is not a repository,
   as for git: keep walking. Otherwise the common dir is `d/.git`, and the checkout is `d` unless
   its config says `core.bare = true`.
2. **`d/.git` is a file `gitdir: X`** (`X` relative to `d`). A file without that line is ignored:
   keep walking.
   - `X` has a `commondir`: a linked worktree. The common dir is that file's value (relative to
     `X`), the checkout is `d`, `worktree` is true. **`core.bare` is not consulted:** the shared
     config of a bare repository says `bare = true` for all of its live worktrees.
   - `X` exists with no `commondir`: the common dir is `X`. The checkout is `d` unless its config
     says `core.bare = true` (the root of a bare + worktrees layout). A submodule or a separate git
     dir takes this path.
   - `X` does not exist: the checkout is `d`. If `X` is `<Y>/worktrees/<n>` the common dir is `Y`
     and `worktree` is true; otherwise there is no common dir.
3. **No `.git` entry, and `d` has `HEAD`, `objects` and `refs`, and is not named `.git`:** `d` is a
   bare repository, or we are inside a store. The common dir is `d`, with no checkout. Inside a
   `.git` directory the walk just continues, and its parent answers (a `.git/worktrees/x` admin
   directory has no `objects`, so it continues too).

Common dir and checkout are canonicalised with `filepath.EvalSymlinks`, falling back to
`filepath.Clean` when the path is gone, so two routes to one repository are one repository.

`remote` is the first `url` of `[remote "origin"]` in the common dir's `config`. Section and key
names compare case-insensitively. Only `origin` counts; a repository with other remotes has none.
`url.insteadOf` and config includes are not followed.

**Normalising a remote.** Scheme, user, password and a trailing `/` and `.git` are stripped, the host
is lower-cased, the path keeps its case, and a default port (ssh 22, https 443, http 80) is dropped.
Credentials never reach `repos.json` or the API.

| origin | `remote` |
|---|---|
| `git@github.com:acme/app.git` | `github.com/acme/app` |
| `ssh://git@github.com/acme/app.git` | `github.com/acme/app` |
| `https://github.com/acme/app` | `github.com/acme/app` |
| `https://user:token@GitHub.com/acme/app.git/` | `github.com/acme/app` |
| `ssh://git@host.example:2222/acme/app.git` | `host.example:2222/acme/app` |
| `/srv/git/app.git`, `file:///srv/git/app.git` | `/srv/git/app` |
| `../app.git` | resolved against the directory holding the common dir, as above |

**Display name of a `repo`.** `repos.Name(common)`: its base name; when that is `.git` or `.bare`,
its parent's; a `.git` suffix stripped. It is a pure function of the common dir, so it is computed,
never stored. A separate git dir shows the store's name.

**Beads.** The cwd to `.beads` lookup does not change. It keeps using the same main directory as
before (the common dir's parent when that is named `.git`, else the common dir, before
canonicalising), only for a worktree found through `commondir`. A test pins the answer for every
fixture. Inferred entries (§4) carry no `beads`, so the beads guard in the catalog sees what it saw
before.

## 4. Gone directories

Worktrees come and go. A directory that once resolved keeps its last answer, marked `gone`, as
before. On the history here most gone directories were never seen alive, because the daemon was not
running when they existed, or only an agent's edit named them (§6). So a directory with no answer
that no longer exists is inferred, in this order:

1. **Sibling worktrees.** `P` is its nearest existing ancestor and it lies at `P/<n>/…`. If at least
   one checkout is recorded directly under `P`, and all of them are linked worktrees of one common
   dir, then its checkout is `P/<n>` and its repo and remote are theirs. A plain repository recorded
   directly under `P` turns this off, which is what keeps it out of a folder like `~/work`.
2. **Ancestor.** The deeper of the longest recorded checkout that is a path prefix of it, and what
   `P` resolves to on disk. It inherits checkout, repo and remote. When the answer comes from the
   disk, the live checkout gets its own entry too, so the catalog can see that it is alive.
3. **Otherwise** nothing is recorded, as before, and it is tried again at the next recheck.

Inferred entries are marked `inferred` and worked out again at each recheck, because the cache grows.
A removed tool worktree with no recorded sibling infers its main checkout: its repo and remote are
right, its checkout is not, and nothing on disk can tell.

## 5. `<MERLIN_HOME>/repos.json`

```
{ "version": 2,
  "paths": { "<abs dir>": { "checkout"?, "gitCommonDir"?, "worktree"?, "remote"?,
                            "beads"?, "gone"?, "inferred"? } } }
```

`worktree` stays explicit: a submodule's checkout is not its common dir's parent either, so it cannot
be derived.

**Migrating version 1.** Done on `Open`, saved at the next `Save`. Live directories are resolved
again on the first refresh of a process anyway, so only gone entries depend on the mapping:

- `top` becomes `checkout`, `worktree`, `beads` and `gone` carry over, and `remote` is normalised.
- `repo` becomes `gitCommonDir`: `repo` itself when it is named `.bare` or ends in `.git` or has a
  `HEAD`, else `repo/.git`.

The root of a bare layout that is gone entirely cannot be told apart this way and keeps a value of
its own under `repo`; it still groups correctly under `remote`.

## 6. Activity: `workDirs` in the digest

A session's `cwd` barely moves (§9): work in a worktree shows up as `cd /abs && …` and as edit
paths. The digest kept neither the commands nor what agents
edited, and agents make most edits. A new field on `Turn` and `AgentTurn` holds this, so a session's
activity can leave out what a forked session or a fork agent copied.

```
workDirs[]  WorkDir, sorted by dir
WorkDir { dir, edits, commands }
```

- `edits`: tool calls that edit a file in `dir` (the parent directory of the path). Claude: Edit,
  Write, NotebookEdit. Codex: each path of a FileChange.
- `commands`: shell calls that run in `dir`. A call counts once, in the directory its first command
  runs in: the leading `cd` when there is one, else the call's working directory. Claude: Bash.
  Codex: CommandExecution, with the item's cwd. `beads.RunDir(script, cwd)` exports this from the
  existing shell splitter.
- Only absolute paths count. Only calls of messages the file owns count, as for bead events.
- Pure: a function of the session's files. Reads do not count, so looking at another repository does
  not pull a session towards it.
- It needs a parser bump (Claude 18, Codex 7). `links.Dirs` reads it too, so the directories it names
  are resolved while they still exist.

Digests whose transcripts are gone keep their older version. For a session with no `workDirs` at all,
the non-inherited turns' `filesTouched` count as edits, and `cwds` and the `cwd` of the bead events
it owns as commands. A session that is nothing but a copy counts none of them.

## 7. A session's primary values

A session counts under one value per key, so totals add up under any grouping. Every other value it
touched is listed in its detail. The keys of a session never contradict each other.

Its activity, summed over turns and agent turns but not the inherited ones (`info.InheritedTurns`,
and agents spawned in such a turn), decides:

1. **`repo`:** the common dir with the most `edits`. If it edited nothing in any repository, the one
   with the most `commands`. If it did neither, that of its start directory, else none.
2. **`checkout`:** the same inside that repo: most edits, else most commands. With none, the start
   directory's checkout if it is in that repo, else none.
3. **`remote`:** the repo's.
4. **`dir`:** always the start directory. Activity would give a deep subfolder.
5. **`branch`:** not a primary value. The spend keeps splitting over the turns' branches, which also
   adds up.

Activity in no repository (a scratch directory) never wins over a repository. Ties go to the start
directory's value, then to the first in sort order.

Edits come first because a lead session runs `git` and `bd` in the main checkout while the work
happens in a worktree. Counting all calls alike hides nearly all of that (§9).

## 8. Catalog, API and UI

**Catalog** (`internal/catalog/places.go`, the rollup).

- `sessFacets` gets `checkout`, `remote`, and lists `checkouts`, `repos`, `remotes`. `worktrees` goes.
- New dimensions `ByCheckout` and `ByRemote`. `Filter` gets `Checkout`, `Remote` and `Touched`.
- A repository or a checkout is gone when no entry with that value is live; an inferred entry never
  counts as live. A repository's remote is the first in directory order among its live entries, else
  among all of them, so it does not depend on map order.
- `SplitBranchKey` splits at the first `#`: a branch name may contain one, a directory rarely does.

**API.**

- `repo` values become common dirs.
- `GET /api/groups?by=dir|checkout|repo|remote`: `groups[]` with `key`, `name`, `remote`, `gone`,
  `sessions`, `lastActivityAt`, `cost`, most recently active first, the group with `key: ""` last.
  It counts as `/api/repos` does (sessions without scripted runs, cost with them).
- `GET /api/cost?by=checkout|remote|dir` (`dir` is `project` under another name).
- `GET /api/repos` stays for what an opened repository shows: `worktrees[]` becomes `checkouts[]`
  (with `worktree` set on linked ones), and `branches[]` stays. `GET /api/projects` stays as it is.
- Filters `checkout=` and `remote=` select primary values, like `repo=`, and `-` selects none. `touched=1`
  widens them to every session that touched the value. `checkout=` replaces `worktree=`.
- A summary carries `checkout` and `remote` beside `repo`. The detail's `places` carries `checkout`,
  `remote`, `checkouts[]`, `repos[]` and `remotes[]`.

**UI** (`docs/ui.md`, "The rail's groupings").

- The rail's switch becomes a picker: Directory, Checkout, Repository, Remote, Beads
  (`group=dir|checkout|repo|remote|bead`).
- Branches stay inside an opened repository, because a branch name means little across repositories.
- Spend's "By repository" gets the same choice of cut.
- Two repositories with one display name show enough of their path to tell them apart.
- The Session page lists the other values a session touched. Its links use `touched=1`, so the
  session is in the list they open.

## 9. What the history shows (2026-11-07)

Measured with the built code, read-only, on one machine: 3,425 digests (3,133 scripted runs), 472
distinct directories of the kind the 11-06 simulation counted. Details and method:
[validation.md](validation.md), "Location keys".

- Layouts seen: plain clones, `git worktree add` and tool-made worktrees, one vendored clone with a
  local-path origin. Not seen: bare + worktrees, submodules, two clones of one remote, Codex
  worktrees. Those rows were checked against real git in a scratch directory only, and are what
  `merlin-t8s.53.8` is for.
- 76 sessions start outside any known repository, 9 of them empty (the simulation said 82 and 9; five
  regained a repository through §4). None start in a repository with no checkout.
- 224 directories are gone and 162 of those were never recorded. §4 recovers 91 (28 under a known
  checkout, 63 sibling worktrees; the simulation split them 32 and 59). 73 stay unknown, all but two of
  them temporary directories. With the directories `workDirs` adds the set is 989, 598 gone, 357
  recovered and 181 unknown.
- `cwd` shows 2 of 248 sessions active in more than one checkout (11-06). Agents make about 60% of the
  edits (11-06). 241 of 261 non-scripted sessions now have `workDirs`; the rest use the §6 fallback.
- The §7 rule on 268 non-scripted Claude sessions: 19 ($240 of $6,612) move to the checkout they
  worked in, and 1 ($3) changes repository. Counting all calls alike moves only 5 (11-06).
- Every grouping adds up to the same total, and no repository or checkout is shown gone while it exists
  or live while it is missing. 14 repositories, 12 remotes (one a local path), no display name `.git` or
  `.bare`, none colliding.

## 10. Not done

- `url.insteadOf` and config includes when reading origin.
- A remote other than `origin` as a fallback.
- Case-insensitive comparison of paths on macOS. No such case occurs here.
