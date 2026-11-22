package digest

import "testing"

func hookAttachment(uuid, par string, sec int, toolUseID, stdout string) L {
	return L{"type": "attachment", "uuid": uuid, "parentUuid": parent(par), "timestamp": ts(sec), "attachment": L{
		"type": "hook_success", "hookName": "PreToolUse:Bash", "hookEvent": "PreToolUse",
		"command": "hook-command", "stdout": stdout, "toolUseID": toolUseID,
	}}
}

const rewriteOut = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"rtk git status"}}}`
const keepOut = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"git status"}}}`

// A PreToolUse hook that rewrote a Bash call to run through rtk counts on the call's turn;
// one that left the command alone, or that is not about Bash, does not.
func TestShellCompressedFromHookRecords(t *testing.T) {
	res := reduce(t,
		prompt("p1", "", 1, "go"),
		assistant("a1", "p1", 2, "m1", usage(10, 3), tool("t1", "Bash", L{"command": "git status"}), tool("t2", "Bash", L{"command": "ls"})),
		hookAttachment("h1", "a1", 3, "t1", rewriteOut),
		hookAttachment("h2", "h1", 4, "t2", keepOut),
		toolResult("r1", "h2", 5, "t1"),
		toolResult("r2", "r1", 6, "t2"),
	)
	if got := res.Turns[0].ShellCompressed; got != 1 {
		t.Errorf("ShellCompressed = %d, want 1", got)
	}
	for _, c := range []struct {
		cmd  string
		want bool
	}{
		{"rtk git status", true},
		{"cd x && rtk cargo test", true},
		{"git log | rtk head", true},
		{"git status", false},
		{"echo rtkish", false},
	} {
		if compressedCommand(c.cmd) != c.want {
			t.Errorf("compressedCommand(%q) = %v", c.cmd, !c.want)
		}
	}
}
