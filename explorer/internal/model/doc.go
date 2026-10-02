// Package model defines the digest schema shared by every other package.
//
// The digest is the contract between the parser, the store, the catalog, the engine and
// the server. It is harness-neutral: nothing here may be specific to Claude Code, so that
// other coding agents can produce the same shape. Field-by-field documentation lives in
// docs/digest-schema.md and must be kept in step with these structs.
//
// Conventions (see explorer/CLAUDE.md): camelCase JSON keys, RFC 3339 UTC timestamps, USD
// as float64, token counts as int64, omitempty on optional fields. Texts are stored whole;
// nothing in this package truncates. Producers must emit timestamps in UTC and slices in
// time-then-id order so that a digest is a pure function of the session's files.
package model
