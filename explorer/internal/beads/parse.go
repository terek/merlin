package beads

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"

	"github.com/terek/merlin/explorer/internal/model"
)

// Result is what a shell call returned.
type Result struct {
	Output string // stdout and stderr as the harness recorded them
	Failed bool   // the harness marked the call failed (an error result, a non-zero exit code)
}

// Parse recognises the bd (beads issue tracker) calls in a shell script and matches them with
// the script's output. cwd is the directory the script runs in ("" when unknown); res is nil
// while the call has no result yet. Each call that names a bead gives one event with Op, IDs
// and what the call and its output say; At, Turn, agent and message fields are the caller's.
//
// bd confirms a write with a line per bead (✓ Created issue: <id> — <title>, ✓ Updated issue,
// ✓ Closed, ✓ Reopened, ✓ Added dependency, ✓ Comment added to, ✓ Note added to), prints JSON
// with --json and the bare id with `bd q`. A confirmed write that no call in the script names
// (a wrapper script that runs bd) gives an event of its own.
func Parse(script, cwd string, res *Result) []model.BeadEvent {
	if !strings.Contains(script, "bd") && (res == nil || !strings.Contains(res.Output, "✓ ")) {
		return nil
	}
	var calls []call
	for _, c := range commands(script, cwd) {
		if !isBd(c.words) {
			continue
		}
		if ca, ok := parseCall(c.words); ok {
			ca.ev.Cwd = c.cwd
			calls = append(calls, ca)
		}
	}
	if res == nil {
		var out []model.BeadEvent
		for _, c := range calls {
			c.ev.Outcome = model.BeadUnknown
			out = append(out, c.ev)
		}
		return out
	}
	o := readOutput(res.Output)
	named := map[string]bool{}
	o.known = map[string]bool{}
	for _, c := range calls {
		for _, id := range c.ev.IDs {
			named[id] = true
			o.known[Prefix(id)] = true
		}
		if c.ev.Parent != "" {
			o.known[Prefix(c.ev.Parent)] = true
		}
	}
	for _, cf := range o.conf {
		if cf.kind != confBare {
			o.known[Prefix(cf.id)] = true
		}
	}
	var out []model.BeadEvent
	for _, c := range calls {
		out = append(out, o.match(c, res, len(calls)))
	}
	// Confirmed writes no call accounts for.
	for i := range o.conf {
		cf := &o.conf[i]
		if cf.used || named[cf.id] || cf.kind == confJSON || cf.kind == confBare {
			continue
		}
		ev := model.BeadEvent{Op: cf.kind.op(), IDs: []string{cf.id}, Title: cf.title, Outcome: model.BeadOK, Cwd: cwd}
		if cf.kind == confDep && cf.other != "" {
			ev.IDs = append(ev.IDs, cf.other)
			ev.DepType = cf.depType
		}
		if ev.Op == model.BeadClose {
			ev.Status = "closed"
		}
		cf.used = true
		out = append(out, ev)
	}
	return out
}

// isBd reports whether a command (wrappers such as xargs already stripped) runs bd.
func isBd(words []string) bool {
	return len(words) > 0 && (words[0] == "bd" || strings.HasSuffix(words[0], "/bd"))
}

// call is one recognised bd invocation.
type call struct {
	ev          model.BeadEvent
	byArgs      bool // the ids came from the arguments (else from the output)
	explicitDep bool // dep add was given --type
}

// valueFlags are the bd flags (global and per command) that take a separate value.
var valueFlags = map[string]bool{
	"--actor": true, "--db": true, "--dir": true, "--status": true, "-s": true, "--reason": true,
	"-r": true, "--reason-file": true, "--parent": true, "--title": true, "--type": true, "-t": true,
	"--priority": true, "-p": true, "--description": true, "-d": true, "--body-file": true,
	"--notes": true, "--append-notes": true, "--design": true, "--acceptance": true,
	"--assignee": true, "-a": true, "--labels": true, "-l": true, "--add-label": true,
	"--remove-label": true, "--set-labels": true, "--deps": true, "--id": true,
	"--external-ref": true, "--estimate": true, "-e": true, "--file": true, "-f": true,
	"--due": true, "--defer": true, "--until": true, "--session": true, "--author": true,
	"--format": true, "--sort": true, "--limit": true, "-n": true, "--since": true,
	"--message": true, "-m": true, "--comment": true,
}

// args splits the words after a bd subcommand into flags (value "" for a boolean) and
// positionals.
func args(words []string) (flags map[string]string, pos []string) {
	flags = map[string]string{}
	for i := 0; i < len(words); i++ {
		w := words[i]
		if len(w) < 2 || w[0] != '-' {
			pos = append(pos, w)
			continue
		}
		if w == "--" {
			pos = append(pos, words[i+1:]...)
			break
		}
		if k := strings.IndexByte(w, '='); k > 0 {
			flags[w[:k]] = w[k+1:]
			continue
		}
		if valueFlags[w] && i+1 < len(words) {
			flags[w] = words[i+1]
			i++
			continue
		}
		flags[w] = ""
	}
	return flags, pos
}

func flag(flags map[string]string, names ...string) (string, bool) {
	for _, n := range names {
		if v, ok := flags[n]; ok {
			return v, true
		}
	}
	return "", false
}

// reID is a bead id: a prefix, a dash, a hash, and child numbers (merlin-t8s.48.1). The
// prefix may itself contain dashes.
var reID = regexp.MustCompile(`^[a-z0-9][a-z0-9_]*(?:-[a-z0-9_]+)*-[a-z0-9]+(?:\.[0-9]+)*$`)

// IsID reports whether s looks like a bead id.
func IsID(s string) bool { return len(s) <= 80 && reID.MatchString(s) }

func ids(pos []string, max int) []string {
	var out []string
	for _, p := range pos {
		if IsID(p) && !slices.Contains(out, p) {
			out = append(out, p)
			if len(out) == max {
				break
			}
		}
	}
	return out
}

// parseCall reads one bd invocation (words[0] is bd). ok is false for a call that is not about
// particular beads.
func parseCall(words []string) (call, bool) {
	i := 1
	for i < len(words) && strings.HasPrefix(words[i], "-") { // global flags
		if !strings.Contains(words[i], "=") && valueFlags[words[i]] {
			i++
		}
		i++
	}
	if i >= len(words) {
		return call{}, false
	}
	sub := words[i]
	flags, pos := args(words[i+1:])
	if _, dry := flags["--dry-run"]; dry {
		return call{}, false
	}
	var c call
	switch sub {
	case "create", "new", "q", "quick":
		c.ev.Op = model.BeadCreate
		c.ev.Title, _ = flag(flags, "--title")
		if c.ev.Title == "" && len(pos) > 0 {
			c.ev.Title = pos[0]
		}
		c.ev.Parent, _ = flag(flags, "--parent")
		if id, ok := flag(flags, "--id"); ok && IsID(id) {
			c.ev.IDs = []string{id}
		}
	case "update", "claim":
		c.ev.Op = model.BeadUpdate
		c.ev.IDs = ids(pos, 0)
		if s, ok := flag(flags, "--status", "-s"); ok {
			c.ev.Status = s
		}
		if _, ok := flags["--claim"]; ok || sub == "claim" {
			c.ev.Op, c.ev.Status = model.BeadClaim, "in_progress"
		}
		if c.ev.Status == "closed" {
			c.ev.Op = model.BeadClose
		}
		c.ev.Title, _ = flag(flags, "--title")
	case "close", "done":
		c.ev.Op, c.ev.Status = model.BeadClose, "closed"
		c.ev.IDs = ids(pos, 0)
		c.ev.Reason, _ = flag(flags, "--reason", "-r", "--message", "-m")
	case "reopen":
		c.ev.Op, c.ev.Status = model.BeadReopen, "open"
		c.ev.IDs = ids(pos, 0)
	case "comment", "note":
		c.ev.Op = model.BeadComment
		c.ev.IDs = ids(pos, 1)
	case "comments":
		if len(pos) > 0 && pos[0] == "add" {
			c.ev.Op = model.BeadComment
			c.ev.IDs = ids(pos[1:], 1)
		} else {
			c.ev.Op = model.BeadShow
			c.ev.IDs = ids(pos, 0)
		}
	case "dep":
		if len(pos) == 0 || pos[0] != "add" {
			return call{}, false
		}
		c.ev.Op = model.BeadDep
		c.ev.IDs = ids(pos[1:], 2)
		c.ev.DepType, c.explicitDep = flag(flags, "--type", "-t")
		if c.ev.DepType == "" {
			c.ev.DepType = "blocks"
		}
	case "show", "view":
		c.ev.Op = model.BeadShow
		c.ev.IDs = ids(pos, 0)
	default:
		return call{}, false
	}
	// A value that is a variable or a substitution says nothing.
	for _, v := range []*string{&c.ev.Title, &c.ev.Reason} {
		if strings.HasPrefix(*v, "$") {
			*v = ""
		}
	}
	if !IsID(c.ev.Parent) {
		c.ev.Parent = ""
	}
	c.byArgs = len(c.ev.IDs) > 0
	if !c.byArgs && c.ev.Op == model.BeadShow {
		return call{}, false // bd show with no literal id
	}
	return c, true
}

// confKind is the kind of a confirmation in the output.
type confKind int

const (
	confCreated confKind = iota
	confUpdated
	confClosed
	confReopened
	confDep
	confComment
	confJSON // an issue object printed with --json
	confBare // a line holding only an id (bd q)
)

func (k confKind) op() model.BeadOp {
	switch k {
	case confCreated:
		return model.BeadCreate
	case confClosed:
		return model.BeadClose
	case confReopened:
		return model.BeadReopen
	case confDep:
		return model.BeadDep
	case confComment:
		return model.BeadComment
	}
	return model.BeadUpdate
}

// accepts lists the confirmation kinds that confirm a call of op, best first.
func accepts(op model.BeadOp) []confKind {
	switch op {
	case model.BeadCreate:
		return []confKind{confCreated, confJSON, confBare}
	case model.BeadClaim, model.BeadUpdate:
		return []confKind{confUpdated, confJSON}
	case model.BeadClose:
		return []confKind{confClosed, confUpdated, confJSON}
	case model.BeadReopen:
		return []confKind{confReopened, confUpdated, confJSON}
	case model.BeadDep:
		return []confKind{confDep}
	case model.BeadComment:
		return []confKind{confComment}
	}
	return []confKind{confJSON}
}

type confirmation struct {
	kind    confKind
	id      string
	title   string
	rest    string // close: what follows the id's " — " (title, then ": reason")
	other   string // dep: the bead it depends on
	depType string
	used    bool
}

type output struct {
	text   string
	conf   []confirmation
	failed map[string]bool // ids named on an error line
	errors bool            // some line is an error line
	known  map[string]bool // prefixes of the ids the calls and the ✓ and JSON lines name
}

var (
	reCreated  = regexp.MustCompile(`^✓ Created issue: (\S+?)(?: — (.*))?$`)
	reUpdated  = regexp.MustCompile(`^✓ Updated issue: (\S+?)(?: — (.*))?$`)
	reClosed   = regexp.MustCompile(`^✓ Closed (\S+?):?(?: — (.*))?$`)
	reReopened = regexp.MustCompile(`^✓ Reopened (\S+?)(?: — (.*))?$`)
	reDep      = regexp.MustCompile(`^✓ Added dependency: (\S+) .*depends on (\S+)`)
	reDepType  = regexp.MustCompile(`\(([a-z-]+)\)\s*$`)
	reComment  = regexp.MustCompile(`^(?:✓ )?(?:Comment|Note) added to (\S+?)[:.]?(?:\s|$)`)
	reErrorID  = regexp.MustCompile(`[a-z0-9][a-z0-9_]*(?:-[a-z0-9_]+)*-[a-z0-9]+(?:\.[0-9]+)*`)
)

func readOutput(text string) *output {
	o := &output{text: text, failed: map[string]bool{}}
	lines := strings.Split(text, "\n")
	offset := 0
	jsonUntil := 0 // output offset up to which JSON was already decoded
	for _, raw := range lines {
		start := offset
		offset += len(raw) + 1
		line := strings.TrimRight(raw, "\r")
		add := func(k confKind, id, title string) *confirmation {
			id = strings.TrimRight(id, ":,.")
			if !IsID(id) {
				return nil
			}
			o.conf = append(o.conf, confirmation{kind: k, id: id, title: strings.TrimSpace(title)})
			return &o.conf[len(o.conf)-1]
		}
		switch {
		case strings.HasPrefix(line, "✓ ") || reComment.MatchString(line):
			if m := reCreated.FindStringSubmatch(line); m != nil {
				add(confCreated, m[1], m[2])
			} else if m := reUpdated.FindStringSubmatch(line); m != nil {
				add(confUpdated, m[1], m[2])
			} else if m := reClosed.FindStringSubmatch(line); m != nil {
				if c := add(confClosed, m[1], ""); c != nil {
					c.rest = m[2]
				}
			} else if m := reReopened.FindStringSubmatch(line); m != nil {
				add(confReopened, m[1], m[2])
			} else if m := reDep.FindStringSubmatch(line); m != nil {
				if c := add(confDep, m[1], ""); c != nil {
					c.other = strings.TrimRight(m[2], ":,.")
					if t := reDepType.FindStringSubmatch(line); t != nil {
						c.depType = t[1]
					}
				}
			} else if m := reComment.FindStringSubmatch(line); m != nil {
				add(confComment, m[1], "")
			}
		case isErrorLine(line):
			o.errors = true
			for _, id := range reErrorID.FindAllString(line, -1) {
				if IsID(id) {
					o.failed[id] = true
				}
			}
		case IsID(line): // a line holding only an id, unindented (bd q; not a listing's entry)
			add(confBare, line, "")
		case start >= jsonUntil && (strings.HasPrefix(line, "{") || strings.HasPrefix(line, "[")):
			n := o.readJSON(text[start:])
			if n > 0 {
				jsonUntil = start + n
			}
		}
	}
	return o
}

func isErrorLine(line string) bool {
	l := strings.TrimSpace(line)
	return strings.HasPrefix(l, "Error") || strings.HasPrefix(l, "error:") ||
		strings.HasPrefix(l, "cannot ") || strings.HasPrefix(l, "✗") ||
		strings.HasPrefix(l, "Issue ") && strings.Contains(l, " not found")
}

// readJSON decodes one JSON value at the start of s and adds the issues in it (objects with an
// id that looks like a bead id). It returns how many bytes it consumed, 0 when s is not JSON.
func (o *output) readJSON(s string) int {
	dec := json.NewDecoder(strings.NewReader(s))
	var v any
	if err := dec.Decode(&v); err != nil {
		return 0
	}
	var visit func(v any)
	visit = func(v any) {
		switch x := v.(type) {
		case []any:
			for _, e := range x {
				visit(e)
			}
		case map[string]any:
			id, _ := x["id"].(string)
			if !IsID(id) {
				return
			}
			title, _ := x["title"].(string)
			o.conf = append(o.conf, confirmation{kind: confJSON, id: id, title: title})
		}
	}
	visit(v)
	return int(dec.InputOffset())
}

// take marks and returns the first unused confirmation of id among kinds, in kind order.
func (o *output) take(id string, kinds []confKind) *confirmation {
	for _, k := range kinds {
		for i := range o.conf {
			c := &o.conf[i]
			if !c.used && c.kind == k && (id == "" || c.id == id) {
				c.used = true
				return c
			}
		}
	}
	return nil
}

// takeNew is take for a create, which names no id. A bare id line counts only when its prefix
// is one the script's other ids use (when they use any): a lone word such as "epic-ok" from an
// echo looks like an id too.
func (o *output) takeNew(kinds []confKind) *confirmation {
	for _, k := range kinds {
		for i := range o.conf {
			c := &o.conf[i]
			if c.used || c.kind != k || k == confBare && len(o.known) > 0 && !o.known[Prefix(c.id)] {
				continue
			}
			c.used = true
			return c
		}
	}
	return nil
}

// match completes a call's event with what the output says about it. n is the number of bd
// calls in the script.
func (o *output) match(c call, res *Result, n int) model.BeadEvent {
	ev := c.ev
	ev.IDs = slices.Clone(ev.IDs)
	kinds := accepts(ev.Op)
	var confirmed []*confirmation
	switch {
	case ev.Op == model.BeadShow:
		for _, id := range ev.IDs {
			if strings.Contains(o.text, id) {
				confirmed = append(confirmed, &confirmation{id: id})
			}
		}
	case ev.Op == model.BeadDep:
		// Either side may be a variable: the line names both.
		for i := range o.conf {
			cf := &o.conf[i]
			if !cf.used && cf.kind == confDep && (slices.Contains(ev.IDs, cf.id) || slices.Contains(ev.IDs, cf.other) || !c.byArgs) {
				cf.used = true
				confirmed = append(confirmed, cf)
				ev.IDs = []string{cf.id, cf.other}
				break
			}
		}
	case c.byArgs:
		for _, id := range ev.IDs {
			if cf := o.take(id, kinds); cf != nil {
				confirmed = append(confirmed, cf)
			}
		}
	case ev.Op == model.BeadCreate:
		if cf := o.takeNew(kinds); cf != nil {
			confirmed = append(confirmed, cf)
			ev.IDs = []string{cf.id}
		}
	default:
		// Ids the arguments do not spell out (a variable, xargs): every unused confirmation of
		// the call's own kind.
		for {
			cf := o.take("", kinds[:1])
			if cf == nil {
				break
			}
			confirmed = append(confirmed, cf)
			ev.IDs = append(ev.IDs, cf.id)
		}
	}
	for _, cf := range confirmed {
		switch {
		case ev.Title == "" && cf.title != "":
			ev.Title = cf.title
		case cf.kind == confClosed && cf.rest != "":
			if ev.Reason != "" && strings.HasSuffix(cf.rest, ": "+ev.Reason) {
				if ev.Title == "" {
					ev.Title = strings.TrimSuffix(cf.rest, ": "+ev.Reason)
				}
			}
		}
		if cf.kind == confDep && !c.explicitDep && cf.depType != "" {
			ev.DepType = cf.depType
		}
	}
	failed := false
	for _, id := range ev.IDs {
		if o.failed[id] {
			failed = true
		}
	}
	switch {
	case failed:
		ev.Outcome = model.BeadFailed
	case len(confirmed) > 0:
		ev.Outcome = model.BeadOK
	case (res.Failed || o.errors) && n == 1:
		// The script's only bd call, nothing confirmed, and the call or an error line says it failed.
		ev.Outcome = model.BeadFailed
	default:
		ev.Outcome = model.BeadUnknown
	}
	return ev
}
