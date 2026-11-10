# Changelog

What changed in each release of Merlin Explorer for the people using it, newest first. To install or upgrade, see the [README](README.md).

## Unreleased

- Auto-upgrade is now opt-in: it means trusting every future release without looking at it. `merlin serve` still checks every 4 hours and tells you about a new release, in `merlin.log` and as a quiet "X available" link in the top bar; `merlin upgrade` installs it.
- `merlin autoupgrade` turns auto-upgrade on and installs the latest release right away (`patch` for fixes only, `off`, `status`).

## 0.7.1 — 2026-11-09

- Releases are signed. `merlin upgrade` and auto-upgrade refuse a release without a valid signature, and on macOS check the Apple signature too (`install.sh` still checks only the checksum).

## 0.7.0 — 2026-11-09

- `merlin serve` can upgrade itself: it checks for a new release at start and every 4 hours, swaps the binary, restarts, and rolls back if the new version does not start. Turn it off with `"autoUpgrade": false` in `config.json`, `MERLIN_AUTO_UPGRADE=0` or `--no-auto-upgrade`; `"autoUpgrade": "patch"` follows only patch releases of the version you run.
- `merlin upgrade --version X` installs exactly that release, older or pre-release included.
- Running `merlin` with no arguments starts the server (`merlin --port 8080` works too).
- The page shows "Merlin updated to X · Reload" when the server restarts as a new version.
- A bad key in `config.json` is reported in the log and ignored instead of stopping `merlin serve`.

## 0.6.2 — 2026-11-08

- Pi: work done by sub-agents (delegating extensions) is now counted. Runs that left no record of their spend are labelled "not recorded", and every total they belong to reads "at least".
- Pi: a session started by another Pi session through `pi -p` is linked to its parent.
- Prices: models reached through a router or host (`anthropic/claude-sonnet-4.6` on OpenRouter, Copilot's `claude-sonnet-4.6`) are priced instead of showing as unpriced.
- Changing prices in `config.json`, or upgrading to a release with new prices, reprices sessions already indexed.

## 0.6.1 — 2026-11-08

### New
- Pi sessions are indexed (preview), with Pi's own per-call cost. `merlin doctor --coverage` and `merlin shape` help check how well a harness is understood.
- Sessions can be grouped by directory, checkout, repository or remote; the Sessions rail and the Cost page offer the same cuts, and a session's header lists where it worked.
- Beads work without an `issues.jsonl` export: cost per bead, families and prefixes are rebuilt from what sessions did, and each bead has a page at `/bead/<id>`.
- Prices for fifteen more Codex and Pi models.
- Older Codex sessions (0.137-0.142) now show files touched and lines changed.

### Changed
- The Session page's time view was reworked: an overview strip with a brush to zoom into any window of the session, line weight by model tier ("By model tier" split), a drawn key, and swarms of one-shot sub-agents folded into one row. Forks and continuations are drawn as branches of the main line.
- The time view opens on the whole session, and spend is a thin grey line per slot so the context lines stay readable.

## 0.6.0 — 2026-11-01

- New Moments page (experimental): what your sessions say about how you work with agents, with a shareable card you can download as a PNG.

## 0.5.3 — 2026-10-29

- Prices for Claude Haiku 5.5.

## 0.5.2 — 2026-10-29

- The time view shows one day at a time for sessions that ran over several days.
- The Beads rail has one entry per bead prefix instead of one per family.
- Agent prompts render as markdown.

## 0.5.1 — 2026-10-28

- Sessions can be grouped by repository, branch or bead, with cost per bead; the Cost page gains By repository and By bead.

## 0.5.0 — 2026-10-28

- Merlin reads the `bd` calls in your sessions and shows which beads each session worked on, plus the git branch of every turn.

## 0.4.3 — 2026-10-27

### Changed
- Sonnet 5.5 cache reads are priced at $0.10 per million tokens (they were $0.20); stored sessions are repriced.
- Sub-agent output Claude Code cut short is estimated and added to the cost, shown as "~"; a total that is only a floor reads "≥ $x" with the reason.

### New
- The spend graph shows spend the harness reported that no message explains, as a hatched band.
- Pull requests a session opened are linked in its header and in `merlin show`.
- Codex's encrypted agent-to-agent messages are shown as "(encrypted)".

## 0.4.2 — 2026-10-25

- Spend graph: each agent is one light frame over its whole life, the plot uses the full width, and the hover readout no longer moves the graph.

## 0.4.1 — 2026-10-25

- The Session page's spend graph is a time view: wall-clock time across, idle stretches squeezed into labelled breaks, one row per agent.
- `merlin hooks install|uninstall|status [claude|codex|all]` manages Codex hooks too.
- Claude Code hooks are opt-in: `merlin serve` no longer adds them on a new install, `merlin hooks install` does.
- Prompts delivered by Claude Code itself (a coordinator's reply, task notifications) start turns, so a resumed sub-agent's later work is split into turns.
- Cache misses are shown for Codex too, with a cause: idle, model switch, fast mode, or none visible.

## 0.4.0 — 2026-10-24

- Codex sessions are indexed beside Claude Code: cost, sub-agents, reviews and forks, with prices for the GPT models.
- The CLI and UI name the harness, with a codex badge; projects merge sessions from both harnesses started in one directory.

## 0.3.1 — 2026-10-04

- `merlin upgrade` replaces the binary with the latest release, after checking its checksum. `--check` only reports; development builds need `--force`.

## 0.3.0 — 2026-10-04

- The Session page is now a spend tree: a session and everything forked or continued from it, with one bar per decision, one per piece of agent work, typed prompts with their running total, cache misses and compactions.
- The Sessions list shows one row per tree, with a member expander.
- Compactions are costed: the call that writes a summary is estimated, marked red when the cache was cold, and kept out of every total. Agents' own compactions are marked too.
- Workflow runs are folded into the turn that launched them, and prompts typed while a turn ran are no longer dropped.
- Teammate messages and task notifications are shown as messages instead of raw markup.

## 0.2.0 — 2026-10-02

First release of the Go rewrite, replacing the earlier Bun-based Merlin. `merlin` indexes your Claude Code sessions, shows what they cost and where the money went in a web UI served from one binary, and keeps its state under `~/.merlin`.

## Earlier

Releases up to 0.1.1 were the previous Bun/TypeScript Merlin.
