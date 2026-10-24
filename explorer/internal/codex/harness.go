package codex

import (
	"fmt"

	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/model"
)

// Harness adapts Codex to harness.Harness.
type Harness struct {
	home   string // CODEX_HOME, normally ~/.codex
	pricer Pricer
	metas  metaCache
}

var _ harness.Harness = (*Harness)(nil)

// New returns the Codex harness for the given home directory (CODEX_HOME, normally
// ~/.codex). pricer prices API calls; *pricing.Table satisfies it.
func New(home string, pricer Pricer) *Harness {
	return &Harness{home: home, pricer: pricer}
}

// Name implements harness.Harness.
func (h *Harness) Name() string { return HarnessName }

// ParserVersion implements harness.Harness.
func (h *Harness) ParserVersion() int { return ParserVersion }

// Discover implements harness.Harness. A missing sessions directory is no sessions.
func (h *Harness) Discover() (harness.Discovery, error) {
	srcs, warnings, err := h.metas.scan(h.home)
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
		return nil, fmt.Errorf("codex: session %s has no discovery handle", s.Key)
	}
	return buildSession(src, h.pricer)
}

// Locate implements harness.Harness. Rollouts are filed by date, not by session, so it
// lists them all; the first lines are cached, so this only stats.
func (h *Harness) Locate(ref harness.SessionRef) (harness.Session, bool, error) {
	srcs, _, err := h.metas.scan(h.home)
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

// LiveSessions implements harness.Harness. Codex keeps no registry of running sessions
// that this package reads; recent file changes decide.
func (h *Harness) LiveSessions() ([]harness.SessionRef, error) { return nil, nil }

// ParseHook implements harness.Harness. Codex hooks are not installed.
func (h *Harness) ParseHook(body []byte) (harness.HookEvent, bool) { return harness.HookEvent{}, false }
