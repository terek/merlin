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
			ID: "steer-mid-turn", Persona: Karpathy, Title: "Steering mid-turn",
			What:    "You sent a correction or more context while the agent was still working, without stopping it.",
			Try:     "You don't have to wait for the agent to finish. Type while it works: the message reaches it mid-turn, so a wrong assumption is fixed before it turns into twenty edits.",
			Detect:  steerMidTurn,
			Symptom: longTurns,
		},
		{
			ID: "interrupt-redirect", Persona: Karpathy, Title: "Interrupt and redirect",
			What:   "You stopped the agent and gave it a new direction within two minutes.",
			Try:    "When the agent heads the wrong way, press Esc and say what you want instead. Stopping early is cheaper than undoing later.",
			Detect: interruptRedirect,
		},
		{
			ID: "rewind", Persona: Karpathy, Title: "Takes the other branch",
			What:   "You rewound the conversation, or forked the session, to try a different route.",
			Try:    "When a turn went wrong, rewind to before it (Esc Esc) instead of arguing with the result: the failed attempt leaves the context.",
			Detect: rewind,
		},
		{
			ID: "grounded-prompt", Persona: Karpathy, Title: "Grounded prompt",
			What:   "Your prompt named files the agent then worked on.",
			Try:    "Name the files, functions or commands that matter. The agent spends fewer tokens searching and guesses wrong less often.",
			Detect: groundedPrompt,
		},
		{
			ID: "pasted-evidence", Persona: Karpathy, Title: "Shows the evidence",
			What:   "You pasted an error, a stack trace or a screenshot instead of describing it.",
			Try:    "Paste the actual error output or a screenshot. It is the most precise context you can give, and it costs nothing to write.",
			Detect: pastedEvidence,
		},
		{
			ID: "acceptance-criteria", Persona: Karpathy, Title: "Spec with criteria",
			What:   "You wrote a structured prompt with constraints or acceptance criteria.",
			Try:    "For anything bigger than a quick fix, list what done means: the constraints, what must not change, how to verify it. The agent then checks its own work.",
			Detect: acceptanceCriteria,
		},
		{
			ID: "one-shot-spec", Persona: Karpathy, Title: "One-shot spec",
			What:   "A detailed prompt that the agent carried out in one go, with no correction afterwards.",
			Try:    "Front-load the thinking: one well-specified prompt usually beats five rounds of corrections, in quality and in tokens.",
			Detect: oneShotSpec,
		},
		{
			ID: "vibe-one-shot", Persona: Karpathy, Title: "Vibe one-shot",
			What:   "A prompt of a few words that led to real edits, with no correction afterwards.",
			Try:    "Once the agent knows the project, a short prompt can carry a lot. Try a one-liner for a change you both understand well.",
			Detect: vibeOneShot,
		},
		{
			ID: "clean-slate", Persona: Karpathy, Title: "Clean slate",
			What:    "You cleared the context to start the next task fresh.",
			Try:     "Starting something new? /clear first. Old context is paid for on every call and distracts the agent.",
			Detect:  cleanSlate,
			Symptom: longSessions,
		},

		// Boris: masters the harness, automates, goes up a meta level.
		{
			ID: "plans-first", Persona: Boris, Title: "Plans first",
			What:   "You had the agent plan before it touched any code.",
			Try:    "Use plan mode (Shift+Tab) for anything non-trivial: you review the approach before a single file changes.",
			Detect: plansFirst,
		},
		{
			ID: "deliberate-compact", Persona: Boris, Title: "Compacts on purpose",
			What:    "You compacted the context yourself, at a moment you chose.",
			Try:     "Context grows with every call, and so does the price of each call. Run /compact at a natural break, saying what to keep, before auto-compaction picks a worse moment.",
			Detect:  deliberateCompact,
			Symptom: autoCompactions,
		},
		{
			ID: "model-switch", Persona: Boris, Title: "Right model for the job",
			What:   "You switched the model or the effort in the middle of a session.",
			Try:    "Not every task needs the largest model. Switch with /model: a smaller one for mechanical work, the largest for hard reasoning.",
			Detect: modelSwitch,
		},
		{
			ID: "custom-command", Persona: Boris, Title: "Own commands and skills",
			What:    "You ran a skill or a slash command that you or a plugin added.",
			Try:     "Typing the same instructions again and again? Make them a skill or a slash command and run them with one word.",
			Detect:  customCommand,
			Symptom: repeatedPrompts,
		},
		{
			ID: "builds-harness", Persona: Boris, Title: "Builds the harness",
			What:   "You had the agent edit its own instructions, skills, commands or settings.",
			Try:    "When you correct the agent twice for the same thing, put the rule in CLAUDE.md or a skill. The fix then holds in every session after.",
			Detect: buildsHarness,
		},
		{
			ID: "context-isolation", Persona: Boris, Title: "Context isolation",
			What:    "A subagent did the reading in a context of its own and came back with a summary.",
			Try:     "Send exploration to a subagent: it reads twenty files in its own context and returns a page, so the main context stays small and cheap.",
			Detect:  contextIsolation,
			Symptom: bigContexts,
		},
		{
			ID: "model-routing", Persona: Boris, Title: "Model routing",
			What:    "A subagent ran on a cheaper model than the session's main one.",
			Try:     "Subagents that search or summarise rarely need the largest model. Give them a smaller one and pay a fraction.",
			Detect:  modelRouting,
			Symptom: unroutedAgents,
		},
		{
			ID: "parallel-sessions", Persona: Boris, Title: "Parallel sessions",
			What:   "Several of your sessions were working at the same time.",
			Try:    "While one agent works, start another on an independent task in a second terminal. Two to five at once is where many experienced users settle.",
			Detect: parallelSessions,
		},
		{
			ID: "worktrees", Persona: Boris, Title: "Worktrees",
			What:   "An agent worked in a git worktree of its own.",
			Try:    "Parallel agents in one checkout trip over each other's changes. Give each one its own git worktree.",
			Detect: worktrees,
		},
		{
			ID: "background-agents", Persona: Boris, Title: "Background agents",
			What:   "Agents worked in the background while the session carried on.",
			Try:    "Long work (a test suite, a broad search) can run as a background agent while you keep talking to the main one.",
			Detect: backgroundAgents,
		},
		{
			ID: "automation", Persona: Boris, Title: "Automation",
			What:   "Agents ran headless or on a schedule, without you typing.",
			Try:    "Some work doesn't need you in the loop: run the agent from a script or CI (claude -p), or schedule a recurring check.",
			Detect: automation,
		},
		{
			ID: "ships-pr", Persona: Boris, Title: "Ships",
			What:   "A session opened or linked a pull request.",
			Try:    "Let the agent take a change all the way: branch, commit, push and open the pull request.",
			Detect: shipsPR,
		},
		{
			ID: "mcp-tools", Persona: Boris, Title: "Plugged in",
			What:   "The agent used tools from an MCP server.",
			Try:    "Connect the agent to the systems you work in (issue tracker, docs, browser) over MCP, so it can look things up itself.",
			Detect: mcpTools,
		},

		// Yegge: a year ahead of everyone. A bit is good; a lot, careful.
		{
			ID: "agent-team", Persona: Yegge, Title: "Agent team",
			What:   "You ran teammates: agents that stay around and take more work.",
			Try:    "An agent team splits a big job over teammates that message each other. Start with two or three on clearly separate parts.",
			Detect: agentTeam,
		},
		{
			ID: "workflow-run", Persona: Yegge, Title: "Workflow",
			What:   "A scripted workflow fanned the work out over many agents.",
			Try:    "When the same multi-step job comes back, script it as a workflow and let it run the agents.",
			Detect: workflowRun,
		},
		{
			ID: "nested-agents", Persona: Yegge, Title: "Agents spawning agents",
			What:   "Agents started agents of their own.",
			Try:    "For tree-shaped work, let a coordinating agent hand pieces out to subagents of its own.",
			Detect: nestedAgents,
		},
		{
			ID: "swarm", Persona: Yegge, Title: "Swarm",
			What:   "Five or more agents ran at the same moment.",
			Try:    "Independent pieces of work (one per package, one per test file) can run as many agents at once. Watch the bill.",
			Detect: swarm,
		},
		{
			ID: "beads-graph", Persona: Yegge, Title: "Beads as the plan",
			What:   "The plan lived in beads: issues created, linked and closed.",
			Try:    "A plan in markdown gets rewritten over and over. Beads (bd) keeps it as a graph of issues that agents claim and close across sessions.",
			Detect: beadsGraph,
		},
		{
			ID: "personas", Persona: Yegge, Title: "Persistent personas",
			What:   "You woke a persistent persona: a named agent with its own memory, whose day ends with sleep rather than an exit.",
			Try:    "Sessions are days, personas persist. Give a recurring role a persona that wakes with its memory and open threads, works a bounded day and sleeps, instead of starting from nothing each time (Yegge's model-welfare essay).",
			Detect: personas,
		},
		{
			ID: "forked-agents", Persona: Yegge, Title: "Forks itself",
			What:   "The agent forked copies of itself that started with its whole context.",
			Try:    "A fork starts with everything the agent knows. Use one for a side quest that needs the full picture.",
			Detect: forkedAgents,
		},
		{
			ID: "two-harnesses", Persona: Yegge, Title: "Two harnesses",
			What:   "You worked with both Claude Code and Codex in the same week.",
			Try:    "Each harness has its strengths. Trying another one on a real task shows you what your main one does well.",
			Detect: twoHarnesses,
		},
		{
			ID: "night-shift", Persona: Yegge, Title: "Night shift",
			What:   "Agents kept working for hours while you were away.",
			Try:    "Hand over a well-specified, well-tested task before you leave, and come back to the result.",
			Detect: nightShift,
		},
	}
}
