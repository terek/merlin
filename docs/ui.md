# Explorer web UI

The design the UI beads build from. The UI is a single-page React app served by `merlin serve`
on the daemon's own port. It is read-only: everything it shows comes from the JSON API in
[api.md](api.md). It answers the same two questions as the rest of Explorer, in this order of
polish: **which session was that, and which do I resume** (Sessions, Session) and **what did it
cost, subagents included** (Session, Cost).

## 1. Stack

| Concern | Choice |
|---|---|
| Build | Vite 8 + `@vitejs/plugin-react` (fast refresh in dev) + TypeScript (strict), package manager and runner **bun** (never npm, npx or node) |
| UI | React 19, function components, no class components |
| Routing | `react-router-dom` 7, browser history (the Go handler falls back to `index.html`) |
| Server state | `@tanstack/react-query` 5; the SSE stream patches or invalidates its cache |
| Client state | URL search parameters for filters; `useState` for the rest. No global store |
| Styling | Tailwind 4 (`@tailwindcss/vite`) over CSS-variable tokens defined in `src/styles.css` |
| Icons | `lucide-react` |
| Markdown | `react-markdown` + `remark-gfm`, for assistant texts and agents' prompts (an agent writes them). No raw HTML, no syntax highlighter |
| Charts | hand-written SVG. No chart library |
| Tests | `bun test` for pure logic in `src/lib` and `src/api`; `tsc --noEmit`; Biome (root `biome.json`) |

Do not add other dependencies. If one seems needed, say so in the bead and stop short of adding it.

Nothing is loaded from the network: no web fonts, no CDN, no analytics. The page is served with
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'`. Texts from sessions are untrusted input: render them as text or through
`react-markdown`, never with `dangerouslySetInnerHTML`.

## 2. Layout of `web`

```
web/
  package.json  bun.lock  tsconfig.json  vite.config.ts  index.html
  src/
    main.tsx            providers (QueryClient, Router, Events), mounts App
    App.tsx             routes
    styles.css          Tailwind import, tokens, base styles
    api/
      types.ts          TypeScript mirror of internal/server/types.go, catalog and model JSON
      client.ts         get<T>(path, params): fetch + ApiError
      queries.ts        query keys and hooks: useProjects, useSessions, useSession, useSearch, useCost
      events.tsx        EventsProvider: one EventSource, cache updates, useScanProgress, useConnection
    lib/                pure functions with tests: format.ts, paths.ts, time.ts, cost.ts, tree.ts
    ui/                 shared primitives (section 5)
    shell/              Layout, TopBar, ScanIndicator
    features/
      sessions/         SessionsPage and its parts            (Sessions bead)
      spend/            SessionPage: the spend tree, header, decisions, turn card
      agents/           AgentDetail, AgentRow (KindIcon), agent helpers
      context/          chart.ts (niceTicks)
      cost/             CostPage and its parts                (Cost bead)
      moments/          MomentsPage, MomentCard (a fixed-look SVG), MomentsInvite (on Sessions), model.ts, avatars/
```

A feature directory is owned by one bead. `api/`, `lib/` and `ui/` are shared: additive changes
only once the scaffold is in, and say so in the closing note.

The build output goes to `internal/webui/dist` (git-ignored) and is embedded with
`go:embed` behind the build tag `embedui`. Without the tag the binary serves a one-line page
saying the UI was not built, so `go build ./...` and `go test ./...` never need bun.

```
make web         # cd web && bun install --frozen-lockfile && bun run build
make build       # make web, then go build -tags embedui -o bin/merlin ./cmd/explorer
make build-go    # go build -o bin/merlin ./cmd/explorer   (no UI, no bun)
make web-check   # cd web && bun run check   (tsc --noEmit, biome check, bun test)
```

Development: `bun run dev` in `web/` starts Vite on port 5173 and proxies `/api` to the daemon
(`EXPLORER_API`, default `http://127.0.0.1:7433`, with `changeOrigin` so the Host guard passes).
Run the daemon against the fixtures, never against the real history (`~/.claude`, `~/.codex`, `~/.pi`); the scratch `HOME` keeps out every harness that defaults to it:

```
HOME=<a scratch dir> CLAUDE_CONFIG_DIR=$PWD/testdata/claude MERLIN_HOME=<a scratch dir> \
  ./bin/merlin serve --no-hooks --port <your port>
```

## 3. Routes

| Route | Page | State kept in the URL |
|---|---|---|
| `/` | Overview (section 10b): one table of sessions over a day, week or month, each row with a text line and a small graph of its context and the agents it launched, scoped by a tree of their places, with a summary of the scope | `range`, `from`, `to`, `by` (`dir`, `checkout`, `repo`, `remote`, `bead`), `in` (the selected place), `q`, `sort`, `dir`; `open=<harness>:<id>` with `sfrom`, `sto` (a session in place) |
| `/overview` | Redirects to `/`, the query string kept | |
| `/sessions` | Sessions (section 8) | `project`, `state`, `kind`, `q` (search), `since` |
| `/s/:harness/:id` | Redirects into the Overview with the session open (section 10b, "A session in place") | `#t<index>`, `#a<agentId>`, `#c<index>` are carried over; `from`, `to` become `sfrom`, `sto` |
| `/cost` | Cost | `range` (`7d`, `30d`, `90d`, `all`), `project`, `by` |
| `/bead/:id` | Bead (section 10a) | none |
| `/moments` | Moments (experimental, [moments.md](moments.md)): the card, the personas' reactions, what to try, the moments by status | none (the card's handle is kept in `localStorage`) |
| anything else | Not found | |

An id prefix in `/s/claude/1616` is fine: the API resolves it. On `409 ambiguous_id` the page lists
the candidates as links. Filters live in the URL so that back, forward and reload keep them, and a
view can be bookmarked.

## 4. Visual language

A dense, calm developer tool. Content first; chrome is thin. One accent colour. Numbers line up.

- **Type.** System UI stack for text; `ui-monospace, SFMono-Regular, Menlo, monospace` for ids,
  paths, money, token counts and code. Base size 13px, line height 1.5. Sizes: 11 (labels, meta),
  12 (secondary), 13 (body), 15 (section titles), 20 (page titles, the big cost figure).
  `font-variant-numeric: tabular-nums` on every number.
- **Colour.** Tokens are CSS variables on `:root`, with a dark set under
  `@media (prefers-color-scheme: dark)`; both themes are first class. Tailwind utilities map to the
  tokens (`bg-surface`, `text-muted`, `border-line`, ...), so components never name a raw colour.
  The system setting can be overridden: `?theme=light` or `?theme=dark` on any URL sets
  `data-theme` on `<html>` and is remembered in `localStorage`; a control in the top bar cycles
  system / light / dark.

| Token | Use |
|---|---|
| `--bg`, `--surface`, `--surface-2` | page, cards and rows, hovered or nested surface |
| `--line` | hairline borders and dividers (1px) |
| `--text`, `--muted`, `--faint` | body text, secondary text, tertiary text and disabled |
| `--accent` | links, focus ring, the selected item, the primary bar in charts |
| `--ok`, `--warn`, `--bad` | busy / completed, estimated / mid-turn / open, interrupted / killed / errors |
| `--reported`, `--attributed`, `--overhead` | the three cost sources, the same colour wherever they appear |
| `--human`, `--machine` | the gutter of a human turn and of a turn nobody typed |

- **Shape.** Radius 6px on cards and inputs, 4px on badges. No shadows except the popover. Rows are
  32–36px high in lists; padding in multiples of 4px.
- **Motion.** None, apart from a 150 ms fade on a row that just changed through a live update.
- **Width.** The app uses the full window; text columns (prompts, answers) are capped at 100ch.
  The layout must hold from 900px to 2000px wide. No mobile layout.
- **Empty, loading, error.** Every data region has all three: a skeleton or spinner after 200 ms,
  an empty state that says what would make it non-empty, and an error state showing the API's
  `error.message` with a retry button.
- **A sentence first (merlin-403).** Each view answers "where have my tokens gone?" on its first
  screen with one sentence computed from the person's own data. The sentence names something they
  can act on and sizes it in dollars or in % of a limit window: "$31 was in calls at 200k+, most
  of it in sub-agent Explore", not "keep your context small". Each clause is a link into an
  existing view (a scope, a sort, a session), and it names the mark or column it explains, so the
  sentence also teaches how to read the view, and the second visit needs no hint. A clause below
  its threshold is left out rather than padded. A figure that is only a floor says so (`≥`).

### How cost is written

One component, `<Money>`, renders every dollar figure, so the rules hold everywhere.

- Under $0.01: `<$0.01`. Under $100: two decimals (`$12.34`). From $100: no decimals, thousands
  separators (`$1,234`). Zero: `$0` in the faint colour. A tooltip always gives the full figure.
- **Flag.** `exact`: the plain figure. `partial`: the figure with a trailing `+est` marker.
  `estimated`: the figure prefixed with `~`. The tooltip explains the flag in a sentence:
  *exact* "reported by Claude Code for the whole session"; *partial* "partly reported; the rest
  recomputed from token counts"; *estimated* "recomputed from token counts; Claude Code reported
  nothing for this session". *recorded* (Pi) "the harness's own per-call figures, its catalog
  estimate", shown with `~`; *billed* "billed by the provider, per call", shown plain.
- **Lower bound.** A figure that is only a floor is prefixed with `≥` (in place of `~`), and the
  tooltip says why: messages cut short in the transcript (partial output tokens, mostly sub-agent
  messages) or messages on a model without a price (counted as $0). A session's best cost is one
  when its `lowerBound` is set (unpriced messages only); an agent's attributed cost when its
  `truncatedMessages` or `unpricedMessages` is non-zero; a cost-page total when `backing.lowerBound` is.
- **Estimate.** A figure that includes the estimated output of sub-agent messages cut short
  (`Message.estimatedUSD`) is prefixed with `~` and the tooltip says how much: the spend graph's
  units and the session header. The overhead bands are what remains after the estimates.
- The two sources are never blended into one unlabeled number below the session level: a per-turn
  or per-agent figure is always attributed (from tokens) and is labelled so once per panel, not on
  every row.

### How states are written

| Thing | Values and look |
|---|---|
| Session `state` | `busy` filled green dot, pulsing; `idle` hollow green dot; `recent` grey dot; `ended` no dot |
| Session `endState` | `clean` nothing; `interrupted` red "interrupted"; `refused` red "refused" (tooltip "the last call was refused at a usage limit"); `mid-turn` amber "stopped mid-turn"; `unknown` nothing |
| Agent `status` | `completed` check; `open` amber "open" (no terminal marker); `killed` red "killed" |
| Turn `origin` | `human` no badge (the default); every other origin a small grey badge with its name |
| Lineage | a session that is not a `leaf` shows "continued in ›" and is dimmed in lists |

## 5. Shared primitives (`src/ui`)

Built by the scaffold bead so the four views look like one app. Views compose these and do not
restyle them.

| Component | What it does |
|---|---|
| `Money` | a dollar figure by the rules above; props `usd`, `flag?`, `dim?` |
| `Tokens` | a token count: `812`, `12.3k`, `1.2M`; tooltip with the exact number |
| `RelTime` | "3 min ago", "yesterday 14:02", "12 Sep"; tooltip with the full local time; re-renders each minute |
| `Duration` | `850 ms`, `12 s`, `4 min 05 s`, `2 h 13 min` |
| `StateDot`, `Badge` | the states above; `Badge` has tones `neutral`, `ok`, `warn`, `bad`, `accent` |
| `Clamp` | text clamped to N lines with "show more" / "show less"; never cuts the data, only the view |
| `Prose` | assistant text through `react-markdown` (GFM), styled for 13px: code blocks scroll sideways, tables are bordered, links open in a new tab with `rel="noreferrer"` |
| `PlainText` | a person's prompt text: `white-space: pre-wrap`, long lines wrap, no markdown (an agent's prompt goes through `Prose`) |
| `CopyButton` | copies a string, shows a check for a second |
| `Bar` | a horizontal proportion bar with one or more coloured segments |
| `Card`, `Section` | a bordered surface with an optional title row |
| `FrameSection` | a full-bleed section of a page's frame: uppercase heading row, `actions` at the right, content, a hairline under (Cost, the session focus) |
| `DataTable` | a plain table: sticky header, right-aligned numeric columns, optional row link |
| `Tabs`, `SegmentedControl`, `Select`, `SearchInput` | small inputs, keyboard accessible |
| `Tooltip` | a title-attribute fallback is acceptable; no popover library |
| `Skeleton`, `Spinner`, `EmptyState`, `ErrorState` | the three non-data states |
| `KeyHint` | a keyboard key (`/`, `Esc`) |

`src/lib` holds the logic behind them as pure functions with `bun test` tests: number and time
formatting, `shortProject(path)` (the last two path segments; the full path in a tooltip),
`modelLabel(name)` (`claude-fable-5-1` → `Fable 5.1`, `claude-haiku-4-5-20251001` → `Haiku 4.5`,
unknown names unchanged), `buildAgentTree(agents)`, and the search-snippet highlighter.

## 6. Data flow

- `api/client.ts`: `get<T>(path, params)` builds the query string, fetches, and throws an
  `ApiError` carrying `status`, `code`, `message` and `candidates` for a non-2xx answer.
- `api/queries.ts`: one hook per endpoint. Keys: `['projects']`, `['sessions', filters]`,
  `['trees', filters]` (the list by tree, `by=tree`), `['session', harness, id]`,
  `['search', q, filters]`, `['cost', params]`. `staleTime` 30 s; `refetchOnWindowFocus` on. Both
  lists are infinite queries over `nextCursor`.
- `api/events.tsx`: `EventsProvider` opens one `EventSource('/api/events')` for the app.
  - `session-updated`: replace the matching row in every cached `['sessions', ...]` page (insert
    at the top of unfiltered first pages when it is new), invalidate `['session', harness, id]`,
    and mark `['projects']` and `['cost']` (and `['overview', params]`, which the whole Overview
    page reads: its table, sidebar and the open session's head) stale without refetching hidden queries. In cached
    `['trees', ...]` pages the member is replaced and its tree re-tallied (last activity, cost,
    the member to open); a new session with no parent becomes a new tree. A new member of a tree,
    or a matching session whose tree is not cached, changes which sessions a tree holds, which
    only the daemon knows: the tree lists are invalidated instead.
  - `session-state`: patch the row's `state` in the cached lists and in a cached detail.
  - `session-missing`: invalidate lists (sessions and trees), that detail and the Overview.
  - `scan-progress`: kept in a small store read by `useScanProgress()`.
  - `hello` and `update`: the daemon's version and the newer release it did not install, kept in
    the same store (`useVersion()`; `availableToShow` decides whether the top bar offers it).
  - on `open` after an error (a reconnect): invalidate everything, because events are not replayed.
  - `useConnection()` gives `connecting | live | offline` for the indicator in the top bar.
- A row that changed through an event gets the 150 ms highlight.

## 7. Shell

The document never scrolls. The top bar is fixed at the top of the viewport and never moves or shifts sideways;
below it a page scrolls inside the shell's main area (its scrollbar starts under the bar) or in its own panes (the
Overview's sidebar and table do). A new page starts at the top of main; a filter change does not move it.
Sticky headers inside main stick at its top (`top: 0`).

One bar, 44px: **brand, the tabs, the theme and status buttons**: navigation only. The bar is global: it looks the
same whether or not a session is open in the Overview, and no page puts tools in it.

- **Left**: the wizard logo (`public/logo-48.png`, shown at 22 px) and "Merlin", linking to `/`. The favicons and the
  apple-touch icon are in `public/`.
- **Left, after the logo**: the tabs **Overview** (`/`), **Cost**, **Moments**, described below.
- **Middle**: a flexible spacer that keeps the right-hand buttons at the right. Pages put nothing in the bar: the
  Overview's search and range and folder controls are in the content area's header row (section 10b).
- **The tabs**: Overview and Cost link with the scope (`range`
  `from` `to` `by` `in`) of the page being read when it is one of the two, else the last one seen (`sessionStorage`),
  and `g o` and `g c` do the same; the search (`q`) is the Overview's alone: Cost's link has none, and the Overview's
  link from Cost restores the one last used there; the active one a quiet pill (`bg-surface-2`,
  rounded, `text-fg`), no underline (one would read as a marker of the table's columns), their tooltips carrying
  the shortcuts; Sessions has no tab (`g s`, or the links that lead to it). Just left of the theme button, only while it
  applies, "Merlin updated to X · Reload" once the daemon has replaced itself. Then the **theme button** (one click cycles System, Light, Dark: Monitor, Sun, Moon) and one **status button**: a
  small icon whose look is the connection (live: quiet; connecting: faint; offline: the bad colour, tooltip
  "offline, retrying"). While an update is offered (and the connection is not offline) the button's icon turns accent and an accent dot sits on its top-right corner with a ring pulsing behind it (`animate-ping`, `motion-safe` only: reduced motion gets a steady dot), and the tooltip reads "Update available: X". Its popover (closes on an outside click and Escape, 288 px) holds the connection and the running version; when an update is offered, a block under them is the most prominent thing in it: "Update available" with X (a link to that release's page) and a full-width primary button **Install X** (not while the "updated" notice is up, nor when X is the version running). The daemon's `update` event gives the state: `ready` and `available` show the button (the latter downloads first, and may carry the last failure as a quiet line); `downloading` shows it with a quiet "downloading…" hint; `blocked` has no button, only the reason (the `sudo` command, selectable). A click POSTs `/api/upgrade` and the button reads "Installing…", then "Restarting…" after the 200; a failed call shows its message under the button and enables it again. The block ends with the quiet hint "Turn on auto-upgrade: `merlin autoupgrade`". The tab that clicked Install reloads itself as soon as the daemon's hello reports the version it installed (the flag lives in the event store, not in storage); other tabs keep the "Merlin updated to X · Reload" notice.
- **The legend panel** (added 2026-11-15, `merlin-bj5.1`): a column at the right of main, 300 px, full height under
  the bar, `bg-surface`, a left border, its own scroll. It pushes main (main narrows; the Cost chart follows its
  width); under 1000 px it overlays main instead. A page fills it with `<PanelTab id title>` (a portal); the known ids, in order, are `overview` ("Overview"), `graph` ("Graph") and `cost` ("Cost"). Only filled tabs show; the one
  picked by hand wins while it stays filled, else the one filled last; a single tab shows its title in place of
  a strip. The **Legend button** (`PanelRight`, before the theme button, pressed while open) shows only while the
  page filled a tab (the Overview fills one only when limits touched it); `l` toggles it (not while typing), Escape does not close it. Open or
  closed is kept per viewer in `localStorage` (`shell.legend`); with no choice it starts open at 1400 px or wider.
  The rules are in `shell/panel-model.ts`.
- **Indexing**: while `pending > 0`, a thin accent line along the bar's bottom edge, as wide as done / seen,
  its tooltip "indexing 120 / 3,355 · n unchanged · n failed". Nothing otherwise.
- **Shortcuts**: `g o` Overview, `g s` Sessions, `g c` Cost, `g m` Moments, `l` the legend panel (where a page filled it); `/` focuses the search on the
  Overview (expanding it) and on Sessions.

## 8. Sessions page (`/sessions`)

The list of sessions, and the answer to "where was that session". It lists **trees**, as the Session
page draws them: a session and every session forked or continued from it are one row.

```
┌ top bar ───────────────────────────────────────────────────────────────────┐
│ Projects        │ [ search prompts, answers, titles…  / ]  state kind  since │
│ All        223  │ ─────────────────────────────────────────────────────────  │
│ merlin      41  │ Today  3 sessions in 2 trees                               │
│ acme/web    30  │ › ● add the footer [2 sessions] acme/web main 3m 12  $9.10 │
│ …               │     "recap or last prompt preview, one line, muted…"       │
│                 │   ○ plan billing          acme/api  feat  1h   3  ~$0.80   │
│                 │ Yesterday  1 session                                       │
│                 │   31 scripted runs · merlin                        $0.42   │
└─────────────────┴────────────────────────────────────────────────────────────┘
```

- **Project rail** (240px, collapsible): "All" and each project from `/api/projects`, most recently
  active first: short name, session count, cost. A project is a directory: Claude Code and Codex
  sessions started there are one project. Selecting one sets `project` in the URL.
- **Filters**: state (`All`, `Running`, `Recent`), kind (`interactive`, `background`, both by
  default), and a since preset (`7d`, `30d`, `all`; default all). They select trees through their
  members (`/api/sessions?by=tree`): a tree is listed when any member matches, and then whole.
- **List**, one row per tree, grouped by the local day of the tree's last activity (its newest
  member's). A day header names the day and counts ("3 sessions in 2 trees", or "2 sessions" when
  every tree is a single session). It shows **no money**: a tree's cost is the whole tree's, spent
  over many days, so a day sum would overstate the day. A row, two lines, describes the tree
  through its **open** member (the newest leaf, the one to resume):
  1. state dot (the busiest member's), title, end-state badge, "codex", the PR badge ("PR #12", "3 PRs":
     every member's PRs once; the tooltip lists the URLs), background and "no source" badges,
     "N sessions" when the tree has several, then right-aligned: short project, branch, the tree's
     last activity, prompts (`humanTurns`) and agents of the open member, the tree's cost (the sum
     of its members' best cost) with the weakest member's flag.
  2. the open member's recap, marked "recap", or its last prompt preview; one line, muted.
  The row is a link to the open member. `j` / `k` move the selection, `Enter` opens it.
- **Members.** A tree of several sessions has a chevron left of the row that lists its members
  underneath, in tree order (a parent before its children), indented, each the two-line session row
  with its lineage hint ("fork of …", "continues …", "continued in ›"), its own cost, and a link to
  that session.
- **Scripted runs** appear only as aggregate lines at the end of a day group ("31 scripted runs ·
  merlin · $0.42"), not clickable.
- **Paging**: load the next page of trees when the end of the list scrolls into view.
- **Search** (`q` in the URL, debounced 200 ms, at least 2 characters): the list is replaced by
  the hits of `/api/search`, grouped by tree (`hit.root`) in the order the API returns them. A group
  shows the title, project and time of its best-ranked hit's session, then each hit as a line: a
  label for `field` (`title`, `prompt`, `answer`, `summary`, `project`, …), the snippet with the
  terms highlighted, and for a turn hit a link to `/s/…#t<turn>`. When the tree has hits in several
  sessions, the header says so and each hit names its session. `continuedIn` is shown as "also in
  ›" links. `Esc` clears.

## 9. A session in the Overview's focus (`/s/:harness/:id` redirects here)

*Since 2026-11-15 the Session page lives in the Overview's focus (section 10b, "A session in place"; epic
`merlin-bj5`). `/s/:harness/:id` only redirects. What is left of it is two things: the **graph** (its key in the Legend
panel's Graph tab) and, under it, the **box** for the pinned turn or piece of agent work (`TurnBox.tsx`). The header,
the resume box, the family strip, the banners, the diagnostics, the decision panel and the list of the most expensive
decisions were removed (the paginator has a copy button for the resume command; the Cost page ranks decisions). The
zoom is state, not address; `sfrom`/`sto` only come in from links.*

The focus answers "what happened in this session, and what did it cost", for a session and every session forked or
continued from it: they are one tree, and the focus is the same whichever member it is opened on.
Code in `features/spend/` (the graph; bead `merlin-t8s.34`, design history on `merlin-t8s.27`) and
`features/overview/` (`SessionView.tsx`, the box). The view loads every member of `family.members` with `?messages=1`;
dollars are recomputed from the messages' token counts with prices fitted per model (the web has no price table).

From top to bottom, the graph and then the box:

- **Spend graph** (`SpendGraph.tsx` the section, `TimeView.tsx` the plot, numbers in `timeline.ts`;
  bead `merlin-t8s.36`): wall-clock time across, local, so that a stretch of the session can be found
  by when it happened. The full-session strip comes first, then the **readout** above the plot and the plot.
  The **breakdown** of spend as three bars (below), unrecorded-work notes and compaction totals follow the plot.
  All of that uses the section's full width (the strip and the plot measure it), with the plot's **key** below.
  - the **readout** is one block of a fixed height (4 lines, so nothing under the pointer moves the graph).
    Its first line is the pointer's (`TimePlot`): the clock time, the row's context (held, or waiting for a
    message), this slot's spend on the row; or, over an overhead band, what that band stands for; or, on a
    collapsed swarm, what it stands for. The lines under it (`TurnReadout` in `SpendGraph.tsx`) are the turn
    under the cursor or pinned (its prompt, step, launched work, decision total, context, idle time, the
    by-who chips and notes on cache misses, compactions, typed-while-running prompts and reports) or the
    selected or hovered piece of agent work. With nothing hovered, pinned or selected the block is one hint:
    how to read and pin, and the scales;
  - the plot's **key** (`Key.tsx`, `Legend`) is always shown: no button, no toggle, nothing
    in `localStorage`. It sits under the plot, below a rule, in three balanced columns (a grid of `auto-fit` columns of at
    least 17rem, so about three above 900 px and fewer below): *Sessions and agents*; *Context*; *Your turns*, *Spend* and *Time*. Entries are
    rows of a column: an inline SVG sample (28x16 px) and its words, samples
    lined up and texts starting at one x, in
    groups with a small heading (the same on the three columns): *Sessions and agents* (session line by tier, forked or continued session,
    agent spine, fork with its copied context, agent frame, fork notch, workflow dashed, swarm "+", report),
    *Context* (the context area, held strong and faint, cache miss, compactions cold, warm, unknown), *Your
    turns* (prompt, typed while a turn ran, decision, pinned decision), *Spend* (spend per slot, not explained
    by messages) and *Time* (break, drawn as the veil over a baseline and a gridline). All entries are always listed: a mark the tree cannot have (`keyFacts`:
    cache misses, each kind of compaction, queued prompts, agents, forks, workflows, swarms, reports, sessions,
    overhead) is drawn faint, with the title "not in this session". The samples use the constants and patterns
    TimeView.tsx exports and draws with (widths, dashes, opacities, tints, the hatching, `elbowPath`), so a
    change to the plot's look changes its legend.
  - stretches longer than 10 minutes in which nothing ran (no call, no turn, no piece of agent work)
    are squeezed into a narrow **break** (a pause, so that the work around it reads first) labelled with its length. A break is not a band: the page stays white, and a veil (a rect of the page colour at `BREAK_VEIL`, 0.6, over the rows) fades whatever crosses it, the baselines, gridlines, held contexts, agent lines and spend, which stay visible. The veil lies over the plot's lines and under the cursor, and the texts written on rows (model names, frame labels) are drawn above it so that they stay readable; it takes no pointer. The veil stops above every overhead strip (it is cut into segments around each one, the strip of a session in the middle of a tree included): a strip is never faded. A break's width is not fixed: `breakWidth` = `BREAK_BASE_PX` (12) + `BREAK_LOG_PX` (8) x ln(length / 10 min), at most `BREAK_MAX_PX` (60), so a 15-minute pause is barely wider than the base (about 15 px) and a night of 8-12 h is 43-46 px; together the breaks take at most `BREAK_SHARE` (a tenth) of the axis, each made narrower to fit (never under `BREAK_MIN_PX`, 6). The overview's axis uses the same rule (it is the same `timeAxis`, so that the effective window measures the same lengths on both). A light dotted stretch of the time axis (`BREAK_DOTS`) with its length written above it, rounded (`15m`, `40m`, `8h`, `21h`, `3d`: to 5 minutes under an hour, to the hour under two days, else to the day), marks it on the axis (its tooltip says exactly how long nothing ran); with more than 12 such
    pauses, only longer ones (20 min, 30 min, 1 h, ... up to 16 h) become breaks. A turn ends at the
    last thing that ran in it (the harness may close a turn hours later, when the session is left);
  - **Lockouts.** The session axis shades observed interruptions for the session's own account. A refusal starts the band. The first successful call anywhere can end the interruption even if the account's own limit remains in effect. A session that stopped at a refusal can extend its axis to the observed end. An open interruption is marked as open through the present, with the scheduled reset in its wording when known. Refusal ticks still mark the individual calls.
  - **a window at a time** (beads `merlin-t8s.50`, `merlin-zls.6`): the plot shows one **window** of
    time, with a time axis, breaks, slot length and dollar scale of its own (its rows and token scale are the whole session's, see the vertical frame below); the rest of a long tree is
    reached through an **overview** strip above the readout (`Overview.tsx`). Every tree has it, a short one
    too (it opens on all of it), so any tree can be zoomed into. A turn, call, context and mark belongs to a window if it starts inside it
    (`[lo, hi)`; a turn running past the edge is kept whole); a piece of agent work if it overlaps it,
    and a launch or report line whose other end is outside the window is drawn along the plot's edge,
    dashed, with a small chevron pointing out (`sliceTimeline`). A turn the window cuts is shown whole, at either
    edge alike, so the plot shows the **effective window**: the brushed one grown to the start and end of
    the turns it cuts (`effectiveWindow`; a turn no longer than the window is made whole, a longer one is being zoomed
    into and is cut at the edges, both measured on the strip, so a brush dragged along keeps its behaviour;
    not repeated for what the grown parts reach into) and every lane is sliced by it (`sliceWindow`), so data fills
    the whole axis (`merlin-zls.9`);
  - the **overview** is 54 px tall and full width: the whole tree on one linear wall-clock scale, idle
    time squeezed out as in the plot (`timeAxis` over every span, at most 16 breaks, so long nights do
    not eat the strip). It draws the context of the main rows as a light area (the largest of the main
    lanes, `contextEnvelope`), the spend as thin columns along the bottom, one grey with the cache miss in its colour like the plot
    (`spendDensity`), a line at each day boundary (the faint text colour at 70 % opacity, clearly stronger than the strip's other lines), the date of each day (from `splitDays`: the
    day-of-month, with the month where it changes) where its activity starts, and the pinned turn's
    marker. The **brush** is the window: a light accent band, no outline, centred on the line between the context area
    and the spend bars, with an accent marker at each edge (as on the Overview's timeline); the rest
    dimmed. Dragging across the strip selects a new range; dragging the window moves it rigidly, its width on the
    strip kept (so over a break its time width changes); dragging a handle resizes it; a click (the pointer
    moved 3 px or less) anywhere on the strip, inside the window or out,
    over a date label or not, selects the day under the pointer. The strip is cut into **day partitions** that tile it
    (`dayParts`): the boundaries are the local midnights, except that midnights with no activity between them (a
    whole idle day, squeezed into a break) are one boundary, at the last of them, so the partition after it is named
    after the day that has the activity. The first partition starts at the strip's left edge and the last ends at its
    right edge (the background's extent); a partition's window is its extent in time clipped to the session's bounds;
    the plot focuses on the active parts of it by itself. One line is drawn per boundary, and a label at the start of
    each partition, only where its text fits inside it. While the pointer is on the strip (not on an edge, not
    dragging) the partition under it gets a soft accent wash, edge to edge. A brush whose window reaches the session's
    start or end is drawn at the strip's start or end (the first piece's start; the end of the last activity, not
    the wait for a limit's reset, which stays outside the brush and dimmed), so All, the first and the last partition fill the strip. **A session shorter than 24 hours has no day selection:** no
    wash, and a click without movement does nothing (drags, edge resizing and the keys that step by window width
    still work). ← → on the strip move the window by its own width, or to the previous or next partition
    when it is one; Home and End go to the first and last partition (or the start and end). A window is never narrower than 5 minutes. The parts of the effective window beyond the
    brush, on either side, are drawn as a fainter continuation of the highlight (no handles; the brush itself is still the
    user's window). A line above the strip says what is shown (the effective window: its span, duration
    and spend, as the plot shows them) and what it spent, with **Latest** (the window the page opened on) and **All**. The days are cut each
    night at the idle stretch that covers most of the night's core (00:00–08:00), then of its window
    (18:00–12:00); the time after the last activity counts as such a stretch, so work past midnight
    with nothing after it stays with its evening, and a turn still running is never cut. A part is the
    calendar day its first-to-last activity overlaps most; when two land on one day the first goes back
    to the day it started on (an evening run deep into the night), or, if it started that same day,
    they are one;
  - a session opened from the Overview **opens on its part in the list's time range** (with `1d`, today's part; the part is cut at
    the range, `scopeWindow`; the range is the one the list asks the API for, whole local days for a preset, the exact instants
    of a limit window). A session wholly inside the range, or with nothing in it, opens on all of it, and `sfrom`/`sto`, when the
    link has them, win. The window is set once, on open, and a later change of range does not move it; a window that ends at
    the session's end follows a live session. **All** is the whole session. **Latest** goes to the day of the last work episode: an episode runs back from the end of
    activity to the first idle stretch longer than 2 hours or the first night cut, whichever comes
    first (`defaultWindow`, `episodes`); an episode that spent under 1% of the tree (a resume that only
    compacted) is passed over for the one before. The window is that episode's day (a day of three
    sittings would otherwise open on its last half hour), or the episode itself, with a little pad,
    when the tree had no night and its one day runs for more than 30 hours. Pinning a
    turn (in the graph, a panel, the list of decisions, `#t<n>`) or moving the keyboard cursor brings
    it into view: when it is outside the effective window, the window moves to hold it, keeping its width, or
    snaps to the turn's day if it was a day (`revealWindow`); a turn asked for on opening picks the
    episode that holds it. The window is the user's: nothing else moves it (the pointer passing over
    the plot does not), and the page keeps room for a scroll bar, so that one appearing mid-drag does
    not shift the strip under the pointer. `?from=<ISO or ms>&to=<ISO or ms>` sets the window (screenshots);
  - the **vertical frame** is laid out once for the whole session and does not move with the window
    (`buildFrame` in `layout.ts`, memoized by `TimePlot`; merlin-zls.11): the rows (swarms collapsed unless
    opened, agents packed on the axis of the whole session), the token scale (from the session's largest
    context), each row's height above the baseline (its largest context in the whole session) and below it
    (its largest slot in the whole session, on the whole session's slot length), and a strip of overhead under
    every session that has overhead anywhere. Rows, gaps and the plot's height are therefore the same for every
    window; only opening or folding a swarm, or the plot's width, changes them. A window draws into the
    frame: each row's lanes are the window's slices of the whole lanes, looked up by key (`windowRow`); a lane
    with nothing in the window draws nothing and a row with nothing in it is empty space with its baseline and
    gridlines. Zoomed on a simple stretch the plot therefore looks sparse, because the session is complex
    elsewhere. Identity and geometry (who launched whom, where a fork began) read the whole lanes, data in view
    the sliced ones. The time axis, the breaks, the slot length and the dollar scale below are the window's own;
  - a **row** per session's main agent and per agent it launched, in the tree's order. Above its
    baseline, the context every call of the agent was sent with (prompt tokens), as a step area, on one
    token scale for every row: a row is as tall as its largest context needs, so the rows that were
    expensive to carry are visibly fat. Solid and dotted say whether the agent was making calls: the
    area stops at the end of every turn (on a main row) or piece of work (on an agent's row), however
    short the wait for the next message, and inside one where it paused longer than 5 minutes (the
    cache going cold); a dotted line then holds its context at the level it will be read again at.
    The dotted line is strong while the turn or piece of work still runs, waiting on a tool or an
    agent, and faint between a main agent's turns, waiting for a message; under it, the context
    carried over the pause is tinted lightly (8%) in the row's colour, so that the context's path
    reads unbroken. An agent's dotted line between two pieces is as strong as within one (it joins
    them, as a main agent's line joins its turns); hover there reads "held, waiting for a message N
    min". A turn whose first call came more than 5 minutes after its prompt (a failed prompt sent
    again) starts its area at that call. A one-shot sub-agent has a single piece of work, so this never shows on its row. An agent's own sub-agents are thin lines on its row;
  - below the baseline, what the row spent in each slot of time (a round length, at least 4 px wide),
    on one dollar scale for every row, as a 1 px line per slot (at the middle of where the row ran in
    it), one quiet grey (`--muted`), with the slot's cache miss in the miss colour at
    its bottom; the lines are drawn under everything on the baseline, so the agent's and session's
    weighted lines stay readable. The scale is the window's own (slots are
    shorter when zoomed in, so a fixed scale would make bars vanish): the largest at which the tallest bar of
    every row in the window still fits the band the row has in the frame (`dollarScale`), less the room a main
    row keeps for its turn numbers; "the tallest bar is $X" above the plot is true of it. A row pays for its agent's calls, its
    sub-agents' calls and, for a main row, the compaction calls. A bar is drawn only over the part of
    its slot in which the row was running (`barSpan`): the slot cut to the turns (main row) or
    pieces of work (agent row) that hold its calls, so it never starts before its agent was
    launched or runs past the end of a turn; calls outside any of them give the span from the first
    to the last call, and a bar narrower than 2 px is widened to 2 px, centred on its calls;
  - the **token scale** is labelled on every row, as far up as the row reaches; zero is not labelled, its line
    is the row's axis: darker than the gridlines (`--faint`) and drawn on into the scale's gutter; the other rows keep faint gridlines;
  - **level of detail** by the median room a turn has on the main row (`detailAt`): above 40 px
    per turn every turn has its tick, thick stretch and number and every decision its bracket and
    dollars. From 12 to 40 px the numbers still show only where they fit, and only the 8 most
    expensive decisions in view (`bracketed`), plus those of the hovered or cursor turn and of the
    pinned turn, have a bracket; the others show only their prompt dot. Below 12 px the turns are
    only the turn in focus has a tick and number, and the brackets are the same top 8 plus focus;
  - a diamond is a **cache miss**, on the call that missed: the part of an agent's previous prompt
    that its next message did not read from the cache, written to it again (Claude Code) or charged
    as plain input (Codex, whose cache has no writes). Each miss has a cause: idle longer than the
    cache lifetime (5 minutes, or an hour after one-hour writes; for Codex, whose cache has no fixed
    lifetime, the same 5 minutes), a model switch, fast mode turned on or off (fast calls do not
    share the cache), or no visible cause;
  - a piece of agent work that the agent's own background work started after it had reported (an
    expired watch waking it; `turns[].origin` task-notification after the first) has no line from a
    sender; the note under the graph counts these wake-ups and their dollars, as work nobody asked for;
  - a vertical mark is a **compaction**, from its context before down to the baseline: solid red
    when its call ran on a cold cache, dashed amber when warm, grey when the digest has no figure.
    The line above the graph adds them up for the tree, with what a warm cache every time would have
    cost. For Claude Code the figure (`compaction.call`) is an estimate (the harness does not record
    the call), cold means idle longer than the cache lifetime, and it is in no figure on the page;
    for Codex it is the recorded call (`compaction.messageId`), cold when less than half the context
    came from the cache, and already in the figures;
  - under a session's last row, a hatched band over each **reported window** whose figure is more
    than its messages add up to (`cost.windows[].overheadUSD`, less the window's `estimatedUSD` and
    `rateDiffUSD`, which the messages and the harness's other rates explain): what the harness
    reported and no message explains, labelled with its dollars and on no scale, since it belongs to the whole window
    and not to a slot, turn or agent in it. Hover reads the window's reported and covered figures. The
    legend's "Not explained by messages" entry adds the bands up, and the legend's percentages are
    of messages plus overhead, which is the header's figure;
  - a main row's baseline is the **session line**: one continuous stretch in `--main` from the session's first
    moment to its last (the whole life, clipped to the window, so it runs through the window even where no
    turn does), over a faint full-width axis (0.75 px) that keeps the scale readable outside it. It is as
    heavy as the tier of the model in effect (3.5 px heavy, 2 px mid, 1 px light; unpriced is mid): during a
    turn the model that ran, between turns and across breaks the model last in effect, before the first
    run the first run's (`tierSegments`, `carrierWeight`). It is never thinned while idle, but where the context above it is held (dotted) it is dashed at the same
    weight, in shorter gaps while a turn still runs and longer ones between turns (`dashPieces`). Each turn has a
    tick where it starts, drawn over the line; the band level of detail keeps only the ticks and numbers
    of the turns in focus, the line is the same. Where the main agent's model changes
    (`lane.runs`), and where its first call in the window is, the model's short name (`Fable 5.1`)
    is written small (9 px, muted, surface-coloured halo) just above the baseline at that point; a
    label that would come within 14 px of the one before is left out, and a change to a name that
    reads the same is no change (`modelMarks`); A turn starts at
    `turn.startedAt` and ends at the last thing that ran in it (a call of the main agent or of any
    agent, or a piece of work starting or ending) up to the harness's `endedAt` and before the next
    turn starts;
  - a main row has a dot on its baseline for every prompt a person typed: at the start of the turn
    it began, or hollow where it was typed while a turn ran (`turn.queued`: it starts no turn,
    but it steered that turn). The turns are grouped by time into **decisions**, and each decision has a
    bracket that rises and runs over the row with the total of everything in its turns, so a decision can
    carry several prompt dots. A gap of 3 hours or more between two turns always separates two decisions;
    turns 60 minutes apart or less join; and a decision with under 5 minutes of active work (a turn's
    active time is its calls, pauses of more than 5 minutes left out) joins its nearer neighbour, the
    earlier one on a tie. A forked or continued session's copied turns never share a decision with its
    own. The decision's prompt is the first one a person typed in it; and the
    turn numbers where they fit. A forked or continued session has a main row of its own with only
    its own turns, starting with a spine from its parent's row (below); nothing is merged across
    session ids;
  - an agent's work is one light frame, in its kind's colour, from the start of its first **piece
    of agent work** to the last call of its last: its start down to the baseline, its top, and a short
    stem at its end, like a decision's bracket turned round (no fill, so the context tint under it
    reads alone; its pieces show in the context, an area while they run, dotted between them). A
    sub-agent solid, a fork with a notch, a workflow dashed. The frame carries the agent's name and its spend at the top left, `name · $1.20` (the spend goes
    first when room is short), and its main model (the model of most of its calls, as `Sonnet 5.5`) at the
    bottom left, just above the baseline and right of the elbow, as main rows write theirs; the model is
    written only if it fits inside the frame. What is left out is in the frame's tooltip, `name · Sonnet 5.5 · $1.20`. A piece is one of the
    agent's turns (`agent.turns`): a sub-agent or fork has one, an addressable agent (a Claude Code
    teammate, a Codex agent) one per message or task that set it working again (from a daemon without
    `turns`: one per message it was sent); a workflow run (`digest.workflows`) is one piece with all
    its agents inside. Agents are packed into rows by their whole life (an addressable agent keeps
    its row over its pauses). The rows have no labels: the plot takes the full width, with only the
    context scale to its left, and each agent is named on its frame;
  - a **swarm** (bead `merlin-zls.4`) is one row until opened: at least 4 one-shot sub-agents (not
    addressable, not forks, not workflows; each with a single piece of work) launched by the same sender
    in the same turn of the main row, whose lives overlap or come within 10 s of one another
    (`findSwarms`, on the whole timeline, so a window keeps its ids; id = branch, sender, launch turn,
    first agent). Its row is as tall as the swarm's largest context. It draws each agent's context as a
    thin line (35%) under a light envelope of their largest (`swarmEnvelope`), the spend of all of them
    summed per slot on the usual dollar scale, one spine from the sender at the first launch weighted by
    the tier most of the swarm's dollars went on (`dominantTier`), one frame over the swarm's whole span
    labelled `25 × Explore · $0.60` (`25 agents` for mixed types; the spend goes first when room is short), with the swarm's model (`Haiku 5.5`, `mixed` for mixed models) at the bottom left, and the agents' misses and compactions.
    Hover reads count, types, models, spend and the span in the line above the plot. A click on the
    frame or its "+" chip, or Enter while the pointer is over it, opens the swarm into its agents' own
    rows, packed as any (`collapseSwarms`); a "−" chip left of the first agent's frame, or Enter while
    one of its pieces of work is selected, folds it again. Selecting a piece of work of a collapsed
    swarm (`#a<agentId>`) opens it. A window that cuts a swarm keeps it one row while two of its agents
    remain; the state is the plot's own and is not kept in the address;
  - **spines** show who launched whom. Every agent lane, and every forked or continued session's main
    row, has a spine: a path that starts on its sender's baseline at the moment of launch (the main row of
    its branch, or the row of the agent a later message names as its sender, `u.from`; for a forked
    or continued session, the main row of its parent session at the moment the new session begins),
    runs vertically to the agent's row, turns with a rounded elbow (radius 6 px) onto its baseline and
    runs along it over the agent's life, from its first launch to its last activity, dashed where its context is held, as a
    session's line is. It is in the
    lane's kind colour, faint (35%) and drawn under the areas and
    frames; at full strength for the work in focus: hovered, selected, or launched or reported in the
    turn under the cursor or pinned. Context-carrying branches are skeleton, not detail: a forked or
    continued session's spine and an agent fork's are always at full strength, a clean-context
    sub-agent's elbow stays thin and faint, while its own line along its baseline is always drawn in
    full. Every row's gridlines and zero line are drawn first, under all of this. Agents packed into one row
    each have their own segment. The horizontal part is as heavy as the model tier of the run the
    agent was on, segment by segment along `lane.runs` (3.5 px heavy, 2 px mid, 1 px light, 1 px grey
    unpriced; the gap between two runs keeps the weight of the one before; `tierSegments`), so a
    cheap worker under an expensive main agent is a thin line and a fork on the parent's model a
    heavy one. The vertical part of an agent's spine is 1.25 px whatever the weight. A forked or continued
    session's spine is the main line bending down: `--main` colour, on a `--surface` halo 4 px wider so that
    it passes in front of the agent rows it crosses. A fork forks the line, so its spine is as heavy as the
    parent's line at that moment (`carrierWeight`) and lands on the fork's own line where it begins; a
    continuation's is as heavy as its first model run (mid when unknown). It has no horizontal part: the
    session line carries the weight. An agent fork's elbow is as heavy as the agent's first tier, not 1.25 px.
    A swarm of 4 or more is one row with one spine
    (above); fewer launched at one moment are a trunk of overlapping spines. A piece of work that began before the window starts at the left
    edge with a chevron and no elbow. A later piece of work of the same agent (a teammate woken again)
    keeps a thin line from its sender, drawn only when it is in focus; none for work the agent's own
    background tasks woke (`woken`). The report lines stay as they were: a dashed line to each turn
    a report came in, only for the work in focus. An agent's turns are its pieces of work: a
    message from the agent that launched it, or a notification that wakes it after it finished,
    starts a new one (the harness writes these as `isMeta` records with an `origin`);
  - **branch nodes and labels**: where a fork or agent fork leaves its parent's baseline a filled dot
    (r 4.5, 2 px surface outline, in `--main` or the fork colour) marks the start of the spine; a continuation
    has a ring (surface fill, 1.75 px `--main` outline). The session's dot has a tooltip ("Forked at turn 27:
    28 turns copied into “…”", "Continued in “…”"); it is left out when it falls outside the window. In a
    tree of more than one session the first model label of each main row is prefixed with its role in
    the text colour, semibold: `original`, `fork of turn N` or `continued`, plus ` · this session` for
    the session the page was opened on (`TimePlot`'s `current`; `branchRole`);
  - **a fork takes the whole context** (every other agent starts clean), so it forks the line: its spine
    leaves the parent's baseline (as a continuation's does) at that moment (for a forked session, at the end
    of the last turn it copied, `lineage.parent.atTurn`), and in the fork's row the first run of its context
    shows the part it inherited, the parent's context then capped at the fork's first context
    (`inheritedContext`), as a light hatched band in
    the parent's colour under the fork's own area, so the copied context and the growth on top of
    it can be told apart. A sub-agent (clean context) and a continuation branch from the parent's
    baseline and have no hatch;
  - hover reads the clock, the context of the row under the pointer and the slot's spend; between
    two turns it reads "between turns 0 and 1: main agent idle 38 min". A click
    pins the turn or selects the piece of work; a click between two turns of one decision, inside
    its bracket, pins its nearest turn, and between two decisions pins nothing; arrow keys move by turn.
- **What is pinned, in the graph**: the pinned turn is tinted on its row with a marker over it, and its decision's
  bracket turns into a thick accent line with its turns lightly tinted across the session's rows (`marks.tsx` holds
  the opacities and the colour of an agent's kind); the selected piece of work has its frame's top drawn heavy.
  The box under the graph does not repeat these marks: it says what the turn or the work was, not what it cost.
- **Breakdown** (`Breakdown.tsx`, numbers in `partition.ts`; the card's top, in place of the old
  switch "By who / By token class / By model tier", which coloured the bars and no longer does, as the
  plots draw spend as thin uniform lines): **three horizontal stacked bars**, one per partition of the same dollars
  (by who, by token class, by model tier), in rows of a fixed height (28 px).
  - **The session's rectangle.** Each row has the whole session's dollars as an outlined rectangle (1 px, `--faint`, no
    fill) whose length is a share of the track from `lengthShare` (`partition.ts`, pure): nothing for $0; a tiny 5% for
    $1 or less ("nobody cares"); from $1 to $100 linear in log10 of the dollars, 5% at $1, 42.5% at $10, 80% at $100;
    beyond $100 it saturates toward the whole track, continuous at $100 with the same slope, 80% + 20% x
    (1 - e^(-(log10 s - 2) x 0.375 / 0.20)) (about 97% at $1000). The track is the card's content less 150 px for the
    price.
  - **The window inside it.** The coloured segments are the plot's **effective window**'s parts, scaled **linearly**
    in the rectangle: a part of $x is x / the session's total of the rectangle's width, from its left edge, in the order
    of the series (`KIND_SERIES`, `CLASS_SERIES`, `TIER_SERIES`), zero parts skipped, the overhead tail last. With the
    whole session they fill the rectangle exactly; with part of it they fill a proportional part from the left and the
    rest of the rectangle is empty (a window of $0 leaves the empty rectangles). A segment writes its label and
    percent of the window inside when they fit. Every segment has a hover title, "Token class: Cache read · $1.20 · 39%",
    and for a model tier the models in it (the tier is by input price per million tokens from `GET /api/prices`:
    **heavy** from $4, **light** up to $1, **mid** between, **unpriced** for a model the table does not know; with the
    prices missing it goes by the family in the name; the whole call, cache miss included, is in its tier).
  - **The price** is written once, right of the rectangles and vertically centred on the three rows: `$12.30` for the
    window and, when it is not the whole session, `of $45.10` muted. Its x depends only on the session's rectangle, so
    nothing moves while a window is dragged (the rows are fixed, the figures tabular).
  - **Faint fills**, like the agent strips of the plot: a segment is its colour at `CTX_FILL` (0.22) under a full-colour
    top edge of `CTX_LINE` (1.25 px), both imported from `TimeView.tsx`. The **token class** bar is in black-and-white
    patterns of theme tokens (`CLASS_PATTERNS`: dark grey output, light grey cache read, diagonal hatch cache write,
    dots uncached input) at the same opacity, so it reads as another kind of partition than the coloured bars; the
    cache miss alone stays pink, as everywhere. Labels keep the normal text colour. The swatches of the names
    have the same look.
  - **The names** (the bars' legend): right of the bars, three narrow columns side by side, *Who* | *Token class* |
    *Model tier*, each a small heading over a vertical list of swatch and name, swatches lined up (the columns are as
    narrow as their longest name; the bars' track takes all the rest of the width, less 150 px for the price). The
    dollars and percents are in each segment's hover title. The overhead's "Not in messages" (hatch swatch) is the last
    entry of the *Model tier* column, the shortest list, always present as the overhead is in every bar. **Every series
    is listed, a part of $0 faint**, so that nothing jumps while a window is dragged. Hovering a segment or a name is
    one shared state (held by the card):
    the segment gets a 1.5 px frame and the name is underlined; nothing dims. The overhead frames its tail in all
    three rows.
  - What is counted is summed from the timeline's calls in one pure function (`sumRange`: the three partitions of a
    range add up to the same total; a call is in when its time is, as in the plot's slots). **Overhead** (what the
    harness reported that no message explains) is in no partition: it is a hatched tail at the end of every row, so that
    the rows stay equal; the whole session's is the tree's. For a window it is apportioned by how much of each reported
    stretch (`Branch.overhead`, which has its time span) lies in the window (`overheadIn`). The line under the plot that reads a
  turn or a piece of work shows the chips by who. The timeline keeps for each call its model and
  tier, and for each row its **model runs** (consecutive calls on one model, `{ t0, t1, model, tier }`)
  and its main model, for drawing the weight of a line by model;
- **The box under the graph** (`TurnBox.tsx`; pure parts in `thread.ts`; bead `merlin-bj5.3`): one section of the focus's frame
  (full-bleed, a hairline under it, no border or corners), shown while a turn or a piece of agent work is pinned. It reads as the conversation: who said what, in
  order, with times, and **no dollars, tokens or cost bars** (the graph and its hover carry those). Texts are
  rendered as markdown (`Prose`) and fold at 12 lines with "show more"; a typed prompt is plain text; lines are
  capped at 100ch.
  - **A pinned main turn**: a heading row (`Turn 12`, its time and duration, marks for interrupted, abandoned or a
    slash command, ‹ › to the previous and next turn of the session, ✕ to unpin); the **prompt**, with who it came
    from (you typed it; a teammate wrote; a background task reported; a wake-up; ...), its text, and each delivered
    `inbox` message as a block with its sender (a link that pins that agent's work when `agentId` is set), its kind
    (message, task result, idle, assignment) and time, prompts that arrived while the turn ran in place (`queued`),
    "N images"; one line of **what it did** (`18 tool calls (Edit 6, Bash 5, Read 4, …) · 3 files · launched
    reviewer, Explore`, the agents being links that open their work); the **reply** (`finalText`, whole), or "No
    reply (interrupted)".
  - **A pinned piece of agent work** (an agent and one of its `turns[]`): a head line (the agent's name, its
    description, its role and model, its time, its status, ✕ back to the turn); "Launched in turn 12" and "reached
    the main agent in turn 15" (links; `Unit.launch` and `Unit.reports`); the **exchange** as a thread, oldest first:
    for each of the agent's turns the request (the main agent's prompt, or the message that set it working again,
    with its sender) and the response (`finalText`). The pinned turn is open, the others are one folded line each
    (sender, first line, time) that open on a click. A one-shot sub-agent is one request and one response. A prompt
    the harness keeps encrypted (Codex) says so. Then what it did in a line, and its own sub-agents as links.
  - The two address forms (`#t<n>`, `#a<id>`) and the Esc behaviour (one Esc takes the pin back, the next closes the
    session) are unchanged.

Addresses: `#t<n>` pins turn n (a copied turn on the session that ran it), `#a<agentId>` opens that
agent's piece of work (a nested agent opens the piece it is inside), `#c<n>` pins the turn of
compaction n; search results and the Cost page link with these. `?pin=`, `?unit=`
and `?cursor=` exist for screenshots. The prototype's address `/dev/spend/:harness/:id` redirects
here.

The previous page (a timeline of every turn with Cost, Agents and Context cards in a side panel)
was retired and deleted on 2026-10-03; it is in the git history before that date. The turn view of the spend graph (the sessions' turns across, agent work as bars under the
turn that launched it, the context along the path to the session in focus) was replaced by the time
view and deleted on 2026-10-25.

### The rail's groupings (added 2026-10-28, location keys 2026-11-07)

The rail's switch is a picker (a native menu: five choices do not fit 240px as a segmented
control): **Directory** (the start directory, as before), **Checkout**, **Repository**, **Remote**
and **Beads** (`group=dir|checkout|repo|remote|bead` in the URL; `dir` is the default and is left
out; switching clears the rail's filters). Directory keeps `/api/projects`, Repository `/api/repos`
and Beads `/api/beads`; Checkout and Remote read `/api/groups?by=`. Every row is the sessions that
count under one primary value (docs/location.md §7): `checkout=Y` or `remote=Z`, with no `touched`.
The group of none (`key: ""`) is the last row, in italics, and selects `-` (`repo=-`, `checkout=-`,
`remote=-`).

Repository lists each repository with its sessions and cost; the selected one opens into its
checkouts (`checkout=`, a linked worktree marked ⌥, a gone one struck through) and branches
(`branch=`, with the cost spent on each). A checkout row of an open repository counts the sessions
of that repository that touched it, so it links `repo=X&checkout=Y&touched=1`. Beads lists the bead
prefixes (merlin for merlin-t8s.48: in practice one project's bead database), the one with the most
recently active session first, each with its sessions and the cost they spent on its beads; picking
one (`bead=merlin`) lists every session that worked on a bead of it, newest first. A single bead
picked elsewhere (`bead=<id>`, a bead and everything below it, from a session's bead tags or the
Session page) shows as a two-line entry (title over id) under its prefix.

Names: a repository's key is a git common dir (`…/acme/.git`), so a name is never cut from a key; the
list shows the API's `name`. Two rows of one list with the same name (two clones, several bare layouts
that each have a checkout `main`) show the fewest trailing directories of their paths that tell them
apart (`acme/main`, `ops/main`); `lib/places.ts` `placeLabels` does it for the rail, the Cost page and
the Session page, and leaves unique names short. Remotes in the rail, the Cost cut and the filter chip show
without their host (`github.com/acme/app` as `acme/app`, a local path as its last two directories;
`remoteLabels`), because a truncated row would read only the shared host; two remotes that would get one
label keep their whole string, and the tooltip and every link hold the whole remote.  The repository chip looks
its name up in `/api/repos` and, until that loads, uses `repoName`, the rule of `repos.Name` in Go.

A grouping filter that the rail does not show (collapsed, or another grouping) is a chip in the
toolbar, with the icon of its kind (repository, checkout, remote). `touched=1` round-trips through the
URL and marks the most specific place chip "+ touched"; the chip's state goes with the filter: clearing
the checkout, remote or repository chip also clears `touched`, so no orphan is left to widen what stays
(`clearPlace` in `features/sessions/model.ts`). An old `worktree=` is not read and is dropped at the
next change. Tree rows show the first two beads their sessions worked on (status dot and id) and how
many more.

## 10. Cost page (`/cost`)

The Overview's scope read as money, in the Overview's frame. One scope, two readings: the Overview reads the work
(sessions, places, time), Cost reads the money (model, price class, agents, compactions, days) of the same scope, so the two
pages never disagree and switching tabs keeps it.

- **Scope**: the URL's `range` (`1d`, `7d`, `30d`), `from` and `to` (a custom range), `by` and `in`, read and written by
  the code the Overview uses (`features/overview/ScopeSlot.tsx`), plus Cost's own `stack` (the chart's toggle). **Cost
  has no search**: its header row (the same `ScopeBar` as the Overview's, section 10b) holds the range capsule and the
  `in` chip, and nothing is in the top bar; `q` is not sent and is dropped from Cost's URL (the Overview keeps its own, and its tab
  restores the last one). The data is `GET /api/cost` with `since`, `until` (the scope's local days), `place` (`by`
  when `in` is set) and `in` ([api.md](api.md)). An old address is rewritten with `replace`: `project=X` is
  `by=dir&in=X`, `range=90d` and `range=all` are `from` and `to` (all: from the first day with spend to today), the
  cuts (`repocut`, `beadcut`) go.
- **Frame**: the Overview's. The sidebar (`features/overview/Sidebar.tsx`, shared: the same tree from the scope's
  lanes, the same Organise by, collapse and selection: a click selects, a click on the selected line clears, each a
  history entry) is where the selection lives; then one white pane, edge to edge, that scrolls inside itself (the
  document never scrolls). Its sections are separated by the Overview's hairline and labelled in its column-header style
  (small, uppercase, muted).
- **The key lives in the legend panel** (section 7), the **Cost** tab, not under the chart. Under a heading naming the
  stack in view (By model, Who, Price class, Tier, Depth, Compactions; it follows the switch) it lists the
  categories with their swatches, the top of the bars first so the list reads like the bars, a muted second line
  where the name does not say enough (price classes, tiers, depth bands); then the marks that apply: the overhead
  hatch ("Not in any session's messages") and, on Compactions, the two dots (muted: a day with compactions; red: one
  ran cold). Under the chart stay only the grain ("One bar per 3 hours; a click selects its day", "One bar per
  week") and the compaction sentence. The tables' swatch headers (Who × Tier, Who × Depth) and the Limits section stay
  in the pane.
- **Headline strip**, no caption (the header row's range capsule and the sidebar already say what the scope is): the total
  large, the change against the same number of days just before the window ("+34% on the 30 days before", the dollars
  on hover; one more `by=model` request for that window, hidden when it spent nothing) and a concentration link, "13
  sessions of 160 are half of it" (the fewest of the selected lanes whose spend makes half of their message spend;
  hidden under 5), to the Overview with the scope sorted by spend.
- **By day** (hour, 3 hours, week: the section is named for its bars): an SVG bar chart over the scope's days.
  **The time axis follows the range** (`grainFor`): up to 2 days one bar per hour, up to 7 days per 3 hours (7 days is
  56 bars), up to 14 days per 6 hours, up to 120 days per day, beyond that per Monday-start week. Hour bars come from
  `by=hour` (summed client-side into 3 or 6 hours, aligned to the clock, so a 23- or 25-hour day still has its 24
  clock hours), days and weeks from `by=day`. Labels: hours as `14:00` and, at midnight, the day (`Fri 13`, with a
  hairline through the plot); days as the Overview's timeline writes them (`Fri 16`); weeks by their first day (`14
  Sep`). The hover names the bar ("Fri 13, 14:00–17:00"). A click selects the days: an hour bar selects its day.
  The bars are stacked by model (`split=model`), the top eight models coloured
  and the rest grouped as "other"; hovering a bar lists that day's split. A switch at the right of the section header
  changes the stack (URL `stack=model|who|class|tier|depth|compaction`) to **Who** (`split=agent`: main thread, series-1,
  and sub-agents, series-2, as the Session page's kind colours; spend no message carries last, grey), **price class**
  (`split=class`: cache reads, cache writes, output, uncached input), **Tier** (`split=model` grouped by `tierOf`
  with the price table: heavy at the bottom in `--series-4`, mid 58 % and light 28 % of it, unpriced grey, as the
  Session page's tier ramp; `(overhead)` stays the hatch), **Depth** (`split=depth`: the context each call carried,
  four bands bottom up `<100k`, `100–200k`, `200–500k`, `500k+` in one sienna ramp, `(overhead)` the hatch) or to
  **compactions** (`stack=compaction`), which keeps the axis and the bars of the other stacks (the day's spend) and
  draws each bar empty, a faint fill and an outline, with only what the compaction calls cost coloured at its bottom
  (cold in red, warm in amber, at least 2 px) and a dot above each bar that has compactions (red when one
  was cold); the tooltip gives the day's total, the compaction cost and its calls. Under the chart, whatever the
  stack, one line: "28 compactions, ~$12.76, 9 of them cold. With a warm cache every time: ~$6.44." (the explanation
  on hover; the estimate is not part of the spend). A click on a bar sets the custom range to that day (remembered
  like a drag): the scope narrows for both pages. An old `stack=source` falls back to the model stack.
- **Colours** (`lib/palette.ts`, shared; the Session page can import it later): a model is coloured by family and
  version, never by rank, so it looks the same on every scope and page: Opus blue, Sonnet orange, Haiku teal, Fable
  violet, GPT astra / sol / luna green / gold / steel (`--model-*`), unknown grey; the newest known version of a family
  is the full hue, the next 65 % and older ones 40 % (mixed into the surface). Stacks run heavy to light, bottom up. The
  price classes keep the Session page's hues (output violet, cache read teal, cache write orange, uncached input
  grey, `(unsplit)` a fainter grey). Pink is the cache miss and no model ever gets it; compactions are amber when warm
  and red when cold; `(overhead)` is the hatch. Depth is one sequential ramp of `--depth` (sienna, a hue no model or
  class uses) mixed into the surface at 22 / 48 / 76 / 100 % for the four bands (`depthColor`).
- **Context depth**, a full-width section under the chart: **Who × Depth** (rows main thread, sub-agents, not split;
  columns `<100k`, `100–200k`, `200–500k`, `500k+`, Overhead as in Who × Tier, Total; `by=agent&split=depth`) and a
  computed sentence: "41% of the spend was in calls carrying 200k or more; sub-agents made 60% of it.", plus, only when
  500k+ is non-zero, "$517 at 500k or more, $464 of it by sub-agents." A call's depth is its input plus cache reads and
  writes; 200k or more is deep.
- **Tables**, a grid of columns separated by vertical hairlines (three when wide, two, then one), each in the
  Overview's table style (uppercase muted header row, tabular figures right-aligned): **Model** (Total and, wide
  enough, a muted ▲/▼ with the percentage against the period before, its dollars on hover; the `(overhead)` row
  explained in a footnote), **Price class** (cache reads, cache writes, output, uncached input, `(unsplit)` last, with
  one computed sentence from the dollars alone), **Kind** and, under it, **Who × Tier** (rows main thread, sub-agents
  and not split; columns heavy, mid, light, the unpriced only when non-zero, and overhead only when the main thread or
  the sub-agents have some (the not-split row is overhead alone, its total says it); dollars from `by=agent&split=model` grouped by tier; one sentence from the figures: "Sub-agents ran on
  heavy models for 52% of their spend; the main thread for 71%."). Both Who tables share `WhoMatrix`: auto layout,
  no wrapping, the Who column at least 6 rem, so "Main thread" is never cut in the narrow third column. The figures are `by=class` and `by=agent`
  ([api.md](api.md)). Every table adds up to the total, and its share bars are a **cascade**: a faint full-width track
  per row, each row's segment starting where the row above ended, so reading down the segments walk once across the
  width (Model rows in the model's colour, Price class in the class's, Kind and Agents in the accent; at least 2
  px; the tables of a grid row share one track width).
- **The sidebar adds up**: under the tree, on Cost only, **Scripted runs** (count muted; nothing selected, the scope
  has any: they are out under a selection, as on the Overview) and **Not in any session** (the scope's `(overhead)`:
  reported spend no message explains), so the tree's rows plus these lines are the headline total to the cent (under
  a selection: the selected place plus its own overhead). A lane's `usd` counts the estimated output of its
  truncated messages (api.md), so nothing else is missing.
- **How these figures are made**, a closed `<details>` at the end of the pane and the one place provenance shows:
  "$273 is what the harnesses reported themselves; $249 Merlin worked out from token counts where they reported
  nothing" (and the harness's own per-call figures where there are any), the backing sentence (exact, partial,
  estimated; unknown, lower bound) and the arithmetic of the sidebar. There is no reported / attributed split anywhere
  else on the page.
- **Limits** under the headline shows qualifying usage windows and refused calls. The table names
  limits, including **Spend cap**, and shows scheduled resets, account lockout episodes, spend and
  the biggest sessions where their window is known. A cap with no known start shows its refusal
  time and scheduled reset separately. Its row has no window link or spend. An account lockout
  says when calls resumed or when the scheduled reset passed. Open lockouts show their status
  and the scheduled reset if known. When several known accounts use the same harness, the table
  labels them Account 1, Account 2 and so on, in first observed order. The unknown group remains
  separate. Window worth compares the same account, limit and observed plan period. Claude
  figures describe what the machine recorded at list prices.
- **A limit window as the scope.** A window with a known start can narrow Cost and Overview to
  its time range, harness and account. Links carry RFC 3339 `from` and `to` instants, a
  `harness`, and an opaque `account` key (or `unknown`). A preset, brush or typed range
  leaves this scope. Cost sends those bounds and selectors on its rollup requests.
- The Overview tab is the way back to the sessions (it keeps the scope); the Overview's footer Spend figure links here with it.
- **Empty**: "Nothing was spent between May 20 and May 29." (the Overview's phrase), with "Clear the selection" when a
  selection emptied it.

## 10a. Bead page (`/bead/:id`)

One bead and what was done to it, from `GET /api/beads/{id}` ([api.md](api.md)). The id is a
bead's id as bd prints it (`acme-k1.2`); an unknown id shows "No such bead" (the API's 404).

- **Header.** Above it the parent chain as links, family root first, parent last. The title is
  the page title with the id under it in mono; a bead with no title shows its id and, when its
  family has a `hint` (from `GET /api/beads`), the hint in muted italics ("in the family ..."). Then
  a status badge (closed green, in progress accent, blocked red), the type, the priority (`P0` is
  most urgent), and, discreetly in the faint colour, `sessions` or `implied` for a bead no export
  has (an export is the usual case and says nothing); the close date and reason when known.
  The children follow as links, each with its status dot.
- **Timeline.** One card per session, in the time order of its first step: the harness badge, the
  session title (a link to the session page), the day and step count. Its rows are time, who
  (`main`, or `worker` with the first characters of the agent's id), the operation as a verb
  (created, claimed, updated, closed, reopened, commented, dependency, viewed), the status it set, and
  the title or the close reason. A `show` row is dimmed; a failed call is struck through and badged
  `failed`, since it is history all the same.
- **Sessions.** Most expensive share first: harness, title (a link), the operations it ran, and its
  share of the session's cost as `<Money>`; a total under two or more.
- **Links in.** A bead id links here from the Cost page's bead and family rows (a family row's key
  is its root) and from the bead chips in the session header (the id; the title still opens the
  Sessions page filtered to the bead).

## 10b. Overview page (`/`)

Where the agents' work went over a day, a week or a month: one full-bleed **table of sessions**, each row a
text line over a small graph of the session's context and the agents it launched, on one shared linear time
axis. Beside it a **sidebar**, the places of those sessions as a file tree, whose selection is the table's
**scope**; under the rows, a **summary** of that scope. Data from `GET /api/overview` ([api.md](api.md));
code in `features/overview/` (epic `merlin-lce`). It is the start page.

There are no group rows. Comparing places is the sidebar's job (every node has its sessions and spend), and
the aggregate of a place is the summary once it is selected: one level up in the tree is the "groups view".
The table only ever lists sessions.

```
 [ 7d ] [ in ~/work x ]            (  search sessions...  )  <- the scope header row
 ORGANISE BY [Folder v] [<]|   START [..-=#=-..] END         FOLDER |   TURNS   AGENTS   SPEND  (sticky)
   ~             95  $342  |-------------------------------------------|----------------------------------
   acme          21  $73   | * bold head  muted description...  ~/acme/web|    22     14   $96.20 (scrolls)
   > api          5  $33   | ..-=#=-..    ..=#=#=..  graph, this column |
 v work/merlin   22  $48   |-------------------------------------------|----------------------------------
   web            9  $20   | ..==##=..  the scope's summed context      |  708  1,139  $353 (sticky)
                           | Sat 7     Sun 8     Mon 9  ... axis       | 102 sessions · 913 scripted runs
```

- **URL**: `range` (`1d`, `7d` default, `30d`: that many whole local days, today included, ending now; the same days the timeline shows and the Cost page counts) or a custom range `from` and `to` (local days,
  `YYYY-MM-DD`, both inclusive; when both are valid and in order they win over `range`, and the presets drop
  them), `by` (the sidebar's key: `dir` default, `checkout`, `repo`, `remote`, `bead`), `in` (the selection), `q` (the
  search), `sort` and `dir`. Nothing else; an old link's `show` is ignored.
- **Scope controls.** The **scope header row** (`ScopeBar`, one component for the Overview and Cost, 48 px, a
  bottom hairline) is at the top of the content area, right of the sidebar and above the list (or Cost's content):
  `[range capsule] [in chip] ······ [search]`. The **search box** is its right end (Overview only: `ScopeBar`'s
  `search` prop; Cost passes none): a rounded 32 px capsule on the grey track holding the magnifier, the input
  (placeholder "Search sessions…") and the `/` hint (the clear button once there is text), taking the free width
  up to 560 px; while the timeline is open it asks for 200 px (the axis grows, the capsule keeping at least 320 px).
  **When the room left for it is under 180 px** (the timeline open in a narrow window, a long `in` chip; measured
  with a `ResizeObserver` on the box's slot, whatever the cause), and it is empty and unfocused, it collapses to a
  round 32 px icon button (title "Search sessions (/)"); with a term (`q`) it never hides: a compact chip holds the
  magnifier, the term (truncated) and a clear ✕. A click on the icon or on the chip's term, or `/`, brings the box
  back, focused (the box then overlays the row's right end, 240 px, as there is no room beside the rest); focusing
  it closes the timeline, as any pointer-down outside the capsule does, so a click or `/` usually leaves room for
  the inline box. Leaving the box (blur) collapses it again if the row is still narrow. Typing is local, the URL
  follows after 200 ms (back / forward update the box), Escape clears, then blurs. Typing never remounts the box:
  `q` filters the rows of the table client-side and does not change what the overview asks for, so the list does
  not empty into the other `ScopeBar` placement (see Overview page). With a session open the row, and with it the
  search, is gone (the head's back button shows the list's term); `/` is registered only while the box is
  mounted, so it does nothing then. The **range capsule** and the **`in` chip** sit in that row. An open session replaces the row with its own head. The capsule
  is 32 px high on the grey track; the axis is open only while the user works the time axis (a preset, Escape or a
  pointer-down outside the capsule closes it); which is which is page state, not URL; widths change in 150 ms.
- **Range capsule**: always `1d | 7d | 30d | Custom`, the active one the white pill. Custom shows its range once
  one is set: `May 20 → 10d` (the first day, then the length in days; `May 20 → 1d` for one day; `May 20, 2025 →
  10d` when the year is not the current one) with a muted `»` that says it opens the timeline. A preset
  applies and closes the axis. Custom, when it is not active and a range is remembered, only applies that range (the `»` says
  "Use May 20 → 10d"); when it is active, or nothing is remembered, a click opens the axis, which fills the slot to
  the right of the segments, taking the row's width; a click while
  it is open closes it, the range staying. A drag on the axis applies on drag end and keeps
  it open. A custom range asks the API for local midnight of `from` to the next local midnight after `to`,
  capped at now; the empty state reads "Nothing ran between May 20 and May 29." (`on May 20` for one day). The
  presets cover the days up to today. The last custom range applied (a drag or a URL with `from` and `to`) is
  **remembered** in `localStorage` (`overview.custom`, `{from, to}`, try/catch; the URL stays the truth). While a
  preset is active the Custom label still reads that range, unpressed and muted. **Custom is one unit, a pill**:
  pressed it is white (`bg-surface`, `outline-line`), unpressed it sits on the grey. A range label has one width
  (`min-width` 13ch, left-aligned), so nothing moves under a drag.
- **`in` chip**: when a place is selected, `in ~/work x` (the display path; x clears) right of the range capsule,
  in the header row (not in the search box).
- **Locator.** The open axis is the range capsule's editor: `[1d 7d 30d | Oct 20 → 10d « [axis ………]]`. The axis has the header row's width,
  less the capsule's segments. It is a strip like the Session page's overview (`features/spend/Overview.tsx`): the whole history
  as whole local days from the first day with spend (`GET /api/cost?by=day`, no bounds) to today, daily spend as
  thin bars in the faint colour on the white pill, a light month axis under it (day numbers too when a day is 16
  px wide), the **brush**: a light accent band centred on the row the bars stand on, no outline, with an accent marker at each end. Drag on the strip to draw a range, drag the brush to move it, drag its edges
  to resize, click the strip to bring the brush there (its length kept); the arrow keys move it a day; a click on a **month's name** on the axis (pointer, underlined on hover, title "Show May 2026") applies exactly that calendar month at once (while the pointer is on the name, that month gets a soft accent wash over the strip's full height, so a stray hover shows what a click would take) (`monthRange`: its first to its last day, the current month ending today, clipped to the strip's first day), updating the URL and the remembered range, with the locator staying open and the brush on that month. The
  brush snaps to whole days, one at least. It starts on the current range (the preset's days when no custom
  range is set). The Custom label follows the drag live; the page applies the range (`from`, `to`) only when
  the drag ends, so a drag does not refetch.
- **Search.** Typing is local and `q` follows after 200 ms (back and forward move the box); `/` focuses it and
  Esc clears, then blurs (neither while a session is open: the box is disabled then). A session matches when the term (trimmed, case-insensitive substring) is in its head
  (name, title, id) or its description texts (recap, first and last prompt), or, for a term of two characters
  or more, when it is among the hits of `/api/search` (full text); until that answers, the local matches show.
  Nothing matching: "No sessions match "term"."
- **Container, full bleed.** The page fills the area under the top bar edge to edge, as tall as the viewport
  (the page itself does not scroll). Beside the sidebar the table has three
  parts: **top, fixed**, the one-line column header; **middle, scrolls**, the rows; **bottom, fixed**, the
  summary. Every part has the same two blocks: the **session column** (takes the width that is left; the plot
  is exactly its inner width, 12 px of padding each side) and the **structured block** (a 1 px rule on its
  left, 12 px padding, then Turns 64, Agents 70, Peak 72, Spend 84, 8 px between). The scrollbar of the
  middle takes width from the rows only, so the header and the summary give up as much (padding right) and the
  columns, the graphs and the axis stay exactly above one another.
- **Row** (one per session in scope). Session column: the text line on top, the graph under it. The text line
  is, from the left: the **harness mark** (`HarnessIcon`, 13 px, vertically centred with the text; its title is
  the harness name), the session's **bold head** (its own name from /rename, else its title, else the first 8
  characters of its id; a link to the Session page) and in muted text the latest recap, else the first prompt,
  else the last prompt, then at the very right the **folder**. Head and description are one run, cut with an
  ellipsis where it reaches the folder (the whole text and the value of the active timeline sort (start, last
  activity or running time) in the `title`). The folder is the session's `dir` as a display path
  (`~/work/merlin/web`; `(none)`, faint, without one), muted `text-meta`, **always printed in full**
  (`shrink-0`): only a path longer than 45 % of the line is capped there and loses its start (`…/merlin/web`, at
  a `/` where possible; `fitTail` measures with the cell's own font on a canvas, and the full text sizes the
  cell, so it grows back when there is room). Its `title` is the real path. A click on the folder **copies the
  resume command** (`resumeCommand(dir, id, harness.resume)`, as the Session page's resume box; `copyText` from
  `ui/controls.tsx`): the title is "Copy: <command>", the text reads "Copied" for 1.2 s, the session does not
  open. A harness with no resume template leaves the folder plain text. Structured block: one line, centred
  vertically in the two-line row: Turns, Agents, Peak and Spend (right-aligned, tabular, `<Money>`; all counts in
  the range). **Peak** is the largest context the session reached, in whole thousands (`262k`, `1.1M` from a million, `peakText`) with a 6 px dot in the span-kind
  colour of the agent that held it (a muted dot when the holder has no span, none for the main thread) and, when
  above $0, the `deepUSD` (spend in calls at 200k or more) under it in small muted type; the figure is body colour at
  200k or more, muted below. Title: "Peak 262k, held by sub-agent \"Explore\" at 10:05 · $31.40 spent in calls at 200k
  or more" ("main thread" when no agent holds it).
- **Click on the row.** A click anywhere on the row (head, description, graph, figures) opens the session whole,
  never a stretch of it: what opens does not depend on where the pointer was. The row's pointer is a pointer; the head
  is the link the keyboard reaches. The folder keeps its own click (it copies), and a click that ends a text selection
  opens nothing. Cmd, ctrl or shift and the middle button open a new tab.
- **Harness mark**: the shared `HarnessIcon` (`ui/harness.tsx`, 13 px in a row), the product's real logo with its path
  data inline: Claude and OpenAI from Simple Icons (CC0), Pi from pi.dev; the marks are the products'
  trademarks, used to name them. Claude's is filled with `--harness-claude`, Codex's with the body colour, Pi's
  keeps its own colours; any other harness gets its first letter in a circle.
- **Header, one 28 px line**, a text line tall. Session column: **`TimelineSort`**, a pictogram of a session
  centred in the cell, and at its right end, over the folders, the sort **FOLDER** (`sort=key`; same caps, size
  and tracking as the other headers, its arrow in a slot to the left of the label). The pictogram is drawn with
  the row graph's own helpers and constants from synthetic slots (`pictoLane`: calls at irregular gaps through
  `heldContext`, so the context holds in narrow per-slot steps and spikes like a real row, a pause that holds as
  idle, the same fills, the thin grey baseline with the session line on it in the lightest weight); up to
  340 px wide, shrinking to a narrower cell, aria-hidden; its baseline is the text baseline of the START and
  END labels. Three sort buttons sit on it: **START** before the drawn session's left end (`sort=start`),
  **END** after its right end (`sort=last`, last activity) and **LENGTH** over the middle, knocked out of the
  drawing (`sort=active`: the slots with a call running times the slot, from the lane's `active`); all three
  start descending. Structured block: **Turns**, **Agents**, **Peak**, **Spend** over their columns on the same line.
  Every sortable header of the block is centred in its cell with an arrow slot of the same width (12 px) on both sides; the
  arrow draws in the left one, so a label does not move when it becomes the sort. A tiny rule (1 px,
  `border-line`, 55 % of the height) stands between adjacent header cells.
- **Sorting.** A click sorts by that column in its own first direction; a click on the active column flips
  it. `sort` is `start`, `last`, `active`, `turns`, `agents`, `peak`, `spend` or `key` (absent: `last`, the last
  activity, newest first; an old `session` reads as `start`); `dir` is `asc` / `desc` (absent: the column's own
  start, descending, but ascending for `key`). Ties by spend, then id (`peak`: by `deepUSD`, spend, id). **FOLDER** (`sort=key`) orders the sessions by their folder line in the
  sidebar's order: segment by segment, case-insensitive (`comparePlace`), so `~/work/merlin` sits right after
  `~/work` and before `~/work/yimple`; no folder last whichever way.
- **Summary** (the footer, sticky). Session column: the scope's **aggregate graph**, the lanes' trimmed
  `context` and `idle` summed into dense arrays (`sumLanes`), drawn as the summed context area over the summed
  idle area on a token scale of its own, with the day lines inside the lifetimes of its sessions (no baseline,
  session line or spine lane), and directly under it the **date axis**. Structured block, centred: on the top
  line the totals of Turns, Agents and Spend of the scope (`totalsOf`) and the largest Peak with the summed `deepUSD` (`depthOf`), under them in small type "102 sessions"
  (its `title` says what the scope is: "25 matching sessions in ~/acme") and, only while there is no search and
  no selection, the scripted runs ("· 913 scripted runs · $5.36", faint).
- **Time axis: linear.** Wall-clock time maps linearly to x over the whole range. Midnight ticks and day
  labels; at `1d`, hour ticks. Every graph uses the same axis and is the width of the session column.
- **Resolution.** The page asks for the slot that gives about one slot per pixel of the plot (`1m` to `1h`);
  the page measures its width before the first paint and asks for nothing until then, so a load makes one request, at the right slot; later resizes follow the width live and the slot once it has held still. One SVG per row. Every session of the range comes
  in one response, so the sidebar's key, the selection and the search work without another request.
- **Row graph**, drawn with the spend graph's constants (`COLOR`, `CTX_FILL`, `WORKFLOW_DASH`, `elbowPath` from
  `features/spend/TimeView.tsx`):
  - **context**: a step area above the baseline, at most 15 px high, filled in the main colour (`CTX_FILL`),
    no outline, on one token scale shared by the session rows;
  - **idle**: where the session is open but paused (the context held through a pause of 5 minutes to an hour,
    the API's `idle`), the same step area in a severely tinted fill (`IDLE_FILL`, 0.2) under the context;
  - a faint **baseline** over the session's lifetime (its start to its last activity, clipped to the range),
    and on it the **session line** where it ran (`active > 0`);
  - **one spine lane**, 7 px under the baseline (omitted when the session launched nothing). Every agent gets a
    thin vertical (0.75 px) from the baseline to the lane at its start, so a burst of spawns reads as a comb. A span whose peak is 200k or more draws its tick at 1.5 px and full opacity.
    Per kind (sub-agent, teammate, fork, workflow dashed) the lives `[start, max(end, start + 10 px)]` are
    merged into runs when they overlap or lie under 4 px apart; a run is the mirrored J, its elbow at the first
    spawn. A forked or continued session is not on the lane: its own row gets a vertical in the main colour
    (`RUN_W`) from the top of the row down to the baseline at its start. A spawn from before the range has no
    vertical and its run starts at the left edge;
  - the day lines, only inside the session's lifetime.
- **Sidebar**: a 260 px column left of the table under the top bar (its own scroll, right border). Its heading
  row is the **Organise by** selector (the shared `Select`: Folder, Worktree, Repo, Remote, Bead; `by`) and a
  collapse button (`PanelLeftClose` / `PanelLeftOpen`); collapsed it is a 37 px strip with the open button. The
  width animates in 150 ms (instantly under reduced motion); the choice is kept in `localStorage`
  (`overview.sidebar`, try/catch). The plot is sized for the final layout, so the graphs do not recompute while
  it slides. Organise by is client-side: every lane carries its value of each key (`dir`, `checkout`, `repo`,
  `remote`), and switching rebuilds the tree from them. **Folder** is the directory the session started in;
  **Worktree** its git checkout; **Repo** its repository (worktrees of one clone merge); **Remote** its origin
  URL (clones of one remote merge); **Bead** the session's bead (below).
  - **The Bead key.** The tree is the bead hierarchy. A session has one bead: the one holding the largest share
    of its bead-attributed cost, ties to the first in sort order (the lane's `bead`, as the `bead` key of
    `/api/groups`; whole session cost, no splitting); sessions on none are `(none)`, so All appears under the
    usual rule. A session's path is `prefix → family root → … ancestors … → the bead` (`beadPath`: the prefix
    from the id, as `beads.Prefix`; the chain from the `beads` map of the response, which stops where a parent
    is not known). The prefixes are the top-level headings (no chevron, always open, even with one child:
    compaction is off for this key). A bead that is a session's bead and the parent of others is one node: its
    sessions count there and its children sit under it. Children are in natural id order (`idLess`, as the
    catalog: `x.2` before `x.10`). A node shows the bead's **title** with the id after it, muted and smaller
    (`merlin-lce`; the id wraps out of sight when it does not fit whole beside the title), the title and id in
    its `title`; a bead without a title (implied by a child's parent link) shows its id; a closed bead is muted
    with a ticked circle (`CircleCheck`; an open one is a `Circle`; a prefix is a folder). `in` is the node's
    path (`merlin/merlin-lce/merlin-lce.10`), matched segment-wise like every key; the chip reads
    `in merlin-lce.10 x`, the title in its tooltip. `sort=key` orders the rows by the tree order of their bead
    path, `(none)` last. The row's folder stays the folder; the row's tooltip names its bead (id and title).
  - **The tree** (`buildPlaceTree`): the places of the sessions the search leaves where they sit in the
    filesystem: dir and worktree at their path, a repository at its working directory (the key without its
    `.git` / `.bare`), a remote as host / owner / name (a local-path remote stays a path). The home is `~`: the
    API has none, so it is inferred from the sessions' folders (`inferHome`: the most common `/Users/<u>` or
    `/home/<u>` prefix); other paths stay absolute. A folder that is no place and has one child merges into it
    (`~/work`, `old/merlin`). Children are ordered by name, case-insensitive, like Finder.
  - **Figures**: sessions and spend summed over the places at or under the node, from the sessions the search
    leaves; they ignore the selection, so the tree does not shrink to it.
  - **(none) and All**: when some sessions have no value for the key, the tree's root is **All** (`HardDrive`,
    "Every place", the figures of everything the search leaves; selecting it clears the selection), with the
    places under it and, as its last child, "(none)" (muted, `FolderX`; its title says which value is
    missing). When there are none, there is no All and no (none): the selection is cleared by a click on the
    selected node or the chip's x.
  - **Headings**: the top-level lines (All when it exists, else the top places) are section headings,
    semibold, always open and with no chevron, like an editor's workspace roots (still clickable to select);
    their children start flush under them, and each level below that indents 12 px with a faint guide line
    through its parent's chevron. What was stored as open or closed for a top-level line does not count. A chevron for a node
    with children; `Folder` / `FolderOpen`, `FolderGit2` for a place in repo, worktree or remote mode, `Globe` for
    a host. The label truncates; `title` is the display path.
  - **The selection is the scope.** A click on a line's label selects it: the table and the summary take only
    the sessions whose place sits **at or under** its path, matched segment-wise on the real path (`underPath`;
    so `~/work` does not take `~/workshop`); `(none)` takes the sessions with no value. A click on the selected
    line, on All or on the chip's x clears it; a chevron only opens or closes. The selected line reads through colour, not
    weight (nothing shifts): the accent at 15% as its background, its label, icon and figures in the accent; All has it when nothing is selected. The selection applies after the search. Nothing under it:
    "Nothing under ~/work in this range." with a "Clear the selection" link.
  - **URL** `in` = the selected node's real path prefix (`-` for (none)). Selecting adds a history entry.
    On a change of Organise by it is kept when some session sits under it in the new key, else dropped
    (`keepSelection`). The selection's ancestors are opened once per selection (`ancestorIds`).
  - **Open and closed**: open by default; the closed folders are kept per key in `localStorage`
    (`overview.tree.<by>`, try/catch). Up / Down move between the buttons; Enter and Space select.
- **Hover** reads the table; the graphs stay `aria-hidden` and `pointer-events: none`.
  - **Row**: the hovered row takes a light background (the text colour at 5 % over the row's own, CSS
    `:hover`).
  - **Day**: the pointer's x over the plot picks the **day** under it (the **hour** when the range is two days
    or less), and the summary's date axis gets a light band for it with its label in the body colour. Nothing
    else is lit.
  - **Sidebar**: the hovered row's place is lit in the tree; when a closed folder hides it, the outermost
    closed folder is marked (`markedNode`).
  - One state (x, place) at table level; rows are memoised and take no hover props. Pure helpers in
    `model.ts`: `bandAt`, `blockWidth`.

### A session in place (added 2026-11-15, `merlin-bj5.2`)

A session opens inside the Overview, in the list it was clicked in. The address is the Overview's plus
`open=<harness>:<id>` (the scope parameters stay as they are); the session's own zoom is `sfrom`/`sto` (the
Overview's `from`/`to` are its scope), and its hash targets (`#t<n>`, `#a<agentId>`, `#c<n>`) work as they did.
A click anywhere on a row opens it on its part in the list's time range (whole when it is inside the range or misses it; see the locator in §9); `sfrom`, `sto` come only from links that carry a stretch (an old `/s/` link), win over that, and are read once on open.
Cost's Limits "biggest sessions" open in the window's scope, sorted by spend. Every open, previous/next and close is
a history entry, so Back is the undo.

- **The main area** (right of the sidebar) shows the focus instead of the table, and the session head replaces the
  scope header row (range capsule, `in` chip); the sidebar and the whole top bar (tabs) stay where they are; the search goes with the row (the head's back button names the list's term). The table stays mounted under it (`visibility: hidden`, laid out, so its width and scroll position
  are where they were): closing gives the list back without a refetch or a jump. **Any scope change closes the
  focus**; with the header row gone, only the sidebar (a place, the Organise-by key) reaches one: the writers of
  those parameters drop `open`, `sfrom`, `sto` (and the development `pin`, `unit`, `cursor`) and the hash
  (`withoutFocus`, `useScope`).
- **The head**, sticky (`SessionHead.tsx`; it shares nothing with the list's row geometry), is the session's own line
  and, under it, the graph's locator. Line 1: `← <context>`, a link back to the list (as ✕; muted, small; tooltip "Back to the list"), where the context
  names the list the session came from: the range as the capsule shows it (`7d`, `Nov 16 → 1d`, a limit window's
  label), then `· in ~/tools` with a folder, then `· "term"` with a search; then the harness mark, the bold title, the
  muted description (it truncates first, then the context's search term and folder), the folder with its copy button
  for the resume command (`FolderCell`), and at the right end the session's **total spend** (its cost summary, not
  the spend in the range; the lane's figure while the detail loads; a fixed-width slot, so paging does not move the
  arrows), the paginator `‹ 12 of 160 ›` (mono count, never truncated) and ✕. ‹ and › walk the table's rows in its current
  sort (`listRows` is the one place both take the ordered list from); at either end the arrow is disabled. A session
  that is not in the list (the scope or the search leaves it out, or an id prefix resolves outside it) says "Not in
  this list" and has no arrows. Keys: `[` and `]`, and `Esc` closes, after the graph's own Esc has taken back a
  pinned turn (one Esc, one thing); none of them while a field has focus. The previous and next sessions' details are
  prefetched once the current one has loaded. Line 2: the **locator** (the whole session on the distorted axis, with
  its brush; `spend/Overview.tsx`), the full width of the head with the body's 16 px side padding, so that it lines up
  with the main graph below. The graph owns the window; it draws the locator into the head's slot (a portal, the
  `locatorHost` prop of `SessionView` and `SpendGraph`), so it stays pinned while the body scrolls. The slot keeps its
  height while the session loads, so the head does not jump when it arrives.
- **Frame.** The body uses the frame of the Overview and Cost, not cards: full-bleed sections, each ending in a
  hairline, each with a small uppercase heading row (`FrameSection` in `ui/layout.tsx`, which Cost's sections use
  too) and its content padded under it. **Spend** carries the locator's "Showing ... Latest All" at the right of its heading
  row (a portal from the strip into the heading; the strip itself is in the head); its detail graph comes next, then the spend bars and
  associated notes. The **turn or agent** section follows it with its own
  heading row (name, time, duration; ‹ › ✕ at the right).
- **The zoom never writes the address.** Drag, click, Latest, All and the keys change state only: no URL
  change, no history entry. `sfrom`/`sto` come in from links (an old `/s/` link) and are
  read once, when the session opens. A pinned turn (`#t<n>`) is read from the hash on open and on a later hash
  change; pinning in the page does not write it.
  A window whose right edge is at the session's end follows the end as a live session grows; one pulled back
  from the end stays where it is.
- **Body**: the session's graph with its key in the Legend panel's Graph tab (the Overview's list fills no tab), and
  the box for the pinned turn or piece of agent work under it (section 9). The zoom window is the user's: toggling the panel resizes the plot and keeps the window
  in time. The graph's vertical frame (`spend/layout.ts`) is built for the width the plot has with the panel open,
  whether it is or not, so a toggle does not move it; going to another session builds a new one. The scroll
  container has `scrollbar-gutter: stable`. An unknown or ambiguous id shows its message (candidates, "No such
  session") in the focus area, under the head.
- **The old address** `/s/:harness/:id` (and `/dev/spend/…`) redirects, replacing its entry, to the Overview as it was
  last left (`lastOverview()`, without a session) with `open=` and the hash; its `from`/`to` become `sfrom`/`sto`,
  `pin`, `unit` and `cursor` are carried. Nothing else is special-cased: Moments, the Bead page and search keep
  linking to `/s/…`.
- Code: `features/overview/focus.ts` (pure: the address, the redirect target, the position in the list, the
  "outside this range" line), `RowParts.tsx` (the row's parts), `SessionFocus.tsx`, `SessionView.tsx` (the graph and the pinned box), `TurnBox.tsx`, `thread.ts`.

### Limit windows (added 2026-11-15, `merlin-6py`)

A known limit window is a custom scope with exact instants, a harness and an account.
An unknown window length has no scope link.

- **Refusal ticks.** Each refused call gets a red tick on its session row, as space allows.
  Scripted refusals have no individual session row.
- **Interruption bands.** Overview and session graphs use the episodes in `/api/limits`.
  A row shows the bands for its own account when an interruption touched that session.
  A successful call anywhere ends the observed interruption, while Cost can still show
  that the original account remained locked out. Open episodes are drawn through the
  present with an open marker. The summary strip links to a usage window when the
  corresponding start is known.
  An open session lists no episodes in text: the session graph draws them as blocks, and the
  locator in the head draws the same blocks at half strength (the lockout pattern at opacity 0.5,
  across its breaks, under its content), so the whole session's lockouts are in view; hover names one.
- **Legend.** The Overview and Graph tabs explain the interruption band and refusal tick.

## 11. As built

Where the built UI differs from the sections above:

- Sessions: kind and date range are dropdowns; search ignores the state filter; scripted-run
  lines are hidden while a state or kind filter is active; a running session shows no end-state
  badge (while it runs, the end state only says the last record is not an answer yet).
- Cost: the range defaults to 7 days; selecting a bar narrows the figures to that day or week and
  keeps the chart; "Top sessions" lists sessions last active in the range with their whole cost,
  which is not the same sum as the other cuts, and says so.
- Tooling: React fast refresh in dev (`@vitejs/plugin-react`). `web/dev/shot.sh` is a wrapper over
  `web/dev/shot.ts`, which drives headless Chrome over the DevTools protocol: it captures scrolled
  deep links and pages with the event stream on, and takes `--wait-for <css>`, `--eval <js>`,
  `--delay <ms>`. `?events=off` still stops the event stream, but screenshots no longer need it.
  `MOCK_DAYS=200 bun run mock` stretches the mock's history (default 90).

## 12. Quality bar

- `bun run check` passes (TypeScript strict with no `any` in new code, Biome clean, `bun test`).
- No console errors or React warnings in the views a bead owns.
- Keyboard: every control reachable by Tab with a visible focus ring; the shortcuts above work and
  are not triggered while typing in an input.
- Both themes look right; nothing is legible in only one of them.
- Looked at, not only compiled. `web/dev/shot.sh <url> <out.png> [width] [height]` takes a
  screenshot with headless Chrome; read the PNG and check it in both themes (`?theme=light`,
  `?theme=dark`). State that matters is in the URL (filters, `q`, `#t12`, `#a<id>`), so every state
  worth checking can be reached by a URL.
- Two data sources to check against, never the real `~/.claude`:
  - the **fixture daemon** (section 2): the real API over the synthetic fixtures; small, exact;
  - the **mock API** (`bun run mock`, `web/dev/mock.ts`): generated data at realistic scale: about
    500 sessions over 90 days in a dozen projects, families, every state and flag, scripted lines,
    a session of 600 turns with compactions, a deep agent tree, prompts of 100 kB and long unbroken
    strings, and an event stream that updates a session every few seconds. It is typed by
    `src/api/types.ts`, so it cannot drift from the types the views use.
- With the mock data: no layout breakage on long unbroken strings, no multi-second freezes.
