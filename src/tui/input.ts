/** Text input line editing for TUI chat. */

import { KEY_BACKSPACE, KEY_LEFT, KEY_RIGHT } from './ansi.ts'

export interface InputState {
  buffer: string
  cursorPos: number
}

export interface InputResult {
  state: InputState
  submit?: boolean
}

/** Process a key press for text input. Returns updated state and whether enter was pressed. */
export function handleInputKey(key: string, state: InputState): InputResult {
  const { buffer, cursorPos } = state

  // Enter → submit
  if (key === '\r') {
    return { state, submit: true }
  }

  // Backspace
  if (key === KEY_BACKSPACE) {
    if (cursorPos > 0) {
      return {
        state: {
          buffer: buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos),
          cursorPos: cursorPos - 1,
        },
      }
    }
    return { state }
  }

  // Arrow left
  if (key === KEY_LEFT) {
    return { state: { buffer, cursorPos: Math.max(0, cursorPos - 1) } }
  }

  // Arrow right
  if (key === KEY_RIGHT) {
    return { state: { buffer, cursorPos: Math.min(buffer.length, cursorPos + 1) } }
  }

  // Ctrl+A → start of line
  if (key === '\x01') {
    return { state: { buffer, cursorPos: 0 } }
  }

  // Ctrl+E → end of line
  if (key === '\x05') {
    return { state: { buffer, cursorPos: buffer.length } }
  }

  // Ctrl+U → clear line
  if (key === '\x15') {
    return { state: { buffer: '', cursorPos: 0 } }
  }

  // Ctrl+K → kill to end
  if (key === '\x0b') {
    return { state: { buffer: buffer.slice(0, cursorPos), cursorPos } }
  }

  // Ignore other control chars and escape sequences
  if (key.charCodeAt(0) < 32 || key.startsWith('\x1b')) {
    return { state }
  }

  // Printable char
  return {
    state: {
      buffer: buffer.slice(0, cursorPos) + key + buffer.slice(cursorPos),
      cursorPos: cursorPos + key.length,
    },
  }
}
