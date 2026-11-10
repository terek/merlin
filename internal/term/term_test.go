package term

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;;[^\x1b]*\x1b\\`)

func visible(s string) int { return utf8.RuneCountInString(ansiRe.ReplaceAllString(s, "")) }

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

var (
	tc    = Profile{TTY: true, Color: TrueColor, Width: 100}
	plain = Profile{}
)

func TestDetect(t *testing.T) {
	cases := []struct {
		name string
		tty  bool
		env  map[string]string
		want Profile
	}{
		{"not tty", false, map[string]string{"COLORTERM": "truecolor"}, Profile{}},
		{"no color", true, map[string]string{"NO_COLOR": "1", "COLORTERM": "truecolor"}, Profile{TTY: true, Width: 90}},
		{"dumb", true, map[string]string{"TERM": "dumb"}, Profile{TTY: true, Width: 90}},
		{"truecolor", true, map[string]string{"COLORTERM": "truecolor"}, Profile{TTY: true, Color: TrueColor, Width: 90}},
		{"24bit", true, map[string]string{"COLORTERM": "24bit"}, Profile{TTY: true, Color: TrueColor, Width: 90}},
		{"default", true, map[string]string{"TERM": "xterm"}, Profile{TTY: true, Color: ANSI256, Width: 90}},
		{"empty NO_COLOR ignored", true, map[string]string{"NO_COLOR": ""}, Profile{TTY: true, Color: ANSI256, Width: 90}},
	}
	for _, c := range cases {
		if got := detect(c.tty, 90, env(c.env)); got != c.want {
			t.Errorf("%s: got %+v want %+v", c.name, got, c.want)
		}
	}
	if (Profile{TTY: true}).Fancy() || (Profile{Color: TrueColor}).Fancy() || !tc.Fancy() {
		t.Error("Fancy needs TTY and colour")
	}
}

func TestTo256(t *testing.T) {
	if got := to256(RGB{255, 0, 0}); got != 196 {
		t.Errorf("red = %d", got)
	}
	if got := to256(RGB{0, 0, 0}); got != 16 {
		t.Errorf("black = %d", got)
	}
	if got := to256(RGB{128, 128, 128}); got < 232 || got > 255 {
		t.Errorf("grey = %d", got)
	}
}

func TestFgEmission(t *testing.T) {
	if got := tc.Fg(RGB{1, 2, 3}, "x"); got != "\x1b[38;2;1;2;3mx\x1b[0m" {
		t.Errorf("truecolor: %q", got)
	}
	a := Profile{TTY: true, Color: ANSI256}
	if got := a.Fg(RGB{255, 0, 0}, "x"); got != "\x1b[38;5;196mx\x1b[0m" {
		t.Errorf("256: %q", got)
	}
	if got := tc.Bold("x"); got != "\x1b[1mx\x1b[0m" {
		t.Errorf("bold: %q", got)
	}
	if got := tc.Bold(tc.Fg(Red, "a") + "b"); !strings.Contains(got, "\x1b[0m\x1b[1mb") {
		t.Errorf("bold does not survive reset: %q", got)
	}
	if got := tc.Link("http://x", "t"); got != "\x1b]8;;http://x\x1b\\t\x1b]8;;\x1b\\" {
		t.Errorf("link: %q", got)
	}
}

func TestIdentityWithoutColor(t *testing.T) {
	for _, p := range []Profile{plain, {TTY: true}} {
		if p.Fg(Red, "x") != "x" || p.Bold("x") != "x" || p.Dim("x") != "x" || p.Link("u", "x") != "x" {
			t.Errorf("%+v not identity", p)
		}
	}
}

func TestGradient(t *testing.T) {
	if Gradient(Lilac, Violet, 0) != Lilac || Gradient(Lilac, Violet, 1) != Violet {
		t.Error("ends")
	}
	if Gradient(Lilac, Violet, -3) != Lilac || Gradient(Lilac, Violet, 9) != Violet {
		t.Error("clamp")
	}
	if g := Gradient(RGB{0, 0, 0}, RGB{100, 200, 50}, 0.5); g != (RGB{50, 100, 25}) {
		t.Errorf("mid %v", g)
	}
}

func TestLogo(t *testing.T) {
	if Logo(plain) != nil || Logo(Profile{TTY: true}) != nil {
		t.Error("logo when not fancy")
	}
	l := Logo(tc)
	if len(l) != len(logoArt)/2 {
		t.Fatalf("%d lines", len(l))
	}
	for i, line := range l {
		if visible(line) != logoWidth() {
			t.Errorf("line %d width %d", i, visible(line))
		}
		if !strings.HasSuffix(line, "\x1b[0m") {
			t.Errorf("line %d no reset", i)
		}
	}
	if !strings.Contains(strings.Join(l, ""), "\x1b[38;2;") || !strings.Contains(strings.Join(l, ""), "\x1b[48;2;") {
		t.Error("no fg+bg colours")
	}
}

func TestBanner(t *testing.T) {
	info := BannerInfo{Version: "0.7.3", Tagline: "what your agents did", Lines: []BannerLine{{"ui", tc.Link("http://x", "http://x")}, {"home", "~/.merlin"}}}
	if Banner(plain, info) != "" {
		t.Error("banner when plain")
	}
	full := Banner(tc, info)
	if !strings.HasSuffix(full, "\n") || !strings.Contains(full, "\x1b[38;2;") {
		t.Error("full not styled")
	}
	text := ansiRe.ReplaceAllString(full, "")
	for _, want := range []string{"███╗   ███╗", "explorer v0.7.3  ·  what your agents did", "▸ ui    http://x", "▸ home  ~/.merlin"} {
		if !strings.Contains(text, want) {
			t.Errorf("full missing %q", want)
		}
	}
	for _, line := range strings.Split(strings.TrimSuffix(full, "\n"), "\n") {
		if w := visible(line); w >= bannerMinWidth {
			t.Errorf("line %d wide: %q", w, line)
		}
	}
	nar := Profile{TTY: true, Color: TrueColor, Width: 60}
	c := Banner(nar, info)
	ct := ansiRe.ReplaceAllString(c, "")
	if strings.Contains(ct, "█") || !strings.HasPrefix(ct, "◆ MERLIN explorer v0.7.3\n") || !strings.HasSuffix(ct, "\n\n") {
		t.Errorf("compact: %q", ct)
	}
	if !strings.Contains(c, "\x1b[1m") {
		t.Error("compact not bold")
	}
	// Width 0 but fancy counts as 80.
	if z := Banner(Profile{TTY: true, Color: ANSI256}, info); !strings.Contains(ansiRe.ReplaceAllString(z, ""), "███╗") {
		t.Error("width 0 should be full layout")
	}
	// Taller right column than the logo.
	var many []BannerLine
	for i := 0; i < 12; i++ {
		many = append(many, BannerLine{fmt.Sprint("k", i), "v"})
	}
	tall := ansiRe.ReplaceAllString(Banner(tc, BannerInfo{Version: "1", Lines: many}), "")
	if !strings.Contains(tall, "▸ k11") {
		t.Error("tall lines dropped")
	}
}

func TestThousandsAndBytes(t *testing.T) {
	for in, want := range map[int]string{0: "0", 999: "999", 1342: "1,342", 1234567: "1,234,567"} {
		if got := thousands(in); got != want {
			t.Errorf("%d: %s", in, got)
		}
	}
	if fmtBytes(512e6) != "512 MB" || fmtBytes(1_200e6) != "1.2 GB" {
		t.Error(fmtBytes(512e6), fmtBytes(1_200e6))
	}
}

func TestETA(t *testing.T) {
	s := time.Second
	cases := []struct {
		pr   Progress
		want string
	}{
		{Progress{Done: 100, Total: 200, Elapsed: 2 * s}, ""},             // too early
		{Progress{Done: 9, Total: 200, Elapsed: 10 * s}, ""},              // too few done
		{Progress{Done: 200, Total: 200, Elapsed: 10 * s}, ""},            // finished
		{Progress{Done: 100, Total: 0, Elapsed: 10 * s}, ""},              // unknown total
		{Progress{Done: 100, Total: 200, Elapsed: 14 * s}, "~14s left"},   // 100 more at 7.14/s
		{Progress{Done: 100, Total: 1400, Elapsed: 10 * s}, "~2m left"},   // 1300 at 10/s = 130s
		{Progress{Done: 10, Total: 100000, Elapsed: 10 * s}, "~28h left"}, // hours
	}
	for _, c := range cases {
		if got := fmtETA(c.pr); got != c.want {
			t.Errorf("%+v: %q want %q", c.pr, got, c.want)
		}
	}
}

func TestBarContent(t *testing.T) {
	pr := Progress{Done: 1342, Total: 2431, Failed: 0, Bytes: 640e6, Elapsed: 20 * time.Second}
	s := formatBar(tc, "indexing", pr, 0, 200)
	text := ansiRe.ReplaceAllString(s, "")
	for _, want := range []string{"⠋ indexing", "1,342/2,431 sessions", "640 MB", "32 MB/s", "left"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in %q", want, text)
		}
	}
	if strings.Contains(text, "failed") {
		t.Error("failed shown at 0")
	}
	if !strings.Contains(s, "\x1b[38;2;") {
		t.Error("no colour")
	}
	pr.Failed = 3
	if !strings.Contains(ansiRe.ReplaceAllString(formatBar(tc, "indexing", pr, 0, 200), ""), "3 failed") {
		t.Error("failed missing")
	}
	if !strings.Contains(formatBar(tc, "x", pr, 0, 200), "\x1b[38;2;240;180;60m3 failed") {
		t.Error("failed not amber")
	}
	if !strings.Contains(formatBar(tc, "x", pr, 3, 200), "⠸") {
		t.Error("spinner does not advance")
	}
}

func barOnly(s string) string {
	t := ansiRe.ReplaceAllString(s, "")
	r := []rune(t)
	var b []rune
	for _, c := range r[2:] {
		if c == '█' || c == '·' || strings.ContainsRune(string(partials), c) {
			b = append(b, c)
		}
	}
	return string(b)
}

func TestBarFractions(t *testing.T) {
	zero := ansiRe.ReplaceAllString(formatBar(tc, "i", Progress{Done: 0, Total: 100}, 0, 200), "")
	zero = strings.SplitN(zero, "0/100", 2)[0]
	if strings.Contains(zero, "█") || strings.Count(zero, "·") < 30 {
		t.Errorf("0%%: %q", zero)
	}
	half := ansiRe.ReplaceAllString(formatBar(tc, "i", Progress{Done: 50, Total: 100}, 0, 200), "")
	if strings.Count(half, "█") != 15 {
		t.Errorf("50%%: %q", half)
	}
	full := ansiRe.ReplaceAllString(formatBar(tc, "i", Progress{Done: 100, Total: 100}, 0, 200), "")
	full = strings.SplitN(full, "100/100", 2)[0]
	if strings.Count(full, "█") != 30 || strings.Contains(full, "·") {
		t.Errorf("100%%: %q", full)
	}
	part := ansiRe.ReplaceAllString(formatBar(tc, "i", Progress{Done: 1, Total: 3}, 0, 200), "")
	if !strings.Contains(part, "▎") { // 10 cells exactly? 1/3*240 = 80 eighths -> 10 full, no partial
		if strings.Count(part, "█") != 10 {
			t.Errorf("1/3: %q", part)
		}
	}
	p2 := ansiRe.ReplaceAllString(formatBar(tc, "i", Progress{Done: 1, Total: 7}, 0, 200), "")
	if !strings.ContainsAny(p2, string(partials)) {
		t.Errorf("no partial: %q", p2)
	}
}

func TestBarIndeterminate(t *testing.T) {
	a := ansiRe.ReplaceAllString(formatBar(tc, "i", Progress{Done: 12}, 0, 200), "")
	b := ansiRe.ReplaceAllString(formatBar(tc, "i", Progress{Done: 12}, 5, 200), "")
	if !strings.Contains(a, "12 sessions") || strings.Contains(a, "/") {
		t.Errorf("counts: %q", a)
	}
	if strings.Count(a, "█") != 6 || a == b {
		t.Errorf("block: %q / %q", a, b)
	}
}

func TestBarNeverTooWide(t *testing.T) {
	prs := []Progress{
		{},
		{Done: 1342, Total: 2431, Failed: 7, Bytes: 5e9, Elapsed: time.Minute},
		{Done: 5, Bytes: 1e6, Elapsed: time.Second},
	}
	for _, w := range []int{12, 20, 30, 40, 50, 80, 120} {
		for i, pr := range prs {
			for f := 0; f < 12; f++ {
				s := formatBar(Profile{TTY: true, Color: TrueColor, Width: w}, "indexing", pr, f, w)
				if v := visible(s); v > w-1 {
					t.Fatalf("width %d pr %d frame %d: %d cols: %q", w, i, f, v, ansiRe.ReplaceAllString(s, ""))
				}
			}
		}
	}
	// Narrow terminals drop trailing fields but keep the counts as long as they fit.
	s := ansiRe.ReplaceAllString(formatBar(tc, "indexing", prs[1], 0, 50), "")
	if !strings.Contains(s, "1,342/2,431") || strings.Contains(s, "failed") {
		t.Errorf("w50: %q", s)
	}
}

func TestLogStyling(t *testing.T) {
	ts := "2026-11-10T14:03:22+01:00"
	loc := time.Date(2026, 11, 10, 14, 3, 22, 0, time.FixedZone("x", 3600)).Local().Format("15:04:05")
	got := styleLogLine(tc, ts+" links: 12 directories resolved")
	want := tc.Dim(loc) + " " + tc.Fg(Lavender, "links:") + " 12 directories resolved"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
	got = styleLogLine(tc, ts+" index-run: scan Failed for x")
	if !strings.Contains(got, tc.Fg(Amber, "scan Failed for x")) || !strings.Contains(got, tc.Fg(Lavender, "index-run:")) {
		t.Errorf("amber: %q", got)
	}
	for _, m := range []string{"stopped", "listening on http://127.0.0.1:1"} {
		if got := styleLogLine(tc, ts+" "+m); !strings.HasSuffix(got, tc.Fg(Green, m)) {
			t.Errorf("green %q: %q", m, got)
		}
	}
	if got := styleLogLine(tc, ts+" this is a very long sentence: no tag"); strings.Contains(got, string(rune(0x1b))+"[38;2;176") {
		t.Errorf("tag mis-detected: %q", got)
	}
	if got := styleLogLine(tc, ts+" averyveryverylongtagname: x"); strings.Contains(got, tc.Fg(Lavender, "averyveryverylongtagname:")) {
		t.Error("long tag accepted")
	}
	for _, l := range []string{"no timestamp here", "garbage message", ""} {
		if styleLogLine(tc, l) != l {
			t.Errorf("%q changed", l)
		}
	}
}

func TestLogWriter(t *testing.T) {
	ts := "2026-11-10T14:03:22+01:00"
	var buf bytes.Buffer
	c := NewConsole(&buf, tc)
	w := c.LogWriter()
	w.Write([]byte(ts + " links: par"))
	if buf.Len() != 0 {
		t.Fatal("printed before newline")
	}
	n, _ := w.Write([]byte("tial\n" + ts + " stopped\nplain line\nrest"))
	if n != len("tial\n"+ts+" stopped\nplain line\nrest") {
		t.Error("n")
	}
	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("%q", buf.String())
	}
	if !strings.Contains(lines[0], tc.Fg(Lavender, "links:")) || !strings.HasSuffix(lines[0], " partial") {
		t.Errorf("%q", lines[0])
	}
	if !strings.Contains(lines[1], tc.Fg(Green, "stopped")) || lines[2] != "plain line" {
		t.Errorf("%q", lines)
	}
}

func TestLogWriterPlainIsByteIdentical(t *testing.T) {
	in := "2026-11-10T14:03:22+01:00 links: failed to x\nno stamp\n\n  spaced  \n"
	for _, p := range []Profile{plain, {TTY: true}, {TTY: true, Color: TrueColor, Width: 80}} {
		var buf bytes.Buffer
		c := NewConsole(&buf, p)
		w := c.LogWriter()
		for i := 0; i < len(in); i += 7 {
			end := i + 7
			if end > len(in) {
				end = len(in)
			}
			w.Write([]byte(in[i:end]))
		}
		if p.Fancy() {
			if buf.String() == in {
				t.Error("fancy output unchanged")
			}
			continue
		}
		if buf.String() != in {
			t.Errorf("%+v: %q", p, buf.String())
		}
	}
}

func TestPlainConsoleProgressIsInert(t *testing.T) {
	var buf bytes.Buffer
	c := NewConsole(&buf, plain)
	c.StartProgress("x")
	c.SetProgress(Progress{Done: 1, Total: 2})
	time.Sleep(400 * time.Millisecond)
	c.Println("hi")
	c.StopProgress()
	if buf.String() != "hi\n" {
		t.Errorf("%q", buf.String())
	}
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuf) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

func TestConsoleBar(t *testing.T) {
	var buf lockedBuf
	c := NewConsole(&buf, tc)
	c.StartProgress("indexing")
	c.SetProgress(Progress{Done: 5, Total: 10})
	time.Sleep(150 * time.Millisecond)
	if buf.String() != "" {
		t.Fatalf("bar drawn before 300ms: %q", buf.String())
	}
	c.Println("early")
	time.Sleep(450 * time.Millisecond)
	s := buf.String()
	if !strings.HasPrefix(s, "early\n") || strings.Count(s, "\x1b[2K") < 2 {
		t.Fatalf("redraw: %q", s)
	}
	if !strings.Contains(ansiRe.ReplaceAllString(s, ""), "5/10 sessions") {
		t.Errorf("bar: %q", s)
	}
	c.Println("during")
	c.StopProgress()
	c.StopProgress() // idempotent
	got := buf.String()
	if !strings.Contains(got, "\r\x1b[2Kduring\n") || !strings.HasSuffix(got, "\r\x1b[2K") {
		t.Errorf("tail: %q", got[len(got)-80:])
	}
	n := len(got)
	time.Sleep(250 * time.Millisecond)
	if len(buf.String()) != n {
		t.Error("ticker still running after stop")
	}
}

func TestConsoleConcurrent(t *testing.T) {
	var buf lockedBuf
	c := NewConsole(&buf, tc)
	c.StartProgress("indexing")
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				c.Println("line")
			}
		}()
		go func() {
			defer wg.Done()
			for i := 0; i < 2000; i++ {
				c.SetProgress(Progress{Done: i, Total: 2000})
			}
		}()
	}
	lw := c.LogWriter()
	for i := 0; i < 50; i++ {
		fmt.Fprintf(lw, "2026-11-10T14:03:22+01:00 x: %d\n", i)
	}
	wg.Wait()
	time.Sleep(350 * time.Millisecond)
	c.StopProgress()
	if strings.Count(buf.String(), "line\n") != 800 {
		t.Error("lost lines")
	}
}

// Failures are the field a narrow line keeps longest: rate and ETA go first.
func TestBarKeepsFailedWhenNarrow(t *testing.T) {
	tc := Profile{TTY: true, Color: TrueColor, Width: 80}
	pr := Progress{Done: 1342, Total: 2431, Failed: 2, Bytes: 412e6, Elapsed: 10 * time.Second}
	s := ansiRe.ReplaceAllString(formatBar(tc, "indexing", pr, 0, 80), "")
	if !strings.Contains(s, "2 failed") {
		t.Errorf("failed dropped at 80: %q", s)
	}
	if strings.Contains(s, "left") && strings.Contains(s, "MB/s") && visible(s) > 79 {
		t.Errorf("too wide: %q", s)
	}
}
