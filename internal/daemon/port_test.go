package daemon_test

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/terek/merlin/internal/daemon"
)

func TestLockRecordsBoundPort(t *testing.T) {
	r := newRig(t, "", "", nil)
	r.start()
	b, err := os.ReadFile(filepath.Join(r.home, "merlin.lock"))
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(r.d.Addr())
	want := fmt.Sprintf("%d\n%s\n", os.Getpid(), port)
	if string(b) != want || strings.HasSuffix(port, ":0") || port == "0" {
		t.Errorf("merlin.lock = %q, want %q", b, want)
	}
	if p, ok := daemon.RecordedPort(r.home); !ok || strconv.Itoa(p) != port {
		t.Errorf("RecordedPort = %d, %v", p, ok)
	}
}

func TestRecordedPort(t *testing.T) {
	for _, tc := range []struct {
		name, content string
		missing       bool
		want          int
		ok            bool
	}{
		{name: "missing", missing: true},
		{name: "pid only", content: "123\n"},
		{name: "garbage", content: "123\nabc\n"},
		{name: "zero", content: "123\n0\n"},
		{name: "too big", content: "123\n70000\n"},
		{name: "valid", content: "123\n4567\n", want: 4567, ok: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			if !tc.missing {
				os.WriteFile(filepath.Join(home, "merlin.lock"), []byte(tc.content), 0o644)
			}
			if p, ok := daemon.RecordedPort(home); p != tc.want || ok != tc.ok {
				t.Errorf("RecordedPort = %d, %v", p, ok)
			}
		})
	}
}
