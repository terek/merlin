package term

import (
	"bytes"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	eraseLine    = "\r\x1b[2K"
	drawDelay    = 300 * time.Millisecond
	redrawPeriod = 100 * time.Millisecond
)

// Console owns one terminal stream so log lines and a live bar never garble each other.
type Console struct {
	w io.Writer
	p Profile

	mu     sync.Mutex // guards output and the fields below
	active bool
	drawn  bool
	label  string
	start  time.Time
	frame  int
	stop   chan struct{}
	done   chan struct{}

	pmu sync.Mutex // guards pr only; SetProgress never waits on I/O
	pr  Progress
}

// NewConsole returns a console writing to w with capabilities p.
func NewConsole(w io.Writer, p Profile) *Console { return &Console{w: w, p: p} }

// Profile returns the console's profile.
func (c *Console) Profile() Profile { return c.p }

func (c *Console) snapshot() Progress {
	c.pmu.Lock()
	defer c.pmu.Unlock()
	return c.pr
}

func (c *Console) barLine() string {
	return formatBar(c.p, c.label, c.snapshot(), c.frame, c.p.Width)
}

// Println writes s and a newline, keeping a showing bar below it.
func (c *Console) Println(s string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.drawn {
		io.WriteString(c.w, eraseLine+s+"\n"+c.barLine())
		return
	}
	io.WriteString(c.w, s+"\n")
}

// StartProgress begins a bar labelled label; it is first drawn after 300ms.
func (c *Console) StartProgress(label string) {
	if !c.p.Fancy() {
		return
	}
	c.mu.Lock()
	if c.active {
		c.label = label
		c.mu.Unlock()
		return
	}
	c.active, c.label, c.start, c.frame = true, label, time.Now(), 0
	c.stop, c.done = make(chan struct{}), make(chan struct{})
	stop, done := c.stop, c.done
	c.mu.Unlock()
	go func() {
		defer close(done)
		t := time.NewTicker(redrawPeriod)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				c.mu.Lock()
				if c.active && (c.drawn || time.Since(c.start) >= drawDelay) {
					c.drawn = true
					c.frame++
					io.WriteString(c.w, eraseLine+c.barLine())
				}
				c.mu.Unlock()
			}
		}
	}()
}

// SetProgress stores the latest numbers; it never blocks on I/O.
func (c *Console) SetProgress(pr Progress) {
	if !c.p.Fancy() {
		return
	}
	c.pmu.Lock()
	c.pr = pr
	c.pmu.Unlock()
}

// StopProgress stops the ticker and erases the bar. Idempotent.
func (c *Console) StopProgress() {
	c.mu.Lock()
	if !c.active {
		c.mu.Unlock()
		return
	}
	c.active = false
	if c.drawn {
		io.WriteString(c.w, eraseLine)
		c.drawn = false
	}
	stop, done := c.stop, c.done
	c.mu.Unlock()
	close(stop)
	<-done
}

// LogWriter returns an io.Writer for daemon log output: complete lines are printed via
// Println, restyled when the console is fancy.
func (c *Console) LogWriter() io.Writer { return &logWriter{c: c} }

type logWriter struct {
	mu  sync.Mutex
	c   *Console
	buf []byte
}

func (l *logWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.buf = append(l.buf, p...)
	for {
		i := bytes.IndexByte(l.buf, '\n')
		if i < 0 {
			break
		}
		line := string(l.buf[:i])
		l.buf = l.buf[i+1:]
		if l.c.p.Fancy() {
			line = styleLogLine(l.c.p, line)
		}
		l.c.Println(line)
	}
	return len(p), nil
}

var logTag = regexp.MustCompile(`^[A-Za-z]+(?:-[A-Za-z]+)?: `)

func styleLogLine(p Profile, line string) string {
	ts, msg, ok := strings.Cut(line, " ")
	if !ok {
		return line
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return line
	}
	head := p.Dim(t.Local().Format("15:04:05")) + " "
	if msg == "stopped" || strings.HasPrefix(msg, "listening on") {
		return head + p.Fg(Green, msg)
	}
	if tag := logTag.FindString(msg); tag != "" && len(tag)-1 <= 16 {
		head += p.Fg(Lavender, tag[:len(tag)-1]) + " "
		msg = msg[len(tag):]
	}
	low := strings.ToLower(msg)
	for _, w := range []string{"failed", "cannot", "error", "abandoning"} {
		if strings.Contains(low, w) {
			return head + p.Fg(Amber, msg)
		}
	}
	return head + msg
}
