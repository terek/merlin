import os from 'node:os'
import {
  ClaudeProjectDiscovery,
  type DiscoveredFolder,
  type ProcessHit,
  ProcessScanner,
  type SessionLock,
  SessionLockfileReader,
} from '@merlin/cc'
import { isSessionIgnored } from '@merlin/ignore'
import type { ProcessingState } from '@merlin/processor'
import type { Project } from '@merlin/protocol'
import type { ModelStore } from './store.ts'
import { WorkspaceStore } from './workspace.ts'

export interface ModelBuilderOptions {
  instanceName: string
  claudeDir?: string
  /** Override home directory for .merlinignore resolution (for testing). */
  homeDir?: string
  scanner?: ProcessScanner
  lockfileReader?: SessionLockfileReader
  settingsStore?: WorkspaceStore
  /** In-memory processing state. Provided by daemon. */
  processingState?: ProcessingState
}

/**
 * Orchestrates discovery (JSONL files + process scanner) and updates the ModelStore.
 */
export class ModelBuilder {
  private discovery: ClaudeProjectDiscovery
  private scanner: ProcessScanner
  private lockfiles: SessionLockfileReader
  private settings: ProjectSettingsStore
  private instanceName: string
  private processingState: ProcessingState | undefined
  private homeDir: string

  constructor(
    private store: ModelStore,
    opts: ModelBuilderOptions,
  ) {
    this.instanceName = opts.instanceName
    this.homeDir = opts.homeDir ?? os.homedir()
    this.discovery = new ClaudeProjectDiscovery(opts.claudeDir, opts.homeDir)
    this.scanner = opts.scanner ?? new ProcessScanner()
    this.lockfiles = opts.lockfileReader ?? new SessionLockfileReader()
    this.settings = opts.settingsStore ?? new WorkspaceStore()
    this.processingState = opts.processingState
  }

  /**
   * Run full discovery: scan JSONL files + running processes, update model.
   */
  async refresh(opts: { force?: boolean } = {}): Promise<void> {
    const [knownProjects, externalProcesses, locksByCwd, archivedProjects, archivedSessions, collapsedCwds] =
      await Promise.all([
        this.discovery.discover(),
        this.scanner.scan(['claude'], this._getManagedPids(), { force: opts.force }),
        this.lockfiles.byCwd(),
        this.settings.archivedProjectCwds(),
        this.settings.archivedSessionIds(),
        this.settings.collapsedCwds(),
      ])

    const projects: Record<string, Project> = {}

    // Add discovered projects from JSONL
    for (const kp of knownProjects) {
      const project = this._toProject(kp, externalProcesses.get(kp.cwd), locksByCwd.get(kp.cwd))
      // Tag archived projects and sessions
      if (archivedProjects.has(kp.cwd)) project.archived = true
      for (const s of project.sessions) {
        if (archivedSessions.has(s.sessionId)) s.archived = true
      }
      projects[kp.cwd] = project
    }

    // Collapse: merge nested projects into their collapsed parent
    this._collapseProjects(projects, collapsedCwds)

    // Merge preprocessing status from in-memory state
    if (this.processingState) {
      this._mergePreprocessingStatus(projects)
    }

    // Add any external processes not in discovered projects (respecting .merlinignore)
    const homeDir = this.homeDir
    for (const [cwd, hits] of externalProcesses) {
      // Check if this cwd is inside a collapsed project (already merged)
      if (this._isCollapsedChild(cwd, collapsedCwds)) continue
      if (projects[cwd]) continue
      const cwdRelative = cwd.startsWith(`${homeDir}/`) ? cwd.slice(homeDir.length + 1) : null
      if (cwdRelative && (await isSessionIgnored(homeDir, `${cwdRelative}/placeholder`))) continue
      projects[cwd] = {
        cwd,
        displayName: cwd.split('/').pop() ?? cwd,
        lastTimestamp: Date.now(),
        sessions: [],
        owner: { type: 'external', pids: hits.map((h) => h.pid) },
      }
    }

    // Preserve activeSessionId for projects managed by this daemon
    for (const [cwd, project] of Object.entries(projects)) {
      const existing = this.store.getModel().projects[cwd]
      if (existing?.activeSessionId) {
        project.activeSessionId = existing.activeSessionId
      }
      if (
        existing?.owner &&
        typeof existing.owner === 'object' &&
        existing.owner.type === 'daemon' &&
        existing.owner.instanceName === this.instanceName
      ) {
        project.owner = existing.owner
      }
    }

    this.store.replaceProjects(projects)
    this.store.setIgnoredProjectCount(this.discovery.lastIgnoredProjectCount)
  }

  getDiscovery(): ClaudeProjectDiscovery {
    return this.discovery
  }

  private _mergePreprocessingStatus(projects: Record<string, Project>): void {
    for (const [cwd, project] of Object.entries(projects)) {
      const stateMap = this.processingState!.getProjectState(cwd)

      let processed = 0,
        running = 0,
        error = 0,
        outdated = 0,
        missing = 0

      for (const s of project.sessions) {
        if (s.sizeBytes < 500) continue

        const entry = stateMap.get(s.sessionId)
        if (entry) {
          s.ppStatus = entry.status
          if (entry.status === 'error') s.ppError = entry.errorMessage
          if (entry.status === 'processed' && entry.userTurnCount) {
            s.ppTurnsCovered = entry.userTurnCount
          }
          switch (entry.status) {
            case 'processed':
              processed++
              break
            case 'running':
              running++
              break
            case 'error':
              error++
              break
            case 'outdated':
              outdated++
              break
            case 'missing':
              missing++
              break
          }
        } else {
          s.ppStatus = 'missing'
          missing++
        }
      }

      const total = processed + running + error + outdated + missing
      if (total > 0) {
        project.preprocessing = { total, processed, running, error, outdated, missing }
      }
    }
  }

  private _toProject(kp: DiscoveredFolder, externalHits?: ProcessHit[], locks?: SessionLock[]): Project {
    const owner =
      externalHits && externalHits.length > 0
        ? { type: 'external' as const, pids: externalHits.map((h) => h.pid) }
        : ('available' as const)

    // Set activePid on sessions. Priority:
    // 1. Lockfile (exact, from SessionStart hook)
    // 2. Process args --resume <sessionId> (exact, from ps/proc)
    const sessions = kp.sessions.map((s) => {
      const lock = locks?.find((l) => l.sessionId === s.sessionId)
      if (lock) return { ...s, activePid: lock.pid }
      const hit = externalHits?.find((h) => h.sessionId === s.sessionId)
      if (hit) return { ...s, activePid: hit.pid }
      return s
    })

    return {
      cwd: kp.cwd,
      displayName: kp.cwd.split('/').pop() ?? kp.cwd,
      lastTimestamp: kp.lastTimestamp,
      sessions,
      owner,
    }
  }

  /**
   * Collapse pass: for each collapsed cwd, merge sessions from child projects
   * into the parent, tagging them with nestedPath, then remove the child projects.
   */
  private _collapseProjects(projects: Record<string, Project>, collapsedCwds: Set<string>): void {
    for (const parentCwd of collapsedCwds) {
      const parent = projects[parentCwd]
      if (!parent) continue // parent must exist (known limitation)

      // Find all child projects whose cwd is nested under the parent
      const childCwds = Object.keys(projects).filter((cwd) => cwd !== parentCwd && cwd.startsWith(`${parentCwd}/`))

      for (const childCwd of childCwds) {
        const child = projects[childCwd]!

        // Skip archived child projects — don't merge their sessions
        if (child.archived) {
          delete projects[childCwd]
          continue
        }

        const relativePath = childCwd.slice(parentCwd.length + 1) // e.g. "daemon" or "sub/nested"

        // Tag each child session with nestedPath and merge into parent
        for (const session of child.sessions) {
          session.nestedPath = relativePath
          parent.sessions.push(session)
        }

        // Update parent timestamp if child is more recent
        if (child.lastTimestamp > parent.lastTimestamp) {
          parent.lastTimestamp = child.lastTimestamp
        }

        // Merge external process ownership: if child has external pids, propagate
        if (typeof child.owner === 'object' && child.owner.type === 'external') {
          if (parent.owner === 'available') {
            parent.owner = child.owner
          } else if (typeof parent.owner === 'object' && parent.owner.type === 'external') {
            parent.owner.pids.push(...child.owner.pids)
          }
        }

        delete projects[childCwd]
      }

      // Re-sort sessions by timestamp (merged children interleave)
      parent.sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp)

      // Mark parent as collapsed for the UI
      parent.collapsed = true
    }
  }

  /** Check if a cwd is a child of any collapsed project. */
  private _isCollapsedChild(cwd: string, collapsedCwds: Set<string>): boolean {
    for (const parentCwd of collapsedCwds) {
      if (cwd.startsWith(`${parentCwd}/`)) return true
    }
    return false
  }

  private _getManagedPids(): Set<number> {
    const pids = new Set<number>()
    return pids
  }
}
