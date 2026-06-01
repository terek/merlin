/** Projects screen: active project list with cursor navigation. */

import type { MerlinModel, Project } from '@merlin/protocol'
import {
  BOLD,
  CLEAR,
  DIM,
  GRAY,
  GREEN,
  KEY_CTRL_C,
  KEY_DOWN,
  KEY_ENTER,
  KEY_TAB,
  KEY_UP,
  ppBadge,
  RED,
  RESET,
  REVERSE,
  sessionLine,
} from '../ansi.ts'
import type { KeyResult, ProjectsScreen, RenderContext } from '../state.ts'

/** Get sorted active (non-archived) projects from the model. */
export function getActiveProjects(model: MerlinModel | null): Project[] {
  if (!model) return []
  return Object.values(model.projects)
    .filter((p) => !p.archived)
    .sort((a, b) => {
      const aActive = a.activeSessionId ? 1 : 0
      const bActive = b.activeSessionId ? 1 : 0
      if (aActive !== bActive) return bActive - aActive
      const aOrd = a.owner === 'available' ? 2 : 1
      const bOrd = b.owner === 'available' ? 2 : 1
      if (aOrd !== bOrd) return aOrd - bOrd
      return b.lastTimestamp - a.lastTimestamp
    })
}

export function renderProjects(model: MerlinModel | null, state: ProjectsScreen, ctx: RenderContext): string {
  const lines: string[] = []

  // Header
  lines.push(`${BOLD}Merlin Go${RESET}  ${DIM}TUI Client${RESET}`)
  if (ctx.daemonName) {
    const status = ctx.connected ? `${GREEN}●${RESET} connected` : `${RED}●${RESET} disconnected`
    lines.push(`${DIM}Host:${RESET} ${ctx.daemonName}  ${status}`)
  }
  lines.push('')

  if (!model) {
    lines.push(`${DIM}Waiting for data...${RESET}`)
    return CLEAR + lines.join('\n')
  }

  const activeProjects = getActiveProjects(model)
  const archivedCount = Object.values(model.projects).filter((p) => p.archived).length

  if (activeProjects.length === 0 && archivedCount === 0) {
    lines.push(`${DIM}No projects discovered.${RESET}`)
    lines.push(`${DIM}Make sure Claude Code has been used in at least one project.${RESET}`)
    return CLEAR + lines.join('\n')
  }

  if (activeProjects.length === 0) {
    lines.push(`${DIM}No active projects. Press ${RESET}A${DIM} to view archived.${RESET}`)
    lines.push('')
  } else {
    lines.push(`${BOLD}Projects${RESET}`)
    lines.push('')

    for (let i = 0; i < activeProjects.length; i++) {
      const p = activeProjects[i]
      const isCursor = i === state.cursor
      const prefix = isCursor ? `${REVERSE}` : ''
      const suffix = isCursor ? `${RESET}` : ''

      const badge = ppBadge(p.preprocessing)
      const badgeSuffix = badge ? `  ${badge}` : ''
      lines.push(`  ${prefix}${BOLD}${p.displayName}${RESET}${suffix}${badgeSuffix}`)
      lines.push(`  ${DIM}${p.cwd}${RESET}`)

      const liveSessions = p.sessions.filter((s) => !s.archived)
      const archivedSessions = p.sessions.filter((s) => s.archived).length
      for (const s of liveSessions.slice(0, 5)) {
        lines.push(sessionLine(s, '    ', p))
      }
      if (liveSessions.length > 5) {
        lines.push(`    ${DIM}└ +${liveSessions.length - 5} more${RESET}`)
      }
      if (archivedSessions > 0) {
        lines.push(`    ${GRAY}${archivedSessions} archived${RESET}`)
      }
      lines.push('')
    }
  }

  // Hidden-by-merlinignore hint
  if (model.ignoredProjectCount > 0) {
    const n = model.ignoredProjectCount
    lines.push(`${DIM}${n} project${n !== 1 ? 's' : ''} hidden by .merlinignore${RESET}`)
    lines.push('')
  }

  // Archived hint
  if (archivedCount > 0) {
    lines.push(
      `${DIM}${archivedCount} archived project${archivedCount !== 1 ? 's' : ''} — press ${RESET}A${DIM} to view${RESET}`,
    )
    lines.push('')
  }

  // Footer
  const total = activeProjects.length
  lines.push(`${DIM}${total} project${total !== 1 ? 's' : ''} · v${model.host.version} · ${model.host.name}${RESET}`)
  lines.push(
    `${DIM}↑↓=navigate  enter=chat  a=archive  A=archived  r=refresh  P=preprocess  R=reprocess  q=quit${RESET}`,
  )

  return CLEAR + lines.join('\n')
}

export function handleProjectsKey(key: string, state: ProjectsScreen, model: MerlinModel | null): KeyResult {
  const projects = getActiveProjects(model)
  const maxIdx = Math.max(0, projects.length - 1)

  switch (key) {
    case 'k':
    case KEY_UP:
      return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } }

    case 'j':
    case KEY_DOWN:
      return { state: { ...state, cursor: Math.min(maxIdx, state.cursor + 1) } }

    case KEY_ENTER:
    case 'c': {
      const p = projects[state.cursor]
      if (p) {
        return {
          state: {
            screen: 'chat',
            projectCwd: p.cwd,
            projectName: p.displayName,
            messages: [],
            inputBuffer: '',
            inputCursorPos: 0,
            streaming: false,
          },
        }
      }
      return { state }
    }

    case 'a': {
      const p = projects[state.cursor]
      if (p) {
        return {
          state: { ...state, cursor: Math.min(state.cursor, maxIdx - 1 >= 0 ? maxIdx - 1 : 0) },
          command: { type: 'archive', scope: 'project', id: p.cwd },
        }
      }
      return { state }
    }

    case 'A':
    case KEY_TAB:
      return { state: { screen: 'archived', cursor: 0 } }

    case 'r':
      return { state, command: { type: 'refresh_projects', force: true } }

    case 'P': {
      const p = projects[state.cursor]
      if (p) {
        return { state, command: { type: 'preprocess_project', cwd: p.cwd } }
      }
      return { state }
    }

    case 'R': {
      const p = projects[state.cursor]
      if (p) {
        return { state, command: { type: 'reprocess_project', cwd: p.cwd } }
      }
      return { state }
    }

    case 'q':
    case KEY_CTRL_C:
      return { state, quit: true }

    default:
      return { state }
  }
}
