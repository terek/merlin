import { describe, expect, test } from 'bun:test'
import type { BeadStep } from '../../api/types'
import { actor, chain, groupSteps, opVerb } from './model'

const step = (at: string, sessionId: string, op = 'update', agentId?: string): BeadStep => ({
  at,
  harness: 'claude',
  sessionId,
  agentId,
  op,
  outcome: 'ok',
})

describe('groupSteps', () => {
  test('groups by session, in the order of the first step', () => {
    const g = groupSteps([
      step('2026-11-03T10:00:00Z', 'b'),
      step('2026-11-01T10:00:00Z', 'a'),
      step('2026-11-04T10:00:00Z', 'a'),
    ])
    expect(g.map((x) => x.sessionId)).toEqual(['a', 'b'])
    expect(g[0]?.steps.map((s) => s.at)).toEqual(['2026-11-01T10:00:00Z', '2026-11-04T10:00:00Z'])
  })
  test('empty', () => expect(groupSteps(undefined)).toEqual([]))
})

test('opVerb', () => {
  expect(opVerb('close')).toBe('closed')
  expect(opVerb('show')).toBe('viewed')
  expect(opVerb('dep')).toBe('dependency')
  expect(opVerb('mystery')).toBe('mystery')
})

test('chain puts the root first', () => {
  const r = (id: string) => ({ id, root: 'a', database: 'd' })
  expect(chain({ ancestors: [r('a.1'), r('a')] }).map((x) => x.id)).toEqual(['a', 'a.1'])
})

test('actor', () => {
  expect(actor({})).toBe('main')
  expect(actor({ agentId: 'x' })).toBe('worker')
})
