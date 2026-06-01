/** Archived screen: list archived projects with unarchive support. */

import type { MerlinModel, Project } from '@merlin/protocol'
import {
  BOLD,
  CLEAR,
  DIM,
  GRAY,
  KEY_CTRL_C,
  KEY_DOWN,
  KEY_ENTER,
  KEY_ESC,
  KEY_TAB,
  KEY_UP,
  RESET,
  REVERSE,
  relativeTime,
} from '../ansi.ts'
import type { ArchivedScreen, KeyResult, RenderContext } from '../state.ts'

/** Get sorted archived projects from the model. */
export function getArchivedProjects(model: MerlinModel | null): Project[] {
  if (!model) return []
  return Object.values(model.projects)
    .filter((p) => p.archived)
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
}

export function renderArchived(model: MerlinModel | null, state: ArchivedScreen, _ctx: RenderContext): string {
  const lines: string[] = []

  // Header
  lines.push(`${BOLD}Merlin Go${RESET}  ${DIM}Archived Projects${RESET}`)
  lines.push('')

  if (!model) {
    lines.push(`${DIM}Waiting for data...${RESET}`)
    return CLEAR + lines.join('\n')
  }

  const archived = getArchivedProjects(model)

  if (archived.length === 0) {
    lines.push(`${DIM}No archived projects.${RESET}`)
    lines.push('')
    lines.push(`${DIM}Press ${RESET}ESC${DIM} or ${RESET}TAB${DIM} to go back.${RESET}`)
    return CLEAR + lines.join('\n')
  }

  for (let i = 0; i < archived.length; i++) {
    const p = archived[i]
    const isCursor = i === state.cursor
    const prefix = isCursor ? `${REVERSE}` : ''
    const suffix = isCursor ? `${RESET}` : ''

    const sessionCount = `${p.sessions.length} session${p.sessions.length !== 1 ? 's' : ''}`
    const time = relativeTime(p.lastTimestamp)

    lines.push(`  ${prefix}${GRAY}${p.displayName}${RESET}${suffix}  ${DIM}${sessionCount} · ${time}${RESET}`)
    lines.push(`  ${DIM}${p.cwd}${RESET}`)
    lines.push('')
  }

  // Footer
  lines.push(`${DIM}${archived.length} archived project${archived.length !== 1 ? 's' : ''}${RESET}`)
  lines.push(`${DIM}↑↓=navigate  u=unarchive  ESC/TAB=back  q=quit${RESET}`)

  return CLEAR + lines.join('\n')
}

export function handleArchivedKey(key: string, state: ArchivedScreen, model: MerlinModel | null): KeyResult {
  const archived = getArchivedProjects(model)
  const maxIdx = Math.max(0, archived.length - 1)

  switch (key) {
    case 'k':
    case KEY_UP:
      return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } }

    case 'j':
    case KEY_DOWN:
      return { state: { ...state, cursor: Math.min(maxIdx, state.cursor + 1) } }

    case 'u':
    case KEY_ENTER: {
      const p = archived[state.cursor]
      if (p) {
        return {
          state: { ...state, cursor: Math.min(state.cursor, maxIdx - 1 >= 0 ? maxIdx - 1 : 0) },
          command: { type: 'unarchive', scope: 'project', id: p.cwd },
        }
      }
      return { state }
    }

    case KEY_ESC:
    case KEY_TAB:
      return { state: { screen: 'projects', cursor: 0 } }

    case 'q':
    case KEY_CTRL_C:
      return { state, quit: true }

    default:
      return { state }
  }
}
