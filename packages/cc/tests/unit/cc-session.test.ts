/**
 * CCSession unit tests.
 * Ported from legacy JSONStreamSession tests.
 * Feed events via _handleLine() without spawning a real CC process.
 */

import { describe, expect, test } from 'bun:test'
import { CCSession, type StateChangeEvent } from '../../src/session.ts'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(id = 'test'): CCSession {
  return new CCSession({ id, workingDirectory: '/tmp' })
}

function feed(session: CCSession, event: Record<string, unknown>): void {
  session._handleLine(JSON.stringify(event))
}

function trackChanges(session: CCSession): string[] {
  const log: string[] = []
  session.addObserver({
    onStateChange: (e: StateChangeEvent) => log.push(`${e.previous}→${e.current}`),
  })
  return log
}

// Minimal CC events
const RESULT = { type: 'result', subtype: 'success', session_id: 'sess-abc' }
const KEEP_ALIVE = { type: 'keep_alive' }
const SYSTEM = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-abc',
  model: 'claude-opus-4-6',
  cwd: '/tmp',
  tools: [],
  mcp_servers: [],
}
const ASSISTANT_TEXT = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
}
const TOOL_USE = { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }
const TOOL_RESULT = {
  type: 'tool_result',
  tool_use_id: 'toolu_1',
  content: 'total 4\ndrwxr-xr-x  2 user user 4096 Jan 1 00:00 .',
}
const ASSISTANT_TOOL_USE = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }],
  },
}
const USER_TOOL_RESULT = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'total 4\ndrwxr-xr-x  2 user user 4096 Jan 1 00:00 .',
        is_error: false,
      },
    ],
  },
}
const THINKING = { type: 'thinking', thinking: 'Let me analyse this carefully...' }
const STREAM_EVENT = { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'He' } } }

function makeCanUseTool(opts: { suggestions?: string[]; name?: string } = {}) {
  return {
    type: 'control_request',
    request_id: 'req-123',
    request: {
      subtype: 'can_use_tool',
      tool_name: opts.name ?? 'Bash',
      input: { command: 'rm -rf /tmp/test' },
      permission_suggestions: opts.suggestions ?? ['allow_once', 'allow_session', 'deny'],
    },
  }
}

// ─── State transitions ─────────────────────────────────────────────────────────

describe('CCSession — initial state', () => {
  test('starts as starting', () => {
    expect(makeSession().state()).toBe('starting')
  })

  test('first event (any type) transitions starting → idle', () => {
    const session = makeSession()
    feed(session, KEEP_ALIVE)
    expect(session.state()).toBe('idle')
  })

  test('starting → idle on system event', () => {
    const session = makeSession()
    const changes = trackChanges(session)
    feed(session, SYSTEM)
    expect(changes).toContain('starting→idle')
  })

  test('starting → idle only once', () => {
    const session = makeSession()
    const changes = trackChanges(session)
    feed(session, KEEP_ALIVE)
    feed(session, KEEP_ALIVE)
    expect(changes.filter((c) => c === 'starting→idle').length).toBe(1)
  })
})

describe('CCSession — write() transitions to busy', () => {
  test('write() → busy immediately', () => {
    const session = makeSession()
    feed(session, SYSTEM)
    session.write('hello')
    expect(session.state()).toBe('busy')
  })

  test('write() from starting → busy', () => {
    const session = makeSession()
    session.write('hello')
    expect(session.state()).toBe('busy')
  })

  test('result event → idle', () => {
    const session = makeSession()
    session.write('hello')
    feed(session, RESULT)
    expect(session.state()).toBe('idle')
  })

  test('full turn cycle: idle → busy → idle', () => {
    const session = makeSession()
    const changes = trackChanges(session)
    feed(session, SYSTEM)
    session.write('hello')
    feed(session, ASSISTANT_TEXT)
    feed(session, RESULT)
    expect(changes).toContain('idle→busy')
    expect(changes).toContain('busy→idle')
  })

  test('result clears pendingApproval', () => {
    const session = makeSession()
    feed(session, makeCanUseTool())
    expect(session.pendingApproval()).not.toBeNull()
    feed(session, RESULT)
    expect(session.pendingApproval()).toBeNull()
  })
})

describe('CCSession — tool approval states', () => {
  test('can_use_tool with 2+ suggestions → offeringChoices', () => {
    const session = makeSession()
    feed(session, makeCanUseTool({ suggestions: ['allow_once', 'allow_session', 'deny'] }))
    expect(session.state()).toBe('offeringChoices')
  })

  test('can_use_tool with 1 suggestion → waitingForInput', () => {
    const session = makeSession()
    feed(session, makeCanUseTool({ suggestions: ['allow'] }))
    expect(session.state()).toBe('waitingForInput')
  })

  test('can_use_tool with no suggestions → waitingForInput', () => {
    const session = makeSession()
    feed(session, {
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} },
    })
    expect(session.state()).toBe('waitingForInput')
  })
})

// ─── pendingApproval() ─────────────────────────────────────────────────────────

describe('CCSession — pendingApproval()', () => {
  test('null initially', () => {
    expect(makeSession().pendingApproval()).toBeNull()
  })

  test('populated from can_use_tool event', () => {
    const session = makeSession()
    feed(session, makeCanUseTool({ name: 'Bash', suggestions: ['allow_once', 'deny'] }))
    const approval = session.pendingApproval()
    expect(approval).not.toBeNull()
    expect(approval!.toolName).toBe('Bash')
    expect(approval!.toolInput).toEqual({ command: 'rm -rf /tmp/test' })
    expect(approval!.options.map((o) => o.key)).toEqual(['allow_once', 'deny'])
  })

  test('option labels are humanized from snake_case', () => {
    const session = makeSession()
    feed(session, makeCanUseTool({ suggestions: ['allow_once', 'allow_session', 'deny'] }))
    const labels = session.pendingApproval()!.options.map((o) => o.label)
    expect(labels[0]).toBe('Allow Once')
    expect(labels[1]).toBe('Allow Session')
    expect(labels[2]).toBe('Deny')
  })

  test('cleared after writeKey y', () => {
    const session = makeSession()
    feed(session, makeCanUseTool())
    session.writeKey('y')
    expect(session.pendingApproval()).toBeNull()
  })

  test('cleared after writeKey n', () => {
    const session = makeSession()
    feed(session, makeCanUseTool())
    session.writeKey('n')
    expect(session.pendingApproval()).toBeNull()
  })

  test('cleared after writeKey enter', () => {
    const session = makeSession()
    feed(session, makeCanUseTool())
    session.writeKey('enter')
    expect(session.pendingApproval()).toBeNull()
  })

  test('writeKey y → busy', () => {
    const session = makeSession()
    feed(session, makeCanUseTool())
    session.writeKey('y')
    expect(session.state()).toBe('busy')
  })

  test('writeKey n → busy', () => {
    const session = makeSession()
    feed(session, makeCanUseTool())
    session.writeKey('n')
    expect(session.state()).toBe('busy')
  })
})

// ─── writeKey arrow navigation ───────────────────────────────────────────────

describe('CCSession — writeKey arrow navigation', () => {
  test('arrow-down increments selection', () => {
    const session = makeSession()
    feed(session, makeCanUseTool({ suggestions: ['allow_once', 'allow_session', 'deny'] }))
    session.writeKey('arrow-down')
    session.writeKey('enter')
    expect(session.state()).toBe('busy')
    expect(session.pendingApproval()).toBeNull()
  })

  test('arrow-up does not go below 0', () => {
    const session = makeSession()
    feed(session, makeCanUseTool({ suggestions: ['allow_once', 'deny'] }))
    session.writeKey('arrow-up')
    session.writeKey('enter')
    expect(session.state()).toBe('busy')
  })

  test('arrow-down clamps at last option', () => {
    const session = makeSession()
    feed(session, makeCanUseTool({ suggestions: ['allow_once', 'deny'] }))
    session.writeKey('arrow-down')
    session.writeKey('arrow-down')
    session.writeKey('enter')
    expect(session.state()).toBe('busy')
  })

  test('writeKey arrow without pending approval is a no-op', () => {
    const session = makeSession()
    expect(() => session.writeKey('arrow-down')).not.toThrow()
    expect(() => session.writeKey('arrow-up')).not.toThrow()
    expect(() => session.writeKey('enter')).not.toThrow()
  })
})

// ─── contextLines() rendering ─────────────────────────────────────────────────

describe('CCSession — contextLines()', () => {
  test('empty initially', () => {
    expect(makeSession().contextLines()).toEqual([])
  })

  test('system event adds [system] line', () => {
    const session = makeSession()
    feed(session, SYSTEM)
    expect(session.contextLines().some((l) => l.startsWith('[system]'))).toBe(true)
  })

  test('assistant event adds [assistant] line', () => {
    const session = makeSession()
    feed(session, ASSISTANT_TEXT)
    const lines = session.contextLines()
    expect(lines.some((l) => l.includes('[assistant]') && l.includes('Hello world'))).toBe(true)
  })

  test('assistant with top-level content array', () => {
    const session = makeSession()
    feed(session, { type: 'assistant', content: [{ type: 'text', text: 'Direct content' }] })
    expect(session.contextLines().some((l) => l.includes('Direct content'))).toBe(true)
  })

  test('tool_use event adds [tool:Name] line', () => {
    const session = makeSession()
    feed(session, TOOL_USE)
    expect(session.contextLines().some((l) => l.includes('[tool:Bash]'))).toBe(true)
  })

  test('tool_result event adds [result] line', () => {
    const session = makeSession()
    feed(session, TOOL_RESULT)
    expect(session.contextLines().some((l) => l.startsWith('[result]'))).toBe(true)
  })

  test('thinking event adds [thinking] line', () => {
    const session = makeSession()
    feed(session, THINKING)
    expect(session.contextLines().some((l) => l.startsWith('[thinking]'))).toBe(true)
  })

  test('result event adds [turn complete] line', () => {
    const session = makeSession()
    feed(session, RESULT)
    expect(session.contextLines().some((l) => l === '[turn complete]')).toBe(true)
  })

  test('can_use_tool adds [approval needed] line', () => {
    const session = makeSession()
    feed(session, makeCanUseTool({ name: 'Bash' }))
    expect(session.contextLines().some((l) => l.includes('[approval needed:Bash]'))).toBe(true)
  })

  test('keep_alive adds nothing', () => {
    const session = makeSession()
    feed(session, KEEP_ALIVE)
    expect(session.contextLines().length).toBe(0)
  })

  test('stream_event adds nothing', () => {
    const session = makeSession()
    feed(session, STREAM_EVENT)
    expect(session.contextLines().length).toBe(0)
  })

  test('multiple events accumulate in order', () => {
    const session = makeSession()
    feed(session, SYSTEM)
    session.write('hello')
    feed(session, ASSISTANT_TEXT)
    feed(session, TOOL_USE)
    feed(session, TOOL_RESULT)
    feed(session, RESULT)
    const lines = session.contextLines()
    const idxSystem = lines.findIndex((l) => l.startsWith('[system]'))
    const idxAssistant = lines.findIndex((l) => l.includes('[assistant]'))
    const idxTool = lines.findIndex((l) => l.includes('[tool:Bash]'))
    const idxResult = lines.findIndex((l) => l.startsWith('[result]'))
    const idxComplete = lines.indexOf('[turn complete]')
    expect(idxSystem).toBeGreaterThanOrEqual(0)
    expect(idxAssistant).toBeGreaterThan(idxSystem)
    expect(idxTool).toBeGreaterThan(idxAssistant)
    expect(idxResult).toBeGreaterThan(idxTool)
    expect(idxComplete).toBeGreaterThan(idxResult)
  })

  test('contextLines returns a copy', () => {
    const session = makeSession()
    feed(session, RESULT)
    const lines = session.contextLines()
    lines.push('injected')
    expect(session.contextLines()).not.toContain('injected')
  })
})

// ─── CC 2.1.59+ embedded tool events ──────────────────────────────────────────

describe('CCSession — CC 2.1.59+ embedded tool events', () => {
  test('assistant with embedded tool_use block', () => {
    const session = makeSession()
    feed(session, ASSISTANT_TOOL_USE)
    expect(session.contextLines().some((l) => l.includes('[tool:Bash]'))).toBe(true)
  })

  test('user event with embedded tool_result', () => {
    const session = makeSession()
    feed(session, USER_TOOL_RESULT)
    expect(session.contextLines().some((l) => l.startsWith('[result]'))).toBe(true)
  })

  test('mixed text + tool_use adds both lines', () => {
    const session = makeSession()
    feed(session, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running the command...' },
          { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'pwd' } },
        ],
      },
    })
    const lines = session.contextLines()
    expect(lines.some((l) => l.includes('Running the command'))).toBe(true)
    expect(lines.some((l) => l.includes('[tool:Bash]'))).toBe(true)
  })

  test('full 2.1.59+ tool cycle', () => {
    const session = makeSession()
    feed(session, SYSTEM)
    session.write('Run ls in /tmp')
    feed(session, ASSISTANT_TOOL_USE)
    feed(session, USER_TOOL_RESULT)
    feed(session, ASSISTANT_TEXT)
    feed(session, RESULT)

    const lines = session.contextLines()
    const idxSystem = lines.findIndex((l) => l.startsWith('[system]'))
    const idxTool = lines.findIndex((l) => l.includes('[tool:Bash]'))
    const idxResult = lines.findIndex((l) => l.startsWith('[result]'))
    const idxAssistant = lines.findIndex((l) => l.includes('[assistant]') && l.includes('Hello world'))
    const idxComplete = lines.indexOf('[turn complete]')

    expect(idxSystem).toBeGreaterThanOrEqual(0)
    expect(idxTool).toBeGreaterThan(idxSystem)
    expect(idxResult).toBeGreaterThan(idxTool)
    expect(idxAssistant).toBeGreaterThan(idxResult)
    expect(idxComplete).toBeGreaterThan(idxAssistant)
  })

  test('user event with text block', () => {
    const session = makeSession()
    feed(session, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    })
    expect(session.contextLines()[0]).toContain('[user] hello')
  })
})

// ─── Session ID capture ────────────────────────────────────────────────────────

describe('CCSession — session_id from result', () => {
  test('session_id captured from result event', () => {
    const session = makeSession()
    feed(session, { type: 'result', subtype: 'success', session_id: 'sess-xyz' })
    expect(session.ccSessionId()).toBe('sess-xyz')
  })

  test('result without session_id does not crash', () => {
    const session = makeSession()
    expect(() => feed(session, { type: 'result', subtype: 'success' })).not.toThrow()
    expect(session.state()).toBe('idle')
  })
})

// ─── Robustness ────────────────────────────────────────────────────────────────

describe('CCSession — robustness', () => {
  test('non-JSON line does not crash', () => {
    const session = makeSession()
    session._handleLine('this is not json {{{')
    expect(session.state()).toBe('starting')
  })

  test('empty line does not crash', () => {
    const session = makeSession()
    session._handleLine('')
    expect(session.state()).toBe('starting')
  })

  test('unknown event type silently ignored', () => {
    const session = makeSession()
    feed(session, { type: 'some_future_event_type', data: { foo: 'bar' } })
    expect(session.state()).toBe('idle')
  })

  test('assistant with empty content array adds nothing', () => {
    const session = makeSession()
    feed(session, { type: 'assistant', message: { content: [] } })
    expect(session.contextLines().some((l) => l.startsWith('[assistant]'))).toBe(false)
  })

  test('stateChange observer carries correct fields', () => {
    const session = makeSession()
    const events: StateChangeEvent[] = []
    session.addObserver({ onStateChange: (e) => events.push(e) })
    feed(session, RESULT)
    const ev = events[0]
    expect(ev.sessionId).toBe('test')
    expect(ev.previous).toBe('starting')
    expect(ev.current).toBe('idle')
    expect(typeof ev.timestamp).toBe('number')
  })

  test('writeKey ctrl-c without proc does not crash', () => {
    const session = makeSession()
    expect(() => session.writeKey('ctrl-c')).not.toThrow()
  })

  test('writeKey ctrl-d without proc does not crash', () => {
    const session = makeSession()
    expect(() => session.writeKey('ctrl-d')).not.toThrow()
  })
})

// ─── data observer ────────────────────────────────────────────────────────────

describe('CCSession — data observer', () => {
  test('data callback fired for each rendered context line', () => {
    const session = makeSession()
    const received: string[] = []
    session.addObserver({ onData: (line) => received.push(line) })

    feed(session, SYSTEM)
    feed(session, ASSISTANT_TEXT)
    feed(session, RESULT)

    expect(received.some((l) => l.startsWith('[system]'))).toBe(true)
    expect(received.some((l) => l.includes('[assistant]'))).toBe(true)
    expect(received.some((l) => l === '[turn complete]')).toBe(true)
  })

  test('keep_alive does not fire data', () => {
    const session = makeSession()
    const received: string[] = []
    session.addObserver({ onData: (l) => received.push(l) })
    feed(session, KEEP_ALIVE)
    expect(received.length).toBe(0)
  })
})

// ─── AskUserQuestion detection ────────────────────────────────────────────────

const ASK_USER_QUESTION = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_ask_1',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which approach would you like?',
              header: 'Approach',
              multiSelect: false,
              options: [
                { label: 'Option A', description: 'First choice' },
                { label: 'Option B', description: 'Second choice' },
              ],
            },
          ],
        },
      },
    ],
  },
}

const ASK_USER_QUESTION_MULTI = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_ask_2',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which features?',
              header: 'Features',
              multiSelect: true,
              options: [
                { label: 'Auth', description: 'Authentication' },
                { label: 'DB', description: 'Database' },
                { label: 'API', description: 'REST API' },
              ],
            },
          ],
        },
      },
    ],
  },
}

describe('CCSession — AskUserQuestion detection', () => {
  test('pendingQuestion() is null initially', () => {
    expect(makeSession().pendingQuestion()).toBeNull()
  })

  test('AskUserQuestion tool_use populates pendingQuestion()', () => {
    const session = makeSession()
    feed(session, ASK_USER_QUESTION)
    const pq = session.pendingQuestion()
    expect(pq).not.toBeNull()
    expect(pq!.questions).toHaveLength(1)
    expect(pq!.questions[0].question).toBe('Which approach would you like?')
    expect(pq!.questions[0].options).toHaveLength(2)
  })

  test('AskUserQuestion does NOT change state immediately', () => {
    const session = makeSession()
    feed(session, SYSTEM)
    session.write('hello')
    feed(session, ASK_USER_QUESTION)
    expect(session.state()).toBe('busy')
    expect(session.pendingQuestion()).not.toBeNull()
  })

  test('result after AskUserQuestion transitions to waitingForInput', () => {
    const session = makeSession()
    feed(session, ASK_USER_QUESTION)
    feed(session, ASSISTANT_TEXT)
    feed(session, RESULT)
    expect(session.state()).toBe('waitingForInput')
    expect(session.pendingQuestion()).not.toBeNull()
  })

  test('write() after result clears pendingQuestion', () => {
    const session = makeSession()
    feed(session, ASK_USER_QUESTION)
    feed(session, ASSISTANT_TEXT)
    feed(session, RESULT)
    session.write('Option A')
    expect(session.pendingQuestion()).toBeNull()
    expect(session.state()).toBe('busy')
  })

  test('second result after user answer goes to idle', () => {
    const session = makeSession()
    feed(session, ASK_USER_QUESTION)
    feed(session, RESULT)
    session.write('Option A')
    feed(session, ASSISTANT_TEXT)
    feed(session, RESULT)
    expect(session.state()).toBe('idle')
    expect(session.pendingQuestion()).toBeNull()
  })

  test('multiSelect question captured correctly', () => {
    const session = makeSession()
    feed(session, ASK_USER_QUESTION_MULTI)
    const pq = session.pendingQuestion()
    expect(pq!.questions[0].multiSelect).toBe(true)
    expect(pq!.questions[0].options).toHaveLength(3)
  })

  test('AskUserQuestion adds [question] to contextLines', () => {
    const session = makeSession()
    feed(session, ASK_USER_QUESTION)
    const lines = session.contextLines()
    expect(lines.some((l) => l.startsWith('[question]') && l.includes('Which approach'))).toBe(true)
  })

  test('regular tool_use does not populate pendingQuestion', () => {
    const session = makeSession()
    feed(session, ASSISTANT_TOOL_USE)
    expect(session.pendingQuestion()).toBeNull()
  })
})

// ─── AskUserQuestion via control_request ─────────────────────────────────────

const ASK_CONTROL_REQUEST = {
  type: 'control_request',
  request_id: 'req-ask-123',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which approach would you like?',
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'Option A', description: 'First choice' },
            { label: 'Option B', description: 'Second choice' },
          ],
        },
      ],
    },
    tool_use_id: 'toolu_ask_1',
  },
}

describe('CCSession — AskUserQuestion via control_request', () => {
  test('control_request for AskUserQuestion → waitingForInput', () => {
    const session = makeSession()
    feed(session, SYSTEM)
    session.write('hello')
    feed(session, ASK_USER_QUESTION)
    feed(session, ASK_CONTROL_REQUEST)
    expect(session.state()).toBe('waitingForInput')
    expect(session.pendingQuestion()).not.toBeNull()
    expect(session.pendingApproval()).toBeNull()
  })

  test('control_request without prior assistant event still populates pendingQuestion', () => {
    const session = makeSession()
    feed(session, SYSTEM)
    session.write('hello')
    feed(session, ASK_CONTROL_REQUEST)
    expect(session.pendingQuestion()).not.toBeNull()
    expect(session.state()).toBe('waitingForInput')
  })

  test('write() answers question via control_response', () => {
    const session = makeSession()
    feed(session, SYSTEM)
    session.write('hello')
    feed(session, ASK_USER_QUESTION)
    feed(session, ASK_CONTROL_REQUEST)
    session.write('Option B')
    expect(session.pendingQuestion()).toBeNull()
    expect(session.state()).toBe('busy')
  })

  test('full flow: assistant → control_request → answer → result → idle', () => {
    const session = makeSession()
    const changes = trackChanges(session)
    feed(session, SYSTEM)
    session.write('hello')
    feed(session, ASK_USER_QUESTION)
    feed(session, ASK_CONTROL_REQUEST)
    session.write('Option A')
    feed(session, ASSISTANT_TEXT)
    feed(session, RESULT)
    expect(session.state()).toBe('idle')
    expect(changes).toEqual(['starting→idle', 'idle→busy', 'busy→waitingForInput', 'waitingForInput→busy', 'busy→idle'])
  })

  test('[user] line added to contextLines when answering question', () => {
    const session = makeSession()
    feed(session, ASK_USER_QUESTION)
    feed(session, ASK_CONTROL_REQUEST)
    session.write('Option A')
    expect(session.contextLines().some((l) => l === '[user] Option A')).toBe(true)
  })

  test('regular can_use_tool still sets pendingApproval', () => {
    const session = makeSession()
    feed(session, SYSTEM)
    session.write('hello')
    feed(session, {
      type: 'control_request',
      request_id: 'req-bash-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'rm -rf /' },
        tool_use_id: 'toolu_bash_1',
      },
    })
    expect(session.pendingApproval()).not.toBeNull()
    expect(session.pendingApproval()!.toolName).toBe('Bash')
    expect(session.pendingQuestion()).toBeNull()
  })
})

// ─── start() lifecycle ────────────────────────────────────────────────────────

describe('CCSession — start() lifecycle', () => {
  test('start() transitions to idle immediately', async () => {
    const session = new CCSession({
      id: 'start-idle-test',
      workingDirectory: '/tmp',
      agentBinary: '/bin/cat',
      agentArgs: [],
    })
    expect(session.state()).toBe('starting')
    await session.start()
    expect(session.state()).toBe('idle')
    session.kill()
  }, 5_000)
})
