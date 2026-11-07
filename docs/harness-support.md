# What each harness supports

Merlin keeps one fixed list of capabilities (`internal/harness/support.go`, about thirty: prompts,
final texts, tools, files and lines, cost per message, a reported cost, compactions and what they
cost, agents, forks, PRs, beads, live registry, hooks, ...). Each harness package declares, in
`internal/<name>/support.go`, one claim per capability. `merlin doctor` compares the claims with
the digests.

## States

A claim is a state plus a short note. Exactly four states:

| state | meaning | the note says |
|---|---|---|
| `unknown` | nobody has decided. The default, and an honest answer | why it is not known |
| `absent` | the harness does not record it | the evidence: a format doc or a parser comment. Redacted data alone is not evidence |
| `dropped` | the harness records it and Merlin does not read it | why |
| `parsed` | code fills the field | where, if not obvious |

Do not write `parsed` for something you hope works, or `absent` because you did not find it: write
`unknown`. A test fails when a capability is left undeclared, when an id is not in the list, and
when a state other than `parsed` has no note. Adding a capability to the list therefore forces a
decision in every harness. Tables hold no versions and no corpus figures.

## The doctor report

`merlin doctor` has a Coverage section: for each harness, a line with the sessions indexed and the
number of capabilities per state, then the contradictions and the unknown ids. `merlin doctor
--coverage` lists every capability with its state and "seen in N of M sessions"; `--json` always
carries the full table (`coverage`).

A capability is **seen** in a session when its digest populated the field (each capability has a
small predicate over the digest). Capabilities a digest cannot show (live registry, hooks) read
"not measured".

Contradictions:

- `parsed but not seen`, with at least one session: the parser may be broken, or the corpus may
  hold no such case. Small data often does; a large corpus rarely.
- `absent but populated`, `dropped but populated`: the claim is wrong.

**Seen does not mean correct.** A field can be filled with the wrong value. Correctness comes from
the invariants (`docs/validation.md`) and from spot checks; coverage only shows where nothing
has been looked at.

## Figures for a corpus

Run Merlin over the corpus with a scratch home and read the report; never point it at a store you
care about, and never read the corpus text itself:

```
CLAUDE_CONFIG_DIR=<corpus>/claude CODEX_HOME=<corpus>/codex MERLIN_HOME=<scratch> merlin scan
MERLIN_HOME=<scratch> merlin doctor --coverage
```

The same report per harness version is the "seen in N of M" evidence for a claim.

## Adding a harness

1. Write `Support() harness.Support` in `internal/<name>/support.go`: one claim for every id of
   `harness.Capabilities()`. Start every capability as `harness.U("not yet looked at")` and move
   it only on evidence. It returns data only.
2. Set `support` in the harness's entry in `harnessList` (`cmd/explorer/harnesses.go`). Neutral
   packages never import a harness package, so the wiring is there and nowhere else.
3. `go test ./cmd/explorer` fails when a listed harness has no table or an unsound one.
4. Run doctor on a corpus and settle contradictions before moving claims to `parsed`.
