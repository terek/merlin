package pi

import (
	"strings"
)

// piSpawn is a `pi` command in a bash call that ran with --no-session: a child Pi whose run
// left no session file anywhere, so nothing records what it spent.
type piSpawn struct {
	model string // the --model argument, as written; "" when none
}

// piSpawns finds the commands of a shell command line that start a child Pi without a session.
// A command is simple: the words between &&, ||, ;, |, & or a newline (outside quotes). Its
// command word is the first one that is not a VAR=value assignment, and counts as pi when it is
// "pi" or a path ending in "/pi". Anything else (echo pi --no-session, pip install x, grep pi
// file, a script that runs pi, bash -c "pi ...") is not looked into: what those do is unknown.
func piSpawns(script string) []piSpawn {
	if !strings.Contains(script, "--no-session") {
		return nil
	}
	var out []piSpawn
	for _, words := range simpleCommands(script) {
		i := 0
		for i < len(words) && isAssign(words[i]) {
			i++
		}
		if i >= len(words) || !(words[i] == "pi" || strings.HasSuffix(words[i], "/pi")) {
			continue
		}
		args := words[i+1:]
		sp, noSession := piSpawn{}, false
		for k := 0; k < len(args); k++ {
			switch a := args[k]; {
			case a == "--no-session":
				noSession = true
			case a == "--model" && k+1 < len(args):
				sp.model = args[k+1]
				k++
			case strings.HasPrefix(a, "--model="):
				sp.model = strings.TrimPrefix(a, "--model=")
			}
		}
		if noSession {
			out = append(out, sp)
		}
	}
	return out
}

// isAssign reports a leading VAR=value word.
func isAssign(w string) bool {
	k := strings.IndexByte(w, '=')
	if k <= 0 {
		return false
	}
	for i := 0; i < k; i++ {
		c := w[i]
		if !(c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || i > 0 && c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

// simpleCommands splits a command line into the words of each simple command. Quotes ('..',
// "..") and backslashes group characters into a word; the quotes are removed. It is a
// recogniser, not a shell: substitutions, subshells and here-documents are not interpreted.
func simpleCommands(s string) [][]string {
	var cmds [][]string
	var words []string
	var cur strings.Builder
	inWord := false
	endWord := func() {
		if inWord {
			words = append(words, cur.String())
			cur.Reset()
			inWord = false
		}
	}
	endCmd := func() {
		endWord()
		if len(words) > 0 {
			cmds = append(cmds, words)
			words = nil
		}
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\' && i+1 < len(s):
			i++
			cur.WriteByte(s[i])
			inWord = true
		case c == '\'':
			inWord = true
			for i++; i < len(s) && s[i] != '\''; i++ {
				cur.WriteByte(s[i])
			}
		case c == '"':
			inWord = true
			for i++; i < len(s) && s[i] != '"'; i++ {
				if s[i] == '\\' && i+1 < len(s) && strings.IndexByte("\"\\$`", s[i+1]) >= 0 {
					i++
				}
				cur.WriteByte(s[i])
			}
		case c == ' ' || c == '\t' || c == '\r':
			endWord()
		case c == '\n' || c == ';' || c == '|' || c == '&' || c == '(' || c == ')':
			endCmd()
		default:
			cur.WriteByte(c)
			inWord = true
		}
	}
	endCmd()
	return cmds
}
