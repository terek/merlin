// Package codex adapts OpenAI's Codex CLI to harness.Harness: it discovers the rollout files
// under $CODEX_HOME/sessions (default ~/.codex) and builds one digest per session tree.
//
// Only this package may know the layout of $CODEX_HOME or the shape of rollout files; the
// format is described in docs/codex-format.md.
package codex
