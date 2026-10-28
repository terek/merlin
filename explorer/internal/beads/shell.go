package beads

import (
	"path"
	"slices"
	"strings"
)

// command is one simple command of a script: its words, without leading keywords, variable
// assignments and wrappers, and the directory it runs in ("" when unknown).
type command struct {
	words []string
	cwd   string
}

// commands splits a shell script into its simple commands in the order they run, as far as
// that can be seen without running it. cwd is the directory the script starts in; a cd to an
// absolute path, or to a relative one from a known directory, changes it for the commands
// after it. A word that contains a substitution or a variable keeps a '$' so it is never
// mistaken for a literal.
func commands(script, cwd string) []command {
	l := &lexer{s: script}
	l.run(0)
	home := homeOf(cwd)
	var out []command
	for _, words := range expandLoops(l.cmds) {
		words = strip(words)
		if len(words) == 0 {
			continue
		}
		switch words[0] {
		case "cd", "pushd":
			cwd = chdir(cwd, home, words[1:])
			continue
		}
		out = append(out, command{words: words, cwd: cwd})
	}
	return out
}

// expandLoops unrolls `for X in a b c; do …; done` over literal words: the body's commands
// once per value, with $X and ${X} replaced. A loop over anything else (a substitution, a
// glob, no list) is left as it is.
func expandLoops(cmds [][]string) [][]string {
	var out [][]string
	for i := 0; i < len(cmds); i++ {
		c := cmds[i]
		if len(c) < 4 || c[0] != "for" || c[2] != "in" || slices.ContainsFunc(c[3:], func(v string) bool {
			return strings.ContainsAny(v, "$*?[")
		}) {
			out = append(out, c)
			continue
		}
		depth, j := 1, i+1
		for ; j < len(cmds); j++ {
			switch cmds[j][0] {
			case "for", "while", "until":
				depth++
			case "done":
				depth--
			}
			if depth == 0 {
				break
			}
		}
		if j == len(cmds) {
			out = append(out, c) // no done: not a loop this can follow
			continue
		}
		name, body := c[1], cmds[i+1:j]
		for _, v := range c[3:] {
			var round [][]string
			for _, b := range body {
				w := make([]string, len(b))
				for k, x := range b {
					w[k] = strings.NewReplacer("${"+name+"}", v, "$"+name, v).Replace(x)
				}
				round = append(round, w)
			}
			out = append(out, expandLoops(round)...)
		}
		i = j // the done
	}
	return out
}

// homeOf is the home directory a working directory is under (/Users/<name>, /home/<name>,
// /root), "" when it is under none. The digest may not read $HOME: it must depend on the
// session's files only.
func homeOf(dir string) string {
	for _, base := range []string{"/Users/", "/home/"} {
		if rest, ok := strings.CutPrefix(dir, base); ok {
			if name, _, _ := strings.Cut(rest, "/"); name != "" {
				return base + name
			}
		}
	}
	if dir == "/root" || strings.HasPrefix(dir, "/root/") {
		return "/root"
	}
	return ""
}

// chdir is the directory after `cd args` from dir; "" when it cannot be known. home expands ~.
func chdir(dir, home string, args []string) string {
	for len(args) > 0 && strings.HasPrefix(args[0], "-") && args[0] != "-" {
		args = args[1:]
	}
	if len(args) == 0 {
		return home
	}
	t := args[0]
	if home != "" && (t == "~" || strings.HasPrefix(t, "~/")) {
		t = home + t[1:]
	}
	switch {
	case strings.Contains(t, "$") || strings.HasPrefix(t, "~") || t == "-":
		return ""
	case strings.HasPrefix(t, "/"):
		return path.Clean(t)
	case dir != "":
		return path.Join(dir, t)
	}
	return ""
}

var keywords = map[string]bool{
	"if": true, "then": true, "else": true, "elif": true, "do": true, "while": true,
	"until": true, "!": true, "{": true, "time": true,
}

// wrappers run the command that follows them; their own flags are skipped.
var wrappers = map[string]bool{"env": true, "command": true, "exec": true, "nohup": true, "xargs": true}

// xargsValue are the xargs flags that take a separate value.
var xargsValue = map[string]bool{"-I": true, "-n": true, "-L": true, "-P": true, "-d": true, "-s": true, "-E": true}

// strip drops leading keywords, assignments (X=y) and wrappers from a command's words.
func strip(words []string) []string {
	for len(words) > 0 {
		w := words[0]
		switch {
		case keywords[w], isAssignment(w):
			words = words[1:]
		case wrappers[w]:
			words = words[1:]
			for len(words) > 0 && (strings.HasPrefix(words[0], "-") || isAssignment(words[0])) {
				if w == "xargs" && xargsValue[words[0]] && len(words) > 1 {
					words = words[1:]
				}
				words = words[1:]
			}
		default:
			return words
		}
	}
	return nil
}

func isAssignment(w string) bool {
	i := strings.IndexByte(w, '=')
	if i <= 0 {
		return false
	}
	for k, c := range w[:i] {
		if !(c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || k > 0 && c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

// lexer splits a script into commands of words. It understands quoting, escapes, comments,
// command substitution ($( ) and backticks, whose commands are listed before the command that
// holds them), redirections (dropped with their targets) and here-documents (skipped).
type lexer struct {
	s        string
	i        int
	cmds     [][]string
	cur      []string
	word     strings.Builder
	inWord   bool
	heredocs []heredoc
}

type heredoc struct {
	delim string
	dash  bool // <<- : leading tabs of the delimiter line are ignored
}

// run lexes until the end of the script or, inside a substitution, its closing stop byte.
func (l *lexer) run(stop byte) {
	depth := 0 // plain parentheses opened inside a $( ) substitution
	for l.i < len(l.s) {
		c := l.s[l.i]
		switch {
		case stop == '`' && c == '`', stop == ')' && c == ')' && depth == 0:
			l.i++
			l.endCmd()
			return
		case c == ' ' || c == '\t' || c == '\r':
			l.endWord()
			l.i++
		case c == '\n':
			l.endCmd()
			l.i++
			l.skipHeredocs()
		case c == '&' && l.peek(1) == '>':
			l.i++
			l.redirect()
		case c == ';' || c == '&' || c == '|':
			l.endCmd()
			l.i++
		case c == '(':
			depth++
			l.endCmd()
			l.i++
		case c == ')':
			depth--
			l.endCmd()
			l.i++
		case c == '<' || c == '>':
			l.redirect()
		case c == '\'':
			l.inWord = true
			end := strings.IndexByte(l.s[l.i+1:], '\'')
			if end < 0 {
				l.word.WriteString(l.s[l.i+1:])
				l.i = len(l.s)
			} else {
				l.word.WriteString(l.s[l.i+1 : l.i+1+end])
				l.i += end + 2
			}
		case c == '"':
			l.dquote()
		case c == '\\':
			if l.peek(1) != '\n' && l.i+1 < len(l.s) {
				l.word.WriteByte(l.s[l.i+1])
				l.inWord = true
			}
			l.i += 2
		case c == '`':
			l.i++
			l.subst('`')
		case c == '$' && l.peek(1) == '(':
			l.i += 2
			l.subst(')')
		case c == '#' && !l.inWord:
			for l.i < len(l.s) && l.s[l.i] != '\n' {
				l.i++
			}
		default:
			l.word.WriteByte(c)
			l.inWord = true
			l.i++
		}
	}
	l.endCmd()
}

func (l *lexer) peek(k int) byte {
	if l.i+k < len(l.s) {
		return l.s[l.i+k]
	}
	return 0
}

// subst lexes a command substitution with a lexer of its own and adds its commands; the word
// being built gets a '$' in its place.
func (l *lexer) subst(stop byte) {
	sub := &lexer{s: l.s, i: l.i}
	sub.run(stop)
	l.cmds = append(l.cmds, sub.cmds...)
	l.i = sub.i
	l.word.WriteByte('$')
	l.inWord = true
}

// dquote reads a double-quoted part of a word.
func (l *lexer) dquote() {
	l.inWord = true
	l.i++
	for l.i < len(l.s) {
		c := l.s[l.i]
		switch {
		case c == '"':
			l.i++
			return
		case c == '\\' && strings.IndexByte("\"\\$`\n", l.peek(1)) >= 0 && l.peek(1) != 0:
			if l.peek(1) != '\n' {
				l.word.WriteByte(l.peek(1))
			}
			l.i += 2
		case c == '`':
			l.i++
			l.subst('`')
		case c == '$' && l.peek(1) == '(':
			l.i += 2
			l.subst(')')
		default:
			l.word.WriteByte(c)
			l.i++
		}
	}
}

// redirect drops a redirection (or registers a here-document) and its target. A file
// descriptor number written just before it is not a word.
func (l *lexer) redirect() {
	if l.inWord && isDigits(l.word.String()) {
		l.word.Reset()
		l.inWord = false
	}
	l.endWord()
	if strings.HasPrefix(l.s[l.i:], "<<<") {
		l.i += 3
		l.target()
		return
	}
	if strings.HasPrefix(l.s[l.i:], "<<") {
		l.i += 2
		dash := l.peek(0) == '-'
		if dash {
			l.i++
		}
		if d := l.target(); d != "" {
			l.heredocs = append(l.heredocs, heredoc{delim: d, dash: dash})
		}
		return
	}
	for l.i < len(l.s) && strings.IndexByte("<>&|", l.s[l.i]) >= 0 {
		l.i++
	}
	l.target()
}

// target reads the word after a redirection operator, quotes removed.
func (l *lexer) target() string {
	for l.i < len(l.s) && (l.s[l.i] == ' ' || l.s[l.i] == '\t') {
		l.i++
	}
	var b strings.Builder
	for l.i < len(l.s) {
		c := l.s[l.i]
		if strings.IndexByte(" \t\r\n;&|<>()", c) >= 0 {
			break
		}
		if c == '\'' || c == '"' {
			end := strings.IndexByte(l.s[l.i+1:], c)
			if end < 0 {
				b.WriteString(l.s[l.i+1:])
				l.i = len(l.s)
				break
			}
			b.WriteString(l.s[l.i+1 : l.i+1+end])
			l.i += end + 2
			continue
		}
		if c == '\\' {
			l.i++
			if l.i < len(l.s) {
				b.WriteByte(l.s[l.i])
			}
			l.i++
			continue
		}
		b.WriteByte(c)
		l.i++
	}
	return b.String()
}

// skipHeredocs skips the bodies of the here-documents opened on the line just ended.
func (l *lexer) skipHeredocs() {
	for _, h := range l.heredocs {
		for l.i < len(l.s) {
			end := strings.IndexByte(l.s[l.i:], '\n')
			var line string
			if end < 0 {
				line, l.i = l.s[l.i:], len(l.s)
			} else {
				line = l.s[l.i : l.i+end]
				l.i += end + 1
			}
			line = strings.TrimRight(line, "\r")
			if h.dash {
				line = strings.TrimLeft(line, "\t")
			}
			if line == h.delim {
				break
			}
		}
	}
	l.heredocs = nil
}

func (l *lexer) endWord() {
	if l.inWord {
		l.cur = append(l.cur, l.word.String())
	}
	l.word.Reset()
	l.inWord = false
}

func (l *lexer) endCmd() {
	l.endWord()
	if len(l.cur) > 0 {
		l.cmds = append(l.cmds, l.cur)
	}
	l.cur = nil
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
