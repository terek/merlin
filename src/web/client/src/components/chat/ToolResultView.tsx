/**
 * Typed renderers for Clerk tool results, used by the chat panel's debug view.
 *
 * The result `content` is the exact string the LLM gets fed back. For known
 * tool shapes we parse it and render a compact, human-readable card — task
 * title + description + concepts, lean-turn user/agent summaries, etc. — so
 * the debugger can judge whether the model had enough context. Low-level
 * fields (turn indices, hashes, token counts, timestamps, callIds) are
 * intentionally omitted; flip back to the raw JSON via "Show raw" when needed.
 */

import { useState } from 'react'

type Json = unknown

interface TaskShape {
  description?: string
  concepts?: Array<{ concept?: string; description?: string }>
}

interface SessionShape {
  title?: string | null
  startedAt?: string
  endedAt?: string
  turnCount?: number
  userTurnCount?: number
  taskCount?: number
}

interface LeanTurnShape {
  userText?: string
  userSummary?: string
  agentText?: string
  agentSummary?: string
  subagents?: unknown[]
}

interface RawTurnShape {
  role?: 'user' | 'assistant'
  text?: string
}

interface CodeMatchShape {
  file?: string
  line?: number
  text?: string
}

export function ToolResultView({ tool, content }: { tool?: string; content: string }) {
  const [showRaw, setShowRaw] = useState(false)

  let parsed: Json
  let isJson = true
  try {
    parsed = JSON.parse(content)
  } catch {
    isJson = false
    parsed = content
  }

  // Errors come back as { error: "..." } from any tool — uniform handling.
  if (isJson && parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)) {
    return <p className="text-xs text-red-400">{(parsed as { error: string }).error}</p>
  }

  const rich = isJson ? renderRich(tool, parsed) : null

  return (
    <div className="space-y-2">
      {rich ?? <RawText content={content} />}
      {rich != null && (
        <button
          type="button"
          onClick={() => setShowRaw(!showRaw)}
          className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
        >
          {showRaw ? 'hide raw' : 'show raw'}
        </button>
      )}
      {showRaw && <RawText content={content} />}
    </div>
  )
}

function renderRich(tool: string | undefined, parsed: Json): React.ReactNode | null {
  switch (tool) {
    case 'list_tasks':
    case 'search_tasks':
      return Array.isArray(parsed) ? <TasksList tasks={parsed as TaskShape[]} /> : null
    case 'get_task':
      return parsed && typeof parsed === 'object' ? <TasksList tasks={[parsed as TaskShape]} /> : null
    case 'list_sessions':
      return Array.isArray(parsed) ? <SessionsList sessions={parsed as SessionShape[]} /> : null
    case 'get_session_header':
      return parsed && typeof parsed === 'object' ? <SessionsList sessions={[parsed as SessionShape]} /> : null
    case 'get_lean_turns':
      return Array.isArray(parsed) ? <LeanTurnsList turns={parsed as LeanTurnShape[]} /> : null
    case 'get_raw_turns':
      return Array.isArray(parsed) ? <RawTurnsList turns={parsed as RawTurnShape[]} /> : null
    case 'search_code':
      return Array.isArray(parsed) ? <CodeMatchesList matches={parsed as CodeMatchShape[]} /> : null
    case 'list_files':
      return Array.isArray(parsed) ? <FilesList files={parsed as string[]} /> : null
    case 'read_file':
      // read_file returns plain (line-numbered) text — handled via the !isJson path above.
      return null
    default:
      return null
  }
}

// ── Per-tool renderers ───────────────────────────────────────────────────────

function TasksList({ tasks }: { tasks: TaskShape[] }) {
  if (tasks.length === 0) return <Empty label="no tasks" />
  return (
    <div className="space-y-2">
      {tasks.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order is stable per tool result
        <div key={i} className="rounded border border-border/40 bg-background/50 p-2">
          <div className="text-xs font-medium leading-snug">{t.description ?? '(no description)'}</div>
          {t.concepts && t.concepts.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {t.concepts.map((c, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: order is stable per tool result
                <li key={j} className="text-[11px] text-muted-foreground leading-snug">
                  <span className="text-emerald-400/80 font-medium">{c.concept ?? '?'}</span>
                  {c.description ? <span> — {c.description}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

function SessionsList({ sessions }: { sessions: SessionShape[] }) {
  if (sessions.length === 0) return <Empty label="no sessions" />
  return (
    <div className="space-y-1">
      {sessions.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order is stable per tool result
        <div key={i} className="text-xs leading-snug">
          <span className="font-medium">{s.title || '(untitled)'}</span>
          <span className="text-muted-foreground">
            {' · '}
            {s.userTurnCount ?? 0} turns
            {s.taskCount != null ? ` · ${s.taskCount} tasks` : null}
            {s.endedAt ? ` · ${shortDate(s.endedAt)}` : null}
          </span>
        </div>
      ))}
    </div>
  )
}

function LeanTurnsList({ turns }: { turns: LeanTurnShape[] }) {
  if (turns.length === 0) return <Empty label="no turns" />
  return (
    <div className="space-y-2">
      {turns.map((t, i) => {
        const userText = t.userSummary || clip(t.userText, 240)
        const agentText = t.agentSummary || clip(t.agentText, 240)
        const subagentCount = t.subagents?.length ?? 0
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: order is stable per tool result
          <div key={i} className="rounded border border-border/40 bg-background/50 p-2 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-cyan-400/80">user</div>
            <div className="text-xs whitespace-pre-wrap leading-snug">{userText || '(empty)'}</div>
            <div className="text-[10px] uppercase tracking-wide text-emerald-400/80 mt-1.5">clerk</div>
            <div className="text-xs whitespace-pre-wrap leading-snug">{agentText || '(empty)'}</div>
            {subagentCount > 0 && (
              <div className="text-[10px] text-amber-400/80">
                + {subagentCount} subagent{subagentCount > 1 ? 's' : ''}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function RawTurnsList({ turns }: { turns: RawTurnShape[] }) {
  if (turns.length === 0) return <Empty label="no turns" />
  return (
    <div className="space-y-2">
      {turns.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order is stable per tool result
        <div key={i} className="rounded border border-border/40 bg-background/50 p-2">
          <div
            className={`text-[10px] uppercase tracking-wide ${
              t.role === 'user' ? 'text-cyan-400/80' : 'text-emerald-400/80'
            }`}
          >
            {t.role ?? '?'}
          </div>
          <div className="text-xs whitespace-pre-wrap leading-snug">{clip(t.text, 320) || '(empty)'}</div>
        </div>
      ))}
    </div>
  )
}

function CodeMatchesList({ matches }: { matches: CodeMatchShape[] }) {
  if (matches.length === 0) return <Empty label="no matches" />
  return (
    <ul className="space-y-1 font-mono text-[11px]">
      {matches.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order is stable per tool result
        <li key={i} className="leading-snug">
          <span className="text-muted-foreground">
            {m.file}:{m.line}
          </span>{' '}
          <span>{clip(m.text, 200)}</span>
        </li>
      ))}
    </ul>
  )
}

function FilesList({ files }: { files: string[] }) {
  if (files.length === 0) return <Empty label="no files" />
  return (
    <ul className="space-y-0.5 font-mono text-[11px]">
      {files.map((f, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order is stable per tool result
        <li key={i} className="leading-snug">
          {f}
        </li>
      ))}
    </ul>
  )
}

function RawText({ content }: { content: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words text-[11px] leading-snug font-mono text-foreground/80 max-h-72 overflow-auto">
      {content}
    </pre>
  )
}

function Empty({ label }: { label: string }) {
  return <p className="text-xs italic text-muted-foreground">({label})</p>
}

// ── Small helpers ────────────────────────────────────────────────────────────

function clip(s: string | undefined, max: number): string {
  if (!s) return ''
  if (s.length <= max) return s
  return `${s.slice(0, max).trimEnd()}…`
}

function shortDate(iso: string): string {
  // Just the date portion of a YYYY-MM-DDTHH:MM:SS-style ISO string.
  return iso.slice(0, 10)
}
