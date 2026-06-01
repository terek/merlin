/**
 * `merlin setup` — one-time host configuration for the compiled binary.
 *
 * Lays down everything the daemon needs that lives *outside* the binary:
 *   - ~/.merlin/hooks/{session-start,session-end}.sh  — the CC session lockfile hooks
 *   - ~/.merlin/.env.example                           — annotated config template
 *   - ~/.merlin/.env                                   — created from the template if absent
 *   - ~/.claude/settings.json                          — SessionStart/SessionEnd hooks merged in
 *
 * The hook scripts and env template are embedded as string constants below so the
 * single-file binary is fully self-contained — there is no repo on the user's disk.
 * These are the canonical copies; the matching files under scripts/ are kept only
 * for running from source. The merge into settings.json is idempotent: re-running
 * setup never duplicates an entry and never clobbers unrelated hooks.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.HOME || os.homedir()
const MERLIN_DIR = path.join(HOME, '.merlin')
const HOOKS_DIR = path.join(MERLIN_DIR, 'hooks')
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json')

const SESSION_START_SH = `#!/bin/sh
# Merlin — SessionStart hook
# Creates a lockfile: ~/.merlin/sessions/<pid>.json
# PID as filename makes liveness checks trivial (no need to read file).
# On /resume or compaction, CC fires SessionStart again with a new session_id
# but the same PID — so we just overwrite the same file.
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | sed -n 's/.*"session_id":"\\([^"]*\\)".*/\\1/p')
CWD=$(echo "$INPUT" | sed -n 's/.*"cwd":"\\([^"]*\\)".*/\\1/p')
LOCK_DIR="$HOME/.merlin/sessions"
mkdir -p "$LOCK_DIR"
echo "{\\"sessionId\\":\\"$SESSION_ID\\",\\"cwd\\":\\"$CWD\\",\\"startedAt\\":$(date +%s)}" > "$LOCK_DIR/$PPID.json"
`

const SESSION_END_SH = `#!/bin/sh
# Merlin — SessionEnd hook
# Removes the lockfile for this process.
rm -f "$HOME/.merlin/sessions/$PPID.json"
`

const ENV_EXAMPLE = `# Provider is inferred from the model name:
#   claude-*  → Anthropic
#   ollama:*  → Ollama (local, no API key needed)
#   *         → Gemini

# --- Clerk agent ---
CLERK_MODEL=claude-sonnet-4-6
ANTHROPIC_CLERK_API_KEY=your-key
# Or: CLERK_MODEL=gemini-2.5-flash + GEMINI_CLERK_API_KEY=your-key
# Or: CLERK_MODEL=ollama:qwen3:8b (no key needed)

# --- Preprocessor ---
PROCESSOR_MODEL=gemini-2.5-flash-lite
GEMINI_PROCESSOR_API_KEY=your-key
# Or: PROCESSOR_MODEL=ollama:qwen3:8b (no key needed)

# --- Ollama (optional) ---
# OLLAMA_BASE_URL=http://localhost:11434
`

// Hook commands we register in CC's settings.json. Use ~ so the file is portable.
const HOOK_COMMANDS = {
  SessionStart: '~/.merlin/hooks/session-start.sh',
  SessionEnd: '~/.merlin/hooks/session-end.sh',
} as const

type HookEntry = { type: 'command'; command: string; timeout?: number }
type HookGroup = { matcher?: string; hooks: HookEntry[] }
type ClaudeSettings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown }

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p)
    return true
  } catch {
    return false
  }
}

async function writeHooks(log: (m: string) => void): Promise<void> {
  await mkdir(HOOKS_DIR, { recursive: true })
  const start = path.join(HOOKS_DIR, 'session-start.sh')
  const end = path.join(HOOKS_DIR, 'session-end.sh')
  await writeFile(start, SESSION_START_SH)
  await writeFile(end, SESSION_END_SH)
  await chmod(start, 0o755)
  await chmod(end, 0o755)
  log(`  hooks       → ${HOOKS_DIR}/`)
}

async function writeEnv(log: (m: string) => void): Promise<void> {
  await mkdir(MERLIN_DIR, { recursive: true })
  const examplePath = path.join(MERLIN_DIR, '.env.example')
  await writeFile(examplePath, ENV_EXAMPLE)
  log(`  env template → ${examplePath}`)

  const envPath = path.join(MERLIN_DIR, '.env')
  if (await fileExists(envPath)) {
    log(`  config       → ${envPath} (kept existing)`)
  } else {
    await writeFile(envPath, ENV_EXAMPLE)
    log(`  config       → ${envPath} (created — add your API keys)`)
  }
}

/** Idempotently merge our SessionStart/SessionEnd hooks into CC's settings.json. */
async function mergeClaudeSettings(log: (m: string) => void): Promise<void> {
  await mkdir(path.dirname(CLAUDE_SETTINGS), { recursive: true })

  let settings: ClaudeSettings = {}
  if (await fileExists(CLAUDE_SETTINGS)) {
    try {
      settings = JSON.parse(await readFile(CLAUDE_SETTINGS, 'utf8')) as ClaudeSettings
    } catch (err) {
      throw new Error(
        `~/.claude/settings.json is not valid JSON — fix or remove it, then re-run \`merlin setup\`.\n  (${(err as Error).message})`,
      )
    }
  }

  settings.hooks ??= {}
  let changed = false

  for (const [event, command] of Object.entries(HOOK_COMMANDS)) {
    if (!settings.hooks[event]) settings.hooks[event] = []
    const groups = settings.hooks[event]
    const present = groups.some((g) => g.hooks?.some((h) => h.command === command))
    if (present) {
      log(`  settings.json: ${event} already registered`)
      continue
    }
    groups.push({ hooks: [{ type: 'command', command }] })
    changed = true
    log(`  settings.json: registered ${event}`)
  }

  if (changed) {
    await writeFile(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`)
  }
}

export async function runSetup(log: (m: string) => void = (m) => console.log(m)): Promise<void> {
  log('Setting up Merlin…')
  await writeHooks(log)
  await writeEnv(log)
  await mergeClaudeSettings(log)
  log('')
  log('✓ Setup complete. Next:')
  log(`  1. Add your API keys to ${path.join(MERLIN_DIR, '.env')}`)
  log('  2. Run `merlin` to start the daemon and pair a client.')
}
