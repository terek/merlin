import { describe, expect, test } from 'bun:test'
import type { Agent } from '../api/types'
import { agentPath, buildAgentTree, flattenAgentTree } from './tree'

const agent = (id: string, parent: string | null, extra: Partial<Agent> = {}): Agent => ({
  id,
  kind: 'subagent',
  parentAgentId: parent,
  depth: 1,
  linkage: 'meta',
  status: 'completed',
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 0.1 },
  subtreeUSD: 0.1,
  startedAt: '2026-09-16T10:00:00Z',
  ...extra,
})

const ids = (nodes: { agent: Agent }[]) => nodes.map((n) => n.agent.id)

describe('buildAgentTree', () => {
  test('nests by parentAgentId, oldest first', () => {
    const t = buildAgentTree([
      agent('b', null, { startedAt: '2026-09-16T10:00:02Z' }),
      agent('a', null, { startedAt: '2026-09-16T10:00:01Z' }),
      agent('c', 'a', { startedAt: '2026-09-16T10:00:03Z' }),
      agent('d', 'c', { startedAt: '2026-09-16T10:00:04Z' }),
    ])
    expect(ids(t.roots)).toEqual(['a', 'b'])
    expect(ids(t.roots[0].children)).toEqual(['c'])
    expect(t.roots[0].children[0].children[0].level).toBe(2)
    expect(t.unresolved).toEqual([])
    expect(agentPath(t.roots, 'd')).toEqual(['a', 'c', 'd'])
    expect(agentPath(t.roots, 'zzz')).toEqual([])
  })

  test('same start time orders by id', () => {
    const t = buildAgentTree([agent('y', null, { startedAt: 'T' }), agent('x', null, { startedAt: 'T' })])
    expect(ids(t.roots)).toEqual(['x', 'y'])
  })

  test('orphans become roots, flagged', () => {
    const t = buildAgentTree([agent('a', null), agent('o', 'missing'), agent('k', 'o')])
    expect(ids(t.roots).sort()).toEqual(['a', 'o'])
    const o = t.roots.find((n) => n.agent.id === 'o')
    expect(o?.orphan).toBe(true)
    expect(ids(o?.children ?? [])).toEqual(['k'])
    expect(t.roots.find((n) => n.agent.id === 'a')?.orphan).toBe(false)
  })

  test('unresolved agents and compaction calls are kept apart', () => {
    const t = buildAgentTree([
      agent('a', null),
      agent('u', null, { linkage: 'unresolved' }),
      agent('uc', 'u'),
      agent('m', null, { kind: 'compact' }),
    ])
    expect(ids(t.roots)).toEqual(['a'])
    expect(ids(t.unresolved)).toEqual(['u'])
    expect(ids(t.unresolved[0].children)).toEqual(['uc'])
    expect(t.compactions.map((a) => a.id)).toEqual(['m'])
  })

  test('a cycle is broken at its oldest member and nothing is lost or repeated', () => {
    const list = [
      agent('a', 'c', { startedAt: '2026-09-16T10:00:01Z' }),
      agent('b', 'a', { startedAt: '2026-09-16T10:00:02Z' }),
      agent('c', 'b', { startedAt: '2026-09-16T10:00:03Z' }),
      agent('self', 'self', { startedAt: '2026-09-16T10:00:09Z' }),
      agent('ok', null, { startedAt: '2026-09-16T10:00:00Z' }),
    ]
    const t = buildAgentTree(list)
    const flat = flattenAgentTree(t.roots)
    expect(flat.map((n) => n.agent.id).sort()).toEqual(['a', 'b', 'c', 'ok', 'self'])
    expect(new Set(flat.map((n) => n.agent.id)).size).toBe(5)
    expect(t.roots.find((n) => n.agent.id === 'a')?.orphan).toBe(true)
    expect(t.roots.find((n) => n.agent.id === 'self')?.orphan).toBe(true)
  })

  test('empty', () => {
    expect(buildAgentTree([])).toEqual({ roots: [], unresolved: [], compactions: [] })
  })
})
