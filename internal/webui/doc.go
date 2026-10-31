// Package webui serves the single-page web UI (web/) from the daemon's own port.
//
// The build output of web/ (internal/webui/dist) is embedded with go:embed behind the build tag
// embedui; without the tag the handler answers with a short page saying the UI was not built, so
// go build, go test and go vet never need bun. See docs/ui.md.
package webui
