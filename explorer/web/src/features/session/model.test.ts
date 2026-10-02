import { describe, expect, test } from 'bun:test'
import type { Compaction, Diagnostics, FamilyMember, SessionDetail, Turn } from '../../api/types'
import {
  applyPromptsOnly,
  buildTimeline,
  costSentence,
  diagnosticsLines,
  familyRows,
  groupInherited,
  hasAgentCost,
  machineLine,
  mergeEntries,
  modelRows,
  parseHash,
  resumeInfo,
  textHead,
  topTools,
  turnNeeds,
} from './model'

const turn = (index: number, extra: Partial<Turn> = {}): Turn => ({
  index,
  epoch: 0,
  origin: 'human',
  userText: `prompt ${index}`,
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 0.01 },
  costWithAgents: 0.01,
  ...extra,
})
const compaction = (t: number, extra: Partial<Compaction> = {}): Compaction => ({
  at: '2026-09-16T10:00:00Z',
  turn: t,
  ...extra,
})

function detail(over: {
  turns?: Turn[]
  compactions?: Compaction[]
  inherited?: number[]
  members?: FamilyMember[]
  leaves?: string[]
  leaf?: boolean
  cwd?: string
}): SessionDetail {
  const key = { harness: 'claude', id: 'aaaa' }
  const members = over.members ?? []
  return {
    summary: { key, cwd: over.cwd } as SessionDetail['summary'],
    cost: {} as SessionDetail['cost'],
    lineage: {
      children: [],
      root: key,
      leaf: over.leaf ?? true,
      inheritedTurns: over.inherited ?? [],
      firstOwnTurn: 0,
    },
    family: { root: key, members, leaves: (over.leaves ?? []).map((id) => ({ harness: 'claude', id })) },
    messageCount: 0,
    digest: { turns: over.turns, compactions: over.compactions, diagnostics: {} } as SessionDetail['digest'],
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

describe('mergeEntries', () => {
  const turns = [turn(0), turn(1), turn(2)]
  const shape = (e: ReturnType<typeof mergeEntries>) =>
    e.map((x) => (x.type === 'turn' ? `t${x.turn.index}` : `c${x.index}`)).join(' ')

  test('a compaction sits after the turn it names', () => {
    expect(shape(mergeEntries(turns, [compaction(0), compaction(2)], []))).toBe('t0 c0 t1 t2 c1')
  })
  test('-1 is before the first turn', () => {
    expect(shape(mergeEntries(turns, [compaction(-1)], []))).toBe('c0 t0 t1 t2')
  })
  test('two after one turn keep their order; an unknown turn goes last', () => {
    expect(shape(mergeEntries(turns, [compaction(1), compaction(1), compaction(99)], []))).toBe('t0 t1 c0 c1 t2 c2')
  })
  test('no turns: compactions alone', () => {
    expect(shape(mergeEntries([], [compaction(-1), compaction(4)], []))).toBe('c0 c1')
  })
  test('a compaction is inherited only between inherited turns', () => {
    const e = mergeEntries(turns, [compaction(0), compaction(1)], [0, 1])
    const flags = e.map((x) => x.inherited)
    // t0 c0 t1 c1 t2
    expect(flags).toEqual([true, true, true, false, false])
  })
  test('a leading compaction follows the first turn', () => {
    expect(mergeEntries(turns, [compaction(-1)], [0]).map((x) => x.inherited)).toEqual([true, true, false, false])
    expect(mergeEntries(turns, [compaction(-1)], []).map((x) => x.inherited)).toEqual([false, false, false, false])
  })
})

describe('groupInherited', () => {
  test('one group for the copied prefix', () => {
    const e = mergeEntries([turn(0), turn(1), turn(2)], [compaction(0)], [0, 1])
    const g = groupInherited(e)
    expect(g.map((x) => x.type)).toEqual(['inherited', 'turn'])
    const grp = g[0]
    expect(grp.type === 'inherited' && grp.turns).toBe(2)
    expect(grp.type === 'inherited' && grp.entries.length).toBe(3)
  })
  test('separate runs make separate groups', () => {
    const g = groupInherited(mergeEntries([turn(0), turn(1), turn(2)], [], [0, 2]))
    expect(g.map((x) => x.type)).toEqual(['inherited', 'turn', 'inherited'])
  })
  test('nothing inherited, nothing grouped', () => {
    expect(groupInherited(mergeEntries([turn(0)], [], [])).map((x) => x.type)).toEqual(['turn'])
  })
})

describe('applyPromptsOnly', () => {
  test('runs of machine turns collapse; compactions and human turns stay', () => {
    const turns = [
      turn(0),
      turn(1, { origin: 'task-notification' }),
      turn(2, { origin: 'command' }),
      turn(3),
      turn(4, { origin: 'peer' }),
    ]
    const items = applyPromptsOnly(groupInherited(mergeEntries(turns, [compaction(3)], [])))
    expect(items.map((x) => x.type)).toEqual(['turn', 'hidden', 'turn', 'compaction', 'hidden'])
    const h = items[1]
    expect(h.type === 'hidden' && h.turns.map((t) => t.index)).toEqual([1, 2])
  })
  test('a compaction splits two hidden runs', () => {
    const turns = [turn(0, { origin: 'sdk' }), turn(1, { origin: 'sdk' })]
    const items = applyPromptsOnly(groupInherited(mergeEntries(turns, [compaction(0)], [])))
    expect(items.map((x) => x.type)).toEqual(['hidden', 'compaction', 'hidden'])
  })
})

describe('buildTimeline', () => {
  test('first own turn and inherited count', () => {
    const d = detail({ turns: [turn(0), turn(1), turn(2)], inherited: [0, 1] })
    const t = buildTimeline(d, false)
    expect(t.firstOwnTurn).toBe(2)
    expect(t.inheritedTurns).toBe(2)
    expect(t.items.map((x) => x.type)).toEqual(['inherited', 'turn'])
  })
  test('every turn inherited: no first own turn', () => {
    const t = buildTimeline(detail({ turns: [turn(0)], inherited: [0] }), false)
    expect(t.firstOwnTurn).toBeNull()
  })
  test('a digest without turns', () => {
    expect(buildTimeline(detail({}), false).items).toEqual([])
  })
})

describe('turnNeeds', () => {
  test('inherited and machine turns', () => {
    const d = detail({ turns: [turn(0), turn(1, { origin: 'peer' })], inherited: [0] })
    expect(turnNeeds(d, 0)).toEqual({ inherited: true, machine: false })
    expect(turnNeeds(d, 1)).toEqual({ inherited: false, machine: true })
    expect(turnNeeds(d, 9)).toEqual({ inherited: false, machine: false })
  })
})

describe('machineLine', () => {
  test('commands show their name', () => {
    expect(machineLine({ origin: 'command', command: 'review', userText: '/review the login page' })).toBe(
      '/review the login page',
    )
    expect(machineLine({ origin: 'command', command: '/wake', userText: '/wake rest of the text' })).toBe(
      '/wake rest of the text',
    )
    expect(machineLine({ origin: 'command', command: 'wake', userText: 'rest of the text' })).toBe(
      '/wake rest of the text',
    )
    expect(machineLine({ origin: 'command', command: 'wake', userText: '/wakeful' })).toBe('/wake /wakeful')
    expect(machineLine({ origin: 'command', command: '/model', userText: '/model' })).toBe('/model')
  })
  test('other origins show the first line', () => {
    expect(machineLine({ origin: 'task-notification', userText: '\n  <task> done\nmore' })).toBe('<task> done')
    expect(machineLine({ origin: 'peer', userText: '' })).toBe('(empty)')
  })
  test('wrapped machine texts show label and summary', () => {
    expect(
      machineLine({
        origin: 'task-notification',
        userText: '<task-notification><status>failed</status><summary>Build broke</summary></task-notification>',
      }),
    ).toBe('failed: Build broke')
    expect(
      machineLine({
        origin: 'peer',
        userText: '<teammate-message teammate_id="x" summary="Done">body</teammate-message>',
      }),
    ).toBe('from x: Done')
  })
  test('delivered prompts show the first message and how many more there are', () => {
    const at = '2026-09-30T10:00:00Z'
    expect(
      machineLine({
        origin: 'peer',
        userText: '',
        inbox: [
          { at, kind: 'message', from: 'x', summary: 'Done', text: 'body' },
          { at, kind: 'idle', from: 'x', status: 'available' },
        ],
      }),
    ).toBe('from x +1: Done')
    expect(
      machineLine({
        origin: 'task-notification',
        userText: '',
        inbox: [{ at, kind: 'task', status: 'failed', summary: 'Build broke' }],
      }),
    ).toBe('task failed: Build broke')
    expect(
      machineLine({ origin: 'peer', userText: '', inbox: [{ at, kind: 'idle', from: 'x', status: 'available' }] }),
    ).toBe('x idle')
  })
})

describe('topTools', () => {
  test('top n by count then name, with the rest summed', () => {
    const r = topTools({ Bash: 5, Read: 9, Edit: 5, Grep: 1, Glob: 2 }, 3)
    expect(r.top.map((t) => t.name)).toEqual(['Read', 'Bash', 'Edit'])
    expect(r.rest).toBe(3)
  })
  test('none', () => {
    expect(topTools(undefined)).toEqual({ top: [], rest: 0 })
  })
})

describe('hasAgentCost', () => {
  test('only when agents were spawned and added cost', () => {
    expect(hasAgentCost({ cost: { usd: 1 }, costWithAgents: 1, spawned: ['a'] })).toBe(false)
    expect(hasAgentCost({ cost: { usd: 1 }, costWithAgents: 3, spawned: [] })).toBe(false)
    expect(hasAgentCost({ cost: { usd: 1 }, costWithAgents: 3, spawned: ['a'] })).toBe(true)
  })
})

describe('textHead', () => {
  test('short text is whole', () => {
    expect(textHead('abc', 10)).toEqual({ head: 'abc', cut: false })
  })
  test('cuts at a paragraph break when one is near', () => {
    const r = textHead(`${'a'.repeat(80)}\n\n${'b'.repeat(80)}`, 100)
    expect(r.cut).toBe(true)
    expect(r.head).toBe('a'.repeat(80))
  })
  test('cuts hard without a break', () => {
    expect(textHead('x'.repeat(50), 10).head).toBe('x'.repeat(10))
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
      key: { harness: 'claude', id },
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
    const k = (id: string) => ({ harness: 'claude', id })
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

describe('costSentence', () => {
  test('one sentence per flag', () => {
    expect(costSentence({ flag: 'exact', reportedUSD: 1, uncoveredUSD: 0 })).toContain('whole session')
    expect(costSentence({ flag: 'partial', reportedUSD: 0.5, uncoveredUSD: 0.25 })).toBe(
      'Partly reported: $0.50 reported, the $0.25 outside the reported windows recomputed from token counts.',
    )
    expect(costSentence({ flag: 'estimated', reportedUSD: 0, uncoveredUSD: 2 })).toContain('nothing')
  })
})

describe('modelRows', () => {
  test('dearest first; cache writes of both lifetimes added', () => {
    const rows = modelRows({
      a: { usd: 1, input: 5, cacheWrite5m: 2, cacheWrite1h: 3 },
      b: { usd: 2, output: 7 },
    })
    expect(rows.map((r) => r.model)).toEqual(['b', 'a'])
    expect(rows[1]).toEqual({ model: 'a', input: 5, output: 0, cacheRead: 0, cacheWrite: 5, usd: 1 })
    expect(modelRows(undefined)).toEqual([])
  })
})
