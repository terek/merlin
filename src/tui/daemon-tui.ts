/**
 * Daemon TUI: split-screen dashboard + scrolling log + keyboard actions.
 *
 * Uses ANSI CSR (Change Scroll Region) to keep the top dashboard fixed
 * while log lines scroll naturally in the lower region.
 *
 * Keybinds:
 *   p — pair a new client (shows 6-char code in dashboard)
 *   d — delete a pairing (numbered selection)
 *   P — process all projects
 *   r — refresh project discovery
 *   q / Ctrl+C — quit
 */

import os from 'node:os'
import type { MerlinModel, PreprocessingStats } from '@merlin/protocol'
import type { StoredPairing } from '@merlin/relay'
import {
  addPairing,
  deriveSharedKey,
  exportAesKey,
  loadOrGenerateKeypair,
  loadPairings,
  loadSharedKey,
  savePairings,
} from '@merlin/relay'
import type { Daemon, RelayPairing } from '../daemon.ts'
import { BLUE, BOLD, CYAN, DIM, GRAY, GREEN, RED, RESET, YELLOW } from './ansi.ts'

// ── TUI mode state machine ──────────────────────────────────────────────────

type TUIMode =
  | { mode: 'normal' }
  | { mode: 'pairing'; code?: string; status: string }
  | { mode: 'delete'; pairings: StoredPairing[] }

export interface DaemonTUIOptions {
  instanceName: string
  /** Callback to get the relay URL (may start a local relay lazily). */
  getRelayUrl: () => Promise<string>
  /** Called when the user presses q or Ctrl+C. */
  onQuit: () => void
}

export class DaemonTUI {
  private daemon: Daemon | null = null
  private opts: DaemonTUIOptions | null = null
  private logBuffer: string[] = []
  private dashHeight = 0
  private rows = process.stdout.rows || 24
  private cols = process.stdout.columns || 80
  private redrawTimer: ReturnType<typeof setInterval> | null = null
  private uiMode: TUIMode = { mode: 'normal' }
  private endpoints: { relayPort?: number; webPort?: number } = {}

  /** LogFn compatible with Daemon's log option. Call before daemon.start(). */
  log = (msg: string): void => {
    const line = `  ${DIM}${this._ts()}${RESET} ${msg}`
    if (this.daemon) {
      this._writeLog(line)
      this._redraw()
    } else {
      this.logBuffer.push(line)
    }
  }

  /** Attach to a running daemon and start rendering + keyboard input. */
  attach(daemon: Daemon, opts: DaemonTUIOptions): void {
    this.daemon = daemon
    this.opts = opts
    this._setup()

    // Flush buffered logs from startup
    for (const line of this.logBuffer) {
      this._writeLog(line)
    }
    this.logBuffer = []

    // Periodic redraw (uptime counter, state polling)
    this.redrawTimer = setInterval(() => this._redraw(), 1000)

    // Terminal resize
    process.stdout.on('resize', () => {
      this.rows = process.stdout.rows || 24
      this.cols = process.stdout.columns || 80
      this._setup()
      this._redraw()
    })

    // Keyboard input
    this._setupKeyboard()
  }

  /** Record the relay/web ports so they show in the dashboard. */
  setEndpoints(e: { relayPort?: number; webPort?: number }): void {
    this.endpoints = { ...this.endpoints, ...e }
    if (this.daemon) this._redraw()
  }

  /** Restore terminal before exit. */
  cleanup(): void {
    if (this.redrawTimer) clearInterval(this.redrawTimer)
    process.stdin.setRawMode?.(false)
    // Reset scroll region to full terminal
    process.stdout.write('\x1b[r')
    process.stdout.write(`\x1b[${this.rows};1H\n`)
  }

  // ── Terminal setup ────────────────────────────────────────────────────────

  private _ts(): string {
    const d = new Date()
    const h = d.getHours().toString().padStart(2, '0')
    const m = d.getMinutes().toString().padStart(2, '0')
    const s = d.getSeconds().toString().padStart(2, '0')
    return `${h}:${m}:${s}`
  }

  private _setup(): void {
    process.stdout.write('\x1b[2J\x1b[H') // clear screen
    const lines = this._renderDashboard()
    this.dashHeight = lines.length
    process.stdout.write(`\x1b[${this.dashHeight + 1};${this.rows}r`)
    process.stdout.write('\x1b[1;1H')
    for (const line of lines) {
      process.stdout.write(`\x1b[2K${line}\n`)
    }
    process.stdout.write(`\x1b[${this.dashHeight + 1};1H`)
  }

  private _redraw(): void {
    const lines = this._renderDashboard()
    if (lines.length !== this.dashHeight) {
      this.dashHeight = lines.length
      process.stdout.write(`\x1b[${this.dashHeight + 1};${this.rows}r`)
    }
    process.stdout.write('\x1b7')
    process.stdout.write('\x1b[1;1H')
    for (const line of lines) {
      process.stdout.write(`\x1b[2K${line}\n`)
    }
    process.stdout.write('\x1b8')
  }

  private _writeLog(text: string): void {
    process.stdout.write('\x1b7')
    process.stdout.write(`\x1b[${this.rows};1H`)
    process.stdout.write(`\x1b[2K${text}\n`)
    process.stdout.write('\x1b8')
  }

  // ── Keyboard handling ─────────────────────────────────────────────────────

  private _setupKeyboard(): void {
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf-8')

    process.stdin.on('data', (key: string) => {
      if (key === '\x03') {
        // Ctrl+C
        this.opts?.onQuit()
        return
      }

      switch (this.uiMode.mode) {
        case 'normal':
          this._handleNormalKey(key)
          break
        case 'pairing':
          this._handlePairingKey(key)
          break
        case 'delete':
          this._handleDeleteKey(key)
          break
      }
    })
  }

  private _handleNormalKey(key: string): void {
    switch (key) {
      case 'q':
        this.opts?.onQuit()
        break
      case 'p':
        void this._startPairing()
        break
      case 'd':
        void this._startDelete()
        break
      case 'P':
        this.daemon?.queue.enqueue({ type: 'all' })
        this.log('queued: process all projects')
        break
      case 'r':
        void this.daemon?.store && this.log('refreshing projects...')
        void (async () => {
          // Use the builder's refresh by accessing it through the daemon
          // The daemon exposes store which triggers discovery on refresh
          const model = this.daemon!.store.getModel()
          const _before = Object.keys(model.projects).length
          // Trigger refresh via a client message (same as frontend 'refresh_projects')
          this.daemon!.handleClientMessage('tui', { type: 'refresh_projects', force: true })
        })()
        break
    }
  }

  private _handlePairingKey(key: string): void {
    if (key === '\x1b' || key === 'q') {
      // ESC or q cancels
      this.uiMode = { mode: 'normal' }
      this.log('pairing cancelled')
      this._redraw()
    }
    // Otherwise ignore — waiting for client
  }

  private _handleDeleteKey(key: string): void {
    if (key === '\x1b' || key === 'q') {
      // ESC or q cancels
      this.uiMode = { mode: 'normal' }
      this._redraw()
      return
    }
    const idx = parseInt(key, 10) - 1
    if (this.uiMode.mode === 'delete' && idx >= 0 && idx < this.uiMode.pairings.length) {
      void this._deletePairing(idx)
    }
  }

  // ── Pairing flow ──────────────────────────────────────────────────────────

  private async _startPairing(): Promise<void> {
    if (!this.opts) return
    this.uiMode = { mode: 'pairing', status: 'connecting to relay...' }
    this._redraw()

    try {
      const relayUrl = await this.opts.getRelayUrl()
      const name = this.opts.instanceName
      const kp = await loadOrGenerateKeypair(name)
      const hostName = os.hostname().replace(/\.local$/, '')

      // Create pairing session via relay API
      const res = await fetch(`${relayUrl}/pair/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daemonPubKey: kp.publicKeySpki, daemonName: hostName }),
      })

      if (!res.ok) throw new Error(`relay error: ${res.status}`)

      const { code, sessionToken, expiresIn } = (await res.json()) as {
        code: string
        sessionToken: string
        expiresIn: number
      }

      this.uiMode = {
        mode: 'pairing',
        code,
        status: `expires in ${Math.floor(expiresIn / 60)}m`,
      }
      this._redraw()
      this.log(`pairing code: ${code}`)

      // Wait for client key exchange on WebSocket
      const wsUrl = relayUrl.replace(/^http/, 'ws')
      const ws = new WebSocket(`${wsUrl}/ws?side=daemon&token=${encodeURIComponent(sessionToken)}`)

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data as string)
          if (msg.type === 'key_exchange' && msg.publicKey) {
            const sharedKey = await deriveSharedKey(kp.privateKey, msg.publicKey)
            const sharedKeyExported = await exportAesKey(sharedKey)

            ws.send(JSON.stringify({ type: 'key_exchange_ack' }))
            ws.close()

            // Save pairing
            await addPairing(name, {
              sessionToken,
              sharedKey: sharedKeyExported,
              relayUrl,
              daemonName: hostName,
            })

            // Connect daemon to the new client
            this.daemon!.addConnector({
              relayUrl: wsUrl,
              token: sessionToken,
              sharedKey,
            })

            this.uiMode = { mode: 'normal' }
            this.log(`${GREEN}paired successfully!${RESET}`)
            this._redraw()
          }
        } catch {
          /* ignore malformed */
        }
      }

      ws.onerror = () => {
        this.uiMode = { mode: 'normal' }
        this.log(`${RED}pairing failed: WebSocket error${RESET}`)
        this._redraw()
      }
    } catch (err) {
      this.uiMode = { mode: 'normal' }
      this.log(`${RED}pairing failed: ${err instanceof Error ? err.message : err}${RESET}`)
      this._redraw()
    }
  }

  private async _startDelete(): Promise<void> {
    if (!this.opts) return
    const pairings = await loadPairings(this.opts.instanceName)
    if (pairings.length === 0) {
      this.log('no pairings to delete')
      return
    }
    this.uiMode = { mode: 'delete', pairings }
    this._redraw()
  }

  private async _deletePairing(index: number): Promise<void> {
    if (!this.opts || !this.daemon) return
    const pairings = await loadPairings(this.opts.instanceName)
    if (index < 0 || index >= pairings.length) return

    const removed = pairings.splice(index, 1)[0]
    await savePairings(this.opts.instanceName, pairings)

    // Rebuild all relay connections with remaining pairings
    const relayPairings: RelayPairing[] = []
    for (const sp of pairings) {
      const sharedKey = await loadSharedKey(sp)
      relayPairings.push({
        relayUrl: sp.relayUrl.replace(/^http/, 'ws'),
        token: sp.sessionToken,
        sharedKey,
      })
    }
    this.daemon.reconnectPairings(relayPairings)

    this.uiMode = { mode: 'normal' }
    const host = removed.relayUrl.replace(/^https?:\/\//, '')
    this.log(`deleted pairing (${host}), ${pairings.length} remaining`)
    this._redraw()
  }

  // ── Dashboard rendering ───────────────────────────────────────────────────

  private _renderDashboard(): string[] {
    if (!this.daemon) return ['  Starting...']

    const model = this.daemon.store.getModel()
    const host = model.host
    const allProjects = Object.values(model.projects)
    const activeProjects = allProjects.filter((p) => !p.archived)
    const archivedCount = allProjects.length - activeProjects.length
    const totalSessions = activeProjects.reduce((n, p) => n + p.sessions.length, 0)

    const lines: string[] = []
    const sep = `  ${GRAY}${'─'.repeat(Math.min(52, this.cols - 4))}${RESET}`

    // Header
    const uptime = this._fmtUptime(Date.now() - this.daemon.startedAt)
    const clients = host.connectedClients ?? 0
    lines.push(
      `  ${BOLD}Merlin${RESET} ${DIM}·${RESET} ${host.instanceName}` +
        ` ${DIM}·${RESET} ${clients} client${clients !== 1 ? 's' : ''}` +
        ` ${DIM}·${RESET} up ${uptime}`,
    )
    lines.push(sep)

    // Endpoints (ports) — surfaced here because the startup log lines scroll away.
    const ep = this.endpoints
    if (ep.webPort || ep.relayPort) {
      const parts: string[] = []
      if (ep.webPort) parts.push(`${DIM}web${RESET} ${BOLD}http://localhost:${ep.webPort}${RESET}`)
      if (ep.relayPort) parts.push(`${DIM}relay${RESET} :${ep.relayPort}`)
      lines.push(`  ${parts.join(`  ${DIM}·${RESET}  `)}`)
    }

    // Mode-specific content
    if (this.uiMode.mode === 'pairing') {
      return this._renderPairingMode(lines, sep)
    }
    if (this.uiMode.mode === 'delete') {
      return this._renderDeleteMode(lines, sep)
    }

    // Discovery
    // Projects line (with ignored breakdown)
    const ignored = model.ignoredProjectCount ?? 0
    const projParts: string[] = [`${archivedCount} archived`]
    if (ignored > 0) projParts.push(`${ignored} ignored`)
    const projSuffix = projParts.length > 0 ? ` ${DIM}(${projParts.join(', ')})${RESET}` : ''
    lines.push(`  ${activeProjects.length} project${activeProjects.length !== 1 ? 's' : ''}${projSuffix}`)

    // Sessions line (with processing breakdown)
    const pp = this._aggregatePP(model)
    const sessParts: string[] = []
    if (pp.total > 0) {
      sessParts.push(`${GREEN}${pp.processed} processed${RESET}`)
      if (pp.running > 0) sessParts.push(`${BLUE}${pp.running} running${RESET}`)
      sessParts.push(`${YELLOW}${pp.outdated} stale${RESET}`)
      sessParts.push(`${GRAY}${pp.missing} new${RESET}`)
      if (pp.error > 0) sessParts.push(`${RED}${pp.error} error${RESET}`)
    }
    const sessSuffix = sessParts.length > 0 ? ` ${DIM}(${sessParts.join(`${DIM}, ${RESET}`)}${DIM})${RESET}` : ''
    lines.push(`  ${totalSessions} session${totalSessions !== 1 ? 's' : ''}${sessSuffix}`)

    // Queue
    const qRun = this.daemon.queue.runningCount
    const qPend = this.daemon.queue.pendingCount
    if (qRun > 0 || qPend > 0) {
      const parts: string[] = []
      if (qRun > 0) parts.push(`${BLUE}⋯${qRun} running${RESET}`)
      if (qPend > 0) parts.push(`${GRAY}…${qPend} pending${RESET}`)
      lines.push(`  Queue: ${parts.join(` ${DIM}/${RESET} `)}`)
    } else {
      lines.push(`  Queue: ${DIM}idle${RESET}`)
    }

    // Live processing progress (aggregated across all running sessions)
    const rt = model.processingRuntime
    if (rt.activeSessions.length > 0) {
      let td = 0,
        tD = 0,
        kd = 0,
        kD = 0
      for (const s of rt.activeSessions) {
        td += s.turnsDone
        tD += s.turnsDiscovered
        kd += s.tasksDone
        kD += s.tasksDiscovered
      }
      const n = rt.activeSessions.length
      lines.push(
        `  ${BLUE}⋯${RESET} ${n} session${n !== 1 ? 's' : ''} ${DIM}·${RESET} ` +
          `${td}/${tD} turns ${DIM}·${RESET} ${kd}/${kD} tasks`,
      )
    }

    // LLM cost totals
    const llm = this.daemon.llmTotals
    if (llm.size > 0) {
      for (const [modelName, s] of llm) {
        const short = modelName.replace(/^models\//, '').replace(/^[^/]+\//, '')
        const cost =
          s.costUsd > 0 ? ` ${DIM}·${RESET} ~$${s.costUsd < 0.01 ? s.costUsd.toFixed(4) : s.costUsd.toFixed(2)}` : ''
        lines.push(`  LLM: ${short} ${DIM}·${RESET} ${s.calls} calls${cost}`)
      }
    }

    // Active processing jobs (per-project)
    const running = this.daemon.queue.getState().running
    const projectJobs = running.filter((j) => j.type === 'project')
    if (projectJobs.length > 0) {
      lines.push(sep)
      for (const job of projectJobs) {
        if (job.type !== 'project') continue
        const proj = model.projects[job.cwd]
        const name = proj?.displayName ?? job.cwd.split('/').pop() ?? job.cwd
        const badge = proj?.preprocessing ? this._ppBadge(proj.preprocessing) : ''
        lines.push(`  ${BLUE}⋯${RESET} ${name}  ${badge}`)
      }
    }

    lines.push(sep)
    lines.push(`  ${DIM}[p]air  [d]elete  [P]rocess all  [r]efresh  [q]uit${RESET}`)
    return lines
  }

  private _renderPairingMode(lines: string[], sep: string): string[] {
    const m = this.uiMode as { mode: 'pairing'; code?: string; status: string }
    if (m.code) {
      const spaced = m.code.split('').join('  ')
      lines.push(`  ${BOLD}${CYAN}Pairing Code:  ${spaced}${RESET}`)
      lines.push(`  ${DIM}${m.status}${RESET}`)
      lines.push(`  Waiting for client... ${DIM}(ESC to cancel)${RESET}`)
    } else {
      lines.push(`  ${DIM}${m.status}${RESET}`)
    }
    lines.push(sep)
    return lines
  }

  private _renderDeleteMode(lines: string[], sep: string): string[] {
    const m = this.uiMode as { mode: 'delete'; pairings: StoredPairing[] }
    lines.push(`  ${BOLD}Delete pairing:${RESET}`)
    for (let i = 0; i < m.pairings.length; i++) {
      const p = m.pairings[i]
      const host = p.relayUrl.replace(/^https?:\/\//, '')
      const label = p.daemonName ? `${p.daemonName} (${host})` : host
      lines.push(`  ${YELLOW}${i + 1}${RESET}) ${label}`)
    }
    lines.push(`  ${DIM}Press 1-${m.pairings.length} to delete, ESC to cancel${RESET}`)
    lines.push(sep)
    return lines
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _aggregatePP(model: MerlinModel): PreprocessingStats {
    const acc = { total: 0, processed: 0, running: 0, error: 0, outdated: 0, missing: 0 }
    for (const p of Object.values(model.projects)) {
      if (p.archived || !p.preprocessing) continue
      acc.total += p.preprocessing.total
      acc.processed += p.preprocessing.processed
      acc.running += p.preprocessing.running
      acc.error += p.preprocessing.error
      acc.outdated += p.preprocessing.outdated
      acc.missing += p.preprocessing.missing
    }
    return acc
  }

  private _ppBadge(pp: PreprocessingStats): string {
    if (pp.total === 0) return ''
    if (pp.processed === pp.total) return `${GREEN}✓${pp.processed}${RESET}`
    const parts: string[] = []
    if (pp.error > 0) parts.push(`${RED}✗${pp.error}${RESET}`)
    if (pp.outdated > 0) parts.push(`${YELLOW}↻${pp.outdated}${RESET}`)
    if (pp.running > 0) parts.push(`${BLUE}⋯${pp.running}${RESET}`)
    if (pp.missing > 0) parts.push(`${GRAY}…${pp.missing}${RESET}`)
    if (pp.processed > 0) parts.push(`${GREEN}✓${pp.processed}${RESET}`)
    return parts.join(' ')
  }

  private _fmtUptime(ms: number): string {
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
    if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`
    const h = Math.floor(ms / 3600_000)
    const m = Math.floor((ms % 3600_000) / 60_000)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
}
