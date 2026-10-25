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
| Markdown | `react-markdown` + `remark-gfm`, for assistant texts only. No raw HTML, no syntax highlighter |
| Charts | hand-written SVG. No chart library |
| Tests | `bun test` for pure logic in `src/lib` and `src/api`; `tsc --noEmit`; Biome (root `biome.json`) |

Do not add other dependencies. If one seems needed, say so in the bead and stop short of adding it.

Nothing is loaded from the network: no web fonts, no CDN, no analytics. The page is served with
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'`. Texts from sessions are untrusted input: render them as text or through
`react-markdown`, never with `dangerouslySetInnerHTML`.

## 2. Layout of `explorer/web`

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
```

A feature directory is owned by one bead. `api/`, `lib/` and `ui/` are shared: additive changes
only once the scaffold is in, and say so in the closing note.

The build output goes to `explorer/internal/webui/dist` (git-ignored) and is embedded with
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
Run the daemon against the fixtures, never against the real `~/.claude`:

```
CLAUDE_CONFIG_DIR=$PWD/testdata/claude MERLIN_HOME=<a scratch dir> \
  ./bin/merlin serve --no-hooks --port <your port>
```

## 3. Routes

| Route | Page | State kept in the URL |
|---|---|---|
| `/` | Sessions | `project`, `state`, `kind`, `q` (search), `since` |
| `/s/:harness/:id` | Session | `#t<index>` pins a turn, `#a<agentId>` opens an agent's work, `#c<index>` pins a compaction's turn |
| `/cost` | Cost | `range` (`7d`, `30d`, `90d`, `all`), `project`, `by` |
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
  nothing for this session".
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
| `PlainText` | prompt text: `white-space: pre-wrap`, long lines wrap, no markdown |
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
  - on `open` after an error (a reconnect): invalidate everything, because events are not replayed.
  - `useConnection()` gives `connecting | live | offline` for the indicator in the top bar.
- A row that changed through an event gets the 150 ms highlight.

## 7. Shell

A top bar, 44px: the name "Explorer", the two destinations (Sessions, Cost), and on the right the
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
  1. state dot (the busiest member's), title, end-state badge, "codex", background and "no source" badges,
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

- **Header**: state, title, end state; project, branch, started, last activity, wall time, id; the
  tree's total (Claude Code's figure for every member) and this session's own share; prompts,
  turns, agents, tool calls, lines added and removed; "fork of" / "continued in" links; a line when
  the messages add up to a different figure than Claude Code reported. Banners when the transcript
  files are gone or the digest could not be built.
- **Resume** box: `cd <cwd> && claude --resume <id>` with a copy button; when the session is not a
  leaf it says so and links the leaves of the family instead. Hidden when the files are gone.
- **Spend graph** (`SpendGraph.tsx` the card, `TimeView.tsx` the plot, numbers in `timeline.ts`;
  bead `merlin-t8s.36`): wall-clock time across, local, so that a stretch of the session can be found
  by when it happened. A legend split by who or by token class, a line adding up the compactions, and
  a readout above the plot of the turn or piece of work under the cursor.
  - stretches longer than 10 minutes in which nothing ran (no call, no turn, no piece of agent work)
    are squeezed into a narrow grey **break** labelled with its length; with more than 12 such
    pauses, only longer ones (20 min, 30 min, 1 h, ... up to 16 h) become breaks. A turn ends at the
    last thing that ran in it (the harness may close a turn hours later, when the session is left);
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
    on one dollar scale for every row, split like the legend. A row pays for its agent's calls, its
    sub-agents' calls and, for a main row, the compaction calls;
  - a diamond is a **cache miss**, on the call that missed: the part of an agent's previous prompt
    that its next message did not read from the cache, written to it again (Claude Code) or charged
    as plain input (Codex, whose cache has no writes). Each miss has a cause: idle longer than the
    cache lifetime (5 minutes, or an hour after one-hour writes; for Codex, whose cache has no fixed
    lifetime, the same 5 minutes), a model switch, fast mode turned on or off (fast calls do not
    share the cache), or no visible cause;
  - a vertical mark is a **compaction**, from its context before down to the baseline: solid red
    when its call ran on a cold cache, dashed amber when warm, grey when the digest has no figure.
    The line above the graph adds them up for the tree, with what a warm cache every time would have
    cost. For Claude Code the figure (`compaction.call`) is an estimate (the harness does not record
    the call), cold means idle longer than the cache lifetime, and it is in no figure on the page;
    for Codex it is the recorded call (`compaction.messageId`), cold when less than half the context
    came from the cache, and already in the figures;
  - on a main row each **turn** is a thick stretch of the baseline from its start to its end, with a
    tick where it starts (the baseline is thin where no turn runs). A turn starts at
    `turn.startedAt` and ends at the last thing that ran in it (a call of the main agent or of any
    agent, or a piece of work starting or ending) up to the harness's `endedAt` and before the next
    turn starts;
  - a main row has a dot on its baseline for every prompt a person typed: at the start of the turn
    it began, or hollow where it was typed while a turn ran (`turn.queued`: it starts no turn and no
    decision, but it steered that turn). From each typed prompt that starts a turn, a bracket rises
    and runs over the row with the total of everything up to the next one (a **decision**); and the
    turn numbers where they fit. A forked or continued session has a main row of its own with only
    its own turns, starting with a line from its parent's row; nothing is merged across session ids;
  - an agent's work is one light frame, in its kind's colour, from the start of its first **piece
    of agent work** to the last call of its last: its start down to the baseline, its top, and a short
    stem at its end, like a decision's bracket turned round (no fill, so the context tint under it
    reads alone; its pieces show in the context, an area while they run, dotted between them). A
    sub-agent solid, a fork with a notch, a workflow dashed, an addressable agent with a dashed
    lifeline along its baseline. The frame carries the agent's name and spend. A piece is one of the
    agent's turns (`agent.turns`): a sub-agent or fork has one, an addressable agent (a Claude Code
    teammate, a Codex agent) one per message or task that set it working again (from a daemon without
    `turns`: one per message it was sent); a workflow run (`digest.workflows`) is one piece with all
    its agents inside. Agents are packed into rows by their whole life (an addressable agent keeps
    its row over its pauses). The rows have no labels: the plot takes the full width, with only the
    context scale to its left, and each agent is named on its frame;
  - the line from the row that sent a piece of work (the main row, or the sender its inbox names;
    none for work the agent's own background tasks woke after it reported) and a dashed line to each
    turn a report of it came in are drawn only for the work in focus: hovered, selected, or launched
    or reported in the turn under the cursor or pinned. An agent's turns are its pieces of work: a
    message from the agent that launched it, or a notification that wakes it after it finished, starts
    a new one (the harness writes these as `isMeta` records with an `origin`);
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
compaction n; search results and the Cost page link with these. `?pin=`, `?unit=`, `?split=class`
and `?cursor=` exist for screenshots. The prototype's address `/dev/spend/:harness/:id` redirects
here.

The previous page (a timeline of every turn with Cost, Agents and Context cards in a side panel)
was retired and deleted on 2026-10-03; it is in the git history before that date. The turn view of the spend graph (the sessions' turns across, agent work as bars under the
turn that launched it, the context along the path to the session in focus) was replaced by the time
view and deleted on 2026-10-25.

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
- Selecting a project row sets the `project` filter; selecting a day bar narrows the range to it.

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
