package harness

import "strings"

// Info describes a harness to people: what the CLI and the web UI print. It is plain data,
// so the packages that must not know any harness (server, web) can carry it.
type Info struct {
	Name   string `json:"name"`             // as in session keys
	Title  string `json:"title"`            // product name, e.g. "Claude Code"
	Resume string `json:"resume,omitempty"` // command that picks a session up, "{id}" for the session id; empty: none
	Badge  string `json:"badge,omitempty"`  // short tag shown beside a session; empty for the main harness
}

// Describe returns the entry for name from list. A harness that is not listed is named by
// its name, tagged with it, and has no resume command: nothing is borrowed from another
// harness.
func Describe(list []Info, name string) Info {
	for _, in := range list {
		if in.Name == name {
			return in
		}
	}
	return Info{Name: name, Title: name, Badge: name}
}

// ResumeCommand is the command that picks session id up again; empty when the harness
// has none.
func (in Info) ResumeCommand(id string) string {
	if in.Resume == "" {
		return ""
	}
	return strings.ReplaceAll(in.Resume, "{id}", id)
}
