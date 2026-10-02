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
      session/          SessionPage, header, cost, timeline   (Session bead)
      agents/           AgentTree, AgentDetail                (Agents bead)
      context/          ContextChart                          (Agents bead)
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
| `/s/:harness/:id` | Session | `#t<index>` scrolls to a turn, `#a<agentId>` opens an agent, `#c<index>` a compaction |
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
  `['session', harness, id]`, `['search', q, filters]`, `['cost', params]`. `staleTime` 30 s;
  `refetchOnWindowFocus` on. The session list is an infinite query over `nextCursor`.
- `api/events.tsx`: `EventsProvider` opens one `EventSource('/api/events')` for the app.
  - `session-updated`: replace the matching row in every cached `['sessions', ...]` page (insert
    at the top of unfiltered first pages when it is new), invalidate `['session', harness, id]`,
    and mark `['projects']` and `['cost']` stale without refetching hidden queries.
  - `session-state`: patch the row's `state` in the cached lists and in a cached detail.
  - `session-missing`: invalidate lists and that detail.
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

The landing page, and the answer to "where was that session".

```
┌ top bar ───────────────────────────────────────────────────────────────┐
│ Projects        │ [ search prompts, answers, titles…  / ]  state kind  │
│ All        223  │ ───────────────────────────────────────────────────  │
│ merlin      41  │ Today                                       $41.20   │
│ acme/web    30  │ ● add the footer        acme/web  main  3m  12  $4.10│
│ …               │   "last prompt preview, one line, muted…"            │
│                 │ ○ plan billing          acme/api  feat  1h   3 ~$0.80│
│                 │ Yesterday                                   $12.02   │
│                 │   31 scripted runs · merlin                  $0.42   │
└─────────────────┴──────────────────────────────────────────────────────┘
```

- **Project rail** (240px, collapsible): "All" and each project from `/api/projects`, most recently
  active first: short name, session count, cost. Selecting one sets `project` in the URL.
- **Filters**: state (`All`, `Running`, `Recent`), kind (`interactive`, `background`, both by
  default), and a since preset (`7d`, `30d`, `all`; default all).
- **List**, grouped by local day of last activity, each group headed by the day and the sum of
  its rows' cost. A row, two lines:
  1. state dot, title (or the first line of the last prompt when there is none), end-state badge,
     lineage hint ("fork of …", "continues …", "continued in ›"), then right-aligned: short project,
     branch, relative time, prompts (`humanTurns`), agents (when > 0), cost with its flag.
  2. the last prompt preview (`lastPrompt.text`), one line, muted; when the session has a recap,
     the recap instead, marked with a small "recap" label.
  The whole row is a link to the session. `j` / `k` move the selection, `Enter` opens it.
- **Families.** Sessions of one family that fall in the same day group are drawn together: the
  leaf first, its ancestors indented below it and dimmed. A member in another day group stays
  where its own date puts it, with the hint text.
- **Scripted runs** appear only as aggregate lines at the end of a day group ("31 scripted runs ·
  merlin · $0.42"), not clickable.
- **Paging**: load the next page when the end of the list scrolls into view.
- **Search** (`q` in the URL, debounced 200 ms, at least 2 characters): the list is replaced by
  the hits of `/api/search`, grouped by session in the order the API returns them. A group shows
  the session's title, project and time, then each hit as a line: a label for `field` (`title`,
  `prompt`, `answer`, `summary`, `project`, …), the snippet with the terms highlighted, and for a
  turn hit a link to `/s/…#t<turn>`. `continuedIn` is shown as "also in ›" links. `Esc` clears.

## 9. Session page (`/s/:harness/:id`)

Two columns: the timeline (fluid) and a side panel (380px, sticky) with Cost, Agents and Context.

- **Header**: title; project path and branch; started, last activity, wall time; state and end
  state; counts (prompts, turns, agents, tool calls, lines added / removed). A **resume** box with
  the command `cd <cwd> && claude --resume <id>` and a copy button; when the session is not a leaf
  the box says so and points at the leaves of the family instead. `sourceMissing`: a banner saying
  the transcript files are gone and this digest is what remains.
- **Family strip** (only when the family has more than one member): the tree from `family.members`,
  one line each: title, relation (`fork` / `continuation`), time, cost; the current one marked, the
  leaves marked "resume here".
- **Cost card** (side panel):
  - the best cost, large, with its flag, and one line in words for the flag;
  - a stacked `Bar`: reported (covered), attributed outside the windows, overhead; the same three
    as a small table with dollars, plus `inheritedUSD` shown apart as "inherited, paid by the parent
    session, not counted here";
  - main agent versus sub-agents: two figures and a bar, from `digest.agents[].cost` (attributed);
  - by model, from `digest.cost.byModel`: label, input, output, cache read, cache write, dollars;
    footnote: attributed from token counts;
  - the reported windows (`cost.windows`) as a collapsed list: from, to, dollars.
- **Timeline**: one block per turn, in order.
  - A human turn: gutter in `--human`; index, time, duration; the prompt as `PlainText` clamped to
    6 lines; images count; the final text as `Prose` clamped to 12 lines; a foot line with assistant
    messages, tool calls (top three tool names), files touched (count; the list on expand), context
    size, and on the right the turn's cost and, when agents were spawned, the cost with agents.
  - A turn nobody typed (`command`, `task-notification`, `peer`, `scheduled`, `continuation`, `sdk`)
    is a compact single line with its origin badge, the first line of its text and its cost; it
    expands to the full block. A toggle "prompts only" hides these.
  - Spawned agents of a turn are chips under it (type or name, status, subtree cost); a chip
    selects the agent in the side panel.
  - `abandoned` turns are struck out lightly and labelled "rewound: not on the path that
    continued"; their cost still counts and the label says so.
  - Inherited turns (`lineage.inheritedTurns`) are collapsed into one divider "N turns copied from
    ‹parent title›", expandable; the first own turn is where the page first scrolls to.
  - A **compaction** is a divider between turns (after turn `compaction.turn`): trigger, context
    before → after, duration, and the summary behind "show summary" (`Prose`).
  - `interrupted` turns carry the red badge. The last turn of a `mid-turn` session carries the amber
    one.
  - A turn is addressable (`#t12`), and the block has a "copy link" affordance.
  - Sessions with hundreds of turns must stay smooth: render clamped blocks, and mount `Prose`
    only when a block is near the viewport (an IntersectionObserver is enough; no virtual list).
- **Agents card** (side panel; Agents bead): the tree from `parentAgentId`, each node: kind icon,
  type or name, description, model label, status, own cost and subtree cost with a proportion bar
  against the session's total. Background agents carry a "bg" badge. Agents with `linkage:
  unresolved` are listed apart under "not tied to a spawn". Selecting a node opens **agent detail**
  below the tree: prompt (`PlainText`, clamped), final text (`Prose`, clamped), inbox messages,
  counts, tools by name, its cost by model, and a link to its spawn turn. Compaction calls
  (`kind: compact`) are listed last, quietly: they are cost, not topology.
- **Context chart** (side panel; Agents bead): an SVG sawtooth of `contextTokens` per turn, with a
  vertical marker at each compaction (pre → post). Hovering shows the turn and the size; clicking
  scrolls the timeline to it. Hidden when the session has fewer than 3 turns.
- **Diagnostics** (foot of the side panel, collapsed): source files, harness versions, parser and
  schema version, unknown record types, bad lines, unpriced models, unresolved agents.

## 10. Cost page (`/cost`)

- **Controls**: range (`7d`, `30d`, `90d`, `all`), project (from `/api/projects`).
- **Headline**: total for the range; reported versus attributed as a `Bar` with both figures; a
  sentence on backing ("69 sessions exact, 5 partial, 149 estimated, 3,132 scripted runs").
- **By day**: an SVG bar chart, one bar per local day, stacked by model (`by=day&split=model`),
  the top five models coloured and the rest grouped as "other"; hovering a bar lists that day's
  split. A toggle switches the stack to reported / attributed.
- **Tables**, each a `DataTable` sorted by cost with a share bar: by project, by model (with the
  `(overhead)` row explained in a footnote), by kind.
- **Top sessions** (`by=session`, limit 50): title, project, last activity, cost with flag, linking
  to the session. Scripted runs are the `scripted:<project>` rows, not links.
- Selecting a project row sets the `project` filter; selecting a day bar narrows the range to it.

## 11. As built

Where the built UI differs from the sections above:

- Sessions: kind and date range are dropdowns; search ignores the state filter; scripted-run
  lines are hidden while a state or kind filter is active; a running session shows no end-state
  badge (while it runs, the end state only says the last record is not an answer yet).
- Session: the page is capped at 1500px and centred; without a hash, an inherited session opens at
  the "N turns copied" divider; the family strip names the relation only for the current session's
  neighbours. Prompts a machine delivered (task notifications, teammate messages, idle
  notifications) arrive from the API already parsed, as `turn.inbox`; each message shows its sender
  or kind, summary and text, and its label selects the agent it came from (`src/lib/inbox.ts`).
  `src/lib/wrapper.ts` unwraps the markup only for digests written before the API did.
- Agents card: a row's bar is measured against the attributed cost of all agents, not of the
  session; runs of more than eight siblings of one type fold into one line.
- Context chart: only the compaction nearest the cursor is labelled.
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
