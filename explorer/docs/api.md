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
  Today the only harness is `claude`.
- **Scripted runs** (`kind: "sdk"`, one-shot `claude -p` calls) are never listed, searched or
  matched by id prefix. They appear only in aggregate: `scripted` lines in the session list, the
  `sdk` row of `/api/cost?by=kind`, `scriptedRuns` in `/api/projects`.
- **Cost.** `bestUSD` is the figure to show and to sum. `flag` says how it is backed:
  `exact` (the harness reported it for the whole session), `partial` (reported, but some owned
  spend lies outside the reported windows and is recomputed from tokens), `estimated` (nothing
  reported; recomputed from tokens). `reportedUSD` + `uncoveredUSD` = `bestUSD`. `overheadUSD`
  is spend the harness reported that no transcript message explains; it is a session-level figure
  and is never spread over agents or turns. `inheritedUSD` is history copied from another session
  that the other session already paid for; it is not in `bestUSD`.
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
| `GET /api/projects` | `ProjectList` |
| `GET /api/sessions` | `SessionList` |
| `GET /api/sessions/{harness}/{id}` | `SessionDetail` |
| `GET /api/search?q=` | `SearchResult` |
| `GET /api/cost` | `CostTable` |
| `GET /api/events` | `text/event-stream` |

## GET /api/projects

Projects with session counts, last activity and cost, most recently active first. No parameters.
`cost` is the sum of the best costs of the project's sessions plus its scripted runs.

```json
{
  "projects": [
    {
      "harness": "claude",
      "projectKey": "-home-dev-acme-nest",
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

### Previews: `humanTurns`, `lastPrompt`, `recap`

Every summary (list row, `session-updated` event, `summary` of the detail) carries three more
fields so that a list can show what a session is about without loading it:

- `humanTurns` (int): the digest's `stats.humanTurns`, the turns a person typed: prompts and
  slash or shell commands, abandoned ones excluded. A session can have `humanTurns > 0` and no
  `lastPrompt`, when everything typed was a command.
- `lastPrompt` `{turn, at, text, truncated}`: the last turn whose origin is `human` and that is not
  abandoned; when every human turn is abandoned, the last human turn. `turn` is the turn index
  (`digest.turns[turn]` in the detail), `at` its start. Omitted when the session has no human turn.
- `recap` `{at, text, truncated}`: the last recap. Omitted when the session has none.

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
        }
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

`turn` is the turn index for `prompt` and `final` hits, the compaction index for `compaction`,
and `-1` for session-level fields. A turn copied into several sessions is a hit once, in the
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
| `by` | `project` (default), `day`, `model`, `kind` or `session` |
| `since`, `until` | for every `by` except `session`: a range of local days (spend is bucketed by day; a time of day is rounded to its day). For `by=session`: bounds on last activity |
| `project` | as for `/api/sessions` |
| `limit` | cut the rows (1 to 500). Default: none; `by=session` defaults to 100. `total` is not affected; `truncated` says rows were cut |
| `split` | `project`, `model` or `kind`: break every row down by a second dimension (see below). Must differ from `by`; a 400 with `by=session`, with another value (`day` included), or equal to `by` |

Rows are ordered by cost, largest first; `by=day` is chronological. `by=model` has a row
`(overhead)` for reported spend no transcript message explains; `by=kind` has the row `sdk` for
scripted runs; `by=session` lists scripted runs as one `scripted:<project>` row per project.
A `by=session` row also carries `harness`, `project` and `lastActivityAt` (a scripted row only
`project`), so it can be shown and linked without a second request; its cost is the session's
whole best cost, whatever the range.
`backing` counts the sessions in the table by cost flag. `sessions` counts the sessions behind
the figure, scripted runs included.

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

(One row shown; the real response has a row per kind.)

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
