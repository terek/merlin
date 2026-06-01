/** Shared ANSI codes and terminal helpers for TUI screens. */

import type { PreprocessingStats, Project, SessionSummary } from '@merlin/protocol'

// ANSI codes
export const ESC = '\x1b'
export const CLEAR = `${ESC}[2J${ESC}[H`
export const BOLD = `${ESC}[1m`
export const DIM = `${ESC}[2m`
export const RESET = `${ESC}[0m`
export const REVERSE = `${ESC}[7m`
export const GREEN = `${ESC}[32m`
export const YELLOW = `${ESC}[33m`
export const BLUE = `${ESC}[34m`
export const CYAN = `${ESC}[36m`
export const RED = `${ESC}[31m`
export const GRAY = `${ESC}[90m`

// Key codes (raw mode)
export const KEY_UP = `${ESC}[A`
export const KEY_DOWN = `${ESC}[B`
export const KEY_RIGHT = `${ESC}[C`
export const KEY_LEFT = `${ESC}[D`
export const KEY_ENTER = '\r'
export const KEY_BACKSPACE = '\x7f'
export const KEY_CTRL_C = '\x03'
export const KEY_ESC = '\x1b'
export const KEY_TAB = '\t'

export function relativeTime(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  return `${Math.floor(delta / 86400_000)}d ago`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function sessionDisplayName(s: SessionSummary): string {
  return s.customTitle ?? s.sessionId.slice(0, 8)
}

export function sessionLed(s: SessionSummary, project: Project): string {
  if (project.activeSessionId === s.sessionId) return `${GREEN}●${RESET}`
  if (s.activePid != null) return `${YELLOW}●${RESET}`
  const hasExternalProcess = typeof project.owner === 'object' && project.owner.type === 'external'
  const hasIdentifiedSession = project.sessions.some((ss) => ss.activePid != null)
  if (hasExternalProcess && !hasIdentifiedSession) return `${YELLOW}◑${RESET}`
  return `${GRAY}○${RESET}`
}

export function sessionLine(s: SessionSummary, indent: string, project: Project): string {
  const led = sessionLed(s, project)
  const name = sessionDisplayName(s)
  const turns = `${s.userTurnCount} turn${s.userTurnCount !== 1 ? 's' : ''}`
  const size = formatSize(s.sizeBytes)
  const time = relativeTime(s.lastTimestamp)
  const agents =
    s.subagentCount > 0 ? ` ${DIM}+${s.subagentCount} agent${s.subagentCount !== 1 ? 's' : ''}${RESET}` : ''
  return `${indent}${led} ${name} ${GRAY}${turns} · ${size} · ${time}${agents}${RESET}`
}

/** Compact preprocessing badge for a project. */
export function ppBadge(pp: PreprocessingStats | undefined): string {
  if (!pp || pp.total === 0) return ''
  if (pp.processed === pp.total) return `${GREEN}✓${pp.processed}${RESET}`
  const parts: string[] = []
  if (pp.error > 0) parts.push(`${RED}✗${pp.error}${RESET}`)
  if (pp.outdated > 0) parts.push(`${YELLOW}↻${pp.outdated}${RESET}`)
  if (pp.running > 0) parts.push(`${BLUE}⋯${pp.running}${RESET}`)
  if (pp.missing > 0) parts.push(`${GRAY}…${pp.missing}${RESET}`)
  if (pp.processed > 0) parts.push(`${GREEN}✓${pp.processed}${RESET}`)
  return parts.join(' ')
}
