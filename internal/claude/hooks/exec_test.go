package hooks

import "os/exec"

func execCommand(name string) *exec.Cmd { return exec.Command(name) }
