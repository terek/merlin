package term

import "strings"

// Logo renders logoArt with half blocks, two pixel rows per line. Every line is exactly the
// art's width in columns and ends with a reset. It returns nil when !p.Fancy().
func Logo(p Profile) []string {
	if !p.Fancy() {
		return nil
	}
	rows := make([][]rune, len(logoArt))
	for i, r := range logoArt {
		rows[i] = []rune(r)
	}
	var out []string
	for y := 0; y+1 < len(rows); y += 2 {
		top, bot := rows[y], rows[y+1]
		var b strings.Builder
		for x := range top {
			tc, tok := logoColor(top[x])
			var bc RGB
			var bok bool
			if x < len(bot) {
				bc, bok = logoColor(bot[x])
			}
			switch {
			case tok && bok:
				b.WriteString(p.sgr(tc, false) + p.sgr(bc, true) + "▀")
			case tok:
				b.WriteString(reset + p.sgr(tc, false) + "▀")
			case bok:
				b.WriteString(reset + p.sgr(bc, false) + "▄")
			default:
				b.WriteString(reset + " ")
			}
		}
		b.WriteString(reset)
		out = append(out, b.String())
	}
	return out
}

func logoColor(r rune) (RGB, bool) {
	c, ok := logoPalette[r]
	if !ok {
		return RGB{}, false
	}
	return RGB{c[0], c[1], c[2]}, true
}

func logoWidth() int {
	if len(logoArt) == 0 {
		return 0
	}
	return len([]rune(logoArt[0]))
}
