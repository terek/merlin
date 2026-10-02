import { describe, expect, test } from 'bun:test'
import type { Agent } from '../../api/types'
import { buildAgentTree } from '../../lib/tree'
import { allOpenKeys, groupSiblings, revealKeys, subtreeStats, treeDepth, typeKey, visibleRows } from './model'

let seq = 0
const agent = (id: string, parent: string | null, extra: Partial<Agent> = {}): Agent => ({
  id,
  kind: 'subagent',
  agentType: 'Explore',
  parentAgentId: parent,
  depth: 1,
  linkage: 'meta',
  status: 'completed',
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 1 },
  subtreeUSD: 1,
  startedAt: `2026-09-16T10:00:${String(seq++ % 60).padStart(2, '0')}Z`,
  ...extra,
})

const forestOf = (agents: Agent[]) => buildAgentTree(agents).roots
const none = new Map<string, boolean>()

describe('subtreeStats', () => {
  test('sums cost, counts and failures from the tree, not from subtreeUSD', () => {
    const f = forestOf([
      agent('a', null, { cost: { usd: 1 }, subtreeUSD: 99 }),
      agent('b', 'a', { cost: { usd: 2 }, status: 'killed' }),
      agent('c', 'b', { cost: { usd: 4 }, status: 'open' }),
      agent('d', 'a', { cost: { usd: 8 } }),
    ])
    const s = subtreeStats(f)
    expect(s.get('a')).toEqual({ usd: 15, count: 4, killed: 1, open: 1 })
    expect(s.get('b')).toEqual({ usd: 6, count: 2, killed: 1, open: 1 })
    expect(s.get('d')).toEqual({ usd: 8, count: 1, killed: 0, open: 0 })
  })

  test('an orphan is a root with its own subtree; a cycle does not hang', () => {
    const f = forestOf([agent('x', 'gone'), agent('y', 'x'), agent('p', 'q'), agent('q', 'p')])
    const s = subtreeStats(f)
    expect(s.get('x')?.count).toBe(2)
    expect(s.get('p')?.count).toBe(2)
    expect(treeDepth(f)).toBe(2)
  })
})

describe('treeDepth', () => {
  test('counts levels', () => {
    expect(treeDepth([])).toBe(0)
    expect(treeDepth(forestOf([agent('a', null)]))).toBe(1)
    expect(treeDepth(forestOf([agent('a', null), agent('b', 'a'), agent('c', 'b'), agent('d', 'c')]))).toBe(4)
  })
})

describe('groupSiblings', () => {
  const run = (n: number, type: string, prefix: string) =>
    Array.from({ length: n }, (_, i) => agent(`${prefix}${i}`, null, { agentType: type }))

  test('folds a run of more than eight, leaves eight alone', () => {
    expect(groupSiblings(forestOf(run(8, 'Explore', 'a'))).every((e) => !e.group)).toBe(true)
    const g = groupSiblings(forestOf(run(9, 'Explore', 'a')))
    expect(g).toHaveLength(1)
    expect(g[0].group && g[0].nodes).toHaveLength(9)
    expect(g[0].group && g[0].id).toBe('g:a0')
  })

  test('only consecutive siblings of one type fold', () => {
    const agents = [...run(9, 'Explore', 'a'), agent('z', null, { agentType: 'Plan' }), ...run(3, 'Explore', 'b')]
    const g = groupSiblings(forestOf(agents))
    expect(g.map((e) => (e.group ? `group ${e.nodes.length}` : e.node.agent.id))).toEqual([
      'group 9',
      'z',
      'b0',
      'b1',
      'b2',
    ])
  })

  test('kind separates types; a teammate groups by name', () => {
    expect(typeKey(agent('a', null, { kind: 'fork' }))).not.toBe(typeKey(agent('a', null)))
    expect(typeKey(agent('a', null, { kind: 'teammate', agentType: undefined, name: 'scout' }))).toBe('teammate:scout')
  })
})

describe('visibleRows', () => {
  const chain = [agent('a', null), agent('b', 'a'), agent('c', 'b'), agent('d', 'c')]

  test('shows three levels, the third collapsed', () => {
    const f = forestOf(chain)
    const rows = visibleRows(f, subtreeStats(f), none)
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c'])
    expect(rows.map((r) => r.level)).toEqual([0, 1, 2])
    expect(rows[2].kind === 'node' && rows[2].open).toBe(false)
  })

  test('overrides open and close', () => {
    const f = forestOf(chain)
    const st = subtreeStats(f)
    expect(visibleRows(f, st, new Map([['c', true]])).map((r) => r.key)).toEqual(['a', 'b', 'c', 'd'])
    expect(visibleRows(f, st, new Map([['a', false]])).map((r) => r.key)).toEqual(['a'])
  })

  test('a group line carries the summed cost and opens to its members', () => {
    const agents = Array.from({ length: 10 }, (_, i) => agent(`k${i}`, null, { cost: { usd: i + 1 } }))
    const f = forestOf(agents)
    const st = subtreeStats(f)
    const closed = visibleRows(f, st, none)
    expect(closed).toHaveLength(1)
    expect(closed[0].kind === 'group' && closed[0].stats.usd).toBe(55)
    expect(closed[0].kind === 'group' && closed[0].stats.count).toBe(10)
    const open = visibleRows(f, st, new Map([['g:k0', true]]))
    expect(open).toHaveLength(11)
    expect(open[1].level).toBe(1)
  })
})

describe('revealKeys', () => {
  test('lists the ancestors and the group that hide an agent', () => {
    const agents = [
      agent('a', null),
      agent('b', 'a'),
      agent('c', 'b'),
      agent('d', 'c'),
      ...Array.from({ length: 10 }, (_, i) => agent(`m${i}`, 'd')),
    ]
    const f = forestOf(agents)
    expect(revealKeys(f, 'a')).toEqual([])
    expect(revealKeys(f, 'd')).toEqual(['a', 'b', 'c'])
    const keys = revealKeys(f, 'm4')
    expect(keys).toEqual(['a', 'b', 'c', 'd', 'g:m0'])
    const overrides = new Map(keys.map((k) => [k, true] as const))
    expect(visibleRows(f, subtreeStats(f), overrides).some((r) => r.key === 'm4')).toBe(true)
    expect(revealKeys(f, 'nope')).toEqual([])
  })

  test('allOpenKeys opens everything', () => {
    const f = forestOf([agent('a', null), agent('b', 'a'), agent('c', 'b'), agent('d', 'c')])
    const rows = visibleRows(f, subtreeStats(f), new Map(allOpenKeys(f).map((k) => [k, true] as const)))
    expect(rows).toHaveLength(4)
  })
})
