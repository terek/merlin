package codex

import (
	"encoding/json"
	"fmt"
	"path/filepath"

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

// ParseHook implements harness.Harness for the hooks internal/codex/hooks installs. The
// session is the tree that holds the thread named by session_id or transcript_path (a
// subagent's hook names its own thread); a thread not on disk yet is taken as a root, whose
// id is the session's. Stop and SessionEnd are rest points; SessionEnd also ends it.
func (h *Harness) ParseHook(body []byte) (harness.HookEvent, bool) {
	var p struct {
		SessionID      string `json:"session_id"`
		TranscriptPath string `json:"transcript_path"`
		EventName      string `json:"hook_event_name"`
	}
	if json.Unmarshal(body, &p) != nil || p.EventName == "" || p.SessionID == "" ||
		filepath.Base(p.SessionID) != p.SessionID {
		return harness.HookEvent{}, false
	}
	ref := harness.SessionRef{ID: p.SessionID}
	if srcs, _, err := h.metas.scan(h.home); err == nil {
	find:
		for _, s := range srcs {
			for _, f := range s.Files {
				if f.Thread == p.SessionID || (p.TranscriptPath != "" && f.Path == p.TranscriptPath) {
					ref = harness.SessionRef{ID: s.ID, ProjectKey: s.ProjectKey}
					break find
				}
			}
		}
	}
	return harness.HookEvent{
		Name:  p.EventName,
		Ref:   ref,
		Final: p.EventName == "Stop" || p.EventName == "SessionEnd",
		Ended: p.EventName == "SessionEnd",
	}, true
}
