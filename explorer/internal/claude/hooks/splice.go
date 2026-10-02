package hooks

import (
	"fmt"
	"strings"

	"github.com/tidwall/gjson"
)

// item is one member of a JSON object or element of a JSON array, located by
// byte offsets in the document. For object members start is the key's first
// byte; for array elements it is the value's first byte.
type item struct {
	key        string
	start, end int
}

func isWS(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func skipWS(s string, i int) int {
	for i < len(s) && isWS(s[i]) {
		i++
	}
	return i
}

// scan lists the members of the container whose opening bracket is at doc[open].
func scan(doc string, open int) ([]item, error) {
	if open < 0 || open >= len(doc) || (doc[open] != '{' && doc[open] != '[') {
		return nil, fmt.Errorf("no container at offset %d", open)
	}
	obj := doc[open] == '{'
	var items []item
	pos := open + 1
	for {
		pos = skipWS(doc, pos)
		if pos >= len(doc) {
			return nil, fmt.Errorf("unterminated container")
		}
		if doc[pos] == '}' || doc[pos] == ']' {
			return items, nil
		}
		it := item{start: pos}
		if obj {
			if doc[pos] != '"' {
				return nil, fmt.Errorf("bad object key at offset %d", pos)
			}
			kend := valueEnd(doc, pos)
			it.key = gjson.Parse(doc[pos:kend]).String()
			pos = skipWS(doc, kend)
			if pos >= len(doc) || doc[pos] != ':' {
				return nil, fmt.Errorf("missing colon at offset %d", pos)
			}
			pos = skipWS(doc, pos+1)
		}
		it.end = valueEnd(doc, pos)
		if it.end <= pos {
			return nil, fmt.Errorf("bad value at offset %d", pos)
		}
		items = append(items, it)
		pos = skipWS(doc, it.end)
		if pos < len(doc) && doc[pos] == ',' {
			pos++
		}
	}
}

// appendItem inserts text (a member `"k":v` or an element) as the last item of
// the container at doc[open], reusing the whitespace that precedes the current
// last item so the result matches the file's own layout.
func appendItem(doc string, open int, text string) (string, error) {
	items, err := scan(doc, open)
	if err != nil {
		return "", err
	}
	if len(items) == 0 {
		return doc[:open+1] + text + doc[open+1:], nil
	}
	last := items[len(items)-1]
	ws := last.start
	for ws > 0 && isWS(doc[ws-1]) {
		ws--
	}
	return doc[:last.end] + "," + doc[ws:last.start] + text + doc[last.end:], nil
}

// removeItem deletes items[idx] of the container at doc[open] together with one
// adjacent separator, which undoes appendItem exactly.
func removeItem(doc string, open, idx int) (string, error) {
	items, err := scan(doc, open)
	if err != nil {
		return "", err
	}
	if idx < 0 || idx >= len(items) {
		return "", fmt.Errorf("no item %d", idx)
	}
	it := items[idx]
	from, to := it.start, it.end
	switch {
	case idx > 0:
		from = items[idx-1].end
	case len(items) > 1:
		to = items[1].start
	}
	return doc[:from] + doc[to:], nil
}

// rootOpen returns the offset of the document's top-level '{'.
func rootOpen(doc string) (int, error) {
	if !gjson.Valid(doc) {
		return 0, fmt.Errorf("not valid JSON")
	}
	i := skipWS(doc, 0)
	if i >= len(doc) || doc[i] != '{' {
		return 0, fmt.Errorf("top level is not an object")
	}
	return i, nil
}

func quote(s string) string { return `"` + escape(s) + `"` }

func escape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\n':
			b.WriteString(`\n`)
		case '\t':
			b.WriteString(`\t`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	return b.String()
}

// valueEnd returns the offset just past the JSON value that starts at doc[pos].
// doc is assumed to be valid JSON (checked once by rootOpen).
func valueEnd(doc string, pos int) int {
	depth := 0
	for i := pos; i < len(doc); i++ {
		switch c := doc[i]; c {
		case '"':
			for i++; i < len(doc) && doc[i] != '"'; i++ {
				if doc[i] == '\\' {
					i++
				}
			}
			if depth == 0 {
				return i + 1
			}
		case '{', '[':
			depth++
		case '}', ']':
			if depth == 0 {
				return i
			}
			depth--
			if depth == 0 {
				return i + 1
			}
		case ',', ' ', '\t', '\n', '\r':
			if depth == 0 {
				return i
			}
		}
	}
	return len(doc)
}
