/** Chat screen: clerk conversation with streaming responses. */

import { BOLD, CLEAR, CYAN, DIM, GREEN, KEY_CTRL_C, KEY_ESC, RED, RESET, YELLOW } from '../ansi.ts'
import { handleInputKey } from '../input.ts'
import type { ChatMessage, ChatScreen, KeyResult, RenderContext } from '../state.ts'

export function renderChat(state: ChatScreen, ctx: RenderContext): string {
  const lines: string[] = []

  // Header
  lines.push(`${BOLD}${state.projectName}${RESET}  ${DIM}Clerk Chat${RESET}`)
  lines.push('')

  // Messages area — fill available rows minus header (2) and footer (3)
  const maxMessageRows = Math.max(5, ctx.rows - 5)
  const messageLines: string[] = []

  for (const msg of state.messages) {
    const roleTag = formatRole(msg.role)
    const textLines = msg.text.split('\n')
    messageLines.push(`${roleTag} ${textLines[0]}`)
    for (let i = 1; i < textLines.length; i++) {
      messageLines.push(`  ${textLines[i]}`)
    }
    if (!msg.done && msg.role === 'assistant') {
      messageLines.push(`  ${DIM}...${RESET}`)
    }
  }

  // Show last N lines that fit
  const visible = messageLines.slice(-maxMessageRows)
  if (messageLines.length > maxMessageRows) {
    lines.push(`${DIM}  ↑ ${messageLines.length - maxMessageRows} more lines${RESET}`)
  }
  lines.push(...visible)

  // Pad to fill screen
  const currentLines = lines.length
  const targetLines = ctx.rows - 3
  for (let i = currentLines; i < targetLines; i++) {
    lines.push('')
  }

  // Input line
  lines.push('')
  if (state.streaming) {
    lines.push(`${DIM}  Clerk is responding... (Ctrl+C to interrupt)${RESET}`)
  } else {
    const cursor =
      state.inputBuffer.slice(0, state.inputCursorPos) +
      '\x1b[7m \x1b[0m' +
      state.inputBuffer.slice(state.inputCursorPos)
    lines.push(`  ${GREEN}>${RESET} ${cursor}`)
  }
  lines.push(`${DIM}ESC=back  enter=send  ctrl+c=interrupt${RESET}`)

  return CLEAR + lines.join('\n')
}

function formatRole(role: ChatMessage['role']): string {
  switch (role) {
    case 'user':
      return `${CYAN}you${RESET}`
    case 'assistant':
      return `${GREEN}clerk${RESET}`
    case 'tool':
      return `${YELLOW}tool${RESET}`
    case 'error':
      return `${RED}error${RESET}`
  }
}

export function handleChatKey(key: string, state: ChatScreen): KeyResult {
  // ESC → back to projects (only when not streaming)
  if (key === KEY_ESC && !state.streaming) {
    return { state: { screen: 'projects', cursor: 0 } }
  }

  // Ctrl+C while streaming → interrupt
  if (key === KEY_CTRL_C && state.streaming) {
    return {
      state: { ...state, streaming: false },
      command: { type: 'clerk_interrupt', cwd: state.projectCwd },
    }
  }

  // Ctrl+C while idle → back to projects
  if (key === KEY_CTRL_C && !state.streaming) {
    return { state: { screen: 'projects', cursor: 0 } }
  }

  // Don't accept input while streaming
  if (state.streaming) {
    return { state }
  }

  // Text input handling
  const result = handleInputKey(key, {
    buffer: state.inputBuffer,
    cursorPos: state.inputCursorPos,
  })

  if (result.submit && result.state.buffer.trim()) {
    const text = result.state.buffer.trim()
    return {
      state: {
        ...state,
        messages: [...state.messages, { role: 'user', text, done: true }],
        inputBuffer: '',
        inputCursorPos: 0,
        streaming: true,
      },
      command: {
        type: 'clerk_message',
        cwd: state.projectCwd,
        text,
      },
    }
  }

  return {
    state: {
      ...state,
      inputBuffer: result.state.buffer,
      inputCursorPos: result.state.cursorPos,
    },
  }
}
