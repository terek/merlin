#!/usr/bin/env bun
/**
 * Pretty-print the `user` payload that was sent to the organizer LLM.
 *
 * Usage:
 *   bun scripts/organizer-input.ts [path]
 *
 * Default path: /tmp/session_organizer_input.json
 */

const DEFAULT_PATH = '/tmp/session_organizer_input.json'

interface FlatTask {
  /** Composite: "<sessionId>/<localTaskId>" */
  taskId: string
  description: string
  turnCount: number
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  concepts?: Array<{ concept: string; description: string }>
}

interface Dump {
  cwd?: string
  generatedAt?: string
  system?: string
  user: { tasks: FlatTask[] }
}

const path = process.argv[2] ?? DEFAULT_PATH
const file = Bun.file(path)
if (!(await file.exists())) {
  console.error(`not found: ${path}`)
  process.exit(1)
}

const raw = (await file.json()) as Dump | Dump['user']
// Accept both shapes: the daemon dumps `{ cwd, system, user: { tasks } }`,
// while organizer-detailed.ts writes `{ cwd, tasks }` at the top level.
const dump: Dump =
  'user' in raw && raw.user ? (raw as Dump) : { ...(raw as Record<string, unknown>), user: raw as Dump['user'] }
const tasks = dump.user?.tasks ?? []

// ANSI helpers. Disable with NO_COLOR=1.
const noColor = process.env.NO_COLOR || !process.stdout.isTTY
const c = (code: string, s: string) => (noColor ? s : `\x1b[${code}m${s}\x1b[0m`)
const bold = (s: string) => c('1', s)
const dim = (s: string) => c('2', s)
const cyan = (s: string) => c('36', s)
const yellow = (s: string) => c('33', s)
const green = (s: string) => c('32', s)

// ── Header ────────────────────────────────────────────────────────────────
console.log(bold(`Organizer input: ${path}`))
if (dump.cwd) console.log(dim(`cwd:         ${dump.cwd}`))
if (dump.generatedAt) console.log(dim(`generatedAt: ${dump.generatedAt}`))
console.log(dim(`tasks:       ${tasks.length} (chronological)`))
const tasksWithConcepts = tasks.filter((t) => t.concepts && t.concepts.length > 0).length
const totalConcepts = tasks.reduce((s, t) => s + (t.concepts?.length ?? 0), 0)
console.log(dim(`concepts:    ${totalConcepts} across ${tasksWithConcepts}/${tasks.length} tasks`))
console.log()

// ── Chronological task stream ─────────────────────────────────────────────
for (const t of tasks) {
  const [sessionId, localTaskId] = splitTaskId(t.taskId)
  const id = `${cyan(sessionId.slice(0, 8))}/${yellow(localTaskId)}`
  const when = fmtDate(t.startedAt)
  const span = fmtDuration(t.durationMs)
  console.log(`${id} ${t.description}`)
  console.log(
    `       ${dim(`${t.turnCount} turn${t.turnCount !== 1 ? 's' : ''} · ${when}${span ? ` · ${span}` : ''}`)}`,
  )
  if (t.concepts && t.concepts.length > 0) {
    for (const con of t.concepts) {
      console.log(`       ${green('›')} ${bold(con.concept)}${dim(' — ')}${con.description}`)
    }
  }
}
console.log()

// Footer: length estimate so you can eyeball token budget.
const userChars = JSON.stringify(dump.user).length
const systemChars = dump.system?.length ?? 0
const totalChars = userChars + systemChars
console.log(
  dim(
    `— payload: system ${systemChars} chars + user ${userChars} chars = ${totalChars} chars (~${Math.ceil(totalChars / 4)} tokens)`,
  ),
)

// ── Helpers ───────────────────────────────────────────────────────────────

function splitTaskId(composite: string): [string, string] {
  const slash = composite.lastIndexOf('/')
  if (slash < 0) return ['', composite]
  return [composite.slice(0, slash), composite.slice(slash + 1)]
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '?'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = Date.now()
  const delta = now - d.getTime()
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  if (delta < 7 * 86400_000) return `${Math.floor(delta / 86400_000)}d ago`
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

function fmtDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return ''
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3600_000).toFixed(1)}h`
}
