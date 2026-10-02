package engine_test

import "github.com/terek/merlin/explorer/internal/harness"

// The live-session methods of the test harnesses: none of these tests use them.

func (f *fake) Locate(harness.SessionRef) (harness.Session, bool, error) {
	return harness.Session{}, false, nil
}
func (f *fake) LiveSessions() ([]harness.SessionRef, error) { return nil, nil }
func (f *fake) ParseHook([]byte) (harness.HookEvent, bool)  { return harness.HookEvent{}, false }
func (*slowHarness) Locate(harness.SessionRef) (harness.Session, bool, error) {
	return harness.Session{}, false, nil
}
func (*slowHarness) LiveSessions() ([]harness.SessionRef, error) { return nil, nil }
func (*slowHarness) ParseHook([]byte) (harness.HookEvent, bool)  { return harness.HookEvent{}, false }
