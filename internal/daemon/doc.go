// Package daemon is the long-running form of Explorer (explorer serve). It keeps the
// stored digests current while sessions run, by three overlapping means:
//
//   - a periodic reconcile of the whole tree (the correctness backstop),
//   - hook notifications posted to /hook (latency only: a lost hook costs one rescan),
//   - stat-polling of the sessions known to be live, with a per-session debounce.
//
// Nothing here is persisted except what the engine writes into the store. The queue, the
// live set and the debounce state are rebuilt from the filesystem after a restart, so the
// process may be stopped or killed at any time.
//
// The package is harness-neutral: it drives harness.Harness values and gets everything
// Claude-specific (hook installation included) from its caller.
package daemon
