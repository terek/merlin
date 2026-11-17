package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/terek/merlin/internal/server"
)

// waitState waits for the update state to be want.
func waitState(t *testing.T, au *autoUpgrader, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for au.update().State != want {
		if time.Now().After(deadline) {
			t.Fatalf("state = %+v, want %s", au.update(), want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func nextFiles(t *testing.T, real string) []string {
	t.Helper()
	m, _ := filepath.Glob(filepath.Join(filepath.Dir(real), nextPrefix+"*"))
	return m
}

// gateSigning makes the check that every download passes block until the returned func is
// called, so a test can look at the state while a download is under way.
func gateSigning(t *testing.T) (release func()) {
	t.Helper()
	gate := make(chan struct{})
	inner := codesignCheck
	setVar(t, &codesignCheck, func(ctx context.Context, p string) error {
		<-gate
		return inner(ctx, p)
	})
	var once bool
	t.Cleanup(func() {
		if !once {
			close(gate)
		}
	})
	return func() {
		if !once {
			once = true
			close(gate)
		}
	}
}

func TestPrefetchStagesInBackground(t *testing.T) {
	home := cleanEnv(t) // auto-upgrade off: the release is reported, not installed
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2")
	open := gateSigning(t)
	au := newAutoUpgrader(home, false)
	var l logs
	done := make(chan bool)
	go func() { done <- au.run(context.Background(), l.logf) }()
	select {
	case <-done: // run returns while the download is still held up
	case <-time.After(5 * time.Second):
		t.Fatal("run waited for the download")
	}
	if u := au.update(); u.Version != "0.6.3" || u.State != "downloading" {
		t.Errorf("while downloading: %+v", u)
	}
	open()
	waitState(t, au, "ready")
	if got := nextFiles(t, real); len(got) != 1 || filepath.Base(got[0]) != ".merlin.next-0.6.3" {
		t.Errorf("staged files: %v", got)
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.2") || au.wasInstalled() {
		t.Error("the staged release was installed")
	}
	if l := leftovers(t, filepath.Dir(real)); len(l) != 0 {
		t.Errorf("temp files left: %v", l)
	}
	// Another check does not download again.
	au.run(context.Background(), l.logf)
	prefetches.Wait()
	if rel.downloads != 1 || au.update().State != "ready" {
		t.Errorf("downloads %d, state %+v", rel.downloads, au.update())
	}
}

func TestPrefetchClearsOldStagedFiles(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2")
	old := filepath.Join(filepath.Dir(real), ".merlin.next-0.6.0")
	os.WriteFile(old, []byte("left by a previous process"), 0o755)
	au := newAutoUpgrader(home, false) // clears what an earlier process left
	if _, err := os.Stat(old); err == nil {
		t.Error("a leftover from a previous process stayed")
	}
	os.WriteFile(old, []byte("x"), 0o755)
	au.run(context.Background(), (&logs{}).logf)
	waitState(t, au, "ready")
	if got := nextFiles(t, real); len(got) != 1 || !strings.HasSuffix(got[0], "0.6.3") {
		t.Errorf("staged files: %v", got)
	}
}

func TestPrefetchDevBuildStagesNothing(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2-dev")
	au := newAutoUpgrader(home, false)
	au.setAvailable("0.6.3") // even if something reported a release
	au.prefetch(context.Background(), (&logs{}).logf, "0.6.3")
	prefetches.Wait()
	if rel.downloads != 0 || len(nextFiles(t, real)) != 0 || au.update().State == "downloading" {
		t.Errorf("downloads %d, state %+v", rel.downloads, au.update())
	}
	if err := au.installNow(context.Background(), "0.6.3"); !errors.Is(err, server.ErrConflict) {
		t.Errorf("installNow on a development build = %v", err)
	}
}

func TestPrefetchUnwritableDirIsBlocked(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can write anywhere")
	}
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2")
	dir := filepath.Dir(real)
	os.Chmod(dir, 0o555)
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
	au := newAutoUpgrader(home, false)
	au.run(context.Background(), (&logs{}).logf)
	prefetches.Wait()
	u := au.update()
	if u.State != "blocked" || u.Reason != "cannot write to "+dir+"; run: sudo "+real+" upgrade" {
		t.Errorf("update = %+v", u)
	}
	if rel.downloads != 0 {
		t.Error("downloaded into a directory that cannot be written")
	}
	err := au.installNow(context.Background(), "0.6.3")
	if !errors.Is(err, server.ErrConflict) || !strings.Contains(err.Error(), "sudo") {
		t.Errorf("installNow = %v", err)
	}
}

func TestPrefetchFailureLeavesAvailable(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3", badSum: true}
	rel.start(t)
	installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	var l logs
	au.run(context.Background(), l.logf)
	prefetches.Wait()
	au.run(context.Background(), l.logf) // tries again at the next check, logs once
	prefetches.Wait()
	u := au.update()
	if u.State != "available" || u.Reason == "" || l.count("update: downloading 0.6.3 failed") != 1 {
		t.Errorf("update %+v, log:\n%s", u, l.text())
	}
}

func readyAu(t *testing.T) (*autoUpgrader, *fakeRelease, string, *logs) {
	t.Helper()
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	l := &logs{}
	au.run(context.Background(), l.logf)
	waitState(t, au, "ready")
	return au, rel, real, l
}

func TestInstallNowUsesStagedRelease(t *testing.T) {
	au, rel, real, l := readyAu(t)
	if err := au.installNow(context.Background(), "0.6.3"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.3") || !au.wasInstalled() {
		t.Errorf("not installed: %q", contents(t, real))
	}
	if !strings.Contains(contents(t, filepath.Join(filepath.Dir(real), prevName)), "merlin 0.6.2") {
		t.Error("previous binary not kept")
	}
	if rel.downloads != 1 {
		t.Errorf("downloads = %d, want the prefetched one only", rel.downloads)
	}
	if len(nextFiles(t, real)) != 0 || len(leftovers(t, filepath.Dir(real))) != 0 {
		t.Error("staged files left")
	}
	if l.count("upgrade: installing 0.6.3 (requested from the web UI)") != 1 {
		t.Errorf("log:\n%s", l.text())
	}
	if u := au.update(); u.State != "installing" {
		t.Errorf("update = %+v", u)
	}
}

func TestInstallNowRestagesTamperedFile(t *testing.T) {
	au, rel, real, _ := readyAu(t)
	next := nextFiles(t, real)[0]
	f, _ := os.OpenFile(next, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("echo tampered\n")
	f.Close()
	if err := au.installNow(context.Background(), "0.6.3"); err != nil {
		t.Fatal(err)
	}
	if got := contents(t, real); strings.Contains(got, "tampered") || !strings.Contains(got, "merlin 0.6.3") {
		t.Errorf("installed the tampered file: %q", got)
	}
	if rel.downloads != 2 {
		t.Errorf("downloads = %d, want a second one", rel.downloads)
	}
}

func TestInstallNowRestagesMissingFile(t *testing.T) {
	au, rel, real, _ := readyAu(t)
	os.Remove(nextFiles(t, real)[0])
	if err := au.installNow(context.Background(), "0.6.3"); err != nil || rel.downloads != 2 {
		t.Errorf("err %v, downloads %d", err, rel.downloads)
	}
}

func TestInstallNowConflicts(t *testing.T) {
	au, _, real, _ := readyAu(t)
	for _, v := range []string{"0.6.4", "0.6.2", ""} {
		err := au.installNow(context.Background(), v)
		if !errors.Is(err, server.ErrConflict) || !strings.Contains(err.Error(), "0.6.3 is") {
			t.Errorf("version %q: %v", v, err)
		}
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.2") || au.wasInstalled() {
		t.Error("a refused install changed the binary")
	}
	if u := au.update(); u.State != "ready" {
		t.Errorf("a refusal changed the state: %+v", u)
	}
	au.setAvailable("")
	if err := au.installNow(context.Background(), "0.6.3"); !errors.Is(err, server.ErrConflict) || !strings.Contains(err.Error(), "nothing to install") {
		t.Errorf("nothing available: %v", err)
	}
}

func TestInstallNowSecondCallConflicts(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3"}
	rel.start(t)
	real := installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	au.setAvailable("0.6.3") // reported, nothing staged: the install downloads
	open := gateSigning(t)
	first := make(chan error, 1)
	go func() { first <- au.installNow(context.Background(), "0.6.3") }()
	waitState(t, au, "downloading")
	if err := au.installNow(context.Background(), "0.6.3"); !errors.Is(err, server.ErrConflict) {
		t.Errorf("second call = %v, want a conflict", err)
	}
	open()
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(contents(t, real), "merlin 0.6.3") || rel.downloads != 1 {
		t.Errorf("binary %q, downloads %d", contents(t, real), rel.downloads)
	}
}

func TestInstallNowFailureResetsState(t *testing.T) {
	home := cleanEnv(t)
	rel := &fakeRelease{latest: "0.6.3", badSum: true}
	rel.start(t)
	real := installed(t, "0.6.2")
	au := newAutoUpgrader(home, false)
	au.setAvailable("0.6.3")
	err := au.installNow(context.Background(), "0.6.3")
	if err == nil || errors.Is(err, server.ErrConflict) {
		t.Fatalf("err = %v", err)
	}
	if u := au.update(); u.State != "available" || u.Reason != err.Error() {
		t.Errorf("update = %+v", u)
	}
	if au.wasInstalled() || !strings.Contains(contents(t, real), "merlin 0.6.2") {
		t.Error("installed after a failure")
	}
	// and the button works again
	if err := au.installNow(context.Background(), "0.6.3"); err == nil || errors.Is(err, server.ErrConflict) {
		t.Errorf("retry = %v", err)
	}
}
