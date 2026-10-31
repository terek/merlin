import { describe, expect, test } from 'bun:test'
import type { Agent, Diagnostics, FamilyMember, Message, SessionDetail, Turn } from '../../api/types'
import { diagnosticsLines, familyRows, parseHash, resolveTarget, resumeInfo } from './session'
import { buildTree } from './tree'

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, min)).toISOString()
const k = (id: string) => ({ harness: 'claude', id })

const turn = (index: number): Turn => ({
  index,
  epoch: 0,
  origin: 'human',
  userText: `prompt ${index}`,
  startedAt: at(index * 2),
  endedAt: at(index * 2 + 1),
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 0 },
  costWithAgents: 0,
})

const msg = (id: string, t: number, agentId?: string): Message => ({
  id,
  at: at(t * 2),
  model: 'model-a',
  turn: t,
  usd: 1,
  output: 100,
  agentId,
})

const agent = (id: string, spawnTurn: number, extra: Partial<Agent> = {}): Agent => ({
  id,
  kind: 'subagent',
  parentAgentId: null,
  depth: 1,
  linkage: 'meta',
  status: 'completed',
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 1 },
  subtreeUSD: 1,
  spawnTurn,
  startedAt: at(spawnTurn * 2),
  endedAt: at(spawnTurn * 2),
  ...extra,
})

function detail(over: {
  id?: string
  turns?: number
  parent?: { id: string; atTurn: number; inherited: number[] }
  agents?: Agent[]
  compactionTurns?: number[]
  members?: FamilyMember[]
  leaves?: string[]
  leaf?: boolean
  cwd?: string
}): SessionDetail {
  const key = k(over.id ?? 'aaaa')
  const n = over.turns ?? 0
  const inherited = over.parent?.inherited ?? []
  const agents = over.agents ?? []
  return {
    summary: { key, cwd: over.cwd, title: key.id } as SessionDetail['summary'],
    cost: {} as SessionDetail['cost'],
    lineage: {
      parent: over.parent && {
        parent: k(over.parent.id),
        child: key,
        sharedMessages: 1,
        sharedTurns: inherited.length,
        atTurn: over.parent.atTurn,
        explicit: true,
        kind: 'fork',
      },
      children: [],
      root: key,
      leaf: over.leaf ?? true,
      inheritedTurns: inherited,
      firstOwnTurn: inherited.length,
    },
    family: { root: key, members: over.members ?? [], leaves: (over.leaves ?? []).map(k) },
    messageCount: 0,
    digest: {
      turns: Array.from({ length: n }, (_, i) => turn(i)),
      messages: [
        ...Array.from({ length: n }, (_, i) => msg(`${key.id}-${i}`, i)),
        ...agents.map((a) => msg(`${key.id}-${a.id}`, a.spawnTurn ?? 0, a.id)),
      ],
      agents,
      compactions: (over.compactionTurns ?? []).map((t) => ({ at: at(t * 2), turn: t })),
      diagnostics: {},
    } as unknown as SessionDetail['digest'],
  }
}

describe('parseHash', () => {
  test('turn, compaction, agent', () => {
    expect(parseHash('#t12')).toEqual({ kind: 'turn', index: 12 })
    expect(parseHash('t0')).toEqual({ kind: 'turn', index: 0 })
    expect(parseHash('#c3')).toEqual({ kind: 'compaction', index: 3 })
    expect(parseHash('#a1234abcd')).toEqual({ kind: 'agent', id: '1234abcd' })
  })
  test('anything else is null', () => {
    expect(parseHash('')).toBeNull()
    expect(parseHash('#')).toBeNull()
    expect(parseHash('#tx')).toBeNull()
    expect(parseHash('#t')).toBeNull()
    expect(parseHash('#other')).toBeNull()
  })
})

describe('resolveTarget', () => {
  // the trunk has four turns and launches a sub-agent in turn 1, which has one of its own; the
  // fork copied turns 0-1, added two and was compacted in its turn 3
  const trunk = detail({
    id: 'trunk',
    turns: 4,
    agents: [agent('sub', 1), agent('kid', 1, { parentAgentId: 'sub', depth: 2 })],
  })
  const fork = detail({
    id: 'fork',
    turns: 4,
    parent: { id: 'trunk', atTurn: 1, inherited: [0, 1] },
    compactionTurns: [3],
  })
  const tree = buildTree([trunk, fork])
  const home = tree.branches.findIndex((b) => b.key.id === 'fork')
  const top = tree.branches.findIndex((b) => b.key.id === 'trunk')

  test('an own turn is pinned on the session itself', () => {
    expect(resolveTarget(tree, home, { kind: 'turn', index: 2 })).toEqual({ pin: { branch: home, col: 2 }, unit: null })
  })
  test('a copied turn is pinned on the session that ran it', () => {
    expect(resolveTarget(tree, home, { kind: 'turn', index: 1 })?.pin).toEqual({ branch: top, col: 1 })
  })
  test('a compaction pins its turn', () => {
    expect(resolveTarget(tree, home, { kind: 'compaction', index: 0 })?.pin).toEqual({ branch: home, col: 3 })
  })
  test('an agent opens its piece of work, a nested one that of the agent it is inside', () => {
    for (const id of ['sub', 'kid']) {
      const r = resolveTarget(tree, home, { kind: 'agent', id })
      expect(r?.pin).toEqual({ branch: top, col: 1 })
      expect(r?.unit?.branch).toBe(top)
      expect(tree.branches[top].model.units.find((u) => u.id === r?.unit?.id)?.agent.id).toBe('sub')
    }
  })
  test('anything not in the tree is null', () => {
    expect(resolveTarget(tree, home, { kind: 'turn', index: 9 })).toBeNull()
    expect(resolveTarget(tree, home, { kind: 'compaction', index: 1 })).toBeNull()
    expect(resolveTarget(tree, home, { kind: 'agent', id: 'nobody' })).toBeNull()
    expect(resolveTarget(tree, home, null)).toBeNull()
  })
})

describe('resumeInfo', () => {
  test('quoted cwd and the full id', () => {
    const d = detail({ cwd: "/home/dev/it's here" })
    expect(resumeInfo(d).command).toBe(`cd '/home/dev/it'\\''s here' && claude --resume aaaa`)
  })
  test('no cwd: just the resume', () => {
    expect(resumeInfo(detail({})).command).toBe('claude --resume aaaa')
  })
  test('a non-leaf lists the other leaves it knows', () => {
    const m = (id: string, leaf: boolean): FamilyMember => ({
      key: k(id),
      kind: 'interactive',
      state: 'ended',
      leaf,
      turns: 1,
      bestUSD: 0,
    })
    const d = detail({
      leaf: false,
      members: [m('aaaa', false), m('bbbb', true), m('cccc', true)],
      leaves: ['cccc', 'bbbb', 'zzzz'],
    })
    const r = resumeInfo(d)
    expect(r.leaf).toBe(false)
    expect(r.leaves.map((x) => x.key.id)).toEqual(['cccc', 'bbbb'])
  })
})

describe('familyRows', () => {
  test('depth follows parents; relations come from the current links', () => {
    const m = (id: string, parent?: string): FamilyMember => ({
      key: k(id),
      kind: 'interactive',
      state: 'ended',
      parent: parent ? k(parent) : undefined,
      leaf: false,
      turns: 1,
      bestUSD: 0,
    })
    const d = detail({ members: [m('r'), m('aaaa', 'r'), m('x', 'aaaa')] })
    d.lineage.parent = {
      parent: k('r'),
      child: k('aaaa'),
      sharedMessages: 1,
      sharedTurns: 1,
      atTurn: 0,
      explicit: true,
      kind: 'fork',
    }
    d.lineage.children = [
      {
        parent: k('aaaa'),
        child: k('x'),
        sharedMessages: 1,
        sharedTurns: 1,
        atTurn: 0,
        explicit: false,
        kind: 'continuation',
      },
    ]
    const rows = familyRows(d)
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2])
    expect(rows.map((r) => r.current)).toEqual([false, true, false])
    expect(rows.map((r) => r.relation)).toEqual([undefined, 'fork', 'continuation'])
  })
})

describe('diagnosticsLines', () => {
  test('only what is there', () => {
    expect(diagnosticsLines({})).toEqual([])
    const dg: Diagnostics = { unknownTypes: { b: 1, a: 3 }, badLines: 2, unpricedModels: ['m1'], unresolvedAgents: 1 }
    expect(diagnosticsLines(dg).map((l) => l.value)).toEqual(['a ×3, b ×1', '2', 'm1', '1'])
  })
})
