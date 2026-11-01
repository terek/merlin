package moments

import "strings"

// The names harnesses give their tools and commands, as they appear in the digest's
// ToolsByName and Turn.Command. This file is the only place in the package that knows them;
// a new harness adds its names here.

// editTools change files.
var editTools = []string{"Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"}

// planTools are the harness's plan mode.
var planTools = []string{"EnterPlanMode", "ExitPlanMode"}

// skillTools invoke a skill.
var skillTools = []string{"Skill"}

// worktreeTools enter an isolated git worktree.
var worktreeTools = []string{"EnterWorktree"}

// scheduleTools set up a later or recurring run.
var scheduleTools = []string{"ScheduleWakeup", "CronCreate", "RemoteTrigger"}

// readOnlyTools only look.
var readOnlyTools = []string{"Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "ToolSearch"}

// builtinCommands are slash commands the harnesses ship. Any other command a person types is
// one they (or a plugin they installed) added.
var builtinCommands = map[string]bool{
	"add-dir": true, "agents": true, "bashes": true, "bug": true, "chrome": true, "clear": true,
	"compact": true, "config": true, "context": true, "cost": true, "doctor": true, "effort": true,
	"exit": true, "export": true, "fast": true, "feedback": true, "help": true, "hooks": true,
	"ide": true, "init": true, "insights": true, "install-github-app": true, "login": true,
	"logout": true, "mcp": true, "memory": true, "model": true, "output-style": true,
	"permissions": true, "plan": true, "plugin": true, "plugins": true, "pr-comments": true,
	"privacy-settings": true, "quit": true, "release-notes": true, "resume": true, "review": true,
	"rewind": true, "sandbox": true, "security-review": true, "status": true, "statusline": true,
	"tasks": true, "terminal-setup": true, "theme": true, "todos": true, "upgrade": true,
	"usage": true, "vim": true, "!": true, "new": true, "approvals": true, "diff": true,
	"mention": true, "init-codex": true, "goal": true, "claim-credit": true, "design-login": true,
	"btw": true, "extra-usage": true, "stickers": true, "remote-env": true,
}

// modelCommands change the model or how hard it thinks.
var modelCommands = []string{"model", "effort", "fast"}

// clearCommands start over with an empty context.
var clearCommands = []string{"clear", "new"}

// personaCommands wake a persistent persona, end its day or hand its work over (the
// model-welfare way of working: sessions are days, personas persist).
var personaCommands = []string{"wake", "sleep", "handoff"}

// personaDirs are path fragments of where persistent personas keep their identity and memory.
var personaDirs = []string{"/personas/"}

// harnessFiles are path fragments of files that configure a harness: instructions, skills,
// commands, agents, hooks and settings.
var harnessFiles = []string{
	"/CLAUDE.md", "/AGENTS.md", "/.claude/skills/", "/.claude/commands/", "/.claude/agents/",
	"/.claude/hooks/", "/.claude/settings.json", "/.claude/settings.local.json", "/.codex/",
	"/.agents/skills/",
}

// worktreeDirs are path fragments of git worktree checkouts made for agents.
var worktreeDirs = []string{"/worktrees/", "/.worktrees/"}

func isMCP(tool string) bool { return strings.HasPrefix(tool, "mcp__") }

func countTools(by map[string]int64, names []string) int64 {
	var n int64
	for _, k := range names {
		n += by[k]
	}
	return n
}

func commandName(cmd string) string {
	cmd = strings.TrimPrefix(strings.TrimSpace(cmd), "/")
	if i := strings.IndexAny(cmd, " \t\n"); i >= 0 {
		cmd = cmd[:i]
	}
	return cmd
}

func isHarnessFile(path string) bool {
	p := "/" + strings.TrimPrefix(path, "/") // a relative path matches too
	for _, f := range harnessFiles {
		if strings.Contains(p, f) {
			return true
		}
	}
	return false
}
