I want to build "Processor", an engine that digests claude code (later other) agentic coding sessions in order to organize knowledge and understand the evolution of concepts, features and technical designs. Let's build it a standalone component, and later it might become a library in a larger project.

The input unit is an agentic coding session, by claude code, typically stored at ~/.claude/projects/<encoded-directory>/<session-hash>.jsonl. The processed / derived artifacts we will store at ~/.merlin/projects/<encoded-directory>/<session-hash>.jsonl. Later we go beyond claude code, e.g. cursor, which stores files in ~/.cursor/projects/*/agent-transcripts/<session-hash>.jsonl, with a slightly different directory encoding -- let's forever stick with claude's encoding even with cursors sessions later.

Our working unit is a project, which is typically the place where the .git/ folder lives. This is not strict, just a healthy way of organizing work. Obvious exceptions include submodules or monorepos.. All sessions of the project folder should be inculded, along with recursively considering all sessions in all the nested folders.

Projects or sessions can be ignored, we will use .merlinignore files for this, just like .gitignore. The unit of reference is either a regular folder (means exclude anything below) or a specific reference to a session with <folder>/<session-identifier>, where session-identifier is either a hash or a name for named sessions, see @MERLINIGNORE.md for full reference.

Processing queue:
- ProcessingQueue is the entry point for all processing requests from the daemon. It accepts project, session, and all-projects requests and serves them with controlled concurrency (maxConcurrent, default 2).
- Cross-type deduplication: a session job is dropped if a project job for the same cwd is pending or running (the project will cover it). A new project job cancels pending session jobs for the same cwd.
- Per-project drain tracking: the queue tracks active jobs per cwd and fires onProjectDrained when the last one completes. The daemon uses this as the single broadcast point for UI updates (not per-job).
- The 'all' job is a dispatcher: it calls resolveAllProjects() at execution time and enqueues individual project jobs (which may run in parallel up to maxConcurrent).
- Queue state persists to ~/.merlin/processing-queue.json. On restart, interrupted running jobs are restored as pending and re-executed. Processing is idempotent via fingerprint checks.
- Collapse/uncollapse during processing is intentionally undefined behavior — no special handling.

Session data model:
- Raw sessions: these are the files in ~/.claude/projects/... or cursor or whatever. the ground truth. we assume they only change incrementally. if already processed sessions change in their raw format, the results are undefined, eventual reprocessing is nice but not stritcly required.
- Lean session: our first pre-processed layer. the idea here is that we throw out the non-important parts of the raw sessions to reduce the further processing needs. we also define a simplified data model here: it's all turns, one turn consists of a single user prompt (mostly identical to raw) and a single agent response (either its last response in a sequence of raw responses or a summary). additionally, each turn contains an optional costs section, the aggregated token consumption and time spent in this turn. Longer user or agent messages will be attached a summary to support more efficient work downstreams. Turns at this stage get an identifier, like session-hash prefix + 4-digit index within that session, e.g. 0c052bba-0001.
- Segments: longer lean sessions are split into semantic segments, most of the time these are consecutive turns, but there can be exceptions if two, semantically different tasks interleave (A A B A B A). Within a segment, the chronological order of turns follows the original order in lean sessions. Segments are the unit of work in further processing (labeling, clustering, requirement extraction, tbd).



