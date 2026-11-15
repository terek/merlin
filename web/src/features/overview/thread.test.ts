import { describe, expect, test } from 'bun:test'
import type { Agent, AgentTurn } from '../../api/types'
import {
  agentThread,
  exchangeGist,
  filesLine,
  noReply,
  openTurn,
  promptSource,
  reachedLine,
  toolsLine,
  turnMarks,
} from './thread'

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, min)).toISOString()

const aturn = (index: number, extra: Partial<AgentTurn> = {}): AgentTurn => ({
  index,
  origin: index === 0 ? 'spawn' : 'peer',
  startedAt: at(index * 10),
  endedAt: at(index * 10 + 5),
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 0 },
  ...extra,
})

const agent = (extra: Partial<Agent> = {}): Agent => ({
  id: 'a1',
  kind: 'subagent',
  parentAgentId: null,
  depth: 1,
  linkage: 'meta',
  status: 'completed',
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 0 },
  subtreeUSD: 0,
  ...extra,
})

describe('promptSource', () => {
  test('a typed prompt and a command are yours', () => {
    expect(promptSource('human')).toEqual({ typed: true, label: 'You typed' })
    expect(promptSource('command').typed).toBe(true)
  })
  test('a delivered prompt says what was delivered', () => {
    expect(promptSource('peer', [{ at: at(0), kind: 'idle' }]).label).toBe('A teammate went idle')
    expect(promptSource('task-notification', [{ at: at(0), kind: 'task' }]).label).toBe('A background task reported')
    expect(promptSource('peer', [{ at: at(0) }]).label).toBe('A teammate wrote')
    expect(promptSource('scheduled').label).toBe('A scheduled wake-up')
  })
  test('mixed messages fall back to the origin', () => {
    const inbox = [{ at: at(0), kind: 'idle' as const }, { at: at(1) }]
    expect(promptSource('peer', inbox).label).toBe('A teammate wrote')
  })
})

describe('toolsLine', () => {
  test('the top three by count, ties by name, then an ellipsis', () => {
    expect(toolsLine(18, { Edit: 6, Bash: 5, Read: 4, Grep: 2, Glob: 1 })).toBe(
      '18 tool calls (Edit 6, Bash 5, Read 4, …)',
    )
    expect(toolsLine(6, { Read: 3, Bash: 3 })).toBe('6 tool calls (Bash 3, Read 3)')
  })
  test('one call, no names, none', () => {
    expect(toolsLine(1, { Read: 1 })).toBe('1 tool call (Read 1)')
    expect(toolsLine(4)).toBe('4 tool calls')
    expect(toolsLine(0, { Read: 0 })).toBe('')
  })
})

test('filesLine', () => {
  expect(filesLine(['a', 'b', 'c'])).toBe('3 files')
  expect(filesLine(['a'])).toBe('1 file')
  expect(filesLine([])).toBe('')
  expect(filesLine()).toBe('')
})

describe('reachedLine', () => {
  test('one report, several, none', () => {
    expect(reachedLine([15])).toBe('reached the main agent in turn 15')
    expect(reachedLine([15, 18])).toBe('reached the main agent in turns 15 and 18')
    expect(reachedLine([3, 5, 9])).toBe('reached the main agent in turns 3, 5 and 9')
    expect(reachedLine([])).toBe('')
  })
})

test('turnMarks and noReply', () => {
  expect(turnMarks({ interrupted: true, command: 'compact' })).toEqual(['interrupted', '/compact'])
  expect(turnMarks({})).toEqual([])
  expect(noReply({ interrupted: true })).toBe('No reply (interrupted)')
  expect(noReply({})).toBe('No reply')
})

describe('agentThread', () => {
  test('a one-shot agent without turns is one request and one response', () => {
    const t = agentThread(agent({ prompt: 'Find the bug', finalText: 'It is in parse.', startedAt: at(0) }), 0)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({
      from: 'the main agent',
      request: 'Find the bug',
      response: 'It is in parse.',
      open: true,
    })
  })

  test('a teammate with several turns: the sender of each, the pinned one open', () => {
    const a = agent({
      kind: 'teammate',
      prompt: 'Review the diff',
      turns: [
        aturn(0, { prompt: 'Review the diff', finalText: 'Two issues.' }),
        aturn(1, { inbox: [{ at: at(10), from: 'lead', text: 'Fix them' }], finalText: 'Fixed.' }),
        aturn(2, { origin: 'human', prompt: 'Thanks', finalText: 'Done.', interrupted: true }),
      ],
    })
    const t = agentThread(a, 1)
    expect(t.map((x) => x.from)).toEqual(['the main agent', 'lead', 'you'])
    expect(t.map((x) => x.open)).toEqual([false, true, false])
    expect(t[1].inbox).toHaveLength(1)
    expect(t[1].response).toBe('Fixed.')
    expect(t[2].interrupted).toBe(true)
    expect(t[0].request).toBe('Review the diff')
  })

  test('an encrypted prompt is flagged, with no text', () => {
    const t = agentThread(agent({ promptEncrypted: true, turns: [aturn(0, { promptEncrypted: true })] }), 0)
    expect(t[0].encrypted).toBe(true)
    expect(t[0].request).toBe('')
    expect(exchangeGist(t[0])).toBe('encrypted')
  })

  test('a folded exchange shows the first line of its request or its first message', () => {
    const a = agent({
      turns: [
        aturn(0, { prompt: 'First line\nsecond' }),
        aturn(1, { inbox: [{ at: at(10), from: 'x', text: 'Hello\nthere' }] }),
      ],
    })
    const t = agentThread(a, 0)
    expect(exchangeGist(t[0])).toBe('First line')
    expect(exchangeGist(t[1])).toBe('Hello')
  })
})

describe('openTurn', () => {
  const a = agent({ turns: [aturn(0), aturn(1), aturn(2)] })
  test('the turn that starts when the piece of work does', () => {
    expect(openTurn(a, Date.parse(at(10)), 1)).toBe(1)
    expect(openTurn(a, Date.parse(at(20)), 1)).toBe(2)
  })
  test('else by ordinal, kept inside the turns', () => {
    expect(openTurn(a, Date.parse(at(500)), 2)).toBe(1)
    expect(openTurn(a, 0, 9)).toBe(2)
    expect(openTurn(agent(), 0, 1)).toBe(0)
  })
})
