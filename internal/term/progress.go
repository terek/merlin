package term

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Progress is a snapshot of an indexing run.
type Progress struct {
	Done, Total, Failed int
	Bytes               int64 // transcript bytes processed
	Elapsed             time.Duration
}

const (
	spinnerFrames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
	barCells      = 30
	minBarCells   = 8
	blockSize     = 6
)

var partials = []rune("▏▎▍▌▋▊▉")

func thousands(n int) string {
	s := strconv.Itoa(n)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

func fmtBytes(n int64) string {
	mb := float64(n) / 1e6
	if mb >= 1000 {
		return fmt.Sprintf("%.1f GB", mb/1000)
	}
	return fmt.Sprintf("%.0f MB", mb)
}

func fmtRate(pr Progress) string {
	if pr.Elapsed <= 0 {
		return ""
	}
	r := float64(pr.Bytes) / 1e6 / pr.Elapsed.Seconds()
	if r >= 10 {
		return fmt.Sprintf("%.0f MB/s", r)
	}
	return fmt.Sprintf("%.1f MB/s", r)
}

// fmtETA is "~14s left" / "~3m left", or "" when it is too early or pointless to guess.
func fmtETA(pr Progress) string {
	if pr.Elapsed < 3*time.Second || pr.Done < 10 || pr.Total <= pr.Done {
		return ""
	}
	secs := float64(pr.Total-pr.Done) / (float64(pr.Done) / pr.Elapsed.Seconds())
	switch {
	case secs < 60:
		return fmt.Sprintf("~%ds left", int(secs+0.5))
	case secs < 3600:
		return fmt.Sprintf("~%dm left", int(secs/60+0.5))
	}
	return fmt.Sprintf("~%dh left", int(secs/3600+0.5))
}

// formatBarCells draws the bar itself, w columns wide.
func formatBarCells(p Profile, pr Progress, frame, w int) string {
	var b strings.Builder
	if pr.Total <= 0 {
		blk := blockSize
		if blk > w {
			blk = w
		}
		span := w - blk
		pos := 0
		if span > 0 {
			pos = frame % (2 * span)
			if pos > span {
				pos = 2*span - pos
			}
		}
		for i := 0; i < w; i++ {
			if i >= pos && i < pos+blk {
				b.WriteString(p.Fg(Lavender, "█"))
			} else {
				b.WriteString(p.Dim("·"))
			}
		}
		return b.String()
	}
	done := pr.Done
	if done > pr.Total {
		done = pr.Total
	}
	if done < 0 {
		done = 0
	}
	eighths := int(float64(done) / float64(pr.Total) * float64(w) * 8)
	full, part := eighths/8, eighths%8
	for i := 0; i < w; i++ {
		switch {
		case i < full:
			t := 0.0
			if w > 1 {
				t = float64(i) / float64(w-1)
			}
			b.WriteString(p.Fg(Gradient(Violet, Green, t), "█"))
		case i == full && part > 0:
			b.WriteString(p.Fg(Lavender, string(partials[part-1])))
		default:
			b.WriteString(p.Dim("·"))
		}
	}
	return b.String()
}

func barFields(p Profile, pr Progress) []string {
	var counts string
	if pr.Total > 0 {
		counts = p.Bold(thousands(pr.Done)) + p.Dim("/"+thousands(pr.Total)+" sessions")
	} else {
		counts = p.Bold(thousands(pr.Done)) + p.Dim(" sessions")
	}
	fields := []string{counts}
	if pr.Failed > 0 { // second, so a narrow line drops the rate and ETA before it
		fields = append(fields, p.Fg(Amber, fmt.Sprintf("%d failed", pr.Failed)))
	}
	fields = append(fields, p.Dim(fmtBytes(pr.Bytes)))
	if r := fmtRate(pr); r != "" {
		fields = append(fields, p.Dim(r))
	}
	if e := fmtETA(pr); e != "" {
		fields = append(fields, p.Dim(e))
	}
	return fields
}

// formatBar renders the single-line bar for the given spinner frame; it never exceeds
// width-1 visible columns (width 0 means 80).
func formatBar(p Profile, label string, pr Progress, frame, width int) string {
	if width <= 0 {
		width = 80
	}
	budget := width - 1
	spin := p.Fg(Green, string([]rune(spinnerFrames)[frame%len([]rune(spinnerFrames))]))
	fields := barFields(p, pr)
	sep := p.Dim("  ·  ")

	build := func(barW, k int, lbl string) string {
		s := spin + " " + p.Bold(lbl) + "  " + formatBarCells(p, pr, frame, barW)
		if k > 0 {
			s += "  " + strings.Join(fields[:k], sep)
		}
		return s
	}
	for k := len(fields); k >= 1; k-- {
		if s := build(barCells, k, label); visibleWidth(s) <= budget {
			return s
		}
	}
	for w := barCells; w >= minBarCells; w-- {
		if s := build(w, 1, label); visibleWidth(s) <= budget {
			return s
		}
	}
	// Narrow: no fields, bar takes what is left, label is cut if it must be.
	lr := []rune(label)
	for len(lr) > 0 && 2+len(lr)+2 > budget {
		lr = lr[:len(lr)-1]
	}
	w := budget - (2 + len(lr) + 2)
	if w < 0 {
		w = 0
	}
	if w > barCells {
		w = barCells
	}
	return build(w, 0, string(lr))
}
