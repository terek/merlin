package term

import "strings"

// BannerLine is one "label  value" row; Value may already contain escapes (e.g. a Link).
type BannerLine struct{ Label, Value string }

// BannerInfo is what the banner shows next to the logo.
type BannerInfo struct {
	Version string
	Tagline string
	Lines   []BannerLine
}

var wordmark = [6]string{
	"███╗   ███╗███████╗██████╗ ██╗     ██╗███╗   ██╗",
	"████╗ ████║██╔════╝██╔══██╗██║     ██║████╗  ██║",
	"██╔████╔██║█████╗  ██████╔╝██║     ██║██╔██╗ ██║",
	"██║╚██╔╝██║██╔══╝  ██╔══██╗██║     ██║██║╚██╗██║",
	"██║ ╚═╝ ██║███████╗██║  ██║███████╗██║██║ ╚████║",
	"╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝",
}

// wordShadow colours the box-drawing shadow; mid-dark violet reads on dark and light terminals.
var wordShadow = RGB{0x6A, 0x55, 0xA0}

const bannerMinWidth = 80 // the full layout is 79 columns: 2 + logo 26 + 2 + wordmark 48 + 1 spare

func wordmarkLines(p Profile) []string {
	out := make([]string, len(wordmark))
	for row, line := range wordmark {
		rs := []rune(line)
		var b strings.Builder
		for col, r := range rs {
			if r == '█' {
				t := 0.6*float64(col)/float64(len(rs)) + 0.4*float64(row)/5
				b.WriteString(p.sgr(Gradient(Lilac, Violet, t), false) + "█")
			} else if r == ' ' {
				b.WriteString(" ")
			} else {
				b.WriteString(p.sgr(wordShadow, false) + string(r))
			}
		}
		b.WriteString(reset)
		out[row] = b.String()
	}
	return out
}

func bannerRows(p Profile, info BannerInfo) []string {
	pad := 0
	for _, l := range info.Lines {
		if n := len([]rune(l.Label)); n > pad {
			pad = n
		}
	}
	var rows []string
	for _, l := range info.Lines {
		label := l.Label + strings.Repeat(" ", pad-len([]rune(l.Label)))
		rows = append(rows, p.Fg(Green, "▸")+" "+p.Dim(label)+"  "+p.Bold(l.Value))
	}
	return rows
}

func versionLine(p Profile, info BannerInfo) string {
	return p.Dim("explorer ") + p.Fg(Lavender, "v"+info.Version) + p.Dim("  ·  "+info.Tagline)
}

// Banner returns the whole banner, ending in "\n", or "" when !p.Fancy().
func Banner(p Profile, info BannerInfo) string {
	if !p.Fancy() {
		return ""
	}
	w := p.Width
	if w == 0 {
		w = 80
	}
	var b strings.Builder
	if w < bannerMinWidth {
		title := p.Bold(p.Fg(Lavender, "◆")) + " "
		letters := []rune("MERLIN")
		for i, r := range letters {
			title += p.Bold(p.Fg(Gradient(Lavender, Violet, float64(i)/float64(len(letters)-1)), string(r)))
		}
		b.WriteString(title + " " + p.Dim("explorer ") + p.Fg(Lavender, "v"+info.Version) + "\n")
		for _, r := range bannerRows(p, info) {
			b.WriteString(r + "\n")
		}
		b.WriteString("\n")
		return b.String()
	}

	logo := Logo(p)
	right := append([]string{}, wordmarkLines(p)...)
	right = append(right, versionLine(p, info), "")
	right = append(right, bannerRows(p, info)...)
	off := (len(logo) - len(right)) / 2
	if off < 0 {
		off = 0
	}
	n := len(logo)
	if off+len(right) > n {
		n = off + len(right)
	}
	blank := strings.Repeat(" ", logoWidth())
	b.WriteString("\n")
	for i := 0; i < n; i++ {
		left := blank
		if i < len(logo) {
			left = logo[i]
		}
		line := "  " + left
		if j := i - off; j >= 0 && j < len(right) {
			line += "  " + right[j]
		}
		b.WriteString(line + "\n")
	}
	b.WriteString("\n")
	return b.String()
}
