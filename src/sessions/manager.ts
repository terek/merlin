/**
 * Session manager: spawns, controls, and monitors live Claude Code processes.
 */

import type { ClaudeProjectDiscovery } from '@merlin/cc'
import { type CCSession, spawnCCSession } from '@merlin/cc'
import type { LogFn } from '../daemon.ts'
import type { ModelStore } from '../discovery/store.ts'

export class SessionManager {
  private ccSessions = new Map<string, CCSession>()
  private managedPids = new Set<number>()

  constructor(
    private store: ModelStore,
    private instanceName: string,
    private log: LogFn,
  ) {}

  get(sessionId: string): CCSession | undefined {
    return this.ccSessions.get(sessionId)
  }

  getAll(): Map<string, CCSession> {
    return this.ccSessions
  }

  getManagedPids(): Set<number> {
    return this.managedPids
  }

  async openProject(
    clientId: string,
    cwd: string,
    discovery: ClaudeProjectDiscovery,
    ccSessionId?: string,
    onError?: (clientId: string, message: string) => void,
  ): Promise<string | undefined> {
    // Check if already active
    const existing = this.store.getModel().projects[cwd]
    if (existing?.activeSessionId && this.ccSessions.has(existing.activeSessionId)) {
      this.log(`open_project: ${cwd} already active (${existing.activeSessionId.slice(0, 8)})`)
      return undefined
    }

    const sessionId = crypto.randomUUID()
    this.log(`open_project: spawning session ${sessionId.slice(0, 8)} in ${cwd}`)

    // Create the active session in the store
    this.store.createActiveSession(sessionId, cwd)
    this.store.upsertProject(cwd, {
      owner: { type: 'daemon', instanceName: this.instanceName },
      activeSessionId: sessionId,
    })

    try {
      // Resolve JSONL path for history preloading
      let jsonlPath: string | undefined
      if (ccSessionId) {
        jsonlPath = (await discovery.getJsonlPathForSession(cwd, ccSessionId)) ?? undefined
      }

      const ccSession = await spawnCCSession({ id: sessionId, cwd, ccSessionId }, jsonlPath)

      this.ccSessions.set(sessionId, ccSession)
      if (ccSession.pid()) this.managedPids.add(ccSession.pid()!)
      this.log(`session ${sessionId.slice(0, 8)}: spawned (pid=${ccSession.pid()})`)

      // Wire CCSession observer → ModelStore
      ccSession.addObserver({
        onStateChange: (event) => {
          this.log(`session ${sessionId.slice(0, 8)}: ${event.previous} → ${event.current}`)
          this.store.setSessionState(sessionId, event.current)
          if (event.current === 'exited') {
            this.store.setProjectActiveSession(cwd, undefined)
            this.store.setProjectOwner(cwd, 'available')
            this.ccSessions.delete(sessionId)
            if (ccSession.pid()) this.managedPids.delete(ccSession.pid()!)
            this.log(`session ${sessionId.slice(0, 8)}: cleaned up`)
          }
        },
        onData: (line) => {
          this.store.pushContextLine(sessionId, line)
          this.store.setPendingApproval(sessionId, ccSession.pendingApproval())
          this.store.setPendingQuestion(sessionId, ccSession.pendingQuestion())
          if (ccSession.ccSessionId()) {
            this.store.setCcSessionId(sessionId, ccSession.ccSessionId()!)
          }
        },
      })

      // Sync initial state (preloaded history)
      this.store.setSessionState(sessionId, ccSession.state())
      this.store.setContextLines(sessionId, ccSession.contextLines())

      return sessionId
    } catch (err) {
      this.log(`session ${sessionId.slice(0, 8)}: spawn failed — ${err}`)
      this.store.setSessionState(sessionId, 'exited')
      this.store.setProjectActiveSession(cwd, undefined)
      this.store.setProjectOwner(cwd, 'available')
      onError?.(clientId, `Failed to start session: ${err}`)
      return undefined
    }
  }

  sendMessage(sessionId: string, text: string): boolean {
    const session = this.ccSessions.get(sessionId)
    if (!session) {
      this.log(`send_message failed: session ${sessionId.slice(0, 8)} not found`)
      return false
    }
    session.write(text)
    return true
  }

  approve(sessionId: string, optionKey: string): void {
    this.ccSessions.get(sessionId)?.approve(optionKey)
  }

  deny(sessionId: string): void {
    this.ccSessions.get(sessionId)?.deny()
  }

  kill(sessionId: string): void {
    const session = this.ccSessions.get(sessionId)
    if (session) {
      this.log(`killing session ${sessionId.slice(0, 8)} (pid=${session.pid()})`)
      session.kill()
    } else {
      this.log(`kill_session: ${sessionId.slice(0, 8)} not found`)
    }
  }

  killAll(): void {
    for (const [_id, session] of this.ccSessions) {
      session.kill()
    }
    this.ccSessions.clear()
    this.managedPids.clear()
  }
}
