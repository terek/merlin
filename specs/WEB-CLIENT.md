This is a full rewrite of the web client.

We re-imagine it in a clean, fully hierarchical way. Each page view is somewhere on this hierarchy: Root > Host > Project > Session. The page which is open represents the user's current focus.

There is a chat that is always visible (RHS, resizable-panel) and we will add later that it operates in the current focus and can also change the focus via tools, but that's later.

Let's implement the navigation: the top bar should be a powerful breadcrumbs, by powerful I mean that the visual distinction between segments should be strong, so that it's very clear what one is viewing. I love the current right sidebar but I'm not sure I can make sense of it.

The archiving will become part of the Project page view. The user can switch between archived and active views and see the relevant projects and operate on them. Other modes in the Project view: either looking at session list or the timeline view.

In the Session level page, one would see either the raw chat, or the summarized one. This will be extremely useful especially initially for me to inspec the quality of the summarization and see if there is more to do.

## Page header

Each page (Host, Project, Session) renders a shared `<PageHeader>` below the breadcrumb. The header is a single horizontal strip with four zones:

- **Left:** `tabs` — shared `<TabGroup>` widget (pill group). Tab items are config-driven (`{ key, label, icon?, loading?, count? }`) so the visual is identical across pages while the tab sets differ: Active|Archived, Sessions|Timeline, Raw|Lean|Tasks.
- **Left (next to tabs):** `search` — shared `<SearchInput>` widget. Page-specific placeholder, Esc clears.
- **Middle:** `children` — escape hatch for anything a page needs inline; currently unused.
- **Right (pushed by `ml-auto`):** `stats` then `actions`. All counters/status indicators (session counts, pp progress, turns/size/subagents, parent-session link, pp status label) live in `stats`. Icon-buttons (Process, Delete, Process All) live in `actions`.

Consolidating stats on the right — rather than scattering them left/middle — keeps the left edge reserved for navigation/filtering (tabs + search) and the right edge for summary + action.

### State

Tab selection stays in the zustand store per page (`hostFilter`, `projectTab`, `sessionTab`) and is URL-synced via `use-url-sync` — same as before the refactor. Search query also lives in the store per page (`hostSearch`, `projectSearch`, `sessionSearch`) but is **not** URL-synced; it's ephemeral filter state.

### Filter semantics (per page)

Search widgets are dumb; each page owns its own filter predicate:

- **Host:** matches project `displayName` or `cwd`.
- **Project / Sessions tab:** matches session `sessionId`, `customTitle`, or `nestedPath`. Timeline tab currently ignores the search.
- **Session / Raw:** matches turn `text`.
- **Session / Lean:** matches `userText` / `userSummary` / `agentText` / `agentSummary` on the turn and its subagents.
- **Session / Tasks:** matches task `id`, `description`, or any label value.

### Files

- `components/layout/PageHeader.tsx` — layout shell.
- `components/layout/TabGroup.tsx` — shared pill-group widget.
- `components/layout/SearchInput.tsx` — shared controlled input with clear button.

Pages (`HostView.tsx`, `SessionsOverview.tsx`, `SessionView.tsx`) compose these by passing zone props — they no longer hand-roll their header chrome.
