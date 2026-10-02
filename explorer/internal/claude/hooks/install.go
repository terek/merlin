package hooks

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

	"github.com/tidwall/gjson"
)

// Events are the Claude Code hook events Explorer subscribes to.
var Events = []string{"SessionStart", "UserPromptSubmit", "Stop", "SubagentStop", "SessionEnd"}

// hookTimeoutSeconds is the timeout written into each entry. The client itself
// gives up after ~150 ms; this only bounds a wedged shell.
const hookTimeoutSeconds = 2

// scriptSuffix identifies an Explorer entry: any hook command ending in it is ours,
// whatever MERLIN_HOME it was installed under.
const scriptSuffix = "/claude/hooks/notify.sh"

// Config says where to install.
type Config struct {
	ClaudeConfigDir string // directory holding settings.json
	ExplorerHome    string // MERLIN_HOME
	Binary          string // explorer binary recorded in notify.sh; default os.Executable
}

// SettingsPath is the settings.json that is edited.
func (c Config) SettingsPath() string { return filepath.Join(c.ClaudeConfigDir, "settings.json") }

// ScriptPath is the wrapper script the hook entries run.
func (c Config) ScriptPath() string {
	return filepath.Join(c.ExplorerHome, "claude", "hooks", "notify.sh")
}

// Result describes what Install or Uninstall did.
type Result struct {
	Events     []string // events whose entries were added or removed
	BackupPath string   // set when Install backed up an existing settings.json
}

// Changed reports whether settings.json was modified.
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
}

func isOwn(command string) bool {
	return strings.HasSuffix(filepath.ToSlash(strings.TrimSpace(command)), scriptSuffix)
}

// Install writes notify.sh and adds one entry per event to settings.json,
// leaving every other byte of the file alone. It is idempotent.
func Install(c Config) (Result, error) {
	var res Result
	bin := c.Binary
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

	path, err := resolveLink(c.SettingsPath())
	if err != nil {
		return res, err
	}
	orig, mode, exists, err := readSettings(path)
	if err != nil {
		return res, err
	}
	doc := string(orig)
	if !exists {
		doc = "{\n}\n"
	}
	newDoc, added, err := addEntries(doc, c.ScriptPath())
	if err != nil {
		return res, fmt.Errorf("%s: %w", path, err)
	}
	if err := writeScript(c.ScriptPath(), bin); err != nil {
		return res, err
	}
	if len(added) == 0 {
		return res, nil
	}
	if !exists {
		newDoc = createdDocument(c.ScriptPath())
	}
	if exists {
		res.BackupPath = path + ".merlin-backup-" + time.Now().UTC().Format("20060102T150405.000000000Z")
		if err := writeAtomic(res.BackupPath, orig, mode); err != nil {
			return Result{}, fmt.Errorf("backup settings.json: %w", err)
		}
	}
	if err := writeAtomic(path, []byte(newDoc), mode); err != nil {
		return Result{}, err
	}
	res.Events = added
	return res, nil
}

// Uninstall removes exactly the entries Install added, and the wrapper script.
func Uninstall(c Config) (Result, error) {
	var res Result
	path, err := resolveLink(c.SettingsPath())
	if err != nil {
		return res, err
	}
	orig, mode, exists, err := readSettings(path)
	if err != nil {
		return res, err
	}
	if exists {
		newDoc, removed, err := removeEntries(string(orig))
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
	if err := os.Remove(c.ScriptPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return res, err
	}
	return res, nil
}

// Status reports, per event, whether an Explorer entry is present and usable.
func Status(c Config) ([]EventStatus, error) {
	path, err := resolveLink(c.SettingsPath())
	if err != nil {
		return nil, err
	}
	orig, _, exists, err := readSettings(path)
	if err != nil {
		return nil, err
	}
	doc := string(orig)
	if exists && !gjson.Valid(doc) {
		return nil, fmt.Errorf("%s: not valid JSON", path)
	}
	out := make([]EventStatus, 0, len(Events))
	for _, ev := range Events {
		st := EventStatus{Event: ev, State: Missing}
		if exists {
			if m, ok, _ := findOwn(doc, ev); ok {
				st.State = Installed
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

// --- settings.json editing ---

func ownGroup() func(script string) string {
	return func(script string) string {
		return `{"hooks": [{"type": "command", "command": ` + quote(script) +
			fmt.Sprintf(`, "timeout": %d}]}`, hookTimeoutSeconds)
	}
}

func createdDocument(script string) string {
	var b strings.Builder
	b.WriteString("{\n  \"hooks\": {\n")
	for i, ev := range Events {
		b.WriteString("    " + quote(ev) + ": [\n      ")
		b.WriteString(ownGroup()(script))
		b.WriteString("\n    ]")
		if i < len(Events)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString("  }\n}\n")
	return b.String()
}

func addEntries(doc, script string) (string, []string, error) {
	root, err := rootOpen(doc)
	if err != nil {
		return "", nil, err
	}
	group := ownGroup()(script)
	var added []string
	for _, ev := range Events {
		if _, ok, err := findOwn(doc, ev); err != nil {
			return "", nil, err
		} else if ok {
			continue
		}
		hooks := gjson.Get(doc, "hooks")
		switch {
		case !hooks.Exists():
			doc, err = appendItem(doc, root, `"hooks": {`+quote(ev)+`: [`+group+`]}`)
		case !hooks.IsObject():
			return "", nil, errors.New(`"hooks" is not an object`)
		default:
			evRes := gjson.Get(doc, "hooks."+ev)
			switch {
			case !evRes.Exists():
				doc, err = appendItem(doc, hooks.Index, quote(ev)+`: [`+group+`]`)
			case !evRes.IsArray():
				return "", nil, fmt.Errorf("hooks.%s is not an array", ev)
			default:
				doc, err = appendItem(doc, evRes.Index, group)
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
	groupOpen int // offset of the group object
	innerOpen int // offset of group.hooks array
	innerIdx  int
	ours      int // own hooks in this group
	total     int // all hooks in this group
}

// findOwn locates the first Explorer hook under hooks.<ev>.
func findOwn(doc, ev string) (ownMatch, bool, error) {
	var m ownMatch
	arr := gjson.Get(doc, "hooks."+ev)
	if !arr.IsArray() {
		return m, false, nil
	}
	groups, err := scan(doc, arr.Index)
	if err != nil {
		return m, false, err
	}
	for gi, g := range groups {
		grp := gjson.Parse(doc[g.start:g.end])
		hk := grp.Get("hooks")
		if !hk.IsArray() {
			continue
		}
		list := hk.Array()
		first := -1
		ours := 0
		for hi, h := range list {
			if isOwn(h.Get("command").String()) {
				ours++
				if first < 0 {
					first = hi
				}
			}
		}
		if first >= 0 {
			return ownMatch{
				command: list[first].Get("command").String(), arrOpen: arr.Index,
				groupIdx: gi, groupOpen: g.start, innerOpen: g.start + hk.Index,
				innerIdx: first, ours: ours, total: len(list),
			}, true, nil
		}
	}
	return m, false, nil
}

func removeEntries(doc string) (string, []string, error) {
	if _, err := rootOpen(doc); err != nil {
		return "", nil, err
	}
	var removed []string
	for _, ev := range Events {
		hit := false
		for {
			m, ok, err := findOwn(doc, ev)
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
	arr := gjson.Get(doc, "hooks."+ev)
	if !arr.IsArray() {
		return doc, nil
	}
	if items, err := scan(doc, arr.Index); err != nil || len(items) > 0 {
		return doc, err
	}
	hooks := gjson.Get(doc, "hooks")
	doc, err := removeKey(doc, hooks.Index, ev)
	if err != nil {
		return "", err
	}
	hooks = gjson.Get(doc, "hooks")
	if items, err := scan(doc, hooks.Index); err != nil || len(items) > 0 {
		return doc, err
	}
	root, err := rootOpen(doc)
	if err != nil {
		return "", err
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

func readSettings(path string) (data []byte, mode fs.FileMode, exists bool, err error) {
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

func writeScript(path, bin string) error {
	body := "#!/bin/sh\n" +
		"# Written by `merlin hooks install`. Silent, always exits 0.\n" +
		binPrefix + shellQuote(bin) + "\n" +
		"if [ -x \"$BIN\" ]; then\n" +
		"  exec \"$BIN\" hook >/dev/null 2>&1\n" +
		"fi\n" +
		"exit 0\n"
	if cur, err := os.ReadFile(path); err == nil && string(cur) == body {
		if st, err := os.Stat(path); err == nil && st.Mode().Perm() == 0o755 {
			return nil
		}
	}
	return writeAtomic(path, []byte(body), 0o755)
}

// scriptBinary returns the explorer binary recorded in a notify.sh.
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

// configPort reads "port" from <explorerHome>/config.json.
func configPort(explorerHome string) int {
	data, err := os.ReadFile(filepath.Join(explorerHome, "config.json"))
	if err != nil {
		return DefaultPort
	}
	var cfg struct {
		Port int `json:"port"`
	}
	if json.Unmarshal(data, &cfg) != nil || cfg.Port <= 0 || cfg.Port > 65535 {
		return DefaultPort
	}
	return cfg.Port
}
