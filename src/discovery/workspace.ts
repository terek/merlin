/**
 * Workspace store: archive and collapse state.
 * Stored in ~/.merlin/workspace.json.
 *
 * - Archive: hides projects/sessions from the UI
 * - Collapse: merges sessions from nested project directories into a parent
 *
 * Migrates from legacy ~/.merlin/archived.json on first load.
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'

interface SettingsFile {
  archived: {
    projects: string[] // cwds
    sessions: string[] // sessionIds
  }
  collapsed: string[] // cwds
}

const DEFAULT_DIR = path.join(process.env.HOME || '~', '.merlin')

export class WorkspaceStore {
  private data: SettingsFile = { archived: { projects: [], sessions: [] }, collapsed: [] }
  private loaded = false
  private filePath: string
  private legacyPath: string

  constructor(merlinDir?: string) {
    const dir = merlinDir || DEFAULT_DIR
    this.filePath = path.join(dir, 'workspace.json')
    this.legacyPath = path.join(dir, 'archived.json')
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return

    // Try new format first
    try {
      const raw = await Bun.file(this.filePath).text()
      this.data = JSON.parse(raw) as SettingsFile
      this.loaded = true
      return
    } catch {
      /* not found or invalid */
    }

    // Migrate from legacy format
    try {
      const raw = await Bun.file(this.legacyPath).text()
      const legacy = JSON.parse(raw) as { entries?: Array<{ id: string; type: string }> }
      if (legacy.entries) {
        this.data = {
          archived: {
            projects: legacy.entries.filter((e) => e.type === 'project').map((e) => e.id),
            sessions: legacy.entries.filter((e) => e.type === 'session').map((e) => e.id),
          },
          collapsed: [],
        }
        // Save in new format
        await this.save()
      }
    } catch {
      /* no legacy file either */
    }

    this.loaded = true
  }

  private async save(): Promise<void> {
    const dir = path.dirname(this.filePath)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {}
    await Bun.write(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`)
  }

  // ── Archive ──────────────────────────────────────────────────────────────

  async archive(type: 'project' | 'session', id: string): Promise<void> {
    await this.ensureLoaded()
    const list = type === 'project' ? this.data.archived.projects : this.data.archived.sessions
    if (!list.includes(id)) list.push(id)
    await this.save()
  }

  async unarchive(type: 'project' | 'session', id: string): Promise<void> {
    await this.ensureLoaded()
    if (type === 'project') {
      this.data.archived.projects = this.data.archived.projects.filter((x) => x !== id)
    } else {
      this.data.archived.sessions = this.data.archived.sessions.filter((x) => x !== id)
    }
    await this.save()
  }

  async archivedProjectCwds(): Promise<Set<string>> {
    await this.ensureLoaded()
    return new Set(this.data.archived.projects)
  }

  async archivedSessionIds(): Promise<Set<string>> {
    await this.ensureLoaded()
    return new Set(this.data.archived.sessions)
  }

  // ── Collapse ─────────────────────────────────────────────────────────────

  async collapse(cwd: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.data.collapsed.includes(cwd)) this.data.collapsed.push(cwd)
    await this.save()
  }

  async uncollapse(cwd: string): Promise<void> {
    await this.ensureLoaded()
    this.data.collapsed = this.data.collapsed.filter((x) => x !== cwd)
    await this.save()
  }

  async collapsedCwds(): Promise<Set<string>> {
    await this.ensureLoaded()
    return new Set(this.data.collapsed)
  }

  // ── General ──────────────────────────────────────────────────────────────

  /** Reload from disk (e.g., if another process modified the file). */
  invalidate(): void {
    this.loaded = false
  }
}
