/**
 * TUI render dispatcher — routes to per-screen renderers.
 * Also exports the legacy `render()` for backward compatibility with tests.
 */

import type { MerlinModel } from '@merlin/protocol'
import { renderArchived } from './screens/archived.ts'
import { renderChat } from './screens/chat.ts'
import { renderProjects } from './screens/projects.ts'
import type { RenderContext, TuiScreen } from './state.ts'

/** Render any screen state. */
export function renderScreen(model: MerlinModel | null, screen: TuiScreen, ctx: RenderContext): string {
  switch (screen.screen) {
    case 'projects':
      return renderProjects(model, screen, ctx)
    case 'archived':
      return renderArchived(model, screen, ctx)
    case 'chat':
      return renderChat(screen, ctx)
  }
}

// ── Legacy render function (used by existing tests and old TUI code) ────────

import type { Project, SessionSummary } from '@merlin/protocol'

const ESC = '\x1b'
const CLEAR = `${ESC}[2J${ESC}[H`
const BOLD = `${ESC}[1m`
const DIM = `${ESC}[2m`
const RESET = `${ESC}[0m`
const GREEN = `${ESC}[32m`
const YELLOW = `${ESC}[33m`
const RED = `${ESC}[31m`
const GRAY = `${ESC}[90m`

function sessionLed(s: SessionSummary, project: Project): string {
  if (project.activeSessionId === s.sessionId) return `${GREEN}●${RESET}`
  if (s.activePid != null) return `${YELLOW}●${RESET}`
  const hasExternalProcess = typeof project.owner === 'object' && project.owner.type === 'external'
  const hasIdentifiedSession = project.sessions.some((ss) => ss.activePid != null)
  if (hasExternalProcess && !hasIdentifiedSession) return `${YELLOW}◑${RESET}`
  return `${GRAY}○${RESET}`
}

function relativeTime(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  return `${Math.floor(delta / 86400_000)}d ago`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function sessionDisplayName(s: SessionSummary): string {
  return s.customTitle ?? s.sessionId.slice(0, 8)
}

function sessionLine(s: SessionSummary, indent: string, project: Project): string {
  const led = sessionLed(s, project)
  const name = sessionDisplayName(s)
  const turns = `${s.userTurnCount} turn${s.userTurnCount !== 1 ? 's' : ''}`
  const size = formatSize(s.sizeBytes)
  const time = relativeTime(s.lastTimestamp)
  const agents =
    s.subagentCount > 0 ? ` ${DIM}+${s.subagentCount} agent${s.subagentCount !== 1 ? 's' : ''}${RESET}` : ''
  return `${indent}${led} ${name} ${GRAY}${turns} · ${size} · ${time}${agents}${RESET}`
}

/** Legacy render function — renders the projects list view. */
export function render(model: MerlinModel | null, daemonName?: string, connected = true): string {
  const lines: string[] = []

  lines.push(`${BOLD}Merlin Go${RESET}  ${DIM}TUI Client${RESET}`)
  if (daemonName) {
    const status = connected ? `${GREEN}●${RESET} connected` : `${RED}●${RESET} disconnected`
    lines.push(`${DIM}Host:${RESET} ${daemonName}  ${status}`)
  }
  lines.push('')

  if (!model) {
    lines.push(`${DIM}Waiting for data...${RESET}`)
    return CLEAR + lines.join('\n')
  }

  const allProjects = Object.values(model.projects)
  const activeProjects = allProjects.filter((p) => !p.archived)
  const archivedProjects = allProjects.filter((p) => p.archived)

  const sortProjects = (list: typeof allProjects) =>
    list.sort((a, b) => {
      const aActive = a.activeSessionId ? 1 : 0
      const bActive = b.activeSessionId ? 1 : 0
      if (aActive !== bActive) return bActive - aActive
      const aOrd = a.owner === 'available' ? 2 : 1
      const bOrd = b.owner === 'available' ? 2 : 1
      if (aOrd !== bOrd) return aOrd - bOrd
      return b.lastTimestamp - a.lastTimestamp
    })

  sortProjects(activeProjects)
  sortProjects(archivedProjects)

  if (allProjects.length === 0) {
    lines.push(`${DIM}No projects discovered.${RESET}`)
    lines.push(`${DIM}Make sure Claude Code has been used in at least one project.${RESET}`)
    return CLEAR + lines.join('\n')
  }

  if (activeProjects.length > 0) {
    lines.push(`${BOLD}Projects${RESET}`)
    lines.push('')
    for (const p of activeProjects) {
      const liveSessions = p.sessions.filter((s) => !s.archived)
      const archivedCount = p.sessions.filter((s) => s.archived).length
      lines.push(`  ${BOLD}${p.displayName}${RESET}`)
      lines.push(`  ${DIM}${p.cwd}${RESET}`)
      if (liveSessions.length > 0) {
        for (const s of liveSessions.slice(0, 5)) {
          lines.push(sessionLine(s, '    ', p))
        }
        if (liveSessions.length > 5) {
          lines.push(`    ${DIM}└ +${liveSessions.length - 5} more${RESET}`)
        }
      }
      if (archivedCount > 0) {
        lines.push(`    ${GRAY}${archivedCount} archived${RESET}`)
      }
      lines.push('')
    }
  }

  if (archivedProjects.length > 0) {
    lines.push(`${DIM}${BOLD}Archived${RESET}${DIM} (${archivedProjects.length})${RESET}`)
    for (const p of archivedProjects) {
      lines.push(
        `  ${GRAY}${p.displayName}  ${relativeTime(p.lastTimestamp)}  ${p.sessions.length} session${p.sessions.length !== 1 ? 's' : ''}${RESET}`,
      )
    }
    lines.push('')
  }

  const activeCount = activeProjects.length
  const totalCount = allProjects.length
  const countLabel =
    archivedProjects.length > 0
      ? `${activeCount} active · ${archivedProjects.length} archived`
      : `${totalCount} project${totalCount !== 1 ? 's' : ''}`
  lines.push(`${DIM}${countLabel} · v${model.host.version} · ${model.host.name}${RESET}`)
  lines.push(`${DIM}r=refresh  q=quit${RESET}`)

  return CLEAR + lines.join('\n')
}
