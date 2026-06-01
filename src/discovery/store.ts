import type {
  ActiveSession,
  LLMCost,
  MerlinModel,
  PendingApproval,
  PendingQuestion,
  Project,
  ProjectOwner,
  RuntimeSession,
  SessionState,
  SessionSummary,
} from '@merlin/protocol'
import type { ModelListener, SessionListener, SyncStore } from '@merlin/sync'

/**
 * Canonical state store for the daemon. All mutations go through this class.
 * Listeners are notified on every mutation so the SyncEngine can diff + patch.
 */
export class ModelStore implements SyncStore {
  private model: MerlinModel
  private activeSessions = new Map<string, ActiveSession>()
  private modelListeners: ModelListener[] = []
  private sessionListeners: SessionListener[] = []

  constructor(hostName: string, instanceName: string, version: string) {
    this.model = {
      host: { name: hostName, instanceName, version, connectedClients: 0 },
      projects: {},
      ignoredProjectCount: 0,
      processingRuntime: { activeSessions: [], llmTotals: {} },
    }
  }

  setIgnoredProjectCount(count: number): void {
    if (this.model.ignoredProjectCount !== count) {
      this.model.ignoredProjectCount = count
      this._notifyModel()
    }
  }

  // ── Runtime processing mutations ───────────────────────────────────────────

  upsertRuntimeSession(session: RuntimeSession): void {
    const list = this.model.processingRuntime.activeSessions
    const idx = list.findIndex((s) => s.sessionId === session.sessionId)
    if (idx >= 0) {
      list[idx] = session
    } else {
      list.push(session)
    }
    this._notifyModel()
  }

  removeRuntimeSession(sessionId: string): void {
    const list = this.model.processingRuntime.activeSessions
    const idx = list.findIndex((s) => s.sessionId === sessionId)
    if (idx >= 0) {
      list.splice(idx, 1)
      this._notifyModel()
    }
  }

  bumpLLMTotals(model: string, delta: LLMCost): void {
    const totals = this.model.processingRuntime.llmTotals
    const existing = totals[model] ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    totals[model] = {
      calls: existing.calls + delta.calls,
      inputTokens: existing.inputTokens + delta.inputTokens,
      outputTokens: existing.outputTokens + delta.outputTokens,
      costUsd: existing.costUsd + delta.costUsd,
    }
    this._notifyModel()
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  getModel(): MerlinModel {
    return this.model
  }

  getActiveSession(sessionId: string): ActiveSession | undefined {
    return this.activeSessions.get(sessionId)
  }

  getAllActiveSessions(): Map<string, ActiveSession> {
    return this.activeSessions
  }

  // ── Model mutations ────────────────────────────────────────────────────────

  upsertProject(cwd: string, data: Partial<Omit<Project, 'cwd'>>): void {
    const existing = this.model.projects[cwd]
    if (existing) {
      Object.assign(existing, data)
    } else {
      this.model.projects[cwd] = {
        cwd,
        displayName: data.displayName ?? cwd.split('/').pop() ?? cwd,
        lastTimestamp: data.lastTimestamp ?? 0,
        sessions: data.sessions ?? [],
        owner: data.owner ?? 'available',
        activeSessionId: data.activeSessionId,
      }
    }
    this._notifyModel()
  }

  removeProject(cwd: string): void {
    if (this.model.projects[cwd]) {
      delete this.model.projects[cwd]
      this._notifyModel()
    }
  }

  setProjectOwner(cwd: string, owner: ProjectOwner): void {
    const project = this.model.projects[cwd]
    if (project) {
      project.owner = owner
      this._notifyModel()
    }
  }

  setProjectActiveSession(cwd: string, sessionId: string | undefined): void {
    const project = this.model.projects[cwd]
    if (project) {
      project.activeSessionId = sessionId
      this._notifyModel()
    }
  }

  setProjectSessions(cwd: string, sessions: SessionSummary[]): void {
    const project = this.model.projects[cwd]
    if (project) {
      project.sessions = sessions
      this._notifyModel()
    }
  }

  /** Replace all projects at once (from discovery). */
  replaceProjects(projects: Record<string, Project>): void {
    this.model.projects = projects
    this._notifyModel()
  }

  // ── Active session mutations ───────────────────────────────────────────────

  createActiveSession(id: string, projectCwd: string): ActiveSession {
    const session: ActiveSession = {
      id,
      projectCwd,
      state: 'starting',
      contextLines: [],
      pendingApproval: null,
      pendingQuestion: null,
      connectedAt: Date.now(),
    }
    this.activeSessions.set(id, session)
    this._notifySession(id)
    return session
  }

  removeActiveSession(id: string): void {
    this.activeSessions.delete(id)
    // No notify — clients unsubscribe or get an error on next patch
  }

  setSessionState(id: string, state: SessionState): void {
    const session = this.activeSessions.get(id)
    if (session && session.state !== state) {
      session.state = state
      this._notifySession(id)
    }
  }

  setCcSessionId(id: string, ccSessionId: string): void {
    const session = this.activeSessions.get(id)
    if (session) {
      session.ccSessionId = ccSessionId
      this._notifySession(id)
    }
  }

  pushContextLine(id: string, line: string): void {
    const session = this.activeSessions.get(id)
    if (session) {
      session.contextLines.push(line)
      // Trim to 2000 lines max
      if (session.contextLines.length > 2000) {
        session.contextLines.splice(0, session.contextLines.length - 2000)
      }
      this._notifySession(id)
    }
  }

  setContextLines(id: string, lines: string[]): void {
    const session = this.activeSessions.get(id)
    if (session) {
      session.contextLines = lines
      this._notifySession(id)
    }
  }

  setPendingApproval(id: string, approval: PendingApproval | null): void {
    const session = this.activeSessions.get(id)
    if (session) {
      session.pendingApproval = approval
      this._notifySession(id)
    }
  }

  setPendingQuestion(id: string, question: PendingQuestion | null): void {
    const session = this.activeSessions.get(id)
    if (session) {
      session.pendingQuestion = question
      this._notifySession(id)
    }
  }

  // ── Listeners ──────────────────────────────────────────────────────────────

  onModelChange(listener: ModelListener): () => void {
    this.modelListeners.push(listener)
    return () => {
      this.modelListeners = this.modelListeners.filter((l) => l !== listener)
    }
  }

  onSessionChange(listener: SessionListener): () => void {
    this.sessionListeners.push(listener)
    return () => {
      this.sessionListeners = this.sessionListeners.filter((l) => l !== listener)
    }
  }

  private _notifyModel(): void {
    for (const listener of this.modelListeners) listener()
  }

  private _notifySession(sessionId: string): void {
    for (const listener of this.sessionListeners) listener(sessionId)
  }
}
