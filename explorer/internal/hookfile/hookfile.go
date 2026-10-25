// Package hookfile adds and removes Merlin's command hooks in a JSON hooks file, the shape
// Claude Code's settings.json and Codex's hooks.json share:
//
//	{"hooks": {"<Event>": [{"matcher": "…", "hooks": [{"type": "command", "command": "…", "timeout": 2}]}]}}
//
// Edits are spliced into the text, so every other byte of the file stays as it was. Each
// entry runs a wrapper script that execs the merlin binary if it still exists. The
// harness packages say where the file and the script are.
package hookfile

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// File describes one harness's hooks file and the entries Merlin keeps in it.
type File struct {
	Path    string   // the JSON file edited
	Script  string   // wrapper script the entries run
	Suffix  string   // a command ending in it is Merlin's, whatever MERLIN_HOME it was installed under
	Events  []string // events subscribed to, in file order
	Timeout int      // seconds, written into each entry; it only bounds a wedged shell
	Args    string   // what the script runs the binary with, e.g. "hook"
	Binary  string   // merlin binary recorded in the script; default os.Executable
}

// Result describes what Install or Uninstall did.
type Result struct {
	Events     []string // events whose entries were added or removed
	BackupPath string   // set when Install backed up an existing file
}

// Changed reports whether the file was modified.
func (r Result) Changed() bool { return len(r.Events) > 0 }

// State of one event's hook.
type State string

const (
	Installed     State = "installed"
	Missing       State = "missing"
	MissingBinary State = "points at a missing binary"
)

// EventStatus is the status of one event.
type EventStatus struct {
	Event  string
	State  State
	Detail string
	// Group and Handler locate the entry when there is one: its matcher group in the
	// event's array and its place in that group's hooks.
	Group, Handler int
}

func (f File) isOwn(command string) bool {
	return strings.HasSuffix(filepath.ToSlash(strings.TrimSpace(command)), f.Suffix)
}

// Install writes the script and adds one entry per event to the file, leaving every
// other byte of it alone. It is idempotent.
func Install(f File) (Result, error) {
	var res Result
	bin := f.Binary
	if bin == "" {
		exe, err := os.Executable()
		if err != nil {
			return res, fmt.Errorf("locate the merlin binary: %w", err)
		}
		bin = exe
	}
	if abs, err := filepath.Abs(bin); err == nil {
		bin = abs
	}

	path, err := resolveLink(f.Path)
	if err != nil {
		return res, err
	}
	orig, mode, exists, err := readFile(path)
	if err != nil {
		return res, err
	}
	doc := string(orig)
	if !exists {
		doc = "{\n}\n"
	}
	newDoc, added, err := f.addEntries(doc)
	if err != nil {
		return res, fmt.Errorf("%s: %w", path, err)
	}
	if err := writeScript(f.Script, bin, f.Args); err != nil {
		return res, err
	}
	if len(added) == 0 {
		return res, nil
	}
	if !exists {
		newDoc = f.createdDocument()
	}
	if exists {
		res.BackupPath = path + ".merlin-backup-" + time.Now().UTC().Format("20060102T150405.000000000Z")
		if err := writeAtomic(res.BackupPath, orig, mode); err != nil {
			return Result{}, fmt.Errorf("backup %s: %w", filepath.Base(path), err)
		}
	}
	if err := writeAtomic(path, []byte(newDoc), mode); err != nil {
		return Result{}, err
	}
	res.Events = added
	return res, nil
}

// Uninstall removes exactly the entries Install added, and the script.
func Uninstall(f File) (Result, error) {
	var res Result
	path, err := resolveLink(f.Path)
	if err != nil {
		return res, err
	}
	orig, mode, exists, err := readFile(path)
	if err != nil {
		return res, err
	}
	if exists {
		newDoc, removed, err := f.removeEntries(string(orig))
		if err != nil {
			return res, fmt.Errorf("%s: %w", path, err)
		}
		if len(removed) > 0 {
			if err := writeAtomic(path, []byte(newDoc), mode); err != nil {
				return res, err
			}
			res.Events = removed
		}
	}
	if err := os.Remove(f.Script); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return res, err
	}
	return res, nil
}

// Status reports, per event, whether a Merlin entry is present and usable.
func Status(f File) ([]EventStatus, error) {
	path, err := resolveLink(f.Path)
	if err != nil {
		return nil, err
	}
	orig, _, exists, err := readFile(path)
	if err != nil {
		return nil, err
	}
	doc := string(orig)
	if exists && !json.Valid(orig) {
		return nil, fmt.Errorf("%s: not valid JSON", path)
	}
	out := make([]EventStatus, 0, len(f.Events))
	for _, ev := range f.Events {
		st := EventStatus{Event: ev, State: Missing}
		if exists {
			if m, ok, _ := f.findOwn(doc, ev); ok {
				st.State, st.Group, st.Handler = Installed, m.groupIdx, m.innerIdx
				script := strings.TrimSpace(m.command)
				if bin, err := scriptBinary(script); err != nil {
					st.State, st.Detail = MissingBinary, "script unreadable: "+script
				} else if !executable(bin) {
					st.State, st.Detail = MissingBinary, bin
				}
			}
		}
		out = append(out, st)
	}
	return out, nil
}

// --- editing ---

func (f File) ownGroup() string {
	return `{"hooks": [{"type": "command", "command": ` + quote(f.Script) +
		fmt.Sprintf(`, "timeout": %d}]}`, f.Timeout)
}

func (f File) createdDocument() string {
	var b strings.Builder
	b.WriteString("{\n  \"hooks\": {\n")
	for i, ev := range f.Events {
		b.WriteString("    " + quote(ev) + ": [\n      ")
		b.WriteString(f.ownGroup())
		b.WriteString("\n    ]")
		if i < len(f.Events)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString("  }\n}\n")
	return b.String()
}

func (f File) addEntries(doc string) (string, []string, error) {
	root, err := rootOpen(doc)
	if err != nil {
		return "", nil, err
	}
	group := f.ownGroup()
	var added []string
	for _, ev := range f.Events {
		if _, ok, err := f.findOwn(doc, ev); err != nil {
			return "", nil, err
		} else if ok {
			continue
		}
		hooks, ok, err := member(doc, root, "hooks")
		switch {
		case err != nil:
			return "", nil, err
		case !ok:
			doc, err = appendItem(doc, root, `"hooks": {`+quote(ev)+`: [`+group+`]}`)
		case doc[hooks] != '{':
			return "", nil, errors.New(`"hooks" is not an object`)
		default:
			arr, ok, err2 := member(doc, hooks, ev)
			switch {
			case err2 != nil:
				return "", nil, err2
			case !ok:
				doc, err = appendItem(doc, hooks, quote(ev)+`: [`+group+`]`)
			case doc[arr] != '[':
				return "", nil, fmt.Errorf("hooks.%s is not an array", ev)
			default:
				doc, err = appendItem(doc, arr, group)
			}
		}
		if err != nil {
			return "", nil, err
		}
		added = append(added, ev)
	}
	return doc, added, nil
}

type ownMatch struct {
	command   string
	arrOpen   int // offset of the event array
	groupIdx  int
	innerOpen int // offset of group.hooks array
	innerIdx  int
	ours      int // own hooks in this group
	total     int // all hooks in this group
}

// eventArray returns the offset of the array hooks.<ev>; ok is false when there is none.
func eventArray(doc, ev string) (int, bool, error) {
	root, err := rootOpen(doc)
	if err != nil {
		return 0, false, err
	}
	hooks, ok, err := member(doc, root, "hooks")
	if err != nil || !ok {
		return 0, false, err
	}
	arr, ok, err := member(doc, hooks, ev)
	if err != nil || !ok || doc[arr] != '[' {
		return 0, false, err
	}
	return arr, true, nil
}

// findOwn locates the first Merlin hook under hooks.<ev>.
func (f File) findOwn(doc, ev string) (ownMatch, bool, error) {
	arr, ok, err := eventArray(doc, ev)
	if err != nil || !ok {
		return ownMatch{}, false, err
	}
	groups, err := scan(doc, arr)
	if err != nil {
		return ownMatch{}, false, err
	}
	for gi, g := range groups {
		hk, ok, err := member(doc, g.val, "hooks")
		if err != nil {
			return ownMatch{}, false, err
		}
		if !ok || doc[hk] != '[' {
			continue
		}
		list, err := scan(doc, hk)
		if err != nil {
			return ownMatch{}, false, err
		}
		m := ownMatch{arrOpen: arr, groupIdx: gi, innerOpen: hk, innerIdx: -1, total: len(list)}
		for hi, h := range list {
			c, ok, err := member(doc, h.val, "command")
			if err != nil {
				return ownMatch{}, false, err
			}
			if !ok {
				continue
			}
			if cmd, ok := stringAt(doc, c); ok && f.isOwn(cmd) {
				m.ours++
				if m.innerIdx < 0 {
					m.innerIdx, m.command = hi, cmd
				}
			}
		}
		if m.innerIdx >= 0 {
			return m, true, nil
		}
	}
	return ownMatch{}, false, nil
}

func (f File) removeEntries(doc string) (string, []string, error) {
	if _, err := rootOpen(doc); err != nil {
		return "", nil, err
	}
	var removed []string
	for _, ev := range f.Events {
		hit := false
		for {
			m, ok, err := f.findOwn(doc, ev)
			if err != nil {
				return "", nil, err
			}
			if !ok {
				break
			}
			hit = true
			if m.ours == m.total {
				doc, err = removeItem(doc, m.arrOpen, m.groupIdx)
			} else {
				doc, err = removeItem(doc, m.innerOpen, m.innerIdx)
			}
			if err != nil {
				return "", nil, err
			}
		}
		if !hit {
			continue
		}
		removed = append(removed, ev)
		var err error
		if doc, err = pruneEmpty(doc, ev); err != nil {
			return "", nil, err
		}
	}
	return doc, removed, nil
}

// pruneEmpty drops hooks.<ev> if it is now an empty array, then hooks if empty.
func pruneEmpty(doc, ev string) (string, error) {
	arr, ok, err := eventArray(doc, ev)
	if err != nil || !ok {
		return doc, err
	}
	if items, err := scan(doc, arr); err != nil || len(items) > 0 {
		return doc, err
	}
	root, err := rootOpen(doc)
	if err != nil {
		return "", err
	}
	hooks, _, err := member(doc, root, "hooks")
	if err != nil {
		return "", err
	}
	if doc, err = removeKey(doc, hooks, ev); err != nil {
		return "", err
	}
	if hooks, _, err = member(doc, root, "hooks"); err != nil {
		return "", err
	}
	if items, err := scan(doc, hooks); err != nil || len(items) > 0 {
		return doc, err
	}
	return removeKey(doc, root, "hooks")
}

func removeKey(doc string, open int, key string) (string, error) {
	items, err := scan(doc, open)
	if err != nil {
		return "", err
	}
	for i, it := range items {
		if it.key == key {
			return removeItem(doc, open, i)
		}
	}
	return doc, nil
}

// --- files ---

func resolveLink(path string) (string, error) {
	p, err := filepath.EvalSymlinks(path)
	if errors.Is(err, fs.ErrNotExist) {
		return path, nil
	}
	return p, err
}

func readFile(path string) (data []byte, mode fs.FileMode, exists bool, err error) {
	st, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, 0o600, false, nil
	}
	if err != nil {
		return nil, 0, false, err
	}
	data, err = os.ReadFile(path)
	if err != nil {
		return nil, 0, false, err
	}
	return data, st.Mode().Perm(), true, nil
}

// writeAtomic replaces path by writing a temp file beside it and renaming.
func writeAtomic(path string, data []byte, mode fs.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func shellUnquote(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && s[0] == '\'' && s[len(s)-1] == '\'' {
		s = s[1 : len(s)-1]
	}
	return strings.ReplaceAll(s, `'\''`, "'")
}

const binPrefix = "BIN="

func writeScript(path, bin, args string) error {
	body := "#!/bin/sh\n" +
		"# Written by `merlin hooks install`. Silent, always exits 0.\n" +
		binPrefix + shellQuote(bin) + "\n" +
		"if [ -x \"$BIN\" ]; then\n" +
		"  exec \"$BIN\" " + args + " >/dev/null 2>&1\n" +
		"fi\n" +
		"exit 0\n"
	if cur, err := os.ReadFile(path); err == nil && string(cur) == body {
		if st, err := os.Stat(path); err == nil && st.Mode().Perm() == 0o755 {
			return nil
		}
	}
	return writeAtomic(path, []byte(body), 0o755)
}

// scriptBinary returns the merlin binary recorded in a script.
func scriptBinary(script string) (string, error) {
	f, err := os.Open(script)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if line := sc.Text(); strings.HasPrefix(line, binPrefix) {
			return shellUnquote(strings.TrimPrefix(line, binPrefix)), nil
		}
	}
	return "", errors.New("no binary recorded")
}

func executable(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0o111 != 0
}
