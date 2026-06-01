import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isSessionIgnored } from '@merlin/ignore'
import type { CCJSONLEntry, SessionSummary } from './types.ts'

export interface DiscoveredFolder {
  path: string // absolute path to project dir under ~/.claude/projects/
  cwd: string // from JSONL cwd field
  sessionId: string // newest session
  slug?: string
  customTitle?: string
  lastTimestamp: number
  sessions: SessionSummary[]
}

export class ClaudeProjectDiscovery {
  private homeDir: string
  /** Number of projects fully hidden by .merlinignore in the last discover() pass. */
  lastIgnoredProjectCount = 0

  constructor(
    private claudeDir: string = path.join(os.homedir(), '.claude', 'projects'),
    homeDir?: string,
  ) {
    this.homeDir = homeDir ?? os.homedir()
  }

  async discover(): Promise<DiscoveredFolder[]> {
    let ignoredProjectCount = 0
    let entries: string[]
    try {
      entries = await readdir(this.claudeDir)
    } catch {
      return []
    }

    const projects: DiscoveredFolder[] = []

    for (const entry of entries) {
      try {
        const projectDir = path.join(this.claudeDir, entry)
        const dirStat = await stat(projectDir)
        if (!dirStat.isDirectory()) continue

        const files = await readdir(projectDir)
        const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))
        if (jsonlFiles.length === 0) continue

        // Extract cwd from JSONL files (cheap: first few lines only, try until found)
        let firstCwd: string | null = null
        for (const f of jsonlFiles) {
          firstCwd = await this.extractCwd(path.join(projectDir, f))
          if (firstCwd) break
        }
        const projectRelative = firstCwd?.startsWith(`${this.homeDir}/`)
          ? firstCwd.slice(this.homeDir.length + 1)
          : null

        const sessions: SessionSummary[] = []
        let projectCwd: string | undefined
        let ignoredInProject = 0

        for (const file of jsonlFiles) {
          const sessionId = file.slice(0, -6) // remove .jsonl

          // Skip ignored sessions (home-relative path)
          if (projectRelative && (await isSessionIgnored(this.homeDir, `${projectRelative}/${sessionId}`))) {
            ignoredInProject++
            continue
          }

          const filePath = path.join(projectDir, file)
          const fileStat = await stat(filePath)
          const summary = await this.parseSessionSummary(filePath, fileStat.size, projectDir)
          if (!summary) continue
          if (summary.cwd && !projectCwd) projectCwd = summary.cwd
          if (summary.session.lastTimestamp === 0) continue
          sessions.push(summary.session)
        }

        if (sessions.length === 0 || !projectCwd) {
          // A project with JSONL sessions that were all filtered by .merlinignore
          // is "hidden by ignore". Count it without capturing any identifying info.
          if (ignoredInProject > 0 && jsonlFiles.length === ignoredInProject) {
            ignoredProjectCount++
          }
          continue
        }

        // Skip temp dirs (macOS + Linux)
        if (
          projectCwd.startsWith('/private/var/folders/') ||
          projectCwd.startsWith('/private/tmp') ||
          projectCwd.startsWith('/tmp') ||
          projectCwd.startsWith('/var/folders/') ||
          projectCwd.startsWith('/snap/') ||
          projectCwd.startsWith('/run/user/')
        )
          continue

        sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp)

        const newest = sessions[0]
        projects.push({
          path: projectDir,
          cwd: projectCwd,
          sessionId: newest.sessionId,
          slug: newest.slug,
          customTitle: newest.customTitle,
          lastTimestamp: newest.lastTimestamp,
          sessions,
        })
      } catch {
        // swallow per-project errors
      }
    }

    projects.sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    this.lastIgnoredProjectCount = ignoredProjectCount
    return projects
  }

  async getLatestJsonlPath(targetCwd: string): Promise<string | null> {
    const projects = await this.discover()
    const project = projects.find((p) => p.cwd === targetCwd)
    if (!project || project.sessions.length === 0) return null
    return path.join(project.path, `${project.sessions[0].sessionId}.jsonl`)
  }

  async getJsonlPathForSession(targetCwd: string, sessionId: string): Promise<string | null> {
    const projects = await this.discover()
    const project = projects.find((p) => p.cwd === targetCwd)
    if (!project) return null
    const session = project.sessions.find((s) => s.sessionId === sessionId)
    if (!session) return null
    return path.join(project.path, `${session.sessionId}.jsonl`)
  }

  /** Read just the first few lines of a JSONL file to extract the cwd field. */
  private async extractCwd(filePath: string): Promise<string | null> {
    try {
      const text = await Bun.file(filePath).text()
      // Only scan first 10 lines — cwd is typically in the first entry
      const lines = text.split('\n', 10)
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as CCJSONLEntry
          if (entry.cwd) return entry.cwd
        } catch {
          /* skip corrupt lines */
        }
      }
    } catch {
      /* file unreadable */
    }
    return null
  }

  private async parseSessionSummary(
    filePath: string,
    sizeBytes: number,
    projectDir: string,
  ): Promise<{ session: SessionSummary; cwd?: string } | null> {
    const text = await Bun.file(filePath).text()
    const lines = text.split('\n').filter((l) => l.trim())

    let cwd: string | undefined
    let sessionId: string | undefined
    let slug: string | undefined
    let customTitle: string | undefined
    let lastTimestamp = 0
    let userTurnCount = 0
    let parentSessionId: string | undefined
    let firstSessionId: string | undefined

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as CCJSONLEntry
        if (entry.cwd && !cwd) cwd = entry.cwd
        if (entry.sessionId) {
          if (!firstSessionId) firstSessionId = entry.sessionId
          sessionId = entry.sessionId
        }
        if (entry.slug) slug = entry.slug
        if (entry.customTitle) customTitle = entry.customTitle
        if (entry.timestamp) {
          const ts =
            typeof entry.timestamp === 'string'
              ? Date.parse(entry.timestamp as unknown as string)
              : Number(entry.timestamp)
          if (!Number.isNaN(ts) && ts > lastTimestamp) lastTimestamp = ts
        }
        if (entry.type === 'user' && isRealUserPrompt(entry)) userTurnCount++
      } catch {
        // skip corrupt lines
      }
    }

    // Detect spawned subagent: first entry has a different sessionId (the parent)
    if (firstSessionId && sessionId && firstSessionId !== sessionId) {
      parentSessionId = firstSessionId
    }

    if (!sessionId) {
      sessionId = path.basename(filePath, '.jsonl')
    }

    let subagentCount = 0
    try {
      const subagentDir = path.join(projectDir, sessionId, 'subagents')
      const subFiles = await readdir(subagentDir)
      subagentCount = subFiles.filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl')).length
    } catch {
      // no subagents dir
    }

    const session: SessionSummary = {
      sessionId,
      slug,
      customTitle,
      lastTimestamp,
      sizeBytes,
      userTurnCount,
      subagentCount,
    }
    if (parentSessionId) session.parentSessionId = parentSessionId
    return { session, cwd }
  }
}

/**
 * Check if a user JSONL entry is a real user prompt (not tool results or system-injected XML).
 * Matches the same logic as jsonl-parser.ts extractUserText.
 */
const SYSTEM_XML_RE = /^\s*<(task-notification|teammate-message|local-command-caveat|command-name|system-reminder)[\s>]/

function isRealUserPrompt(entry: CCJSONLEntry): boolean {
  const msg = entry.message as { content?: unknown } | undefined
  // No message field — count it (simple/older JSONL format, test fixtures)
  if (!msg) return true
  if (!msg.content) return false

  // String content — check for system XML
  if (typeof msg.content === 'string') {
    return !SYSTEM_XML_RE.test(msg.content)
  }

  // Array content — must have at least one text block that isn't system XML or tool_result
  if (Array.isArray(msg.content)) {
    for (const block of msg.content as Array<{ type?: string; text?: string }>) {
      if (block.type === 'text' && block.text && !SYSTEM_XML_RE.test(block.text)) {
        return true
      }
    }
  }

  return false
}
