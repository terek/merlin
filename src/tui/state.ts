/** TUI state types — discriminated union for multi-screen TUI. */

import type { ClientMessage } from '@merlin/protocol'

// ── Screen states ──────────────────────────────────────────────────────────

export interface ProjectsScreen {
  screen: 'projects'
  cursor: number
}

export interface ArchivedScreen {
  screen: 'archived'
  cursor: number
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
  done: boolean
}

export interface ChatScreen {
  screen: 'chat'
  projectCwd: string
  projectName: string
  messages: ChatMessage[]
  inputBuffer: string
  inputCursorPos: number
  streaming: boolean
}

export type TuiScreen = ProjectsScreen | ArchivedScreen | ChatScreen

// ── Key handler result ─────────────────────────────────────────────────────

export interface KeyResult {
  state: TuiScreen
  command?: ClientMessage
  quit?: boolean
}

// ── Render context ─────────────────────────────────────────────────────────

export interface RenderContext {
  daemonName?: string
  connected: boolean
  rows: number
  cols: number
}

// ── Initial state ──────────────────────────────────────────────────────────

export function initialState(): ProjectsScreen {
  return { screen: 'projects', cursor: 0 }
}
