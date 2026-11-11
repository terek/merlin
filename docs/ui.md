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
| `/` | Sessions | `project`, `state`, `kind`, `q` (search), `since` |
| `/s/:harness/:id` | Session | `#t<index>` pins a turn, `#a<agentId>` opens an agent's work, `#c<index>` pins a compaction's turn |
| `/cost` | Cost | `range` (`7d`, `30d`, `90d`, `all`), `project`, `by` |
| `/bead/:id` | Bead (section 10a) | none |
| `/moments` | Moments (experimental, [moments.md](moments.md)): the card, the personas' reactions, what to try, the moments by status | none (the card's handle is kept in `localStorage`) |
| `/overview` | Overview (experimental, section 10b): every group of sessions over a day, week or month, context above and spend below | `range`, `by`, `sort`, `ctx`, `open` (the opened group) |
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
| Session `endState` | `clean` nothing; `interrupted` red "interrupted"; `mid-turn` amber "stopped mid-turn"; `unknown` nothing |
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
    and mark `['projects']` and `['cost']` stale without refetching hidden queries. In cached
    `['trees', ...]` pages the member is replaced and its tree re-tallied (last activity, cost,
    the member to open); a new session with no parent becomes a new tree. A new member of a tree,
    or a matching session whose tree is not cached, changes which sessions a tree holds, which
    only the daemon knows: the tree lists are invalidated instead.
  - `session-state`: patch the row's `state` in the cached lists and in a cached detail.
  - `session-missing`: invalidate lists (sessions and trees) and that detail.
  - `scan-progress`: kept in a small store read by `useScanProgress()`.
  - `hello` and `update`: the daemon's version and the newer release it did not install, kept in
    the same store (`useVersion()`; `availableToShow` decides whether the top bar offers it).
  - on `open` after an error (a reconnect): invalidate everything, because events are not replayed.
  - `useConnection()` gives `connecting | live | offline` for the indicator in the top bar.
- A row that changed through an event gets the 150 ms highlight.

## 7. Shell

A top bar, 44px: the name "Explorer", the two destinations (Sessions, Cost), and on the right the
update notices (nothing most of the time): "Merlin updated to X · Reload" once the daemon has
replaced itself, and, quieter, a muted link "X available" to that release's page when the daemon
found a newer release and did not install it (an `update` event; the tooltip says `merlin upgrade`
installs it and `merlin autoupgrade` keeps Merlin up to date; hidden while the "updated" notice is
up, and when X is the version the daemon runs), the
scan indicator ("indexing 120 / 3,355" with a thin progress bar while `pending > 0`, otherwise
nothing), the connection state (a dot: live, or "offline, retrying"), and the total spend of the
last 7 days as a quiet link to Cost. `g s` and `g c` switch pages; `/` focuses search on Sessions.

## 8. Sessions page (`/`)

The landing page, and the answer to "where was that session". It lists **trees**, as the Session
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

## 9. Session page (`/s/:harness/:id`)

The page answers "which of my decisions cost the most", for a session and every session forked or
continued from it: they are one tree, and the page is the same whichever member it is opened on.
Code in `features/spend/` (bead `merlin-t8s.34`; the design history is on `merlin-t8s.27`). The
page loads every member of `family.members` with `?messages=1`; dollars are recomputed from the
messages' token counts with prices fitted per model (the web has no price table).

From top to bottom:

- **Header**: state, title, end state; project, branch, started, last activity, wall time, id, then
  a link per PR the session opened or linked (`#12`, opens in a new tab); the
  tree's total (Claude Code's figure for every member) and this session's own share; prompts,
  turns, agents, tool calls, lines added and removed; "fork of" / "continued in" links; a line when
  the messages add up to a different figure than Claude Code reported. Banners when the transcript
  files are gone or the digest could not be built.
- **Resume** box: `cd <cwd> && claude --resume <id>` with a copy button; when the session is not a
  leaf it says so and links the leaves of the family instead. Hidden when the files are gone.
- **Spend graph** (`SpendGraph.tsx` the card, `TimeView.tsx` the plot, numbers in `timeline.ts`;
  bead `merlin-t8s.36`): wall-clock time across, local, so that a stretch of the session can be found
  by when it happened. At the top the **breakdown** of the spend as three bars (below); then a line adding up the compactions, the strip,
  the **readout** above the plot, and the plot. All of that is the card's content, at its full width (the strip and the plot
  measure it), with the plot's **key** under the plot.
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
    (`spendDensity`), a faint tick at each midnight, the date of each day (from `splitDays`: the
    day-of-month, with the month where it changes) where its activity starts, and the pinned turn's
    marker. The **brush** is the window: a highlighted rectangle with a handle at each edge, the rest
    dimmed. Dragging across the strip selects a new range; dragging the window moves it rigidly, its width on the
    strip kept (so over a break its time width changes); dragging a handle resizes it; a click outside the
    window centres it there; a click on a date, or a double-click inside a day, snaps to that day (its
    activity with a pad of 2%, 1 to 30 minutes, never into the next day). ← → on the strip move the
    window by its own width, or to the previous or next day when it is a day; Home and End go to the
    start and end. A window is never narrower than 5 minutes. The parts of the effective window beyond the
    brush, on either side, are drawn as a fainter continuation of the highlight (no handles; the brush itself is still the
    user's window). A line above the strip says what is shown (the effective window: its span, duration
    and spend, as the plot shows them) and what it spent, with **Latest** (the window the page opened on) and **All**. The days are cut each
    night at the idle stretch that covers most of the night's core (00:00–08:00), then of its window
    (18:00–12:00); the time after the last activity counts as such a stretch, so work past midnight
    with nothing after it stays with its evening, and a turn still running is never cut. A part is the
    calendar day its first-to-last activity overlaps most; when two land on one day the first goes back
    to the day it started on (an evening run deep into the night), or, if it started that same day,
    they are one;
  - a session **opens on all of it**; **Latest** goes to the day of the last work episode: an episode runs back from the end of
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
    run the first run's (`tierSegments`, `carrierWeight`). It is never thinned while idle. Each turn has a
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
    it began, or hollow where it was typed while a turn ran (`turn.queued`: it starts no turn and no
    decision, but it steered that turn). From each typed prompt that starts a turn, a bracket rises
    and runs over the row with the total of everything up to the next one (a **decision**); and the
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
    runs along it over the agent's life, from its first launch to its last activity. It is in the
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
    two turns it reads "between turns 0 and 1: main agent idle 38 min" and pins nothing. A click
    pins the turn or selects the piece of work; arrow keys move by turn.
- **What is pinned, in the graph and below it**: each panel under the graph wears the graph's mark
  for what it opens (`marks.tsx`), so that the two can be matched at a glance:
  - the pinned turn's **decision**: its bracket turns into a thick accent line, and its turns are
    lightly tinted across the session's rows. The decision panel has the same thick line along its
    top, its title bar the same light tint, and a small bracket before its title; in "Your most
    expensive decisions" the decision's row has that line and tint too;
  - the **pinned turn**: tinted on its row with a marker over it. The turn card's title bar has the
    tint and the marker; in the decision panel, its step is tinted;
  - the **selected piece of work**: its frame's top is drawn heavy over it. Under the turn card it
    opens with a title bar that is that box (tint, outline, dashed for a workflow, notched for a
    fork), and its row in the lists is boxed the same way. Agent icons on the page take their kind's
    colour.
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
- **Decision panel**: the pinned turn's decision, its total split by who, then every step and every
  piece of agent work in it, most expensive first, and the compactions after its turns. A decision
  is only "everything between two typed prompts": work an earlier prompt asked for is counted where
  it ran, and the page says so rather than claiming the prompt caused it.
- **Turn card**: the pinned turn's prompt (machine-delivered messages parsed, `lib/inbox.ts`), the
  prompts typed or delivered while it ran, the reply, the compaction after it (`lib/compaction.ts`),
  what the main agent paid for by token class, its cache misses in words, the work launched in it
  and the reports that came in; a selected piece of work opens under it with what it was asked,
  what it paid for and the agent's detail (`features/agents/AgentDetail`).
- **Your most expensive decisions**: the top ten of the tree, always shown; a click pins the
  decision and scrolls back to the graph.
- **Sessions in this tree** (more than one member): title, relation, time, cost, "resume here" on
  the leaves. **Diagnostics**, collapsed.

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
label keep their whole string, and the tooltip and every link hold the whole remote. The Session page
header shows remotes whole. The repository chip looks
its name up in `/api/repos` and, until that loads, uses `repoName`, the rule of `repos.Name` in Go.

A grouping filter that the rail does not show (collapsed, or another grouping) is a chip in the
toolbar, with the icon of its kind (repository, checkout, remote). `touched=1` round-trips through the
URL and marks the most specific place chip "+ touched"; the chip's state goes with the filter: clearing
the checkout, remote or repository chip also clears `touched`, so no orphan is left to widen what stays
(`clearPlace` in `features/sessions/model.ts`). An old `worktree=` is not read and is dropped at the
next change. Tree rows show the first two beads their sessions worked on (status dot and id) and how
many more.

The Session page header has a line for where the session worked (`places`): the checkout, repository
and remote it counts under, then "also" and the other values it touched (three, then "+N more"), each
linking to the Sessions page grouped by it with `touched=1` so the session you came from is in the
list; then its branches with their cost when there are several, and its beads (six, then "more") with
the cost spent on each and "no bead" for the rest.

## 10. Cost page (`/cost`)

- **Controls**: range (`7d`, `30d`, `90d`, `all`), project (from `/api/projects`).
- **Headline**: total for the range; reported versus attributed as a `Bar` with both figures; a
  sentence on backing ("69 sessions exact, 5 partial, 149 estimated, 3,132 scripted runs"); a line
  on the compaction calls of the range, with what a warm cache every time would have cost.
- **By day**: an SVG bar chart, one bar per local day, stacked by model (`by=day&split=model`),
  the top five models coloured and the rest grouped as "other"; hovering a bar lists that day's
  split. A toggle switches the stack to reported / attributed, or to **compactions**
  (`stack=compaction`): the estimated compaction calls on their own, each bar the warm-cache price
  (grey) with the extra a cold cache cost on top (red) and the number of cold calls over it, and a
  paragraph under the chart that says what makes a compaction cold. The estimate is not part of the
  spend, so it never shares a bar with it.
- **Tables**, each a `DataTable` sorted by cost with a share bar: by project, by model (with the
  `(overhead)` row explained in a footnote), by kind.
- **Top sessions** (`by=session`, limit 50): title, project, last activity, compaction calls ("1 cold
  · ~$3.48"), cost with flag, linking
  to the session. Scripted runs are the `scripted:<project>` rows, not links.
- **By repository** (repository, checkout, remote or branch, `repocut=checkout|remote|branch`, the
  repository cut by default; the old `repocut=branch` URLs work) and **By bead** (family or bead,
  `beadcut=bead`), limit 30 each, with a footnote saying how a session's cost is split. A row opens
  the Sessions page grouped and filtered to it: a repository, checkout or remote row counts primary
  values, so it links `group=…&repo|checkout|remote=<key>` with no `touched` (none is `-`); two rows
  with one name show enough of their path to tell them apart.
- Selecting a project row sets the `project` filter; selecting a day bar narrows the range to it.

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

## 10b. Overview page (`/overview`, experimental)

Where the agents' work went over a day, a week or a month, drawn as the Session page's spend graph
zoomed out: a **timeline**, one row per group of sessions (a project, by default), **context above
each row's baseline and spend below it**, and the work the sessions launched hanging under it as
the graph's spines. A row that carried a lot is tall above its line, a row that spent a lot is deep
below it, and both are on scales every row shares, so rows compare at a glance. Data from
`GET /api/overview` ([api.md](api.md)); code in `features/overview/` (epic `merlin-lce`). A separate
route while it is an experiment: if it works, it becomes the landing page and the Cost page's day
chart and project table go.

Revised 2026-11-11 after the first look (Zsolt): the axis is linear time, nights and empty days
included; the detail is the Session page's; agents and forks use the Session page's spines.

```
 [1d 7d 30d]  group [Project ▾]  sort [Spend ▾]  context [Sum | Peak]
                 Mon 3         Tue 4         Wed 5         Thu 6
 dev/merlin      ▁▃▅▇▆▃                ▂▅▇█▇▅                 context above (held, step area)
 $172 · 12       ━━━━━━━━━━            ━━━━━━━━━━             session line where sessions ran
 max $96         ||| ||||              |||| |||               spend below, one line per slot
                  ╰──── Explore ×4       ●╰────── fork         spines: agents, forks, continuations
 › acme/api      (thinner: it carried and spent less)
   429 scripted runs · $9.80   ▏▏ ▏▏▏ ▏                        one faint row, spend only
```

- **Toolbar** (state in the URL): range `1d`, `7d` (default), `30d`, ending now; group by `dir`
  (Project), `checkout`, `repo`, `remote`; sort by spend (default), sessions, priciest session, last
  activity; context `sum` (default: what the group carried) or `peak` (its deepest session).
- **Label column** (fixed width, left, HTML): the group's name, its spend in the range as
  `<Money>`, its session count, and its priciest session's spend ("max $96"). A chevron opens the
  group.
- **Time axis: linear.** Wall-clock time maps linearly to x over the whole range: nights, weekends
  and empty days take their real width. There are no breaks. Midnight ticks and day labels; at
  `1d`, hour ticks. Every row uses the same axis.
- **Resolution: the Session page's.** The page asks for the slot that gives about one slot per
  pixel of plot width (`1m` to `1h`, see the API), so the drawing has the spend graph's grain, not
  a bar chart's. **One SVG per row** (label column outside it), all of the same width.
- Per row, drawn with the spend graph's own constants and helpers, imported from
  `features/spend/TimeView.tsx` (`COLOR`, `CTX_FILL`, `CTX_LINE`, `SPEND_COLOR`, `COMPACT_MARK`,
  `markColor`, `ELBOW_R`, `SPINE_OPACITY`, `SPINE_W`, `elbowPath`, `BranchNode`, `NODE_R`), so the
  two pages look like one language and a change there changes both:
  - above the baseline, the **context** as a step area in the main colour (`CTX_FILL`, outline
    `CTX_LINE`), one token scale for all rows. Context is held between calls as on the Session page
    (a call's context lasts until the next call, unless the pause is longer than 5 minutes), so a
    working session is a continuous area, not a comb;
  - below it, the **spend** per slot as 1 px lines in `SPEND_COLOR`, one dollar scale for all rows;
  - on it, the **session line** in the main colour wherever a session of the group was running
    (`active > 0`), 1 px, 2 px with two at once, 3.5 px with three or more;
  - **compactions** as the spend graph marks them: a vertical from the context down to the
    baseline, `markColor` (red cold, amber warm, grey unknown), `COMPACT_MARK` widths and dashes;
  - under the spend, the **spines** of the work the group's sessions launched (`spans` from the
    API), packed into thin sub-lanes so that overlapping ones do not collide: each is the spend
    graph's spine, a vertical from the row's baseline at the launch down to its sub-lane, the
    rounded elbow (`elbowPath`), and a horizontal along the sub-lane over its life, in its kind's
    colour (`COLOR`: sub-agent, teammate, fork, workflow dashed). The horizontal is at least 10 px
    long so the shape reads at any zoom, and longer when the life is. A span of several agents
    (`n > 1`, a swarm) is one spine labelled `×n` where there is room. A **forked or continued
    session** is the main colour's spine with `BranchNode` at its start: a dot for a fork, a ring
    for a continuation. Vertical parts are faint (`SPINE_OPACITY`), horizontals at full strength,
    as on the Session page;
  Each row is as tall as its own peak needs on the shared scales plus its sub-lanes (a minimum keeps
  a quiet row's line readable), so the big projects are visibly big; the shared scales are labelled
  once, at the top row.
- **Hover** fills a readout of fixed height above the plot (nothing under the pointer moves): the
  time under the pointer, the group, the slot's spend, sessions running, context sum and peak; over
  a spine, what it stands for (kind, `n`, its session's title, start and length). When the pointer
  leaves the plot the readout goes back to its hint. Nothing else is printed on the page.
- **Click** on a row lists, below the plot, that group's sessions active at that time (from
  `lanes`): title as a link to the Session page, its spend in the slot and in the range, last
  activity. A dragged range on a row does the same for the range. A click on a spine lists its
  session.
- **Open a group**: its sessions as lanes under it, the same grammar on the same scales, each its
  own SVG; a lane's label is the session's title and links to its Session page.
- **Scripted runs**: one faint row at the end, spend only, not openable.

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
