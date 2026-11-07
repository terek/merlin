package pi

import (
	"fmt"

	"github.com/terek/merlin/internal/harness"
	"github.com/terek/merlin/internal/model"
)

// Harness adapts Pi to harness.Harness.
type Harness struct {
	dir    string // the sessions directory (PI_CODING_AGENT_SESSION_DIR, else <agent dir>/sessions)
	pricer Pricer
	heads  headerCache
}

var _ harness.Harness = (*Harness)(nil)

// New returns the Pi harness for a sessions directory. pricer prices the calls that carry no
// cost of their own; *pricing.Table satisfies it.
func New(sessionsDir string, pricer Pricer) *Harness {
	return &Harness{dir: sessionsDir, pricer: pricer}
}

// Name implements harness.Harness.
func (h *Harness) Name() string { return HarnessName }

// ParserVersion implements harness.Harness.
func (h *Harness) ParserVersion() int { return ParserVersion }

// Discover implements harness.Harness. A missing sessions directory is no sessions.
func (h *Harness) Discover() (harness.Discovery, error) {
	srcs, warnings, err := h.heads.scan(h.dir)
	if err != nil {
		return harness.Discovery{}, err
	}
	out := harness.Discovery{Warnings: warnings}
	for _, s := range srcs {
		out.Sessions = append(out.Sessions, session(s))
	}
	return out, nil
}

func session(s source) harness.Session {
	return harness.Session{
		Key:         model.SessionKey{Harness: HarnessName, ID: s.ID},
		ProjectKey:  s.ProjectKey,
		Fingerprint: s.Fingerprint,
		Handle:      s,
	}
}

// Build implements harness.Harness.
func (h *Harness) Build(s harness.Session) (*model.SessionDigest, error) {
	src, ok := s.Handle.(source)
	if !ok {
		return nil, fmt.Errorf("pi: session %s has no discovery handle", s.Key)
	}
	return buildSession(src, h.pricer)
}

// Locate implements harness.Harness. Session files are named by time, not by id, so it
// lists them all; the headers are cached, so this only stats.
func (h *Harness) Locate(ref harness.SessionRef) (harness.Session, bool, error) {
	srcs, _, err := h.heads.scan(h.dir)
	if err != nil {
		return harness.Session{}, false, err
	}
	for _, s := range srcs {
		if s.ID == ref.ID {
			return session(s), true, nil
		}
	}
	return harness.Session{}, false, nil
}

// LiveSessions implements harness.Harness. Pi keeps no registry of running sessions that
// this package reads; recent file changes decide.
func (h *Harness) LiveSessions() ([]harness.SessionRef, error) { return nil, nil }

// ParseHook implements harness.Harness. Pi has no hook list Merlin installs into (its
// extensions are TypeScript files), so no hook notification is ever a Pi event.
func (h *Harness) ParseHook([]byte) (harness.HookEvent, bool) { return harness.HookEvent{}, false }
