package harness

import "github.com/terek/merlin/explorer/internal/model"

// Session is one discoverable session as the engine sees it. Everything the engine needs
// to decide whether the stored digest is stale is here; Handle is opaque to the engine
// and is given back to the same harness's Build.
type Session struct {
	Key         model.SessionKey
	ProjectKey  string
	Fingerprint []model.SourceFile // every file the digest is built from, sorted by path
	Handle      any
}

// Discovery is the result of one stat-only walk of a harness's session storage.
type Discovery struct {
	Sessions []Session // at most one per Key.ID
	Warnings []string  // unreadable paths, duplicate ids: logged, never fatal
}

// Harness is a coding agent whose sessions Explorer indexes.
//
// The engine drives only this interface and never learns how a harness stores its
// sessions. Digests are stored under <EXPLORER_HOME>/<Name()>/.
//
// The daemon (explorer serve) additionally uses Locate, LiveSessions and ParseHook.
type Harness interface {
	// Name is the harness name used in session keys and as the storage directory.
	Name() string

	// ParserVersion identifies the output of Build; a stored digest with a different
	// parserVersion is rebuilt.
	ParserVersion() int

	// Discover lists the sessions that exist now. It only lists and stats; it must be
	// cheap enough to run every few seconds. An error means the storage could not be
	// read at all: the engine then leaves that harness's stored digests untouched.
	Discover() (Discovery, error)

	// Build reads the files of one session and returns its digest. An error means a
	// file could not be read. Safe for concurrent use.
	//
	// SEAM (merlin-t8s.19): today every call re-reads the whole session. Incremental
	// reads for live sessions will keep a Builder per live file inside the adapter and
	// feed it only the appended bytes; the engine and daemon do not change.
	Build(s Session) (*model.SessionDigest, error)

	// Locate re-lists one session: the same result Discover would give for it, without
	// walking the rest of the storage. found is false when the session has no files (yet,
	// or any more). ref.ProjectKey may be empty, in which case the harness finds it.
	// It only lists and stats; the daemon calls it every second for every live session.
	Locate(ref SessionRef) (s Session, found bool, err error)

	// LiveSessions names the sessions the harness itself says are running now (for Claude
	// Code, the pid files whose process is alive). Best effort: an error or an empty list
	// only means the other live-session signals decide.
	LiveSessions() ([]SessionRef, error)

	// ParseHook interprets the body of a hook notification. ok is false when the body is
	// not an event of this harness, is malformed, or names no session; callers ignore it.
	ParseHook(body []byte) (ev HookEvent, ok bool)
}

// SessionRef names a session within one harness. ProjectKey is optional.
type SessionRef struct {
	ID         string
	ProjectKey string
}

// HookEvent is a harness hook notification reduced to what the daemon needs.
type HookEvent struct {
	Name  string     // the harness's own event name, for logs
	Ref   SessionRef // the session it is about
	Final bool       // the session just reached a rest point: process it now, no debounce
	Ended bool       // the session is over: it no longer counts as live because of this hook
}
