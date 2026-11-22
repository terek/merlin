package moments

// Registry returns the catalog of moments in display order: Karpathy, Boris, Yegge.
//
// To add a moment, append an entry with a new ID and a detector (in the persona's file) and a
// test. To remove one, delete its entry; its ID must not be reused. To change one, edit its
// detector or texts in place and keep its ID. Nothing is stored, so no change needs a
// migration. docs/moments.md lists the catalog; keep it in step.
func Registry() []Moment {
	return []Moment{
		// Karpathy: in control, knows what he wants, gives the agent the right context.
		{
			ID: "steer-mid-turn", Category: CategoryPrompt, Persona: Karpathy, Title: "Steering mid-turn",
			Detects: "Counted when you send a message while the agent is still working on a turn.",
			What:    "You sent a correction or more context while the agent was still working, without stopping it.",
			Try:     "You don't have to wait for the agent to finish. Type while it works: the message reaches it mid-turn, so a wrong assumption is fixed before it turns into twenty edits.",
			Detect:  steerMidTurn,
			Symptom: longTurns,
		},
		{
			ID: "interrupt-redirect", Category: CategoryPrompt, Persona: Karpathy, Title: "Interrupt and redirect",
			Detects: "Counted when you stop the agent mid-turn and, within two minutes, send a different prompt.",
			What:    "You stopped the agent and gave it a new direction within two minutes.",
			Try:     "When the agent heads the wrong way, press Esc and say what you want instead. Stopping early is cheaper than undoing later.",
			Detect:  interruptRedirect,
		},
		{
			ID: "rewind", Category: CategoryPrompt, Persona: Karpathy, Title: "Takes the other branch",
			Detects: "Counted when you rewind the conversation and abandon a turn, or when a session is forked from another one.",
			What:    "You rewound the conversation, or forked the session, to try a different route.",
			Try:     "When a turn went wrong, rewind to before it (Esc Esc) instead of arguing with the result: the failed attempt leaves the context.",
			Detect:  rewind,
		},
		{
			ID: "grounded-prompt", Category: CategoryPrompt, Persona: Karpathy, Title: "Grounded prompt",
			Detects: "Counted when your prompt names a file by its name and the agent then works on that file in the same turn.",
			What:    "Your prompt named files the agent then worked on.",
			Try:     "Name the files, functions or commands that matter. The agent spends fewer tokens searching and guesses wrong less often.",
			Detect:  groundedPrompt,
		},
		{
			ID: "pasted-evidence", Category: CategoryPrompt, Persona: Karpathy, Title: "Shows the evidence",
			Detects: "Counted when you attach an image, or paste two or more lines that look like an error or a stack trace.",
			What:    "You pasted an error, a stack trace or a screenshot instead of describing it.",
			Try:     "Paste the actual error output or a screenshot. It is the most precise context you can give, and it costs nothing to write.",
			Detect:  pastedEvidence,
		},
		{
			ID: "acceptance-criteria", Category: CategoryPrompt, Persona: Karpathy, Title: "Spec with criteria",
			Detects: "Counted when a long prompt (300 bytes or more) has three or more list items and a word like must, never, verify or test.",
			What:    "You wrote a structured prompt with constraints or acceptance criteria.",
			Try:     "For anything bigger than a quick fix, list what done means: the constraints, what must not change, how to verify it. The agent then checks its own work.",
			Detect:  acceptanceCriteria,
		},
		{
			ID: "one-shot-spec", Category: CategoryPrompt, Persona: Karpathy, Title: "One-shot spec",
			Detects: "Counted when a prompt of 120 words or more leads to ten or more tool calls, without an interruption or a correction after it.",
			What:    "A detailed prompt that the agent carried out in one go, with no correction afterwards.",
			Try:     "Front-load the thinking: one well-specified prompt usually beats five rounds of corrections, in quality and in tokens.",
			Detect:  oneShotSpec,
		},
		{
			ID: "vibe-one-shot", Category: CategoryPrompt, Persona: Karpathy, Title: "Vibe one-shot",
			Detects: "Counted when a short prompt (2 to 25 words, not a plain approval) leads to three or more edits with no correction after it.",
			What:    "A prompt of a few words that led to real edits, with no correction afterwards.",
			Try:     "Once the agent knows the project, a short prompt can carry a lot. Try a one-liner for a change you both understand well.",
			Detect:  vibeOneShot,
		},
		{
			ID: "clean-slate", Category: CategoryContext, Persona: Karpathy, Title: "Clean slate",
			Detects: "Counted when you start fresh with /clear.",
			What:    "You cleared the context to start the next task fresh.",
			Try:     "Starting something new? /clear first. Old context is paid for on every call and distracts the agent.",
			Detect:  cleanSlate,
			Symptom: longSessions,
		},

		// Boris: masters the harness, automates, goes up a meta level.
		{
			ID: "plans-first", Category: CategoryPrompt, Persona: Boris, Title: "Plans first",
			Detects: "Counted when a turn uses plan mode.",
			What:    "You had the agent plan before it touched any code.",
			Try:     "Use plan mode (Shift+Tab) for anything non-trivial: you review the approach before a single file changes.",
			Detect:  plansFirst,
		},
		{
			ID: "deliberate-compact", Category: CategoryContext, Persona: Boris, Title: "Compacts on purpose",
			Detects: "Counted when you compact the conversation yourself, not when it compacts on its own.",
			What:    "You compacted the context yourself, at a moment you chose.",
			Try:     "Context grows with every call, and so does the price of each call. Run /compact at a natural break, saying what to keep, before auto-compaction picks a worse moment.",
			Detect:  deliberateCompact,
			Symptom: autoCompactions,
		},
		{
			ID: "model-switch", Category: CategoryContext, Persona: Boris, Title: "Switches model mid-session",
			Detects: "Counted when you change model, effort or fast mode with /model, /effort or /fast during a session.",
			What:    "You switched the model or the effort in the middle of a session.",
			Try:     "Not every task needs the largest model. Switch with /model: a smaller one for mechanical work, the largest for hard reasoning.",
			Detect:  modelSwitch,
		},
		{
			ID: "custom-command", Category: CategoryHarness, Persona: Boris, Title: "Own commands and skills",
			Detects: "Counted when you run a slash command that is not built in, or the agent uses a skill.",
			What:    "You ran a skill or a slash command that you or a plugin added.",
			Try:     "Typing the same instructions again and again? Make them a skill or a slash command and run them with one word.",
			Detect:  customCommand,
			Symptom: repeatedPrompts,
		},
		{
			ID: "builds-harness", Category: CategoryHarness, Persona: Boris, Title: "Builds the harness",
			Detects: "Counted when a turn with edits touches your agent setup: CLAUDE.md, AGENTS.md, skills, commands, agents, hooks or settings.",
			What:    "You had the agent edit its own instructions, skills, commands or settings.",
			Try:     "When you correct the agent twice for the same thing, put the rule in CLAUDE.md or a skill. The fix then holds in every session after.",
			Detect:  buildsHarness,
		},
		{
			ID: "context-isolation", Category: CategoryContext, Persona: Boris, Title: "Context isolation",
			Detects: "Counted when a subagent starts with a fresh context and explores, or reads five or more times without editing.",
			What:    "A subagent did the reading in a context of its own and came back with a summary.",
			Try:     "Send exploration to a subagent: it reads twenty files in its own context and returns a page, so the main context stays small and cheap.",
			Detect:  contextIsolation,
		},
		{
			ID: "model-routing", Category: CategoryHarness, Persona: Boris, Title: "Model routing",
			Detects: "Counted when a subagent runs on a cheaper model than the main session's.",
			What:    "A subagent ran on a cheaper model than the session's main one.",
			Try:     "Subagents that search or summarise rarely need the largest model. Give them a smaller one and pay a fraction.",
			Detect:  modelRouting,
			Symptom: unroutedAgents,
		},
		{
			ID: "compressed-shell", Category: CategoryHarness, Persona: Boris, Title: "Compressed shell output",
			Detects: "Counted for each turn with shell calls in a Claude Code session started after a shell-output compressor (an rtk hook) was set up in your settings.",
			What:    "A hook shrank the output of your shell commands before the agent read it.",
			Try:     "A hook such as rtk rewrites git status, test runs and listings into a compact form. The agent reads far fewer tokens, and so does every later call that carries them.",
			Detect:  compressedShell,
		},
		{
			ID: "parallel-sessions", Category: CategoryParallelism, Persona: Boris, Title: "Parallel sessions",
			Detects: "Counted when two or more sessions work at once; turns less than five minutes apart form one stretch. One time per day.",
			What:    "Several of your sessions were working at the same time.",
			Try:     "While one agent works, start another on an independent task in a second terminal. Two to five at once is where many experienced users settle.",
			Detect:  parallelSessions,
		},
		{
			ID: "worktrees", Category: CategoryParallelism, Persona: Boris, Title: "Worktrees",
			Detects: "Counted when a session enters a worktree or works in a directory under worktrees/.",
			What:    "An agent worked in a git worktree of its own.",
			Try:     "Parallel agents in one checkout trip over each other's changes. Give each one its own git worktree.",
			Detect:  worktrees,
		},
		{
			ID: "background-agents", Category: CategoryParallelism, Persona: Boris, Title: "Background agents",
			Detects: "Counted when a subagent runs in the background.",
			What:    "Agents worked in the background while the session carried on.",
			Try:     "Long work (a test suite, a broad search) can run as a background agent while you keep talking to the main one.",
			Detect:  backgroundAgents,
		},
		{
			ID: "automation", Category: CategoryHarness, Persona: Boris, Title: "Automation",
			Detects: "Counted for scripted sessions (once per day), scheduled turns, or when the agent schedules a wake-up or a recurring job.",
			What:    "Agents ran headless or on a schedule, without you typing.",
			Try:     "Some work doesn't need you in the loop: run the agent from a script or CI (claude -p), or schedule a recurring check.",
			Detect:  automation,
		},
		{
			ID: "ships-pr", Category: CategoryHarness, Persona: Boris, Title: "Ships",
			Detects: "Counted when a session links a pull request.",
			What:    "A session opened or linked a pull request.",
			Try:     "Let the agent take a change all the way: branch, commit, push and open the pull request.",
			Detect:  shipsPR,
		},
		{
			ID: "mcp-tools", Category: CategoryHarness, Persona: Boris, Title: "Plugged in",
			Detects: "Counted when the agent calls a tool from an MCP server.",
			What:    "The agent used tools from an MCP server.",
			Try:     "Connect the agent to the systems you work in (issue tracker, docs, browser) over MCP, so it can look things up itself.",
			Detect:  mcpTools,
		},

		// Yegge: a year ahead of everyone. A bit is good; a lot, careful.
		{
			ID: "agent-team", Category: CategoryParallelism, Persona: Yegge, Title: "Agent team",
			Detects: "Counted when a session has teammates, subagents you can address by name. Once per session.",
			What:    "You ran teammates: agents that stay around and take more work.",
			Try:     "An agent team splits a big job over teammates that message each other. Start with two or three on clearly separate parts.",
			Detect:  agentTeam,
		},
		{
			ID: "workflow-run", Category: CategoryHarness, Persona: Yegge, Title: "Workflow",
			Detects: "Counted when a session runs a workflow.",
			What:    "A scripted workflow fanned the work out over many agents.",
			Try:     "When the same multi-step job comes back, script it as a workflow and let it run the agents.",
			Detect:  workflowRun,
		},
		{
			ID: "nested-agents", Category: CategoryParallelism, Persona: Yegge, Title: "Agents spawning agents",
			Detects: "Counted when an agent is started by another agent, at the deepest point. Once per session.",
			What:    "Agents started agents of their own.",
			Try:     "For tree-shaped work, let a coordinating agent hand pieces out to subagents of its own.",
			Detect:  nestedAgents,
		},
		{
			ID: "swarm", Category: CategoryParallelism, Persona: Yegge, Title: "Swarm",
			Detects: "Counted when five or more agents run at the same moment. Once per session.",
			What:    "Five or more agents ran at the same moment.",
			Try:     "Independent pieces of work (one per package, one per test file) can run as many agents at once. Watch the bill.",
			Detect:  swarm,
		},
		{
			ID: "beads-graph", Category: CategoryHarness, Persona: Yegge, Title: "Beads as the plan",
			Detects: "Counted when one session creates three or more beads, links at least one and closes at least one.",
			What:    "The plan lived in beads: issues created, linked and closed.",
			Try:     "A plan in markdown gets rewritten over and over. Beads (bd) keeps it as a graph of issues that agents claim and close across sessions.",
			Detect:  beadsGraph,
		},
		{
			ID: "personas", Category: CategoryHarness, Persona: Yegge, Title: "Persistent personas",
			Detects: "Counted when you use /wake, /sleep or /handoff, or touch a file under personas/. Once per session.",
			What:    "You woke a persistent persona: a named agent with its own memory, whose day ends with sleep rather than an exit.",
			Try:     "Sessions are days, personas persist. Give a recurring role a persona that wakes with its memory and open threads, works a bounded day and sleeps, instead of starting from nothing each time (Yegge's model-welfare essay).",
			Detect:  personas,
		},
		{
			ID: "forked-agents", Category: CategoryParallelism, Persona: Yegge, Title: "Forks itself",
			Detects: "Counted when a subagent starts with its parent's whole context.",
			What:    "The agent forked copies of itself that started with its whole context.",
			Try:     "A fork starts with everything the agent knows. Use one for a side quest that needs the full picture.",
			Detect:  forkedAgents,
		},
		{
			ID: "two-harnesses", Category: CategoryHarness, Persona: Yegge, Title: "Two harnesses",
			Detects: "Counted when you work in two different harnesses in the same week.",
			What:    "You worked with both Claude Code and Codex in the same week.",
			Try:     "Each harness has its strengths. Trying another one on a real task shows you what your main one does well.",
			Detect:  twoHarnesses,
		},
		{
			ID: "night-shift", Category: CategoryParallelism, Persona: Yegge, Title: "Night shift",
			Detects: "Counted when two hours or more pass between two of your prompts and the agent starts three or more turns on its own in between.",
			What:    "Agents kept working for hours while you were away.",
			Try:     "Hand over a well-specified, well-tested task before you leave, and come back to the result.",
			Detect:  nightShift,
		},
	}
}
