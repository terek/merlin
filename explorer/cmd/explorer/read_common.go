package main

// Shared plumbing of the read commands (sessions, show, search, cost, doctor): loading
// the catalog, parsing flags and durations, resolving ids and projects, and formatting.

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/terek/merlin/explorer/internal/catalog"
	"github.com/terek/merlin/explorer/internal/model"
	"github.com/terek/merlin/explorer/internal/paths"
	"github.com/terek/merlin/explorer/internal/store"
)

// claudeHarness is the only harness today; the registry of live sessions is read for it.
const claudeHarness = "claude"

// world is everything a read command needs: the catalog over all digests, the digests
// themselves (doctor reads the error stubs), the live registry and the current time.
type world struct {
	cat      *catalog.Catalog
	digests  []*model.SessionDigest // every digest read, stubs included, in store order
	sessions []*model.SessionDigest // indexed sessions only (no stubs), in store order
	live     catalog.Liveness
	now      time.Time
	projects map[string]string // project path -> short label
}

// currentTime is the clock of the read commands. EXPLORER_NOW (RFC 3339) fixes it; it
// exists for tests.
func currentTime() time.Time {
	if v := os.Getenv("EXPLORER_NOW"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			return t
		}
	}
	return time.Now()
}

// aliveFunc decides whether a registry entry's process exists. EXPLORER_TEST_ALIVE_PIDS
// (a comma separated pid list, possibly empty) replaces the real check; it exists for
// tests.
func aliveFunc() func(int) bool {
	v, ok := os.LookupEnv("EXPLORER_TEST_ALIVE_PIDS")
	if !ok {
		return nil
	}
	var pids []int
	for _, f := range strings.Split(v, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(f)); err == nil {
			pids = append(pids, n)
		}
	}
	return func(pid int) bool { return slices.Contains(pids, pid) }
}

// loadWorld reads every digest of the Explorer home into a catalog. name is the command
// name, for messages.
func loadWorld(name string) (*world, error) {
	home, err := paths.ExplorerHome()
	if err != nil {
		return nil, err
	}
	st, err := store.New(home)
	if err != nil {
		return nil, err
	}
	st.Warn = func(msg string) { fmt.Fprintf(os.Stderr, "merlin %s: %s\n", name, msg) }
	refs, err := st.List("")
	if err != nil {
		return nil, err
	}
	w := &world{cat: catalog.New(), now: currentTime()}
	for _, r := range refs {
		d, found, err := st.Read(r)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		w.digests = append(w.digests, d)
		if d.Error == "" {
			w.sessions = append(w.sessions, d)
		}
		w.cat.Upsert(d)
	}
	cfg, err := paths.ClaudeConfigDir()
	if err != nil {
		return nil, err
	}
	reg, err := catalog.ReadRegistry(claudeHarness, filepath.Join(cfg, "sessions"), aliveFunc())
	if err != nil {
		reg = catalog.Registry{}
	}
	w.live = catalog.Liveness{Registry: reg, Now: w.now}
	var all []string
	for _, d := range w.sessions {
		all = append(all, d.Project)
	}
	w.projects = projectLabels(all)
	return w, nil
}

// projectLabels gives every project path the shortest trailing part of the path that is
// unique among the projects: usually the last element, "acme/app" when two projects end
// in "app".
func projectLabels(all []string) map[string]string {
	uniq := map[string]bool{}
	for _, p := range all {
		uniq[p] = true
	}
	out := map[string]string{}
	for p := range uniq {
		parts := strings.Split(strings.TrimRight(p, "/"), "/")
		label := p
		for n := 1; n <= len(parts); n++ {
			cand := strings.Join(parts[len(parts)-n:], "/")
			clash := false
			for q := range uniq {
				if q != p && (q == cand || strings.HasSuffix(q, "/"+cand)) {
					clash = true
					break
				}
			}
			if !clash {
				label = cand
				break
			}
		}
		if label == "" {
			label = "/"
		}
		out[p] = label
	}
	return out
}

func (w *world) label(project string) string {
	if l, ok := w.projects[project]; ok {
		return l
	}
	return lastElem(project)
}

func lastElem(p string) string {
	p = strings.TrimRight(p, "/")
	if i := strings.LastIndex(p, "/"); i >= 0 && i < len(p)-1 {
		return p[i+1:]
	}
	if p == "" {
		return "/"
	}
	return p
}

// shortID is the shortest prefix of a session id, at least 8 characters, that no other
// indexed session shares.
func (w *world) shortID(id string) string {
	n := 8
	for _, d := range w.sessions {
		if d.ID == id {
			continue
		}
		n = max(n, commonPrefix(d.ID, id)+1)
	}
	if n > len(id) {
		n = len(id)
	}
	return id[:n]
}

func commonPrefix(a, b string) int {
	n := 0
	for n < len(a) && n < len(b) && a[n] == b[n] {
		n++
	}
	return n
}

// resolveSession finds a session by full id or unique prefix. The error of an ambiguous
// prefix lists the candidates.
func (w *world) resolveSession(arg string) (model.SessionKey, error) {
	arg = strings.ToLower(strings.TrimSpace(arg))
	if arg == "" {
		return model.SessionKey{}, errors.New("empty session id")
	}
	var matches []*model.SessionDigest
	for _, d := range w.sessions {
		id := strings.ToLower(d.ID)
		if id == arg {
			return d.Key(), nil
		}
		if strings.HasPrefix(id, arg) {
			matches = append(matches, d)
		}
	}
	switch len(matches) {
	case 0:
		return model.SessionKey{}, fmt.Errorf("no session matches %q", arg)
	case 1:
		return matches[0].Key(), nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%q matches %d sessions; give more characters:", arg, len(matches))
	for i, d := range matches {
		if i == 10 {
			fmt.Fprintf(&b, "\n  ... and %d more", len(matches)-10)
			break
		}
		title := d.Title
		if title == "" {
			title = "(untitled)"
		}
		fmt.Fprintf(&b, "\n  %s  %-12s %s", d.ID, w.label(d.Project), snip(title, 50))
	}
	return model.SessionKey{}, errors.New(b.String())
}

// resolveProject maps a --project value to a project directory. It accepts the path, the
// harness storage key, or a trailing part of the path ("app", "acme/app"). A trailing
// part that fits several projects is an error listing them.
func (w *world) resolveProject(arg string) (string, error) {
	if arg == "" {
		return "", nil
	}
	trimmed := strings.TrimRight(arg, "/")
	var paths []string
	seen := map[string]bool{}
	for _, d := range w.sessions {
		if seen[d.Project] {
			continue
		}
		seen[d.Project] = true
		if d.Project == trimmed || d.ProjectKey == arg {
			return d.Project, nil
		}
		if strings.HasSuffix(d.Project, "/"+strings.TrimLeft(trimmed, "/")) {
			paths = append(paths, d.Project)
		}
	}
	sort.Strings(paths)
	switch len(paths) {
	case 0:
		return "", fmt.Errorf("no project matches %q", arg)
	case 1:
		return paths[0], nil
	}
	return "", fmt.Errorf("project %q matches %d projects; give more of the path:\n  %s", arg, len(paths), strings.Join(paths, "\n  "))
}

// parseSince turns a --since value into an instant: a duration back from now ("90m",
// "36h", "7d", "2w") or a date ("2026-09-01", local midnight).
func parseSince(s string, now time.Time) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, nil
	}
	if t, err := time.ParseInLocation("2006-01-02", s, time.Local); err == nil {
		return t, nil
	}
	if n := len(s); n > 1 && (s[n-1] == 'd' || s[n-1] == 'w') {
		k, err := strconv.Atoi(s[:n-1])
		if err == nil && k >= 0 {
			days := k
			if s[n-1] == 'w' {
				days *= 7
			}
			return now.AddDate(0, 0, -days), nil
		}
	}
	if d, err := time.ParseDuration(s); err == nil && d >= 0 {
		return now.Add(-d), nil
	}
	return time.Time{}, fmt.Errorf("cannot read --since %q: use a duration such as 90m, 36h, 7d, 2w, or a date such as 2026-09-01", s)
}

func parseKinds(s string) ([]model.SessionKind, error) {
	if s == "" {
		return nil, nil
	}
	switch k := model.SessionKind(s); k {
	case model.KindInteractive, model.KindBackground:
		return []model.SessionKind{k}, nil
	case model.KindSDK:
		return nil, errors.New("scripted (sdk) sessions are shown only in aggregate; use `merlin cost --by kind`")
	}
	return nil, fmt.Errorf("unknown --kind %q: use interactive or background", s)
}

// --- command scaffolding -------------------------------------------------------------

// usageError marks a mistake in how a command was called (exit code 2).
type usageError string

func (e usageError) Error() string { return string(e) }

// parseArgs parses flags that may come before, between or after the positional
// arguments. It returns the positionals. help is true when -h/--help was asked for; the
// caller prints it to stdout and exits 0.
func parseArgs(name string, fs *flag.FlagSet, help string, args []string) (pos []string, showHelp bool, err error) {
	for _, a := range args {
		if a == "--" {
			break
		}
		if a == "-h" || a == "--help" || a == "-help" {
			return nil, true, nil
		}
	}
	fs.SetOutput(io.Discard)
	fs.Usage = func() {}
	rest := args
	for {
		if err := fs.Parse(rest); err != nil {
			return nil, false, usageError(err.Error())
		}
		rest = fs.Args()
		if len(rest) == 0 {
			return pos, false, nil
		}
		if rest[0] == "--" {
			return append(pos, rest[1:]...), false, nil
		}
		pos = append(pos, rest[0])
		rest = rest[1:]
	}
}

// finish prints a command's error and returns its exit code.
func finish(name string, err error) int {
	if err == nil {
		return 0
	}
	fmt.Fprintf(os.Stderr, "merlin %s: %v\n", name, err)
	var ue usageError
	if errors.As(err, &ue) {
		fmt.Fprintf(os.Stderr, "try: merlin %s --help\n", name)
		return 2
	}
	return 1
}

func writeJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

// emptyHint says, on stderr, that nothing is indexed yet.
func (w *world) emptyHint(name string) {
	if len(w.sessions) == 0 {
		fmt.Fprintf(os.Stderr, "merlin %s: no sessions indexed; run `merlin scan` first\n", name)
	}
}

// --- terminal ------------------------------------------------------------------------

// termWidth is the width to fit output to: COLUMNS, else the terminal's, else 0
// (unlimited, e.g. when piped).
func termWidth() int {
	if v := os.Getenv("COLUMNS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return ttyWidth(os.Stdout)
}

// --- formatting ----------------------------------------------------------------------

// usd formats a dollar amount with enough digits to be useful at its size.
func usd(v float64) string {
	neg := ""
	if v < 0 {
		neg, v = "-", -v
	}
	switch {
	case v == 0:
		return "$0"
	case v < 0.01:
		return neg + fmt.Sprintf("$%.4f", v)
	case v < 1:
		return neg + fmt.Sprintf("$%.3f", v)
	}
	return neg + "$" + commas(fmt.Sprintf("%.2f", v))
}

func commas(s string) string {
	dot := strings.IndexByte(s, '.')
	if dot < 0 {
		dot = len(s)
	}
	head, tail := s[:dot], s[dot:]
	if len(head) <= 3 {
		return s
	}
	var b strings.Builder
	for i, c := range head {
		if i > 0 && (len(head)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String() + tail
}

// marked adds the cost notation: "≈" before an amount that is only recomputed from
// tokens (estimated), "*" after one that is partly recomputed (partial).
func marked(v float64, flag catalog.CostFlag) string {
	switch flag {
	case catalog.CostEstimated:
		return "≈" + usd(v)
	case catalog.CostPartial:
		return usd(v) + "*"
	}
	return usd(v)
}

// moneyFlag derives the notation for an aggregate from its reported/attributed split.
func moneyFlag(m catalog.Money) catalog.CostFlag {
	switch {
	case m.AttributedUSD > 0 && m.ReportedUSD == 0:
		return catalog.CostEstimated
	case m.AttributedUSD > 0:
		return catalog.CostPartial
	}
	return catalog.CostExact
}

const costLegend = "cost notation: ≈ estimated from tokens (no reported figure)   * partly estimated (some spend outside Claude Code's reported windows)"

// snip collapses whitespace and cuts to n runes.
func snip(s string, n int) string {
	return cut(strings.Join(strings.Fields(s), " "), n)
}

// cut shortens s to n runes, ending in an ellipsis.
func cut(s string, n int) string {
	if n <= 0 || utf8.RuneCountInString(s) <= n {
		return s
	}
	if n == 1 {
		return "…"
	}
	r := []rune(s)
	return strings.TrimRight(string(r[:n-1]), " ") + "…"
}

func fmtDur(ms int64) string {
	d := time.Duration(ms) * time.Millisecond
	switch {
	case d < time.Second:
		return fmt.Sprintf("%dms", ms)
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dd%02dh", int(d.Hours())/24, int(d.Hours())%24)
}

func fmtTokens(n int64) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1000:
		return fmt.Sprintf("%.0fk", float64(n)/1e3)
	}
	return strconv.FormatInt(n, 10)
}

// when formats a moment in local time, relative when recent.
func when(t, now time.Time) string {
	if t.IsZero() {
		return "-"
	}
	t, now = t.Local(), now.Local()
	if d := now.Sub(t); d >= 0 && d < time.Hour {
		if d < time.Minute {
			return "just now"
		}
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	}
	ty, tm, td := t.Date()
	ny, nm, nd := now.Date()
	clock := t.Format("15:04")
	switch {
	case ty == ny && tm == nm && td == nd:
		return "today " + clock
	}
	y := now.AddDate(0, 0, -1)
	if yy, ym, yd := y.Date(); ty == yy && tm == ym && td == yd {
		return "yesterday " + clock
	}
	if ty == ny {
		return t.Format("Jan 2 15:04")
	}
	return t.Format("2006 Jan 2")
}

// stamp is an absolute local time for detail views.
func stamp(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.Local().Format("Jan 2 15:04")
}

// shellQuote quotes a path for the resume command only when it needs it.
func shellQuote(s string) string {
	if s != "" && strings.IndexFunc(s, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("/._-+=:@%,~", r))
	}) < 0 {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// resumeCommand is what to type to pick a session up again: Claude Code finds a session
// by the directory it was started in.
func resumeCommand(project, id string) string {
	if project == "" {
		return "claude --resume " + id
	}
	return "cd " + shellQuote(project) + " && claude --resume " + id
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// stateText says whether a session is running or how it ended.
func stateText(in catalog.SessionInfo) string {
	var s string
	switch {
	case in.State == catalog.StateBusy:
		s = "running (busy)"
	case in.State == catalog.StateIdle:
		s = "running (idle)"
	case in.EndState == "" || in.EndState == model.EndUnknown:
		s = "-"
	default:
		s = string(in.EndState)
	}
	if in.SourceMissing {
		s += " (files gone)"
	}
	return s
}

// --- tables --------------------------------------------------------------------------

type column struct {
	head  string
	right bool // right aligned
	flex  bool // may be shortened to fit the terminal
	max   int  // widest the column gets (0: no limit)
}

// renderTable writes an aligned table. Flex columns shrink to make the table fit width
// (0: no limit).
func renderTable(out io.Writer, cols []column, rows [][]string, width int) {
	const gap = 2
	wid := make([]int, len(cols))
	for i, c := range cols {
		wid[i] = utf8.RuneCountInString(c.head)
	}
	for _, r := range rows {
		for i := range cols {
			if n := utf8.RuneCountInString(r[i]); n > wid[i] {
				wid[i] = n
			}
		}
	}
	for i, c := range cols {
		if c.max > 0 && wid[i] > c.max {
			wid[i] = c.max
		}
	}
	if width > 0 {
		for {
			total := gap * (len(cols) - 1)
			for _, w := range wid {
				total += w
			}
			over := total - width
			if over <= 0 {
				break
			}
			pick := -1
			for i, c := range cols {
				if c.flex && wid[i] > 12 && (pick < 0 || wid[i] > wid[pick]) {
					pick = i
				}
			}
			if pick < 0 {
				break
			}
			wid[pick] = max(12, wid[pick]-over)
		}
	}
	line := func(cells []string) {
		var b strings.Builder
		for i, c := range cols {
			cell := cut(cells[i], wid[i])
			pad := wid[i] - utf8.RuneCountInString(cell)
			if i > 0 {
				b.WriteString(strings.Repeat(" ", gap))
			}
			if c.right {
				b.WriteString(strings.Repeat(" ", pad))
				b.WriteString(cell)
			} else {
				b.WriteString(cell)
				b.WriteString(strings.Repeat(" ", pad))
			}
		}
		fmt.Fprintln(out, strings.TrimRight(b.String(), " "))
	}
	heads := make([]string, len(cols))
	for i, c := range cols {
		heads[i] = c.head
	}
	line(heads)
	for _, r := range rows {
		line(r)
	}
}
