import { describe, expect, test } from 'bun:test'
import type { MerlinModel } from '@merlin/protocol'
import { handleInputKey } from '../../src/tui/input.ts'
import { renderScreen } from '../../src/tui/render.ts'
import { getArchivedProjects, handleArchivedKey, renderArchived } from '../../src/tui/screens/archived.ts'
import { handleChatKey, renderChat } from '../../src/tui/screens/chat.ts'
import { getActiveProjects, handleProjectsKey, renderProjects } from '../../src/tui/screens/projects.ts'
import type { ArchivedScreen, ChatScreen, ProjectsScreen } from '../../src/tui/state.ts'

const ctx = { connected: true, daemonName: 'test', rows: 24, cols: 80 }

function makeModel(overrides?: Partial<MerlinModel>): MerlinModel {
  return {
    host: { name: 'h', instanceName: 'i', version: '1.0', connectedClients: 0 },
    projects: {
      '/tmp/active': {
        cwd: '/tmp/active',
        displayName: 'active-proj',
        lastTimestamp: Date.now(),
        sessions: [{ sessionId: 's1', lastTimestamp: Date.now(), sizeBytes: 1000, userTurnCount: 5, subagentCount: 0 }],
        owner: 'available',
      },
      '/tmp/archived': {
        cwd: '/tmp/archived',
        displayName: 'old-proj',
        lastTimestamp: Date.now() - 86400000,
        sessions: [
          { sessionId: 's2', lastTimestamp: Date.now() - 86400000, sizeBytes: 500, userTurnCount: 2, subagentCount: 0 },
        ],
        owner: 'available',
        archived: true,
      },
    },
    ignoredProjectCount: 0,
    processingRuntime: { activeSessions: [], llmTotals: {} },
    ...overrides,
  }
}

// ── Projects screen ─────────────────────────────────────────────────────────

describe('Projects screen', () => {
  test('getActiveProjects filters out archived', () => {
    const model = makeModel()
    const active = getActiveProjects(model)
    expect(active).toHaveLength(1)
    expect(active[0].displayName).toBe('active-proj')
  })

  test('renders project list with cursor', () => {
    const state: ProjectsScreen = { screen: 'projects', cursor: 0 }
    const output = renderProjects(makeModel(), state, ctx)
    expect(output).toContain('active-proj')
    expect(output).toContain('Projects')
    expect(output).not.toContain('old-proj')
  })

  test('shows archived count hint', () => {
    const state: ProjectsScreen = { screen: 'projects', cursor: 0 }
    const output = renderProjects(makeModel(), state, ctx)
    expect(output).toContain('1 archived project')
    expect(output).toContain('press')
  })

  test('j/k moves cursor', () => {
    const model = makeModel({
      projects: {
        '/a': { cwd: '/a', displayName: 'a', lastTimestamp: Date.now(), sessions: [], owner: 'available' },
        '/b': { cwd: '/b', displayName: 'b', lastTimestamp: Date.now() - 1000, sessions: [], owner: 'available' },
      },
    })
    const state: ProjectsScreen = { screen: 'projects', cursor: 0 }
    const down = handleProjectsKey('j', state, model)
    expect((down.state as ProjectsScreen).cursor).toBe(1)
    const up = handleProjectsKey('k', down.state as ProjectsScreen, model)
    expect((up.state as ProjectsScreen).cursor).toBe(0)
  })

  test('enter transitions to chat', () => {
    const model = makeModel()
    const state: ProjectsScreen = { screen: 'projects', cursor: 0 }
    const result = handleProjectsKey('\r', state, model)
    expect(result.state.screen).toBe('chat')
    if (result.state.screen === 'chat') {
      expect(result.state.projectCwd).toBe('/tmp/active')
    }
  })

  test('a archives project', () => {
    const model = makeModel()
    const state: ProjectsScreen = { screen: 'projects', cursor: 0 }
    const result = handleProjectsKey('a', state, model)
    expect(result.command).toEqual({ type: 'archive', scope: 'project', id: '/tmp/active' })
  })

  test('A switches to archived screen', () => {
    const state: ProjectsScreen = { screen: 'projects', cursor: 0 }
    const result = handleProjectsKey('A', state, null)
    expect(result.state.screen).toBe('archived')
  })

  test('q quits', () => {
    const state: ProjectsScreen = { screen: 'projects', cursor: 0 }
    const result = handleProjectsKey('q', state, null)
    expect(result.quit).toBe(true)
  })
})

// ── Archived screen ─────────────────────────────────────────────────────────

describe('Archived screen', () => {
  test('getArchivedProjects filters to archived only', () => {
    const model = makeModel()
    const archived = getArchivedProjects(model)
    expect(archived).toHaveLength(1)
    expect(archived[0].displayName).toBe('old-proj')
  })

  test('renders archived list', () => {
    const state: ArchivedScreen = { screen: 'archived', cursor: 0 }
    const output = renderArchived(makeModel(), state, ctx)
    expect(output).toContain('old-proj')
    expect(output).toContain('Archived Projects')
  })

  test('empty state shows helpful message', () => {
    const emptyModel = makeModel({ projects: {} })
    const state: ArchivedScreen = { screen: 'archived', cursor: 0 }
    const output = renderArchived(emptyModel, state, ctx)
    expect(output).toContain('No archived projects')
  })

  test('u unarchives project', () => {
    const state: ArchivedScreen = { screen: 'archived', cursor: 0 }
    const result = handleArchivedKey('u', state, makeModel())
    expect(result.command).toEqual({ type: 'unarchive', scope: 'project', id: '/tmp/archived' })
  })

  test('ESC goes back to projects', () => {
    const state: ArchivedScreen = { screen: 'archived', cursor: 0 }
    const result = handleArchivedKey('\x1b', state, null)
    expect(result.state.screen).toBe('projects')
  })
})

// ── Chat screen ─────────────────────────────────────────────────────────────

describe('Chat screen', () => {
  const chatState: ChatScreen = {
    screen: 'chat',
    projectCwd: '/tmp/proj',
    projectName: 'test-proj',
    messages: [
      { role: 'user', text: 'hello', done: true },
      { role: 'assistant', text: 'hi there', done: true },
    ],
    inputBuffer: '',
    inputCursorPos: 0,
    streaming: false,
  }

  test('renders messages', () => {
    const output = renderChat(chatState, ctx)
    expect(output).toContain('hello')
    expect(output).toContain('hi there')
    expect(output).toContain('test-proj')
  })

  test('typing adds to input buffer', () => {
    const result = handleChatKey('h', chatState)
    if (result.state.screen === 'chat') {
      expect(result.state.inputBuffer).toBe('h')
      expect(result.state.inputCursorPos).toBe(1)
    }
  })

  test('enter submits message', () => {
    const withInput: ChatScreen = { ...chatState, inputBuffer: 'test message', inputCursorPos: 12 }
    const result = handleChatKey('\r', withInput)
    expect(result.command).toBeDefined()
    if (result.command?.type === 'clerk_message') {
      expect(result.command.text).toBe('test message')
      expect(result.command.cwd).toBe('/tmp/proj')
    }
    if (result.state.screen === 'chat') {
      expect(result.state.inputBuffer).toBe('')
      expect(result.state.streaming).toBe(true)
      expect(result.state.messages).toHaveLength(3)
    }
  })

  test('enter on empty buffer does nothing', () => {
    const result = handleChatKey('\r', chatState)
    expect(result.command).toBeUndefined()
  })

  test('ESC goes back when not streaming', () => {
    const result = handleChatKey('\x1b', chatState)
    expect(result.state.screen).toBe('projects')
  })

  test('Ctrl+C interrupts when streaming', () => {
    const streaming: ChatScreen = { ...chatState, streaming: true }
    const result = handleChatKey('\x03', streaming)
    expect(result.command).toEqual({
      type: 'clerk_interrupt',
      cwd: '/tmp/proj',
    })
    if (result.state.screen === 'chat') {
      expect(result.state.streaming).toBe(false)
    }
  })

  test('Ctrl+C goes back when not streaming', () => {
    const result = handleChatKey('\x03', chatState)
    expect(result.state.screen).toBe('projects')
  })

  test('shows streaming indicator', () => {
    const streaming: ChatScreen = { ...chatState, streaming: true }
    const output = renderChat(streaming, ctx)
    expect(output).toContain('Clerk is responding')
  })
})

// ── Input handler ───────────────────────────────────────────────────────────

describe('Input handler', () => {
  test('printable chars inserted at cursor', () => {
    const result = handleInputKey('a', { buffer: '', cursorPos: 0 })
    expect(result.state.buffer).toBe('a')
    expect(result.state.cursorPos).toBe(1)
  })

  test('insert in middle of buffer', () => {
    const result = handleInputKey('x', { buffer: 'ab', cursorPos: 1 })
    expect(result.state.buffer).toBe('axb')
    expect(result.state.cursorPos).toBe(2)
  })

  test('backspace deletes before cursor', () => {
    const result = handleInputKey('\x7f', { buffer: 'abc', cursorPos: 2 })
    expect(result.state.buffer).toBe('ac')
    expect(result.state.cursorPos).toBe(1)
  })

  test('backspace at start does nothing', () => {
    const result = handleInputKey('\x7f', { buffer: 'abc', cursorPos: 0 })
    expect(result.state.buffer).toBe('abc')
    expect(result.state.cursorPos).toBe(0)
  })

  test('arrow keys move cursor', () => {
    const left = handleInputKey('\x1b[D', { buffer: 'abc', cursorPos: 2 })
    expect(left.state.cursorPos).toBe(1)
    const right = handleInputKey('\x1b[C', { buffer: 'abc', cursorPos: 1 })
    expect(right.state.cursorPos).toBe(2)
  })

  test('Ctrl+A goes to start', () => {
    const result = handleInputKey('\x01', { buffer: 'abc', cursorPos: 3 })
    expect(result.state.cursorPos).toBe(0)
  })

  test('Ctrl+E goes to end', () => {
    const result = handleInputKey('\x05', { buffer: 'abc', cursorPos: 0 })
    expect(result.state.cursorPos).toBe(3)
  })

  test('Ctrl+U clears line', () => {
    const result = handleInputKey('\x15', { buffer: 'abc', cursorPos: 2 })
    expect(result.state.buffer).toBe('')
    expect(result.state.cursorPos).toBe(0)
  })

  test('enter sets submit flag', () => {
    const result = handleInputKey('\r', { buffer: 'hello', cursorPos: 5 })
    expect(result.submit).toBe(true)
  })
})

// ── Render dispatcher ───────────────────────────────────────────────────────

describe('renderScreen dispatcher', () => {
  test('routes to projects screen', () => {
    const output = renderScreen(makeModel(), { screen: 'projects', cursor: 0 }, ctx)
    expect(output).toContain('Projects')
  })

  test('routes to archived screen', () => {
    const output = renderScreen(makeModel(), { screen: 'archived', cursor: 0 }, ctx)
    expect(output).toContain('Archived Projects')
  })

  test('routes to chat screen', () => {
    const chatState: ChatScreen = {
      screen: 'chat',
      projectCwd: '/tmp/proj',
      projectName: 'my-proj',
      messages: [],
      inputBuffer: '',
      inputCursorPos: 0,
      streaming: false,
    }
    const output = renderScreen(null, chatState, ctx)
    expect(output).toContain('my-proj')
    expect(output).toContain('Clerk Chat')
  })
})
