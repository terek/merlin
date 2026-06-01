# Archive System

Server-side archiving of projects and sessions. Shared state across all clients (web, TUI).

## Data Model

Archive and collapse state lives in `~/.merlin/workspace.json` (migrated from legacy `~/.merlin/archived.json`):

```json
{
  "archived": {
    "projects": ["/Users/alice/work/old-proj"],
    "sessions": ["sess-abc123"]
  },
  "collapsed": ["/Users/alice/work/monorepo"]
}
```

Two scopes:
- **Project-level** (`type: "project"`, `id` = cwd): Archives the project and all its sessions. Archived projects are excluded from the clerk's context and from daemon session connections.
- **Session-level** (`type: "session"`, `id` = sessionId): Archives a single session within an active project. The project remains active but the session is hidden from default views and clerk context.

## Protocol

### Client → Daemon

```
{ type: "archive",   scope: "project" | "session", id: string }
{ type: "unarchive", scope: "project" | "session", id: string }
```

### Effect on Model

The daemon's `ModelBuilder` reads `WorkspaceStore` during every `refresh()` and sets `archived: true` on matching `Project` and `SessionSummary` entries in the `MerlinModel`. Clients receive these flags via the normal snapshot/patch sync — no separate archive-specific messages needed.

```
Project.archived?: boolean     // set by builder from ArchiveStore
SessionSummary.archived?: boolean
```

After an archive/unarchive command, the daemon:
1. Persists to `~/.merlin/workspace.json`
2. Calls `builder.refresh()` which re-tags projects/sessions
3. SyncEngine diffs and broadcasts patches to all subscribed clients

## Server Implementation

`src/discovery/workspace.ts` — `WorkspaceStore` class:
- `archive(scope, id)` / `unarchive(scope, id)` — mutate + persist
- `archivedProjectCwds()` → `Set<string>`
- `archivedSessionIds()` → `Set<string>`
- `collapse(cwd)` / `uncollapse(cwd)` / `collapsedCwds()` — project collapsing
- `invalidate()` — clear in-memory cache (for hot reload)
- Auto-migrates from legacy `~/.merlin/archived.json` on first load

Deduplicates on write (idempotent archive calls).

`src/discovery/builder.ts` — reads archived/collapsed sets during `refresh()`, tags model entries, merges nested projects.

`src/daemon.ts` — handles `archive`/`unarchive`/`collapse_project`/`uncollapse_project` messages from clients.

## Filtering Rules

| Context | Sees archived? |
|---|---|
| Clerk chat context | No — only active projects + non-archived sessions |
| Clerk full discovery (for move-to-archive tool) | Yes — can see everything to manage archive |
| Daemon CC session connections | No — only active project/session pairs |
| External CC processes on archived sessions | Ignored (not an error, just not shown) |
| Preprocessor | No — only preprocesses active projects |

## TUI Client

Three screens, archive-aware:

**Projects screen** (`src/tui/screens/projects.ts`):
- Shows non-archived projects with cursor navigation
- `a` = archive selected project (sends `archive` command)
- `A` / `TAB` = switch to Archived screen
- Footer shows archived project count as hint

**Archived screen** (`src/tui/screens/archived.ts`):
- Shows archived projects only
- `u` / `Enter` = unarchive selected project (sends `unarchive` command)
- `ESC` / `TAB` = back to Projects

**Chat screen** (`src/tui/screens/chat.ts`):
- Entered from Projects screen via `Enter`/`c`
- Clerk chat scoped to the selected project

## Web Client

Archive state comes from the synced model (server-side), not local storage. The client just reads the `archived` flags and sends `archive`/`unarchive` messages.

- **`HostView.tsx`**: partitions `model.projects` into active (`!p.archived`) and archived (`p.archived`) via a `filter` tab (`active` / `archived`).
- **`ProjectCard.tsx`**: an `archiveMode` (`'active' | 'archived'`) toggles the archive/unarchive button, which sends `{ type: "archive" | "unarchive", scope: "project", id: cwd }`.
- **`SessionsOverview.tsx`**: splits a project's sessions into live (`!s.archived`) and archived (`s.archived`), rendering the archived group dimmed.

## Key Design Decisions

1. **Server-side, not client-side**: Archive state is canonical on the daemon (`~/.merlin/workspace.json`). All clients see the same state. Earlier iOS implementation used local `UserDefaults` per-pairing — replaced with server-side.

2. **Tags on model, not separate scope**: Archive flags are properties on `Project` and `SessionSummary` within the existing metadata scope. No need for a separate `archived` subscription or message type. Changes flow through the normal patch pipeline.

3. **Hierarchical**: Archiving a project implicitly archives all its sessions. Session-level archiving is independent — you can archive individual sessions within an active project.

4. **Idempotent**: Duplicate archive calls are deduplicated. Unarchiving a non-archived item is a no-op.

5. **Re-discovery on change**: Archive/unarchive triggers a full `builder.refresh()`. This is simple and correct — the builder re-reads the archive file and re-tags everything. The sync engine then diffs against each client's shadow copy and sends minimal patches.
