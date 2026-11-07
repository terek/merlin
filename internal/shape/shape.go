// Package shape reports the structure of JSONL session files (field paths, JSON types,
// record kinds and counts) without ever printing what the files say.
//
// The report is meant to be pasted into chats, beads and committed docs, so every
// decision fails closed:
//
//   - Values are never printed, except for a short allowlist of discriminator keys
//     (ValueKeys), matched on the last path element, and only when the value is a short
//     token that does not look like a path, address or secret. Anything else is counted
//     as "other".
//   - Key names are data too. A key is printed only if it looks like an identifier and
//     not like a secret; any other key collapses to "*". An object with more than
//     maxKeys distinct identifier keys at one path collapses all of them to "*". The
//     children of free-form containers (FreeForm) are never walked, only counted.
//   - Record kinds come from discriminator paths; a value that fails the token test is
//     tagged "other".
//   - Parse errors, file names and line contents are never echoed; they are counted.
package shape

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/bits"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	maxKeys       = 40       // distinct identifier keys at one path before collapsing to "*"
	maxValues     = 30       // distinct printed values per path before collapsing to a count
	maxKinds      = 256      // distinct kinds tracked; further ones are tagged "other"
	maxNodes      = 100000   // field nodes tracked in total (bounds memory on hostile input)
	maxChildren   = 200      // identifier children tracked per node before routing to "*"
	maxLine       = 64 << 20 // longer lines are counted as bad
	hardMaxDepth  = 64
	starKey       = "*"
	arrayKey      = "[]"
	deeperKey     = "(deeper)"
	rootPath      = "$"
	unknownKind   = "unknown"
	otherKind     = "other"
	collapsedNote = ">30 distinct"
)

// Options configure a scan. The zero value is not useful; start from DefaultOptions.
type Options struct {
	Discriminators []string // dotted paths whose string values tag a record's kind
	FreeForm       []string // key names whose children are counted, never walked or named
	ValueKeys      []string // key names whose short token values may be printed
	MaxDepth       int      // nesting below this is counted as "(deeper)"
}

// DefaultOptions are the defaults of `merlin shape`.
func DefaultOptions() Options {
	return Options{
		Discriminators: []string{"type", "payload.type", "message.role"},
		FreeForm: []string{"arguments", "args", "input", "tool_input", "toolInput", "details", "data", "env",
			"headers", "parameters", "params", "schema", "metadata", "properties", "options", "extra", "attributes"},
		ValueKeys: []string{"type", "role", "stopReason", "stop_reason", "provider", "api", "model", "modelId",
			"version", "cli_version", "customType", "kind", "subtype", "source", "originator", "status",
			"entrypoint", "userType", "permissionMode", "service_tier", "reasoning_effort", "effort", "level"},
		MaxDepth: 16,
	}
}

// slashKeys are the value keys that may hold a provider/model style token with "/", ":" or "@".
var slashKeys = map[string]bool{"model": true, "modelId": true, "provider": true}

var (
	genericValue = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$`)
	modelValue   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,63}$`)
	identKey     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,48}$`)
	kindToken    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._:-]{0,47}$`)
)

var homeLike = map[string]bool{"users": true, "home": true, "root": true, "var": true, "tmp": true, "etc": true,
	"opt": true, "usr": true, "private": true, "mnt": true, "volumes": true, "library": true, "windows": true}

// looksSecret is a heuristic: long alphanumeric runs with digits, very long runs and well
// known credential prefixes. It errs towards rejecting.
func looksSecret(s string) bool {
	run, hasDigit := 0, false
	flush := func() bool {
		bad := run >= 40 || (run >= 16 && hasDigit)
		run, hasDigit = 0, false
		return bad
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= '0' && c <= '9' {
			hasDigit = true
			run++
		} else if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' {
			run++
		} else if flush() {
			return true
		}
	}
	if flush() {
		return true
	}
	segs := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return strings.ContainsRune("-_.:/@", r) })
	for _, g := range segs {
		switch g {
		case "sk", "pk", "ghp", "gho", "ghu", "ghs", "pat", "bearer", "password", "passwd", "secret":
			return true
		}
		for _, p := range []string{"eyj", "akia", "xox", "github", "glpat", "ghp"} {
			if strings.HasPrefix(g, p) {
				return true
			}
		}
	}
	return false
}

func keyOK(k string) bool { return identKey.MatchString(k) && !looksSecret(k) }

func kindOK(s string) bool { return kindToken.MatchString(s) && !looksSecret(s) }

// valueOK decides whether a string value under the allowlisted key may be printed.
func valueOK(key, s string) bool {
	if slashKeys[key] {
		if !modelValue.MatchString(s) || looksSecret(s) || strings.Contains(s, "..") || strings.Contains(s, ":/") ||
			strings.Count(s, "/") > 2 || net.ParseIP(s) != nil {
			return false
		}
		if i := strings.IndexByte(s, '@'); i >= 0 && strings.Contains(s[i:], ".") {
			return false
		}
		for _, seg := range strings.Split(s, "/") {
			if seg == "" || homeLike[strings.ToLower(seg)] {
				return false
			}
		}
		return true
	}
	return genericValue.MatchString(s) && !looksSecret(s) && net.ParseIP(s) == nil
}

// node is one field path. Children are keyed by printed label.
type node struct {
	label     string
	count     int64
	types     map[string]int64
	files     []uint64
	children  map[string]*node
	allow     bool
	values    map[string]int64
	other     int64
	collapsed bool
}

type kindAgg struct {
	records int64
	files   []uint64
	root    *node
}

type agg struct {
	opt      Options
	words    int
	nodes    int
	kinds    map[string]*kindAgg
	freeForm map[string]bool
	valueKey map[string]bool
	cur      int
	maxDepth int
}

func (a *agg) newNode(label string) *node {
	a.nodes++
	return &node{label: label, allow: a.valueKey[label] && !a.freeForm[strings.ToLower(label)]}
}

func (a *agg) child(n *node, label string) *node {
	if c, ok := n.children[label]; ok {
		return c
	}
	if label != starKey && label != arrayKey && label != deeperKey {
		if a.nodes >= maxNodes || len(n.children) >= maxChildren {
			label = starKey
			if c, ok := n.children[label]; ok {
				return c
			}
		}
	}
	if n.children == nil {
		n.children = map[string]*node{}
	}
	c := a.newNode(label)
	n.children[label] = c
	return c
}

func setBit(b *[]uint64, i, words int) {
	if *b == nil {
		*b = make([]uint64, words)
	}
	(*b)[i/64] |= 1 << (uint(i) % 64)
}

func popcount(b []uint64) int {
	n := 0
	for _, w := range b {
		n += bits.OnesCount64(w)
	}
	return n
}

func jsonType(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case string:
		return "string"
	case json.Number:
		if strings.ContainsAny(string(x), ".eE") {
			return "number"
		}
		return "integer"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

func (a *agg) observe(n *node, v any) {
	n.count++
	t := jsonType(v)
	if n.types == nil {
		n.types = map[string]int64{}
	}
	n.types[t]++
	setBit(&n.files, a.cur, a.words)
	if !n.allow {
		return
	}
	var s string
	ok := false
	switch x := v.(type) {
	case string:
		s, ok = x, valueOK(n.label, x)
	case bool:
		s, ok = strconv.FormatBool(x), true
	case json.Number:
		if t == "integer" && len(x) <= 6 {
			s, ok = string(x), true
		}
	case nil, []any, map[string]any:
		return
	}
	if !ok {
		n.other++
		return
	}
	if n.collapsed {
		return
	}
	if n.values == nil {
		n.values = map[string]int64{}
	}
	n.values[s]++
	if len(n.values) > maxValues {
		n.collapsed, n.values = true, nil
	}
}

func (a *agg) walk(n *node, v any, depth int) {
	a.observe(n, v)
	switch x := v.(type) {
	case map[string]any:
		if depth >= a.maxDepth {
			a.observe(a.child(n, deeperKey), nil)
			return
		}
		if a.freeForm[strings.ToLower(n.label)] {
			star := a.child(n, starKey)
			for _, e := range x {
				a.observe(star, e)
			}
			return
		}
		for k, e := range x {
			label := k
			if !keyOK(k) {
				label = starKey
			}
			a.walk(a.child(n, label), e, depth+1)
		}
	case []any:
		if depth >= a.maxDepth {
			a.observe(a.child(n, deeperKey), nil)
			return
		}
		if a.freeForm[strings.ToLower(n.label)] {
			star := a.child(n, starKey)
			for _, e := range x {
				a.observe(star, e)
			}
			return
		}
		el := a.child(n, arrayKey)
		for _, e := range x {
			a.walk(el, e, depth+1)
		}
	}
}

func lookup(obj map[string]any, path string) (any, bool) {
	var cur any = obj
	for _, p := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = m[p]; !ok {
			return nil, false
		}
	}
	return cur, true
}

func (a *agg) kindOf(rec any) string {
	obj, ok := rec.(map[string]any)
	if !ok {
		return unknownKind
	}
	var tags []string
	for _, d := range a.opt.Discriminators {
		v, found := lookup(obj, d)
		if !found {
			continue
		}
		tag := otherKind
		if s, ok := v.(string); ok && kindOK(s) {
			tag = s
		}
		if len(tags) > 0 && tags[len(tags)-1] == tag {
			continue
		}
		tags = append(tags, tag)
	}
	if len(tags) == 0 {
		return unknownKind
	}
	return strings.Join(tags, "/")
}

// merge folds b into n (used when keys collapse to "*").
func (a *agg) merge(n, b *node) {
	n.count += b.count
	if len(b.types) > 0 && n.types == nil {
		n.types = map[string]int64{}
	}
	for t, c := range b.types {
		n.types[t] += c
	}
	if b.files != nil {
		if n.files == nil {
			n.files = make([]uint64, len(b.files))
		}
		for i, w := range b.files {
			n.files[i] |= w
		}
	}
	for l, c := range b.children {
		if nc, ok := n.children[l]; ok {
			a.merge(nc, c)
			continue
		}
		if n.children == nil {
			n.children = map[string]*node{}
		}
		n.children[l] = c
	}
}

// finalize collapses wide objects, after all input is read, so the result does not
// depend on the order lines were seen in.
func (a *agg) finalize(n *node) {
	ids := 0
	for l := range n.children {
		if l != starKey && l != arrayKey && l != deeperKey {
			ids++
		}
	}
	if ids > maxKeys {
		star := n.children[starKey]
		if star == nil {
			star = &node{label: starKey}
		}
		for l, c := range n.children {
			if l != starKey && l != arrayKey && l != deeperKey {
				a.merge(star, c)
				delete(n.children, l)
			}
		}
		n.children[starKey] = star
	}
	for _, c := range n.children {
		a.finalize(c)
	}
}

// Report is the result of a scan. Nothing in it comes from file names or free text.
type Report struct {
	Files           int          `json:"files"`
	UnreadableFiles int          `json:"unreadableFiles,omitempty"`
	Records         int64        `json:"records"`
	BadLines        int64        `json:"badLines"`
	Kinds           []KindReport `json:"kinds"`
}

// KindReport describes the records of one kind.
type KindReport struct {
	Kind    string  `json:"kind"`
	Records int64   `json:"records"`
	Files   int     `json:"files"`
	Fields  []Field `json:"fields"`
}

// Field is one field path within a kind.
type Field struct {
	Path        string           `json:"path"`
	Types       map[string]int64 `json:"types"`
	Count       int64            `json:"count"`
	Files       int              `json:"files"`
	Values      []ValueCount     `json:"values,omitempty"`
	OtherValues int64            `json:"otherValues,omitempty"`
	Collapsed   bool             `json:"valuesCollapsed,omitempty"`
}

// ValueCount is a printed discriminator value and how often it was seen.
type ValueCount struct {
	Value string `json:"value"`
	Count int64  `json:"count"`
}

func (a *agg) fields(n *node, path string, out *[]Field) {
	f := Field{Path: path, Types: n.types, Count: n.count, Files: popcount(n.files), OtherValues: n.other, Collapsed: n.collapsed}
	if f.Types == nil {
		f.Types = map[string]int64{}
	}
	vs := make([]string, 0, len(n.values))
	for v := range n.values {
		vs = append(vs, v)
	}
	sort.Strings(vs)
	for _, v := range vs {
		f.Values = append(f.Values, ValueCount{v, n.values[v]})
	}
	*out = append(*out, f)
	labels := make([]string, 0, len(n.children))
	for l := range n.children {
		labels = append(labels, l)
	}
	sort.Strings(labels)
	for _, l := range labels {
		p := path + "." + l
		switch {
		case path == rootPath:
			p = l
		case l == arrayKey:
			p = path + arrayKey
		}
		if path == rootPath && l == arrayKey {
			p = rootPath + arrayKey
		}
		a.fields(n.children[l], p, out)
	}
}

func set(list []string) map[string]bool {
	m := map[string]bool{}
	for _, s := range list {
		if s = strings.TrimSpace(s); s != "" {
			m[s] = true
		}
	}
	return m
}

// Scan reads the files and directories named by args (directories are walked for *.jsonl)
// and returns the report. It only reads. The error never contains a path.
func Scan(args []string, opt Options) (*Report, error) {
	files, unreadable, err := collect(args)
	if err != nil {
		return nil, err
	}
	a := &agg{opt: opt, words: (len(files) + 63) / 64, kinds: map[string]*kindAgg{}, freeForm: map[string]bool{}, valueKey: set(opt.ValueKeys)}
	for k := range set(opt.FreeForm) {
		a.freeForm[strings.ToLower(k)] = true
	}
	a.maxDepth = min(max(opt.MaxDepth, 1), hardMaxDepth)
	rep := &Report{Files: len(files), UnreadableFiles: unreadable, Kinds: []KindReport{}}
	for i, p := range files {
		a.cur = i
		if !a.scanFile(p, rep) {
			rep.UnreadableFiles++
		}
	}
	names := make([]string, 0, len(a.kinds))
	for k := range a.kinds {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		ka := a.kinds[k]
		a.finalize(ka.root)
		kr := KindReport{Kind: k, Records: ka.records, Files: popcount(ka.files), Fields: []Field{}}
		a.fields(ka.root, rootPath, &kr.Fields)
		rep.Kinds = append(rep.Kinds, kr)
	}
	return rep, nil
}

func collect(args []string) (files []string, unreadable int, err error) {
	seen := map[string]bool{}
	add := func(p string) {
		if abs, e := filepath.Abs(p); e == nil {
			p = abs
		}
		if !seen[p] {
			seen[p] = true
			files = append(files, p)
		}
	}
	for i, arg := range args {
		st, e := os.Stat(arg)
		if e != nil {
			return nil, 0, fmt.Errorf("argument %d: cannot read", i+1)
		}
		if !st.IsDir() {
			add(arg)
			continue
		}
		_ = filepath.WalkDir(arg, func(p string, d fs.DirEntry, e error) error {
			if e != nil {
				unreadable++
				return nil
			}
			if d.Type().IsRegular() && strings.HasSuffix(p, ".jsonl") {
				add(p)
			}
			return nil
		})
	}
	sort.Strings(files)
	return files, unreadable, nil
}

func (a *agg) scanFile(path string, rep *Report) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	var buf []byte
	for {
		buf = buf[:0]
		tooLong := false
		var rerr error
		for {
			chunk, e := r.ReadSlice('\n')
			if !tooLong {
				if len(buf)+len(chunk) > maxLine {
					tooLong = true
					buf = buf[:0]
				} else {
					buf = append(buf, chunk...)
				}
			}
			if errors.Is(e, bufio.ErrBufferFull) {
				continue
			}
			rerr = e
			break
		}
		line := bytes.TrimSpace(buf)
		if tooLong {
			rep.BadLines++
		} else if len(line) > 0 {
			a.record(line, rep)
		}
		if rerr != nil {
			return rerr == io.EOF
		}
	}
}

func (a *agg) record(line []byte, rep *Report) {
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		rep.BadLines++
		return
	}
	if _, err := dec.Token(); err != io.EOF {
		rep.BadLines++
		return
	}
	rep.Records++
	kind := a.kindOf(v)
	ka := a.kinds[kind]
	if ka == nil {
		if len(a.kinds) >= maxKinds {
			kind = otherKind
			ka = a.kinds[kind]
		}
		if ka == nil {
			ka = &kindAgg{root: a.newNode(rootPath)}
			a.kinds[kind] = ka
		}
	}
	ka.records++
	setBit(&ka.files, a.cur, a.words)
	a.walk(ka.root, v, 0)
}
