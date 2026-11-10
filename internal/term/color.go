// Package term is the command line's terminal look: capability detection, colour, the banner,
// a live progress bar and restyled daemon log lines. When a stream is not a terminal, or
// NO_COLOR/TERM=dumb say no, Profile.Fancy is false and callers print their plain output.
package term

import (
	"fmt"
	"os"
	"strings"
	"unicode/utf8"
)

// ColorLevel is how many colours a stream can show.
type ColorLevel int

const (
	NoColor ColorLevel = iota
	ANSI256
	TrueColor
)

// Profile says what a stream can show.
type Profile struct {
	TTY   bool
	Color ColorLevel
	Width int // columns; 0 when unknown / not a terminal
}

// Detect inspects f and the environment.
func Detect(f *os.File) Profile {
	w, ok := ttyWidth(f)
	return detect(ok, w, os.Getenv)
}

func detect(isTTY bool, width int, getenv func(string) string) Profile {
	if !isTTY {
		return Profile{}
	}
	if getenv("NO_COLOR") != "" || getenv("TERM") == "dumb" {
		return Profile{TTY: true, Color: NoColor, Width: width}
	}
	switch getenv("COLORTERM") {
	case "truecolor", "24bit":
		return Profile{TTY: true, Color: TrueColor, Width: width}
	}
	return Profile{TTY: true, Color: ANSI256, Width: width}
}

// Fancy reports whether callers should use the styled output: TTY and colour.
func (p Profile) Fancy() bool { return p.TTY && p.Color != NoColor }

// RGB is a colour.
type RGB struct{ R, G, B uint8 }

// Palette. Lilac is only used as the top of gradients.
var (
	Lilac    = RGB{0xD9, 0xC8, 0xF5}
	Lavender = RGB{0xB0, 0x8E, 0xEA}
	Violet   = RGB{0x7E, 0x4F, 0xD0}
	Green    = RGB{0x3D, 0xDC, 0x84}
	Amber    = RGB{0xF0, 0xB4, 0x3C}
	Red      = RGB{0xF2, 0x55, 0x5A}
	Grey     = RGB{0x8A, 0x88, 0x9C}
)

const reset = "\x1b[0m"

// Gradient interpolates linearly from a to b; t is clamped to [0,1].
func Gradient(a, b RGB, t float64) RGB {
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}
	mix := func(x, y uint8) uint8 { return uint8(float64(x) + (float64(y)-float64(x))*t + 0.5) }
	return RGB{mix(a.R, b.R), mix(a.G, b.G), mix(a.B, b.B)}
}

var cubeLevels = [6]int{0, 95, 135, 175, 215, 255}

func nearestCube(v uint8) int {
	best, bd := 0, 1<<30
	for i, l := range cubeLevels {
		d := (int(v) - l) * (int(v) - l)
		if d < bd {
			best, bd = i, d
		}
	}
	return best
}

func dist2(a RGB, r, g, b int) int {
	dr, dg, db := int(a.R)-r, int(a.G)-g, int(a.B)-b
	return dr*dr + dg*dg + db*db
}

// to256 maps c to the nearest xterm 256-colour index (cube 16-231 or grey ramp 232-255).
func to256(c RGB) int {
	ri, gi, bi := nearestCube(c.R), nearestCube(c.G), nearestCube(c.B)
	cubeD := dist2(c, cubeLevels[ri], cubeLevels[gi], cubeLevels[bi])
	avg := (int(c.R) + int(c.G) + int(c.B)) / 3
	gi2 := (avg - 8 + 5) / 10
	if gi2 < 0 {
		gi2 = 0
	}
	if gi2 > 23 {
		gi2 = 23
	}
	gv := 8 + 10*gi2
	if dist2(c, gv, gv, gv) < cubeD {
		return 232 + gi2
	}
	return 16 + 36*ri + 6*gi + bi
}

// sgr returns the escape selecting c as foreground (or background); "" under NoColor.
func (p Profile) sgr(c RGB, bg bool) string {
	base := 38
	if bg {
		base = 48
	}
	switch p.Color {
	case TrueColor:
		return fmt.Sprintf("\x1b[%d;2;%d;%d;%dm", base, c.R, c.G, c.B)
	case ANSI256:
		return fmt.Sprintf("\x1b[%d;5;%dm", base, to256(c))
	}
	return ""
}

// Fg colours s; it returns s unchanged when Color == NoColor.
func (p Profile) Fg(c RGB, s string) string {
	if p.Color == NoColor || s == "" {
		return s
	}
	return p.sgr(c, false) + s + reset
}

// Bold makes s bold; it survives resets inside s.
func (p Profile) Bold(s string) string {
	if p.Color == NoColor || s == "" {
		return s
	}
	return "\x1b[1m" + strings.ReplaceAll(s, reset, reset+"\x1b[1m") + reset
}

// Dim is the grey used for secondary text.
func (p Profile) Dim(s string) string { return p.Fg(Grey, s) }

// Link makes text an OSC 8 hyperlink to url when Fancy, else returns text.
func (p Profile) Link(url, text string) string {
	if !p.Fancy() {
		return text
	}
	return "\x1b]8;;" + url + "\x1b\\" + text + "\x1b]8;;\x1b\\"
}

// visibleWidth counts the columns of s, ignoring CSI and OSC sequences.
func visibleWidth(s string) int {
	n := 0
	for i := 0; i < len(s); {
		if s[i] == 0x1b && i+1 < len(s) {
			switch s[i+1] {
			case '[':
				j := i + 2
				for j < len(s) && (s[j] < 0x40 || s[j] > 0x7e) {
					j++
				}
				i = j + 1
				continue
			case ']':
				j := i + 2
				for j < len(s) {
					if s[j] == 0x07 {
						j++
						break
					}
					if s[j] == 0x1b && j+1 < len(s) && s[j+1] == '\\' {
						j += 2
						break
					}
					j++
				}
				i = j
				continue
			}
		}
		_, sz := utf8.DecodeRuneInString(s[i:])
		n++
		i += sz
	}
	return n
}
