/**
 * Per-project Clerk memory.
 *
 * Two artifacts on disk under `<clerkDir>/<project-slug>/`:
 *   - `active.json`    The single ongoing study session (overwritten on each save).
 *   - `memory.jsonl`   FIFO log of compacted past sessions, capped at MAX_ENTRIES.
 *
 * Layout & semantics:
 *   - Closing the active session pushes one MemoryEntry onto memory.jsonl
 *     (verbatim if total user+assistant text < VERBATIM_THRESHOLD chars,
 *     otherwise an LLM summary). The oldest entry is popped when the cap
 *     is exceeded. Beyond MAX_ENTRIES: forgotten.
 *   - Past entries are injected verbatim into the next session's system
 *     prompt as ambient memory (no separate retrieval tool).
 */

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ConversationMessage } from '@merlin/llm'

export const MAX_ENTRIES = 3
export const VERBATIM_THRESHOLD = 500

export interface ActiveSession {
  /** Stable id for telemetry. Not surfaced to users. */
  id: string
  startedAt: string
  updatedAt: string
  messages: ConversationMessage[]
}

/** A compacted past study session. Either verbatim text or LLM summary. */
export type MemoryEntry =
  | {
      kind: 'verbatim'
      id: string
      startedAt: string
      endedAt: string
      turnCount: number
      /** Whole conversation rendered as one short transcript. */
      text: string
    }
  | {
      kind: 'summary'
      id: string
      startedAt: string
      endedAt: string
      turnCount: number
      /** 2–5 sentence LLM-produced summary. */
      summary: string
      topics: string[]
    }

export class ClerkMemory {
  private dir: string

  constructor(clerkDir: string, projectCwd: string) {
    this.dir = path.join(clerkDir, slugify(projectCwd))
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  // ── Active session ───────────────────────────────────────────────────────

  async readActive(): Promise<ActiveSession | null> {
    try {
      return (await Bun.file(path.join(this.dir, 'active.json')).json()) as ActiveSession
    } catch {
      return null
    }
  }

  async writeActive(session: ActiveSession): Promise<void> {
    await Bun.write(path.join(this.dir, 'active.json'), JSON.stringify(session, null, 2))
  }

  async deleteActive(): Promise<void> {
    try {
      await Bun.file(path.join(this.dir, 'active.json')).delete()
    } catch {}
  }

  newActive(): ActiveSession {
    const now = new Date().toISOString()
    return { id: crypto.randomUUID(), startedAt: now, updatedAt: now, messages: [] }
  }

  // ── Memory log ───────────────────────────────────────────────────────────

  async readMemory(): Promise<MemoryEntry[]> {
    try {
      const content = await readFile(path.join(this.dir, 'memory.jsonl'), 'utf8')
      const entries: MemoryEntry[] = []
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          entries.push(JSON.parse(trimmed) as MemoryEntry)
        } catch {}
      }
      return entries
    } catch {
      return []
    }
  }

  /** Push a new entry, FIFO-cap to MAX_ENTRIES, persist. Newest first in file. */
  async pushMemory(entry: MemoryEntry): Promise<void> {
    const existing = await this.readMemory()
    const next = [entry, ...existing].slice(0, MAX_ENTRIES)
    const body = next.map((e) => JSON.stringify(e)).join('\n')
    await Bun.write(path.join(this.dir, 'memory.jsonl'), body ? `${body}\n` : '')
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Total char count of substantive (user + assistant) message text. Tool I/O excluded. */
export function substantiveChars(messages: ConversationMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      n += m.text?.length ?? 0
    }
  }
  return n
}

/** Render an active session as a plain transcript. Used for verbatim memory entries. */
export function renderTranscript(messages: ConversationMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'user' && m.text) lines.push(`User: ${m.text}`)
    else if (m.role === 'assistant' && m.text) lines.push(`Clerk: ${m.text}`)
  }
  return lines.join('\n\n')
}

function slugify(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-')
}
