// Package pi indexes Pi (pi.dev) sessions: one JSONL file per session under the sessions
// directory, holding a tree of entries (docs/pi-format.md). It is the only package that knows
// the shape of Pi's session files. LiveSessions and ParseHook give no signal: Pi has no
// registry or hook list that Merlin reads, so a running session is told by its file changing.
package pi
