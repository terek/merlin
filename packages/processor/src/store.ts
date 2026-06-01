/**
 * Storage layer for processed sessions.
 *
 * Each session is stored in its own folder:
 *   ~/.merlin/projects/<project-dir-name>/<session-id>/
 *     lean.jsonl        — LeanSessionHeader (line 1) + LeanTurn per line
 *     segments.json     — Array of Segment objects
 *     (future: labels.json, clusters.json, etc.)
 *
 * The project index is stored at:
 *   ~/.merlin/projects/<project-dir-name>/index.json
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FolderIndex, LeanSession, LeanSessionHeader, LeanTurn, SessionEmbeddings, SessionTask } from './schema.ts'
import type { Segment } from './segment-schema.ts'
import type { SummarizationContext } from './summarizer.ts'

export class LeanSessionStore {
  private baseDir: string
  private projectDir: string

  constructor(merlinDir: string, projectDirName: string) {
    this.baseDir = path.join(merlinDir, 'projects')
    this.projectDir = path.join(this.baseDir, projectDirName)
  }

  /** Ensure the project directory exists. */
  async init(): Promise<void> {
    await mkdir(this.projectDir, { recursive: true })
  }

  // -------------------------------------------------------------------------
  // Lean session I/O
  // -------------------------------------------------------------------------

  /** Write a lean session as JSONL (header + turns) + tasks. */
  async writeSession(session: LeanSession): Promise<void> {
    const dir = this.sessionDir(session.header.sessionId)
    await mkdir(dir, { recursive: true })
    const filePath = path.join(dir, 'lean.jsonl')
    const lines = [JSON.stringify(session.header), ...session.turns.map((t) => JSON.stringify(t))]
    await Bun.write(filePath, `${lines.join('\n')}\n`)

    // Persist tasks alongside the session
    if (session.tasks && session.tasks.length > 0) {
      await this.writeTasks(session.header.sessionId, session.tasks)
    }

    // Persist summarization context for exact incremental resume
    if (session.summarizationContext) {
      await this.writeSummarizationContext(
        session.header.sessionId,
        session.summarizationContext as SummarizationContext,
      )
    }
  }

  /** Read a lean session from disk. Returns null if not found. */
  async readSession(sessionId: string): Promise<LeanSession | null> {
    const filePath = path.join(this.sessionDir(sessionId), 'lean.jsonl')
    try {
      const content = await Bun.file(filePath).text()
      const session = parseLeanSessionJsonl(content)
      if (session) {
        session.tasks = (await this.readTasks(sessionId)) ?? undefined
        session.summarizationContext = (await this.readSummarizationContext(sessionId)) ?? undefined
      }
      return session
    } catch {
      return null
    }
  }

  /** Read only the header of a lean session (first line). Returns null if not found. */
  async readHeader(sessionId: string): Promise<LeanSessionHeader | null> {
    const filePath = path.join(this.sessionDir(sessionId), 'lean.jsonl')
    try {
      const content = await Bun.file(filePath).text()
      const firstLine = content.slice(0, content.indexOf('\n'))
      if (!firstLine) return null
      return JSON.parse(firstLine) as LeanSessionHeader
    } catch {
      return null
    }
  }

  /** List all stored session IDs. */
  async listSessionIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.projectDir)
      const ids: string[] = []
      for (const entry of entries) {
        // Skip index.json and any non-directory entries
        if (entry === 'index.json') continue
        const entryPath = path.join(this.projectDir, entry)
        try {
          const s = await stat(entryPath)
          if (s.isDirectory()) ids.push(entry)
        } catch {}
      }
      return ids
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // Segments I/O
  // -------------------------------------------------------------------------

  /** Write segments for a session. */
  async writeSegments(sessionId: string, segments: Segment[]): Promise<void> {
    const dir = this.sessionDir(sessionId)
    await mkdir(dir, { recursive: true })
    const filePath = path.join(dir, 'segments.json')
    await Bun.write(filePath, `${JSON.stringify(segments, null, 2)}\n`)
  }

  /** Read segments for a session. Returns null if not found. */
  async readSegments(sessionId: string): Promise<Segment[] | null> {
    const filePath = path.join(this.sessionDir(sessionId), 'segments.json')
    try {
      const content = await Bun.file(filePath).text()
      return JSON.parse(content) as Segment[]
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Tasks I/O (discovered workstreams from context-aware summarization)
  // -------------------------------------------------------------------------

  /** Write tasks for a session. */
  async writeTasks(sessionId: string, tasks: SessionTask[]): Promise<void> {
    const dir = this.sessionDir(sessionId)
    await mkdir(dir, { recursive: true })
    const filePath = path.join(dir, 'tasks.json')
    await Bun.write(filePath, `${JSON.stringify(tasks, null, 2)}\n`)
  }

  /** Read tasks for a session. Returns null if not found. */
  async readTasks(sessionId: string): Promise<SessionTask[] | null> {
    const filePath = path.join(this.sessionDir(sessionId), 'tasks.json')
    try {
      const content = await Bun.file(filePath).text()
      return JSON.parse(content) as SessionTask[]
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Task embeddings I/O (vector representations for semantic search)
  // -------------------------------------------------------------------------

  /** Write task embeddings for a session. */
  async writeEmbeddings(sessionId: string, embeddings: SessionEmbeddings): Promise<void> {
    const dir = this.sessionDir(sessionId)
    await mkdir(dir, { recursive: true })
    const filePath = path.join(dir, 'embeddings.json')
    await Bun.write(filePath, `${JSON.stringify(embeddings)}\n`)
  }

  /** Read task embeddings for a session. Returns null if not found. */
  async readEmbeddings(sessionId: string): Promise<SessionEmbeddings | null> {
    const filePath = path.join(this.sessionDir(sessionId), 'embeddings.json')
    try {
      const content = await Bun.file(filePath).text()
      return JSON.parse(content) as SessionEmbeddings
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Summarization context I/O (rolling state for incremental updates)
  // -------------------------------------------------------------------------

  /** Write the final summarization context for a session. */
  async writeSummarizationContext(sessionId: string, ctx: SummarizationContext): Promise<void> {
    const dir = this.sessionDir(sessionId)
    await mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, 'context.json'), `${JSON.stringify(ctx, null, 2)}\n`)
  }

  /** Read the summarization context for a session. Returns null if not found. */
  async readSummarizationContext(sessionId: string): Promise<SummarizationContext | null> {
    try {
      const content = await Bun.file(path.join(this.sessionDir(sessionId), 'context.json')).text()
      return JSON.parse(content) as SummarizationContext
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Project index I/O
  // -------------------------------------------------------------------------

  async readIndex(): Promise<FolderIndex | null> {
    const filePath = path.join(this.projectDir, 'index.json')
    try {
      const content = await Bun.file(filePath).text()
      return JSON.parse(content) as FolderIndex
    } catch {
      return null
    }
  }

  async writeIndex(index: FolderIndex): Promise<void> {
    const filePath = path.join(this.projectDir, 'index.json')
    await Bun.write(filePath, `${JSON.stringify(index, null, 2)}\n`)
  }

  // -------------------------------------------------------------------------
  // Deletion
  // -------------------------------------------------------------------------

  /** Delete a session's folder (lean.jsonl, segments.json, etc.) and remove from index. */
  async deleteSession(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId)
    await rm(dir, { recursive: true, force: true })

    // Remove from index if it exists
    const index = await this.readIndex()
    if (index) {
      index.sessions = index.sessions.filter((s) => s.sessionId !== sessionId)
      await this.writeIndex(index)
    }
  }

  /** Delete all session folders and reset the index. */
  async deleteAllSessions(): Promise<void> {
    const ids = await this.listSessionIds()
    for (const id of ids) {
      await rm(this.sessionDir(id), { recursive: true, force: true })
    }

    const index = await this.readIndex()
    if (index) {
      index.sessions = []
      await this.writeIndex(index)
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private sessionDir(sessionId: string): string {
    return path.join(this.projectDir, sessionId)
  }

  /** Get the project directory path (for external use). */
  getProjectDir(): string {
    return this.projectDir
  }
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/** Parse a lean session JSONL file (header + turns). */
export function parseLeanSessionJsonl(content: string): LeanSession | null {
  const lines = content.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return null

  try {
    const header = JSON.parse(lines[0]!) as LeanSessionHeader
    const turns: LeanTurn[] = []
    for (let i = 1; i < lines.length; i++) {
      turns.push(JSON.parse(lines[i]!) as LeanTurn)
    }
    return { header, turns }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Raw session discovery
// ---------------------------------------------------------------------------

/**
 * Convert a project cwd to the directory name format Claude Code uses.
 * "/Users/alice/work/myapp" -> "-Users-alice-work-myapp"
 */
export function cwdToProjectDirName(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

/**
 * List all stored project dirs under merlinDir/projects/ that match the given
 * project (the exact dir + nested-subdirectory variants like "<dir>-foo").
 */
export async function listMatchingProjectDirs(merlinDir: string, projectDirName: string): Promise<string[]> {
  const baseDir = path.join(merlinDir, 'projects')
  try {
    const entries = await readdir(baseDir)
    return entries.filter((d) => d === projectDirName || d.startsWith(`${projectDirName}-`))
  } catch {
    return []
  }
}

/**
 * Discover raw session JSONL files for a project.
 * Looks in claudeProjectsDir/<projectDirName>/*.jsonl
 *
 * Also recursively discovers sessions in subdirectory-encoded projects.
 * E.g., if projectCwd is /Users/alice/work/myapp, it also finds
 * sessions in -Users-alice-work-myapp-processor (a subdirectory).
 */
export async function discoverRawSessions(
  claudeProjectsDir: string,
  projectDirName: string,
): Promise<RawSessionInfo[]> {
  const results: RawSessionInfo[] = []

  // Find all project dirs that start with our projectDirName
  // (includes the exact match + subdirectory projects)
  let allDirs: string[]
  try {
    allDirs = await readdir(claudeProjectsDir)
  } catch {
    return []
  }

  const matchingDirs = allDirs.filter((d) => d === projectDirName || d.startsWith(`${projectDirName}-`))

  for (const dir of matchingDirs) {
    const dirPath = path.join(claudeProjectsDir, dir)
    try {
      const dirStat = await stat(dirPath)
      if (!dirStat.isDirectory()) continue

      const files = await readdir(dirPath)
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))

      for (const file of jsonlFiles) {
        const filePath = path.join(dirPath, file)
        const fileStat = await stat(filePath)
        results.push({
          sessionId: file.slice(0, -6),
          filePath,
          projectDirName: dir,
          sizeBytes: fileStat.size,
          lastModified: fileStat.mtime.toISOString(),
        })
      }
    } catch {}
  }

  return results
}

export interface RawSessionInfo {
  sessionId: string
  filePath: string
  projectDirName: string
  sizeBytes: number
  lastModified: string
}
