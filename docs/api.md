# Explorer HTTP API

Read-only JSON over HTTP, plus one Server-Sent Events stream. It is served by `merlin serve`
on the daemon's address (`127.0.0.1:7433` by default) next to `/hook` and `/healthz`, which are
not part of this API. The response types are Go structs in `internal/server/types.go`; the
examples below come from the synthetic fixtures (`testdata/`), trimmed.

## Conventions

- **Methods.** `GET` (and `HEAD`) only. Anything else on `/api/...` is `405` with an `Allow` header.
- **Host guard.** A request whose `Host` header is not `127.0.0.1[:port]` or `localhost[:port]`
  is refused with `403 forbidden_host` (DNS-rebinding guard: the digests contain your prompts).
  No CORS headers are sent, so a web page on another origin cannot read the responses. Reach the
  API through the loopback address, not through a proxy that rewrites `Host`.
- **JSON.** Keys are camelCase. Times are RFC 3339 (`2026-09-16T10:00:00Z`). Money is USD as a
  float. Absent optional fields are omitted; lists are `[]`, never `null`. Responses carry
  `Cache-Control: no-store`.
- **Sessions are keyed by `(harness, id)`**; a key is the object `{"harness": "claude", "id": "..."}`.
  The harnesses are `claude` (Claude Code) and `codex` (Codex CLI).
- **Scripted runs** (`kind: "sdk"`, one-shot `claude -p` calls) are never listed, searched or
  matched by id prefix. They appear only in aggregate: `scripted` lines in the session list, the
  `sdk` row of `/api/cost?by=kind`, `scriptedRuns` in `/api/projects`.
- **Cost.** `bestUSD` is the figure to show and to sum. `flag` says how it is backed:
  `exact` (the harness reported it for the whole session), `partial` (reported, but some owned
  spend lies outside the reported windows and is recomputed from tokens), `estimated` (nothing
  reported; recomputed from tokens), `recorded` (no reported windows, but every priced owned message
  carries the harness's own per-call figure, `Message.recorded`: Pi's catalog estimate, not an
  invoice, so it keeps the `~` marker; a mix of recorded and recomputed messages stays `estimated`), `unknown` (the session has no billed message and no reported
  window, yet a turn or agent shows work: a final text or tool calls; `bestUSD` is 0 but the cost
  is not known to be 0. Show an em dash, not $0; it adds nothing to any total, and `backing.unknown`
  and `merlin doctor` count such sessions). `reportedUSD` + `uncoveredUSD` + `estimatedUncoveredUSD` =
  `bestUSD`. `overheadUSD` is spend the harness reported that no transcript message explains; it
  is a session-level figure and is never spread over agents or turns, except through the
  estimates below. `inheritedUSD` is history copied from another session that the other session
  already paid for; it is not in `bestUSD`.
  `truncatedMessages` (omitted when 0) counts the owned messages the harness wrote down before
  they finished (null `stop_reason` on the last line; mostly sub-agent messages): their output
  tokens are partial, so the recomputed part of the cost is a lower bound when it is non-zero.
  The per-agent counts are in the detail's `digest.agents[].cost.truncatedMessages`.
  **Rate differences.** `windows[].rateDiffUSD` (from the digest) is the part of a window's
  overhead that is the harness charging other rates than Merlin's table, not missing calls;
  `rateDiffUSD` sums it over the windows.
  **Estimates.** A truncated sub-agent message carries `estimatedUSD`, the expected cost of its
  missing output. Inside a window the estimates explain part of the overhead:
  `windows[].estimatedUSD` is their sum capped at the window's `overheadUSD` minus its
  `rateDiffUSD`, and
  `windows[].estimateScale` (set only when the cap applies) is the share of each message's estimate
  counted; `estimatedCoveredUSD` sums them over the windows. Outside every window they are added to
  `bestUSD` as `estimatedUncoveredUSD`, and `/api/cost` counts them as attributed. With
  `?messages=1` each message's `estimatedUSD` is already scaled, so the messages add up to these
  figures.
  `unpricedMessages` (omitted when 0) counts the owned messages billed on a model with no price;
  they count $0. `lowerBound` (omitted when false) says `bestUSD` itself is a lower bound: an
  unpriced message lies outside every reported window (inside one, the reported total covers it). All three are in the session list's `cost` and on `/api/cost?by=session`
  rows too; `/api/cost`'s `backing.lowerBound` counts the sessions with `lowerBound`.
- **Dates and times** given as parameters are an RFC 3339 time or a date (`2026-09-16`, local
  midnight). A date-only `until` includes that whole day.
- **Errors.** Every non-2xx body has this shape:

```json
{"error": {"code": "invalid_parameter", "message": "limit=\"0\": use a number from 1 to 500"}}
```

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_parameter` | a parameter is malformed or unknown to the endpoint's vocabulary |
| 403 | `forbidden_host` | the Host guard |
| 404 | `not_found` | unknown session or endpoint |
| 405 | `method_not_allowed` | not GET/HEAD |
| 409 | `ambiguous_id` | an id prefix matches several sessions; `error.candidates` lists them |
| 503 | `unavailable` | the daemon has not loaded its catalog yet |

## Route table

| Route | Returns |
|---|---|
| `GET /api/harnesses` | `HarnessList` |
| `GET /api/projects` | `ProjectList` |
| `GET /api/repos` | `RepoList` |
| `GET /api/groups?by=` | `GroupList` |
| `GET /api/beads` | `BeadList` |
| `GET /api/beads/{id}` | `BeadDetail` |
| `GET /api/sessions` | `SessionList` |
| `GET /api/sessions/{harness}/{id}` | `SessionDetail` |
| `GET /api/search?q=` | `SearchResult` |
| `GET /api/cost` | `CostTable` |
| `GET /api/moments` | `moments.Report` (experimental) |
| `GET /api/events` | `text/event-stream` |

## GET /api/harnesses

What differs per harness, from the daemon's one list (`cmd/explorer/harnesses.go`). The web UI
reads its product names, badges and resume commands here and keeps none of its own. No parameters.

```json
{
  "harnesses": [
    { "name": "claude", "title": "Claude Code", "resume": "claude --resume {id}" },
    { "name": "codex", "title": "Codex", "resume": "codex resume {id}", "badge": "codex" }
  ]
}
```

`resume` is the command that picks a session up again, with `{id}` for the session id; absent when
the harness has none. `badge` is the short tag shown beside a session; absent for Claude Code. A
harness that has sessions but is not in the list appears with its own name as `title` and `badge`
and no `resume`: nothing is borrowed from another harness. The CLI does the same (`merlin show`
prints no Resume section, JSON has no `resume`).

## GET /api/projects

Projects with session counts, last activity and cost, most recently active first. No parameters.
`cost` is the sum of the best costs of the project's sessions plus its scripted runs. A project is
a directory: sessions of every harness started there are counted together, and `harnesses` lists
which (`harness` and `projectKey` are those of the first in name order). Filtering `/api/sessions`
or `/api/cost` by `project` (the directory) selects them all. `unknownSessions` (omitted when 0)
counts the project's sessions with cost flag `unknown`; when it equals `sessions` and `cost` is 0,
show a dash, not $0.

```json
{
  "projects": [
    {
      "harness": "claude",
      "projectKey": "-home-dev-acme-nest",
      "harnesses": ["claude"],
      "project": "/home/dev/acme/nest",
      "sessions": 2,
      "scriptedRuns": 0,
      "lastActivityAt": "2026-09-22T10:00:14Z",
      "cost": {
        "totalUSD": 0.024600000000000004,
        "reportedUSD": 0,
        "attributedUSD": 0.024600000000000004
      }
    },
    {
      "harness": "claude",
      "projectKey": "-home-dev-acme-misc",
      "harnesses": ["claude"],
      "project": "/home/dev/acme/misc",
      "sessions": 1,
      "scriptedRuns": 0,
      "lastActivityAt": "2026-09-21T10:00:04Z",
      "cost": {
        "totalUSD": 0.0105,
        "reportedUSD": 0,
        "attributedUSD": 0.0105
      }
    }
  ]
}
```

## GET /api/sessions

Session summaries, newest last activity first: no turns, no messages. Meant for the list view.

| Parameter | Meaning |
|---|---|
| `project` | project directory, or the harness's project key (`projects[].project` / `.projectKey`). Exact match; an unknown project gives an empty list |
| `kind` | `interactive` or `background`, comma separated or repeated. `sdk` is a 400 |
| `since`, `until` | bound the session's **last activity**: `since <= lastActivityAt < until` |
| `state` | `running` (busy or idle), `recent` (not running, active in the last 10 minutes), `ended`; comma separated. `busy` and `idle` are accepted too |
| `limit` | page size, 1 to 500, default 50 |
| `cursor` | the `nextCursor` of the previous page |
| `by` | `session` (the default) or `tree`: see [By tree](#by-tree) |
| `repo` | a repository's git common dir (`repos[].repo`, `groups[].key`): the sessions that count under it; `-` for the sessions with none |
| `checkout` | a checkout's directory: the sessions that count under it; `-` for the sessions with none |
| `remote` | a normalised remote (`github.com/acme/app`): the sessions that count under it; `-` for the sessions with none |
| `touched` | `1` or `0` (also `true`, `false`; default 0). With `1`, the most specific of `checkout`, `repo` and `remote` selects every session that touched the value, not only those that count under it: with `checkout` set only it widens, and `repo` and `remote` stay primary (so `repo=X&checkout=Y&touched=1` is the sessions under X that touched Y, as `checkouts[].sessions` counts). `-` still selects the primary none |
| `branch` | a branch name: the sessions with a turn on it (combine with `repo`) |
| `bead` | a bead id: the sessions that worked on it or on a bead below it in its family (any bd call but `show`); or a bead prefix (`merlin`): the sessions that worked on any bead of it |

The grouping filters (`repo`, `checkout`, `remote`, `touched`, `branch`, `bead`) are facets: see
[Groupings](#groupings-get-apirepos-and-get-apibeads) and [Location keys](#location-keys). They
apply to `/api/groups`, `/api/search` and `/api/cost` too. The old `worktree=` is gone: use
`checkout=` with `touched=1`.

`total` counts all sessions matching the filters, over all pages. `nextCursor` is set while more
follow; it encodes a position (last activity, key), so paging stays correct when sessions are
added or removed meanwhile. `scripted` holds the per-project, per-day aggregate lines of scripted
runs and is filled on the first page (no `cursor`) only.

`state` in a summary is `busy`, `idle`, `recent` or `ended`. `lineage` is the brief form: the
parent (if the session starts with a copy of another session's history), how many children copied
from it, the family root, whether it is a `leaf` (nobody continues from it), and how many turns are
inherited.

```json
{
  "sessions": [
    {
      "key": {
        "harness": "claude",
        "id": "22222222-0000-4000-8000-000000000002"
      },
      "project": "/home/dev/acme/nest/inner",
      "projectKey": "-home-dev-acme-nest",
      "cwd": "/home/dev/acme/nest/inner",
      "branch": "main",
      "title": "inner session in a nested project directory",
      "kind": "interactive",
      "startedAt": "2026-09-22T10:00:00Z",
      "lastActivityAt": "2026-09-22T10:00:14Z",
      "endState": "clean",
      "state": "ended",
      "turns": 1,
      "humanTurns": 1,
      "lastPrompt": {
        "turn": 0,
        "at": "2026-09-22T10:00:00Z",
        "text": "inner session in a nested project directory",
        "truncated": false
      },
      "agents": 1,
      "cost": {
        "bestUSD": 0.014100000000000001,
        "flag": "estimated",
        "reportedUSD": 0,
        "uncoveredUSD": 0.014100000000000001,
        "overheadUSD": 0,
        "inheritedUSD": 0
      },
      "lineage": {
        "children": 0,
        "root": {
          "harness": "claude",
          "id": "22222222-0000-4000-8000-000000000002"
        },
        "leaf": true,
        "inheritedTurns": 0,
        "firstOwnTurn": 0
      }
    }
  ],
  "total": 34,
  "scripted": [
    {
      "project": "/home/dev/acme/sdk",
      "day": "2026-09-15",
      "count": 1,
      "totalUSD": 0.0139,
      "reportedUSD": 0.0139,
      "attributedUSD": 0
    }
  ],
  "nextCursor": "MjAyNi0wOS0yMlQxMDowMDoxNFp8Y2xhdWRlfDIyMjIyMjIyLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMg"
}
```

### By tree

`?by=tree` lists **trees** instead: a session and every session forked or continued from it (a
family, as `family` in the detail has it). The filters select trees through their members: a tree
is listed when any member matches, and it then holds all its members. Trees come newest last
activity first, where a tree's last activity is its newest member's; ties by root harness and id.
`limit` counts trees, and `nextCursor` (a position: the tree's last activity and root) is only
valid with `by=tree`.

| Field | Meaning |
|---|---|
| `trees[].root` | the family root |
| `trees[].open` | the member to resume: the newest leaf |
| `trees[].lastActivityAt` | the newest last activity of any member |
| `trees[].bestUSD` | the sum of the members' `cost.bestUSD`; each counts only what it owns, so nothing is counted twice |
| `trees[].sessions` | every member's summary (as above), in tree order: a parent before its children, siblings oldest first |
| `total` | trees with a matching member, over all pages |
| `sessions` | sessions in those trees |
| `scripted` | as without `by` (first page only) |

```json
{
  "trees": [
    {
      "root": {"harness": "claude", "id": "13131313-0000-4000-8000-000000000001"},
      "open": {"harness": "claude", "id": "13131313-0000-4000-8000-000000000002"},
      "lastActivityAt": "2026-09-13T10:04:00Z",
      "bestUSD": 0.0412,
      "sessions": [{"key": {"harness": "claude", "id": "13131313-0000-4000-8000-000000000001"}, "…": "…"},
                   {"key": {"harness": "claude", "id": "13131313-0000-4000-8000-000000000002"}, "…": "…"}]
    }
  ],
  "total": 29,
  "sessions": 34,
  "scripted": [],
  "nextCursor": "…"
}
```

### Previews: `humanTurns`, `lastPrompt`, `recap`, `prs`

Every summary (list row, `session-updated` event, `summary` of the detail) carries four more
fields so that a list can show what a session is about without loading it:

- `humanTurns` (int): the digest's `stats.humanTurns`, the turns a person typed: prompts and
  slash or shell commands, abandoned ones excluded. A session can have `humanTurns > 0` and no
  `lastPrompt`, when everything typed was a command.
- `lastPrompt` `{turn, at, text, truncated}`: the last turn whose origin is `human` and that is not
  abandoned; when every human turn is abandoned, the last human turn. `turn` is the turn index
  (`digest.turns[turn]` in the detail), `at` its start. Omitted when the session has no human turn.
- `recap` `{at, text, truncated}`: the last recap. Omitted when the session has none.
- `prs` `[{at, number, url, repository}]`: the pull requests the session created or linked, the
  digest's `prs`. Omitted when there are none.

`text` in both is a **preview**, and this is the one place the API shortens a text: runs of
whitespace are collapsed to one space, the text is trimmed, and it is cut to 300 runes (at a rune
boundary, never inside a character); `truncated` says it was cut. The whole text is in the
detail's `digest` (`turns[].userText`, `recaps[].text`); the stored digests are not touched.

```json
{
  "humanTurns": 4,
  "lastPrompt": {"turn": 5, "at": "2026-09-22T10:41:00Z", "text": "now add the retry to the upload step", "truncated": false},
  "recap": {"at": "2026-09-22T10:40:12Z", "text": "Goal: ship uploads. The retry is in; the tests for it are next.", "truncated": false}
}
```

## GET /api/sessions/{harness}/{id}

Everything about one session in one response. `id` is the full session id or any unique prefix
(`/api/sessions/claude/1616`). A prefix that matches several sessions is `409` with the candidates
(up to 20); no match is `404`. A scripted run is served only to its exact full id.

| Parameter | Meaning |
|---|---|
| `messages` | `1` includes `digest.messages[]`, one entry per billed API call (large). Default: omitted; `messageCount` is always the real count |

Fields: `summary` (the list shape), `cost` (the full breakdown: reported windows, own / covered /
uncovered / overhead / inherited), `lineage` (parent link, child links, root, `inheritedTurns`:
indexes of turns copied from the parent; `firstOwnTurn`: index of the first turn that is not),
`family` (every linked session in tree order, and the `leaves` to resume, newest first) and
`digest` (the stored digest, see `digest-schema.md`).

Each of `cost.windows` carries, beside the harness's figures, `coveredUSD` (what the session's own
messages inside the window add up to) and `overheadUSD` (`totalUSD` − `coveredUSD`, not clamped: what
the harness reported in the window that no message explains, negative when the messages add up to
more). The windows' `overheadUSD` add up to `reportedUSD` − `coveredUSD`; the session's `overheadUSD`
is that, clamped at 0.

```json
{
  "summary": {
    "key": {
      "harness": "claude",
      "id": "16161616-0000-4000-8000-000000000001"
    },
    "project": "/home/dev/acme/coststate",
    "projectKey": "-home-dev-acme-coststate",
    "cwd": "/home/dev/acme/coststate",
    "branch": "main",
    "title": "plan the billing module",
    "kind": "interactive",
    "startedAt": "2026-09-16T10:00:00Z",
    "lastActivityAt": "2026-09-16T11:00:30Z",
    "endState": "clean",
    "state": "ended",
    "turns": 3,
    "humanTurns": 3,
    "lastPrompt": {
      "turn": 2,
      "at": "2026-09-16T11:00:26Z",
      "text": "review the invoice totals",
      "truncated": false
    },
    "agents": 1,
    "cost": {
      "bestUSD": 0.1172,
      "flag": "exact",
      "reportedUSD": 0.1172,
      "uncoveredUSD": 0,
      "overheadUSD": 0.0015000000000000013,
      "inheritedUSD": 0
    },
    "lineage": {
      "children": 0,
      "root": {
        "harness": "claude",
        "id": "16161616-0000-4000-8000-000000000001"
      },
      "leaf": true,
      "inheritedTurns": 0,
      "firstOwnTurn": 0
    }
  },
  "cost": {
    "bestUSD": 0.1172,
    "flag": "exact",
    "reportedUSD": 0.1172,
    "windows": [
      {
        "from": "2026-09-16T10:00:00Z",
        "to": "2026-09-16T11:00:30Z",
        "totalUSD": 0.1172,
        "byModel": {
          "claude-fable-5-1": {
            "inputTokens": 1000,
            "outputTokens": 400,
            "cacheReadTokens": 5000,
            "cacheCreationTokens": 1000,
            "usd": 0.05125
          },
          "claude-haiku-4-5-20251001": {
            "inputTokens": 4000,
            "outputTokens": 200,
            "cacheCreationTokens": 1000,
            "usd": 0.00625
          },
          "claude-opus-5-5": {
            "inputTokens": 1200,
            "outputTokens": 500,
            "cacheReadTokens": 4000,
            "cacheCreationTokens": 4500,
            "usd": 0.0516
          },
          "claude-sonnet-5-5": {
            "inputTokens": 600,
            "outputTokens": 180,
            "cacheReadTokens": 1500,
            "cacheCreationTokens": 1200,
            "usd": 0.0081
          }
        },
        "coveredUSD": 0.1157,
        "overheadUSD": 0.0015000000000000013
      }
    ],
    "ownUSD": 0.1157,
    "coveredUSD": 0.1157,
    "uncoveredUSD": 0,
    "overheadUSD": 0.0015000000000000013,
    "inheritedUSD": 0,
    "ownMessages": 6,
    "inheritedMessages": 0
  },
  "lineage": {
    "children": [],
    "root": {
      "harness": "claude",
      "id": "16161616-0000-4000-8000-000000000001"
    },
    "leaf": true,
    "inheritedTurns": [],
    "firstOwnTurn": 0
  },
  "family": {
    "root": {
      "harness": "claude",
      "id": "16161616-0000-4000-8000-000000000001"
    },
    "members": [
      {
        "key": {
          "harness": "claude",
          "id": "16161616-0000-4000-8000-000000000001"
        },
        "title": "plan the billing module",
        "kind": "interactive",
        "startedAt": "2026-09-16T10:00:00Z",
        "lastActivityAt": "2026-09-16T11:00:30Z",
        "state": "ended",
        "leaf": true,
        "turns": 3,
        "bestUSD": 0.1172
      }
    ],
    "leaves": [
      {
        "harness": "claude",
        "id": "16161616-0000-4000-8000-000000000001"
      }
    ]
  },
  "messageCount": 6,
  "digest": {
    "schemaVersion": 1,
    "parserVersion": 1,
    "source": [
      {
        "path": "projects/-home-dev-acme-coststate/16161616-0000-4000-8000-000000000001.jsonl",
        "size": 0,
        "mtimeNs": 0
      }
    ],
    "harness": "claude",
    "id": "16161616-0000-4000-8000-000000000001",
    "projectKey": "-home-dev-acme-coststate",
    "project": "/home/dev/acme/coststate",
    "cwd": "/home/dev/acme/coststate",
    "cwds": [
      "/home/dev/acme/coststate"
    ],
    "gitBranches": [
      "main"
    ],
    "harnessVersions": [
      "2.1.280"
    ],
    "kind": "interactive",
    "title": "plan the billing module",
    "startedAt": "2026-09-16T10:00:00Z",
    "lastActivityAt": "2026-09-16T11:00:30Z",
    "endState": "clean",
    "lineage": {},
    "stats": {
      "humanTurns": 3,
      "turns": 3,
      "assistantMessages": 6,
      "toolCalls": 2,
      "toolsByName": {
        "Agent": 1,
        "Read": 1
      },
      "linesAdded": 10,
      "linesRemoved": 2
    },
    "cost": {
      "usd": 0.1157,
      "byModel": {
        "claude-fable-5-1": {
          "input": 1000,
          "output": 400,
          "cacheRead": 5000,
          "cacheWrite1h": 1000,
          "usd": 0.05125
        },
        "claude-haiku-4-5-20251001": {
          "input": 3000,
          "output": 100,
          "cacheWrite5m": 1000,
          "usd": 0.00475
        },
        "claude-opus-5-5": {
          "input": 1200,
          "output": 500,
          "cacheRead": 4000,
          "cacheWrite1h": 4500,
          "usd": 0.0516
        },
        "claude-sonnet-5-5": {
          "input": 600,
          "output": 180,
          "cacheRead": 1500,
          "cacheWrite1h": 1200,
          "usd": 0.0081
        }
      }
    },
    "reported": {
      "totalUSD": 0.1172,
      "byModel": {
        "claude-fable-5-1": {
          "inputTokens": 1000,
          "outputTokens": 400,
          "cacheReadTokens": 5000,
          "cacheCreationTokens": 1000,
          "usd": 0.05125
        },
        "claude-haiku-4-5-20251001": {
          "inputTokens": 4000,
          "outputTokens": 200,
          "cacheCreationTokens": 1000,
          "usd": 0.00625
        },
        "claude-opus-5-5": {
          "inputTokens": 1200,
          "outputTokens": 500,
          "cacheReadTokens": 4000,
          "cacheCreationTokens": 4500,
          "usd": 0.0516
        },
        "claude-sonnet-5-5": {
          "inputTokens": 600,
          "outputTokens": 180,
          "cacheReadTokens": 1500,
          "cacheCreationTokens": 1200,
          "usd": 0.0081
        }
      },
      "windows": [
        {
          "from": "2026-09-16T10:00:00Z",
          "to": "2026-09-16T11:00:30Z",
          "totalUSD": 0.1172,
          "byModel": {
            "claude-fable-5-1": {
              "inputTokens": 1000,
              "outputTokens": 400,
              "cacheReadTokens": 5000,
              "cacheCreationTokens": 1000,
              "usd": 0.05125
            },
            "claude-haiku-4-5-20251001": {
              "inputTokens": 4000,
              "outputTokens": 200,
              "cacheCreationTokens": 1000,
              "usd": 0.00625
            },
            "claude-opus-5-5": {
              "inputTokens": 1200,
              "outputTokens": 500,
              "cacheReadTokens": 4000,
              "cacheCreationTokens": 4500,
              "usd": 0.0516
            },
            "claude-sonnet-5-5": {
              "inputTokens": 600,
              "outputTokens": 180,
              "cacheReadTokens": 1500,
              "cacheCreationTokens": 1200,
              "usd": 0.0081
            }
          }
        }
      ]
    },
    "turns": [
      {
        "index": 0,
        "epoch": 0,
        "uuid": "16010000-0000-4000-9000-000000000001",
        "startedAt": "2026-09-16T10:00:00Z",
        "endedAt": "2026-09-16T10:00:08Z",
        "durationMs": 9000,
        "origin": "human",
        "userText": "plan the billing module",
        "finalText": "Plan: invoices, totals, tax.",
        "assistantMessages": 2,
        "toolCalls": 1,
        "toolsByName": {
          "Read": 1
        },
        "contextTokens": 4700,
        "cost": {
          "usd": 0.0516,
          "byModel": {
            "claude-opus-5-5": {
              "input": 1200,
              "output": 500,
              "cacheRead": 4000,
              "cacheWrite1h": 4500,
              "usd": 0.0516
            }
          }
        },
        "costWithAgents": 0.0516
      },
      "..."
    ],
    "agents": [
      {
        "id": "a16e0c0de0000001",
        "kind": "subagent",
        "agentType": "general-purpose",
        "description": "Check tax rules",
        "model": "haiku",
        "parentAgentId": null,
        "spawnTurn": 1,
        "depth": 1,
        "status": "completed",
        "assistantMessages": 1,
        "turns": [
          {
            "index": 0,
            "startedAt": "2026-09-16T11:00:15Z",
            "endedAt": "2026-09-16T11:00:17Z",
            "origin": "spawn",
            "prompt": "List the tax rules in billing.ts.",
            "finalText": "Tax rules: flat 10 percent.",
            "rootTurn": 1,
            "assistantMessages": 1,
            "toolCalls": 0,
            "cost": { "usd": 0.00475 }
          }
        ],
        "cost": {
          "usd": 0.00475,
          "byModel": {
            "claude-haiku-4-5-20251001": {
              "input": 3000,
              "output": 100,
              "cacheWrite5m": 1000,
              "usd": 0.00475
            }
          }
        },
        "subtreeUSD": 0.00475
      }
    ],
    "diagnostics": {}
  }
}
```

A continuation, trimmed to its `lineage` (`claude/13131313-0000-4000-8000-000000000002`: turns 0 and 1
were copied from the parent, its own work starts at turn 2):

```json
{
  "parent": {
    "parent": {
      "harness": "claude",
      "id": "13131313-0000-4000-8000-000000000001"
    },
    "child": {
      "harness": "claude",
      "id": "13131313-0000-4000-8000-000000000002"
    },
    "sharedMessages": 3,
    "sharedTurns": 2,
    "atTurn": 1,
    "explicit": false,
    "kind": "continuation"
  },
  "children": [],
  "root": {
    "harness": "claude",
    "id": "13131313-0000-4000-8000-000000000001"
  },
  "leaf": true,
  "inheritedTurns": [
    0,
    1
  ],
  "firstOwnTurn": 2
}
```

Ambiguous prefix (`409`):

```json
{
  "error": {
    "code": "ambiguous_id",
    "message": "the id prefix matches several sessions; give more characters",
    "candidates": [
      {
        "key": {
          "harness": "claude",
          "id": "19191919-0000-4000-8000-000000000001"
        },
        "title": "add a footer",
        "project": "/home/dev/acme/daybound",
        "lastActivityAt": "2026-09-19T04:05:22Z"
      },
      {
        "key": {
          "harness": "claude",
          "id": "18181818-0000-4000-8000-000000000001"
        },
        "title": "start the feature",
        "project": "/home/dev/acme/cwdchange",
        "lastActivityAt": "2026-09-18T10:00:16Z"
      }
    ]
  }
}
```

## GET /api/search

Where is the session where I asked X: turns, final texts, compaction summaries, titles, project,
cwd and branch containing every term (case-insensitive). Title and prompt hits rank first.

| Parameter | Meaning |
|---|---|
| `q` | required; whitespace separated terms, all of which must occur in one field |
| `kind`, `project`, `since`, `until` | as for `/api/sessions` |
| `limit` | 1 to 500, default 50 |

`root` is the root of the hit's session's tree (the session itself when it has no parent), so
hits can be grouped by tree. `turn` is the turn index for `prompt` and `final` hits, the compaction
index for `compaction`, and `-1` for session-level fields. A turn copied into several sessions is a hit once, in the
session that owns it; `continuedIn` lists the others (family leaves first). `truncated` is true
when more hits exist than `limit`.

```json
{
  "query": "changelog",
  "hits": [
    {
      "session": {
        "harness": "claude",
        "id": "21212121-0000-4000-8000-000000000001"
      },
      "root": {
        "harness": "claude",
        "id": "21212121-0000-4000-8000-000000000001"
      },
      "title": "write the changelog",
      "project": "/home/dev/acme/misc",
      "at": "2026-09-21T10:00:04Z",
      "field": "title",
      "turn": -1,
      "snippet": "write the changelog"
    },
    {
      "session": {
        "harness": "claude",
        "id": "21212121-0000-4000-8000-000000000001"
      },
      "root": {
        "harness": "claude",
        "id": "21212121-0000-4000-8000-000000000001"
      },
      "title": "write the changelog",
      "project": "/home/dev/acme/misc",
      "at": "2026-09-21T10:00:00Z",
      "field": "prompt",
      "turn": 0,
      "snippet": "write the changelog"
    }
  ],
  "truncated": false
}
```

## GET /api/cost

Cost rollups. Totals are the same for every `by`: they add up to the sum of best costs.

| Parameter | Meaning |
|---|---|
| `by` | `project` (default), `dir` (the same as `project`), `day`, `model`, `kind`, `repo`, `checkout`, `remote`, `branch`, `bead`, `family` or `session`. A row of `repo`, `checkout` or `remote` with key `""` is labelled `no repository`, `no checkout` or `no remote` |
| `since`, `until` | for every `by` except `session`: a range of local days (spend is bucketed by day; a time of day is rounded to its day). For `by=session`: bounds on last activity |
| `project`, `repo`, `checkout`, `remote`, `touched`, `branch`, `bead` | as for `/api/sessions` (the same parser reads them) |
| `limit` | cut the rows (1 to 500). Default: none; `by=session` defaults to 100. `total` is not affected; `truncated` says rows were cut |
| `split` | `project`, `model` or `kind`: break every row down by a second dimension (see below). Must differ from `by`; a 400 with `by=session`, with another value (`day` included), or equal to `by` |

Rows are ordered by cost, largest first; `by=day` is chronological. `by=model` has a row
`(overhead)` for reported spend no transcript message explains; `by=kind` has the row `sdk` for
scripted runs; `by=session` lists scripted runs as one `scripted:<project>` row per project.
A `by=session` row also carries `harness`, `project` and `lastActivityAt` (a scripted row only
`project`), so it can be shown and linked without a second request; its cost is the session's
whole best cost, whatever the range.
`backing` counts the sessions in the table by cost flag. `sessions` counts the sessions behind
the figure, scripted runs included. A row's `sessions` (and `sessions`) counts the sessions that
spent something inside the row, so a scripted run that made no API call (it ended before the first
request; it has a reported window of $0 and no messages) is in none of them; `backing.scriptedRuns`
counts every scripted run that started in the range, such runs included. The two figures differ by
exactly those runs: on one real history 2,529 of 3,132 scripted runs had spend, the other 603 none.

```json
{
  "by": "model",
  "rows": [
    {
      "key": "claude-sonnet-5-5",
      "sessions": 35,
      "totalUSD": 0.4949100000000001,
      "reportedUSD": 0.020499999999999997,
      "attributedUSD": 0.47441000000000016
    },
    {
      "key": "claude-opus-5-5",
      "sessions": 2,
      "totalUSD": 0.07680000000000001,
      "reportedUSD": 0.0516,
      "attributedUSD": 0.0252
    },
    {
      "key": "claude-fable-5-1",
      "sessions": 1,
      "totalUSD": 0.05125,
      "reportedUSD": 0.05125,
      "attributedUSD": 0
    }
  ],
  "total": {
    "totalUSD": 0.6307099999999999,
    "reportedUSD": 0.1311,
    "attributedUSD": 0.49961000000000017
  },
  "sessions": 35,
  "backing": {
    "exact": 1,
    "partial": 0,
    "estimated": 33,
    "scriptedRuns": 1
  }
}
```

### Split

With `split`, the response gains `"split": "<dimension>"` and every row carries
`split: [{key, totalUSD, reportedUSD, attributedUSD}]`: its parts, largest `totalUSD` first, ties
by key. The parts add up to the row (to within float rounding, 1e-9), the `(overhead)` model is a
part where it applies, and the row itself is what it is without `split`. `limit` cuts rows, not
parts. Without `split` nothing changes in the response: no `split` key anywhere.

```json
{
  "by": "kind",
  "split": "model",
  "rows": [
    {
      "key": "sdk",
      "label": "sdk (scripted runs)",
      "sessions": 1,
      "totalUSD": 0.0139,
      "reportedUSD": 0.0139,
      "attributedUSD": 0,
      "split": [
        {"key": "claude-sonnet-5-5", "totalUSD": 0.0124, "reportedUSD": 0.0124, "attributedUSD": 0},
        {"key": "(overhead)", "totalUSD": 0.0015, "reportedUSD": 0.0015, "attributedUSD": 0}
      ]
    }
  ],
  "total": {"totalUSD": 0.6307099999999999, "reportedUSD": 0.1311, "attributedUSD": 0.49961000000000017},
  "sessions": 35,
  "backing": {"exact": 1, "partial": 0, "estimated": 33, "scriptedRuns": 1}
}
```

`backing.unknown` (omitted when 0) counts the sessions flagged `unknown`. `backing.recorded` (omitted when 0) counts those flagged `recorded`.

(One row shown; the real response has a row per kind.)

## Groupings: GET /api/repos and GET /api/beads

Besides its project (the directory it started in), a session can be grouped by the repository it
worked in, the branches its turns ran on and the beads it worked on. These are facets: a session's
key stays `(harness, id)` and its `project` the start directory. They come from the repository
lookups and bead databases Merlin keeps ([beads-and-repos.md](beads-and-repos.md)); until those
are known, every session is in no repository and on no bead.

- **Repository** (`summary.repo`): the git common dir its work happened in, by the rule under
  [Location keys](#location-keys). One per session, so a `by=repo` table adds up. A linked worktree
  counts under its main repository. The key is a path inside the repository (`/home/dev/acme/.git`):
  a client must show `name`, never derive a name from the key (the base of the key is `.git`).
- **Branches**: the `gitBranch` of its turns. `by=branch` splits a session's best cost over its
  branches in proportion to the attributed cost of its messages (an agent's messages go with the
  turn that launched it). Row keys are `<repository>#<branch>`.
- **Beads**: the beads named by its bd calls (any but `show`; failed calls and calls copied from
  another session do not count; ids the bead databases do not know, or of another database than
  the call's repository, are dropped). `by=bead` splits a session's best cost over the beads in
  proportion to the attributed cost of the messages spent on each: per thread (the main agent, each
  agent) a bead is worked on from its claim (`--claim`, `--status in_progress`) to its close, or
  from the thread's previous claim or close (or its creation, if later) when it was closed without
  a claim; a message spent while several are worked on is shared evenly; an agent that worked on
  exactly one bead spends everything on it; a thread working on none takes what the thread that
  launched it worked on. The rest is the row with key `""` and label `no bead`. `by=family` groups
  the same by the root of each bead's family (from the database's parent links).

Every grouped table adds up to the same total as `by=project`.

`GET /api/repos` (`RepoList`): `repos[]` with `repo` (the key), `name`, `remote`, `gone`,
`sessions` (not scripted runs), `lastActivityAt`, `cost` (`Money`: their best costs, scripted runs
included), `checkouts[]` (`checkout`, `name`, `worktree` when it is a linked one, `gone`, `sessions`,
`bestUSD`: every checkout of the repository that sessions touched, and the whole cost of those
sessions) and `branches[]` (`name`, `sessions`, `usd`: the share spent on it).
Most recently active first; the group with `repo: ""` (no repository) last.

`GET /api/beads` (`BeadList`, optional `repo=`): `prefixes[]`, the one with the most recently active
session first, each with `prefix` (merlin for merlin-t8s.48), `database`, `sessions` (distinct),
`usd` (the share of their cost spent on its beads), `bestUSD` (their whole cost), `lastActivityAt`
(of the sessions), `issues` and `closed` (its beads in the database) and `families` (those sessions
worked on); `bead=<prefix>` as a filter keeps every session that worked on a bead of the prefix.
`families[]`, most recently worked on first, each
with `hint` (the title of its earliest member that has one, when the root has no title) and `root` (a
`BeadRef`: `id`, `title`, `type`, `status`, `parent`, `root`, `database`, `source`),
`sessions` (distinct), `usd`, `lastActivityAt` (the last bd call), `issues` and `closed` (the
family in the database) and `beads[]` (the root and every member a session worked on, in id order,
each with `sessions`, `usd`, `lastActivityAt`); `databases` is how many bead databases are known.

`BeadRef.database` is the registry key of the bead database: a project id, or `prefix:<name>` for
beads that only sessions' bd calls revealed. `BeadRef.source` says how the bead is known: `export`
(the database's export), `sessions` (a bd call in some session) or `implied` (named only as the
parent of another bead, so it may have no title).

`GET /api/beads/{id}` (`BeadDetail`): one bead, with its family, the sessions that worked on it and
every bd call that named it. 404 `not_found` when no database or session names it.

```json
{
  "id": "acme-a1.1", "title": "Parse the config", "type": "task", "status": "closed",
  "parent": "acme-a1", "root": "acme-a1", "database": "p-acme", "source": "export",
  "priority": 2, "createdAt": "2026-10-01T10:00:00Z", "closedAt": "2026-10-01T10:40:00Z",
  "closeReason": "done", "firstSeen": "2026-10-01T10:01:00Z", "lastSeen": "2026-10-01T10:40:00Z",
  "ancestors": [{ "id": "acme-a1", "title": "Config", "type": "epic", "status": "open",
                  "root": "acme-a1", "database": "p-acme", "source": "export" }],
  "children": [{ "id": "acme-a1.1.1", "title": "Tests", "parent": "acme-a1.1", "root": "acme-a1",
                 "database": "p-acme", "source": "sessions" }],
  "sessions": [{ "harness": "claude", "id": "0f8e…", "title": "Wire up the parser",
                 "project": "/home/dev/acme", "usd": 1.42, "ops": ["claim", "close"] }],
  "timeline": [{ "at": "2026-10-01T10:01:00Z", "harness": "claude", "sessionId": "0f8e…",
                 "agentId": "a1b2", "turn": 3, "agentTurn": 1, "op": "claim",
                 "status": "in_progress", "outcome": "ok", "title": "Parse the config",
                 "reason": "" }]
}
```

`id`, `title`, `type`, `status`, `parent`, `root`, `database` and `source` are the `BeadRef`.
`priority` (0 is most urgent), `createdAt`, `closedAt` and `closeReason` come from the database
export and are left out when unknown. `firstSeen` and `lastSeen` are the first and last bd call that
named the bead. `ancestors[]` is the parent chain (`BeadRef`s), the parent first and the family
root last. `children[]` are the direct children in id order. `sessions[]` are those that ran any bd
call on it but `show`, the largest `usd` first: `harness`, `id`, `title`, `project`, `usd` (its share
of the session's best cost) and `ops` (the bd operations it ran on the bead, in order of first
use). `timeline[]` is every bd call that named it, in time order across sessions and agents: `at`,
`harness`, `sessionId`, `agentId` (empty for the main agent), `turn` and `agentTurn` (when known),
`op`, `status` (the status the call set), `outcome` (`ok` or `failed`; failed calls are history
too), `title` and `reason` (the close reason).

A session summary carries `repo` (`RepoRef`), `checkout`, `remote` and `beads[]` (`id`, `title`,
`status`, `root`; most spent on first). The detail carries `places`: `repo`, `checkout`, `remote`,
`checkouts[]`, `repos[]` (`RepoRef`) and `remotes[]` (every value it touched, sorted),
`branches[]` (`name`, `usd`), `beads[]` (`BeadRef` with `usd` and `ops`, the bd operations it ran)
and `noBeadUSD`.

### Location keys

Design: [location.md](location.md). A session counts under one value per key, so every table adds
up; the other values it touched are listed in its detail.

| Key | Meaning |
|---|---|
| `dir` | the directory it started in (`project`) |
| `checkout` | top of a working tree; none in a bare repository |
| `repo` | the git common dir, the object store (`/home/dev/acme/.git`) |
| `remote` | the normalised origin URL |

The primary rule (location.md §7), over what it did in its own turns and agents' turns, leaving out
copied history: the `repo` with the most file edits, else the most shell commands, else that of the
start directory; the `checkout` the same way inside that repo, else the start directory's if it is in
that repo; the `remote` is the repo's. Edits outrank commands, ties go to the start directory's value
and then to the first in sort order, and a directory in no repository counts for nothing. A session
therefore never has a checkout outside its repo.

`GET /api/groups?by=` (`GroupList`), `by` one of `dir`, `checkout`, `repo`, `remote`, `beadDatabase`,
`prefix`, `family`, `bead`: `groups[]` with `key`, `name` (the display name: `repos.Name` for a repo,
the base name of a directory, the remote itself), `remote`, `gone` (no live entry has this value),
`sessions` (not scripted runs), `lastActivityAt` and `cost` (`Money`, scripted runs included), most
recently active first and the group with `key: ""` last. It takes the filters of `/api/sessions`. A
missing or unknown `by` is a 400 naming all eight values. Two clones of one remote are two groups
under `repo` and one under `remote`.

The four bead keys group sessions by the beads they worked on:

| Key | Group key | Name |
|---|---|---|
| `beadDatabase` | the folded bead database (`BeadRef.database`: a project id, or `prefix:<name>`) | the database's name |
| `prefix` | the id prefix (`acme` for `acme-a1.2`) | the prefix |
| `family` | the id of the root of the bead's family | the root's title, else its `hint` |
| `bead` | the bead id | its title |

A session counts under the one value that holds the largest share of its bead-attributed cost (the
split of `by=bead` under [Groupings](#groupings-get-apirepos-and-get-apibeads)); ties go to the first in sort order.
Sessions that worked on no bead count under key `""`, named `(no bead)`, which comes last. Every
table adds up to the `by=project` total.

## GET /api/moments

Experimental: the moments report ([moments.md](moments.md)), recomputed from every digest on each
request. No parameters.

```json
{
  "now": "…", "windowDays": 28, "sessions": 3419, "scripted": 3133, "since": "…",
  "projects": 41,
  "personas": [{ "id": "karpathy", "name": "Andrej Karpathy", "focus": "Context",
                 "reaction": "👏", "reason": "Keeping up 8 habits: …",
                 "habits": 8, "explored": 1, "unseen": 0, "new": 0 }],
  "moments": [{ "id": "steer-mid-turn", "persona": "karpathy", "title": "Steering mid-turn",
                "what": "…", "try": "…", "status": "habit", "hits": 84, "sessions": 49,
                "weeks": 18, "recentHits": 10, "new": false, "first": "…", "last": "…",
                "examples": [{ "at": "…", "session": { "harness": "claude", "id": "…" },
                               "turn": 3, "note": "sent while the agent was working" }] }],
  "suggestions": [{ "moment": "clean-slate", "reason": "3 sessions went past 40 prompts in one context." }],
  "overYegge": false
}
```

`projects` counts where the interactive sessions worked: a session's repository when it has
one (so its worktrees count once), else the directory it started in. `moments` is in registry
order (Karpathy, Boris, Yegge) and lists every moment, unseen ones
included. `status` is `habit`, `explored` or `unseen`; `examples` are the latest hits, newest
first, at most 3. A note never quotes the session. `suggestions[].reason` is absent when the
moment's symptom did not fire. Clients ignore moment ids they do not know.

## GET /api/events

A Server-Sent Events stream (`Content-Type: text/event-stream`), for live updates without polling.
Use `new EventSource("/api/events")`. The stream starts with `retry: 3000` and a `: connected`
comment, then a `scan-progress` event with the current state.

| Event | When | Data |
|---|---|---|
| `session-updated` | a session's digest was written (new, or changed) | `{"key": {...}, "session": <session summary>}`: the same shape as a row of `/api/sessions` |
| `session-missing` | a session's files are gone (the digest is kept, `sourceMissing` is set) | `{"key": {...}}` |
| `session-state` | a listed session changed between `busy`, `idle`, `recent` and `ended` | `{"key": {...}, "state": "idle", "previous": "busy"}` |
| `scan-progress` | while indexing is under way, when the counters change, and once more when it ends | `{"pending": 20, "seen": 35, "processed": 15, "unchanged": 0, "failed": 0, "missing": 0}` |

```
retry: 3000
: connected

event: scan-progress
data: {"pending":0,"seen":35,"processed":0,"unchanged":35,"failed":0,"missing":0}

event: session-updated
data: {"key":{"harness":"claude","id":"16161616-0000-4000-8000-000000000001"},"session":{...}}

event: session-state
data: {"key":{"harness":"claude","id":"16161616-0000-4000-8000-000000000001"},"state":"ended","previous":"idle"}

: heartbeat
```

- Events of one session within 250 ms are sent once, with the state after the last of them.
- Scripted runs and sessions that failed to build never produce `session-updated`.
- A line starting with `:` (`: heartbeat`, every 15 s) is a comment; ignore it.
- The stream never holds up the indexer: if a client cannot keep up, events are dropped for that
  client, and a write that stalls for 10 s ends its stream. After a reconnect (EventSource does
  it by itself) re-read `/api/sessions` to catch up, since events are not replayed.
- `session-state` comes from looking at the live-session registry and the clock every 2 s, so a
  change shows up within about that long. It also fires for the passing of time alone (`recent`
  to `ended` after 10 minutes of inactivity). Scripted runs never produce it.
- Nothing is sent for the first look after a stream opens: read the states from `/api/sessions`
  (or the events you already have) and apply `session-state` on top. A session first seen later
  is announced by its `session-updated`, not by `session-state`.
- A `session-updated` for the same session in the same tick replaces the `session-state`: the
  summary carries `state`. So a change is announced by one event, never both.
