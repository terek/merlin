# Merlin Go — Setup

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code](https://claude.ai/claude-code) installed

## Install hooks

Merlin uses Claude Code hooks to track which CC session is running in which process.
This enables accurate per-session status indicators in the TUI.

### 1. Copy the hook scripts

The hook scripts are in [`scripts/`](scripts/):

```bash
mkdir -p ~/.merlin/hooks ~/.merlin/sessions
cp scripts/session-start.sh ~/.merlin/hooks/
cp scripts/session-end.sh ~/.merlin/hooks/
chmod +x ~/.merlin/hooks/session-start.sh ~/.merlin/hooks/session-end.sh
```

### 2. Register hooks in Claude Code settings

Add the following to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.merlin/hooks/session-start.sh"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.merlin/hooks/session-end.sh"
          }
        ]
      }
    ]
  }
}
```

If you already have a `hooks` section, merge the `SessionStart` and `SessionEnd` entries into it.

### 3. Verify

Start a new Claude Code session, then check:

```bash
ls ~/.merlin/sessions/
```

You should see a `.json` file named after the CC process PID. Inspect it:

```bash
cat ~/.merlin/sessions/*.json
```

Each file contains `{"sessionId":"<id>","cwd":"<project_path>","startedAt":<unix_timestamp>}`.

## How it works

- **SessionStart hook**: when CC starts or resumes a session, the hook writes `~/.merlin/sessions/<pid>.json` containing `{ sessionId, cwd, startedAt }`. The PID comes from `$PPID` (the hook runs as a child of the CC process). On `/resume` or compaction, CC fires SessionStart again with a new session_id but the same PID — the file is simply overwritten.
- **SessionEnd hook**: when CC exits cleanly, the hook removes the lockfile.
- **Stale cleanup**: if CC crashes (no SessionEnd), the daemon detects dead PIDs on its next refresh and removes stale lockfiles automatically.
- **Fallback**: if hooks aren't installed, the daemon falls back to extracting `--resume <sessionId>` from CC process args (works when CC was started with `--resume`, but not for fresh sessions).

## Session indicators in the TUI

> The TUI is a legacy/reference client (see [BUILD.md](BUILD.md)) — the web client is the primary UI. The session hooks above improve session identification for all clients, not just the TUI.

| Symbol | Color  | Meaning |
|--------|--------|---------|
| `●`    | green  | Daemon-managed session |
| `●`    | yellow | External CC process, session identified |
| `◑`    | yellow | External CC process running, session unknown |
| `○`    | gray   | No active process |

With hooks installed, you'll see yellow `●` for every active CC session. Without hooks, unidentified sessions show `◑`.

## LLM configuration (env vars)

Merlin's three LLM consumers are configured entirely through environment
variables. In dev, Bun auto-loads a `.env` from the repo root (see
`.env.example`). For the **compiled binary**, put the same file at
**`~/.merlin/.env`** — it's loaded on startup regardless of where the binary
lives or which directory you launch it from.

Precedence (highest first): real shell environment → cwd `.env` (dev) →
`~/.merlin/.env`. Already-set vars are never overwritten.

Each consumer picks one model var and infers the provider from the model name.
API keys follow a **task-specific → generic** fallback per provider:

| Consumer | Model var | Provider inference | API key (specific → generic) |
|----------|-----------|--------------------|------------------------------|
| **Clerk** (study chat) | `CLERK_MODEL` (required, else clerk disabled) | `claude-*`→Anthropic, `ollama:*`→Ollama, else Gemini | `<PROVIDER>_CLERK_API_KEY` → `<PROVIDER>_API_KEY` |
| **Processor / summarizer / organizer** | `PROCESSOR_MODEL` (else LLM features disabled) | `claude*`→Anthropic, `gpt-*`→OpenAI, `ollama:*`→Ollama, else Gemini | `<PROVIDER>_PROCESSOR_API_KEY` → `<PROVIDER>_API_KEY` |
| **Embeddings** (task search) | `PROCESSOR_EMBEDDING_MODEL` (else embeddings disabled) | `text-embedding-*`→OpenAI, else Gemini | `<PROVIDER>_PROCESSOR_API_KEY` → `<PROVIDER>_API_KEY` |

Gemini keys also fall back to `GOOGLE_API_KEY` as a final step. Ollama needs no
key; set `OLLAMA_BASE_URL` to override `http://localhost:11434`.

Example `~/.merlin/.env`:

```bash
# Clerk study-mode chat
CLERK_MODEL=claude-sonnet-4-6
ANTHROPIC_CLERK_API_KEY=sk-ant-...

# Preprocessor + summarizer + organizer
PROCESSOR_MODEL=gemini-2.5-flash-lite
GEMINI_PROCESSOR_API_KEY=...

# Semantic task search (optional)
PROCESSOR_EMBEDDING_MODEL=gemini-embedding-001
# reuses GEMINI_PROCESSOR_API_KEY above
```
