package claude

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/claude/digest"
	"github.com/terek/merlin/explorer/internal/claude/discover"
	"github.com/terek/merlin/explorer/internal/harness"
	"github.com/terek/merlin/explorer/internal/model"
)

// Harness adapts Claude Code to harness.Harness.
type Harness struct {
	projectsDir string
	registryDir string // <config>/sessions: one <pid>.json per running session
	pricer      digest.Pricer

	inc           *incremental
	logf          func(format string, args ...any)
	parserVersion int // tests only: the parser version the kept state is tagged with
}

var (
	_ harness.Harness  = (*Harness)(nil)
	_ harness.Follower = (*Harness)(nil)
)

// New returns the Claude Code harness for the given config directory (CLAUDE_CONFIG_DIR,
// normally ~/.claude). pricer prices API messages; *pricing.Table satisfies it.
func New(configDir string, pricer digest.Pricer) *Harness {
	return &Harness{
		projectsDir: filepath.Join(configDir, "projects"),
		registryDir: filepath.Join(configDir, "sessions"),
		pricer:      pricer,
		inc:         newIncremental(),
	}
}

// Name implements harness.Harness.
func (h *Harness) Name() string { return discover.Harness }

// ParserVersion implements harness.Harness.
func (h *Harness) ParserVersion() int { return digest.ParserVersion }

// Discover implements harness.Harness. If the same session id turns up in two places it
// keeps the one that has a main transcript (else the first by project key) and warns
// about the other, so the two never fight over one catalog key.
func (h *Harness) Discover() (harness.Discovery, error) {
	res, err := discover.Scan(h.projectsDir)
	if err != nil {
		return harness.Discovery{}, err
	}
	var out harness.Discovery
	for _, w := range res.Warnings {
		out.Warnings = append(out.Warnings, w.String())
	}
	chosen := map[string]int{} // session id -> index into out.Sessions
	for _, src := range res.Sessions {
		s := harness.Session{
			Key:         src.Key(),
			ProjectKey:  src.ProjectKey,
			Fingerprint: src.Fingerprint,
			Handle:      src,
		}
		i, dup := chosen[src.ID]
		if !dup {
			chosen[src.ID] = len(out.Sessions)
			out.Sessions = append(out.Sessions, s)
			continue
		}
		kept := out.Sessions[i].Handle.(discover.Source)
		if kept.Main == "" && src.Main != "" {
			out.Sessions[i] = s
			kept, src = src, kept
		}
		out.Warnings = append(out.Warnings, fmt.Sprintf(
			"session %s found in two places; ignoring project %s, keeping %s", src.ID, src.ProjectKey, kept.ProjectKey))
	}
	sort.SliceStable(out.Sessions, func(i, j int) bool {
		a, b := out.Sessions[i], out.Sessions[j]
		if a.ProjectKey != b.ProjectKey {
			return a.ProjectKey < b.ProjectKey
		}
		return a.Key.ID < b.Key.ID
	})
	return out, nil
}

// Build implements harness.Harness.
func (h *Harness) Build(s harness.Session) (*model.SessionDigest, error) {
	src, ok := s.Handle.(discover.Source)
	if !ok {
		return nil, fmt.Errorf("claude: session %s has no discovery handle", s.Key)
	}
	if st := h.inc.begin(src.ID); st != nil {
		return h.buildFollowed(src, st)
	}
	return digest.BuildSession(src, h.pricer)
}

// Locate implements harness.Harness. An orphan (subagent files without a main
// transcript) is a session too, exactly as in Discover.
func (h *Harness) Locate(ref harness.SessionRef) (harness.Session, bool, error) {
	src, found, _, err := discover.ScanSession(h.projectsDir, ref.ProjectKey, ref.ID)
	if err != nil || !found {
		return harness.Session{}, false, err
	}
	return harness.Session{
		Key:         src.Key(),
		ProjectKey:  src.ProjectKey,
		Fingerprint: src.Fingerprint,
		Handle:      src,
	}, true, nil
}

// LiveSessions implements harness.Harness: the sessions in <config>/sessions/<pid>.json
// whose process is alive.
func (h *Harness) LiveSessions() ([]harness.SessionRef, error) {
	reg, err := catalog.ReadRegistry(h.Name(), h.registryDir, nil)
	if err != nil {
		return nil, err
	}
	out := make([]harness.SessionRef, 0, len(reg))
	for key := range reg {
		out = append(out, harness.SessionRef{ID: key.ID})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// ParseHook implements harness.Harness. The session comes from session_id, or from the
// transcript file name when that is missing; the project from the transcript path (the
// main one, else the subagent's) when it lies under the projects directory. SubagentStop
// may carry neither path, then the harness finds the project by session id. Stop and
// SessionEnd are rest points; SessionEnd also ends the session.
func (h *Harness) ParseHook(body []byte) (harness.HookEvent, bool) {
	var p struct {
		SessionID           string `json:"session_id"`
		TranscriptPath      string `json:"transcript_path"`
		AgentTranscriptPath string `json:"agent_transcript_path"`
		EventName           string `json:"hook_event_name"`
	}
	if json.Unmarshal(body, &p) != nil || p.EventName == "" {
		return harness.HookEvent{}, false
	}
	var ref harness.SessionRef
	for _, path := range []string{p.TranscriptPath, p.AgentTranscriptPath} {
		if key, ok := h.projectOf(path); ok {
			ref.ProjectKey = key
			break
		}
	}
	ref.ID = p.SessionID
	if ref.ID == "" {
		if base, ok := strings.CutSuffix(filepath.Base(p.TranscriptPath), ".jsonl"); ok {
			ref.ID = base
		}
	}
	if ref.ID == "" || filepath.Base(ref.ID) != ref.ID {
		return harness.HookEvent{}, false
	}
	return harness.HookEvent{
		Name:  p.EventName,
		Ref:   ref,
		Final: p.EventName == "Stop" || p.EventName == "SessionEnd",
		Ended: p.EventName == "SessionEnd",
	}, true
}

// projectOf returns the project key of a transcript path under the projects directory.
func (h *Harness) projectOf(path string) (string, bool) {
	if path == "" || !filepath.IsAbs(path) {
		return "", false
	}
	rel, err := filepath.Rel(h.projectsDir, filepath.Clean(path))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	key, _, nested := strings.Cut(rel, string(filepath.Separator))
	return key, nested && key != ""
}
