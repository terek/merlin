import { describe, expect, test } from 'bun:test'
import type { Agent, Message, SessionDetail, Turn } from '../../api/types'
import {
  buildSpend,
  CLASS_SERIES,
  compactionTally,
  decisionItems,
  fitPrices,
  packRows,
  promptLine,
  type Row,
  rereadTokens,
  stepParts,
  topDecisions,
  turnAt,
  unitParts,
} from './model'

// Prices of the fixture, dollars per token: input 10, output 50, cache read 1 (per million).
const IN = 10e-6
const READ = 1e-6

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, min)).toISOString()

const price = (m: Partial<Message>) =>
  IN * ((m.input ?? 0) + 5 * (m.output ?? 0) + 1.25 * (m.cacheWrite5m ?? 0) + 2 * (m.cacheWrite1h ?? 0)) +
  READ * (m.cacheRead ?? 0)

let seq = 0
const msg = (min: number, tok: Partial<Message>, extra: Partial<Message> = {}): Message => ({
  id: `m${seq++}`,
  at: at(min),
  model: 'model-a',
  usd: price(tok),
  ...tok,
  ...extra,
})

const turn = (index: number, startMin: number, endMin: number, extra: Partial<Turn> = {}): Turn => ({
  index,
  epoch: 0,
  origin: 'human',
  userText: `prompt ${index}`,
  startedAt: at(startMin),
  endedAt: at(endMin),
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 0 },
  costWithAgents: 0,
  ...extra,
})

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
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

const detail = (turns: Turn[], messages: Message[], agents: Agent[] = [], inheritedTurns: number[] = []) =>
  ({
    lineage: { children: [], inheritedTurns, leaf: true, firstOwnTurn: 0, root: { harness: 'claude', id: 's' } },
    digest: { turns, agents, messages },
  }) as unknown as SessionDetail

const sum = (xs: { usd: number }[]) => xs.reduce((a, x) => a + x.usd, 0)

describe('fitPrices', () => {
  test('recovers the input and cache-read prices from the messages', () => {
    const f = fitPrices([
      msg(0, { input: 100, output: 2000, cacheWrite5m: 30_000 }),
      msg(1, { input: 50, output: 500, cacheRead: 30_000, cacheWrite5m: 2000 }),
      msg(2, { input: 10, output: 900, cacheRead: 32_000, cacheWrite1h: 700 }),
    ]).get('model-a')
    expect(f?.input).toBeCloseTo(IN, 12)
    expect(f?.read).toBeCloseTo(READ, 12)
  })

  test('one message cannot separate the two prices: a read is a tenth of input', () => {
    const f = fitPrices([msg(0, { input: 100, output: 100 })]).get('model-a')
    expect(f?.input).toBeCloseTo(IN, 12)
    expect(f?.read).toBeCloseTo(IN / 10, 12)
  })
})

describe('rereadTokens', () => {
  const prev = msg(0, { input: 10, cacheRead: 90_000, cacheWrite5m: 10_000 })
  test('a warm message reads what was cached and writes only what is new', () => {
    expect(rereadTokens(prev, msg(1, { cacheRead: 100_000, cacheWrite5m: 3000 }))).toBe(0)
  })
  test('a miss writes the previous prompt again', () => {
    expect(rereadTokens(prev, msg(9, { cacheRead: 15_000, cacheWrite5m: 88_000 }))).toBe(85_010)
  })
  test('a smaller context after a compaction is new content, not a miss', () => {
    expect(rereadTokens(prev, msg(1, { cacheRead: 15_000, cacheWrite5m: 20_000 }))).toBe(0)
  })
  test('the first message of an agent has nothing to miss', () => {
    expect(rereadTokens(undefined, msg(1, { cacheWrite5m: 80_000 }))).toBe(0)
  })
})

describe('turnAt', () => {
  test('the last turn started at or before the time; 0 before the first', () => {
    const starts = [10, 20, 30]
    expect(turnAt(starts, 5)).toBe(0)
    expect(turnAt(starts, 20)).toBe(1)
    expect(turnAt(starts, 29)).toBe(1)
    expect(turnAt(starts, 99)).toBe(2)
  })
})

describe('promptLine', () => {
  test('joins a line that only introduces the next one', () => {
    expect(promptLine({ userText: 'A session sent a message:\n\nplease check the build' })).toBe(
      'A session sent a message: please check the build',
    )
    expect(promptLine({ userText: 'fix the test\nand the docs' })).toBe('fix the test')
    expect(
      promptLine({
        userText:
          'A session sent a message:\n<teammate-message teammate_id="builder" summary="tests pass">\nall green\n</teammate-message>\nnote',
      }),
    ).toBe('from builder: tests pass')
    expect(promptLine({ userText: '', command: '/compact' })).toBe('/compact')
    // a delivered prompt as the API gives it
    expect(
      promptLine({
        userText: '',
        inbox: [{ at: at(0), kind: 'message', from: 'builder', summary: 'tests pass', text: 'all green' }],
      }),
    ).toBe('from builder: tests pass')
    expect(
      promptLine({ userText: '', inbox: [{ at: at(0), kind: 'idle', from: 'builder', status: 'available' }] }),
    ).toBe('builder idle')
  })
})

describe('buildSpend', () => {
  // A person types turn 0 and turn 3. Turn 0 launches a sub-agent (which has a sub-agent of its
  // own) and a teammate. The teammate reports in turn 1, is sent more work in turn 1 and reports
  // again in turn 2. Turn 3 comes 35 minutes later: the main agent's cache has expired.
  const report = (name: string) =>
    `A session sent a message:\n<teammate-message teammate_id="${name}" summary="done">\nok\n</teammate-message>\n`
  const turns = [
    turn(0, 0, 2),
    turn(1, 3, 5, { origin: 'peer', userText: report('builder') }),
    turn(2, 7, 8, {
      origin: 'peer',
      userText: '',
      inbox: [{ at: at(7), kind: 'message', from: 'builder', agentId: 'mate', summary: 'done', text: 'ok' }],
    }),
    turn(3, 43, 45),
  ]
  const agents = [
    agent('sub', { spawnTurn: 0, startedAt: at(1), endedAt: at(1), prompt: 'look around' }),
    agent('kid', { spawnTurn: 0, parentAgentId: 'sub', kind: 'fork', startedAt: at(1), endedAt: at(1) }),
    agent('mate', {
      kind: 'teammate',
      name: 'builder',
      spawnTurn: 0,
      startedAt: at(1),
      endedAt: at(6),
      prompt: 'build it',
      inbox: [
        { at: at(4), from: 'team-lead', text: 'now the tests' },
        { at: at(9), from: 'team-lead', text: 'thanks' },
      ],
    }),
    agent('squash', { kind: 'compact', spawnTurn: 2, startedAt: at(7) }),
  ]
  const messages = [
    msg(0, { input: 100, output: 1000, cacheWrite5m: 50_000 }, { turn: 0 }),
    msg(1, { output: 400, cacheWrite5m: 8000 }, { agentId: 'sub', turn: 0 }),
    msg(1, { output: 100, cacheWrite5m: 1000 }, { agentId: 'kid', turn: 0 }),
    msg(2, { output: 900, cacheWrite5m: 20_000 }, { agentId: 'mate', turn: 0 }),
    msg(3, { output: 500, cacheRead: 50_100, cacheWrite5m: 2000 }, { turn: 1 }),
    msg(5, { output: 700, cacheRead: 20_000, cacheWrite5m: 3000 }, { agentId: 'mate', turn: 0 }),
    msg(6, { output: 300, cacheRead: 23_000, cacheWrite5m: 500 }, { agentId: 'mate', turn: 0 }),
    msg(7, { output: 600, cacheWrite5m: 100 }, { agentId: 'squash', turn: 2 }),
    msg(8, { output: 200, cacheRead: 52_100, cacheWrite5m: 900 }, { turn: 2 }),
    // 35 minutes later: nothing read, everything written again
    msg(43, { output: 200, cacheWrite5m: 54_000 }, { turn: 3 }),
  ]
  const m = buildSpend(detail(turns, messages, agents))
  const unit = (id: string) => m.units.find((u) => u.id === id)

  test('everything adds up to the messages, in both splits', () => {
    expect(m.total).toBeCloseTo(sum(messages), 10)
    expect(sum(m.byKind)).toBeCloseTo(m.total, 10)
    expect(sum(m.byClass)).toBeCloseTo(m.total, 10)
    expect(m.stepsUSD + m.unitsUSD).toBeCloseTo(m.total, 10)
    for (const c of m.cols) {
      expect(sum(stepParts(c, 'kind'))).toBeCloseTo(c.usd, 10)
      expect(sum(stepParts(c, 'class'))).toBeCloseTo(c.usd, 10)
    }
    for (const u of m.units) {
      expect(sum(unitParts(u, 'kind'))).toBeCloseTo(u.bucket.usd, 10)
      expect(sum(unitParts(u, 'class'))).toBeCloseTo(u.bucket.usd, 10)
    }
  })

  test('a step is the main agent only; a compaction call is on its turn', () => {
    expect(m.cols[0].usd).toBeCloseTo(messages[0].usd, 10)
    expect(m.cols[1].usd).toBeCloseTo(messages[4].usd, 10)
    expect(m.cols[2].step.usd).toBeCloseTo(messages[8].usd, 10)
    expect(m.cols[2].compact.usd).toBeCloseTo(messages[7].usd, 10)
    expect(m.maxStep).toBeCloseTo(m.cols[3].usd, 10)
  })

  test('a sub-agent is one unit with its own sub-agents inside, launched and back in the same turn', () => {
    const u = unit('sub#0')
    expect(u?.bucket.usd).toBeCloseTo(messages[1].usd + messages[2].usd, 10)
    expect(u?.nestedUSD).toBeCloseTo(messages[2].usd, 10)
    expect(u?.nested.map((a) => a.id)).toEqual(['kid'])
    expect([u?.launch, u?.ret, u?.returned, u?.of]).toEqual([0, 0, true, 1])
    expect(u?.asked).toBe('look around')
    expect(m.units.some((x) => x.agent.id === 'kid')).toBe(false)
  })

  test('a teammate is one unit per message it was sent, each ending where its report arrived', () => {
    const first = unit('mate#0')
    const second = unit('mate#1')
    expect(first?.bucket.usd).toBeCloseTo(messages[3].usd, 10)
    expect([first?.launch, first?.ret, first?.ordinal, first?.of]).toEqual([0, 1, 1, 2])
    expect(second?.bucket.usd).toBeCloseTo(messages[5].usd + messages[6].usd, 10)
    expect([second?.launch, second?.ret, second?.ordinal]).toEqual([1, 2, 2])
    expect([second?.asked, second?.from]).toEqual(['now the tests', 'team-lead'])
    // the last message started no work: it is not a unit
    expect(unit('mate#2')).toBeUndefined()
    expect(m.cols[0].launched.map((u) => u.id)).toEqual(['sub#0', 'mate#0'])
    expect(m.cols[1].arrived.map((u) => u.id)).toEqual(['mate#0'])
    expect(m.cols[1].launched.map((u) => u.id)).toEqual(['mate#1'])
    expect(m.maxUnit).toBeCloseTo(messages[3].usd, 10)
  })

  test('rows: one per agent the main session launched, side by side while they overlap', () => {
    expect(m.rows.map((r) => [r.agent.id, r.lane, r.first, r.last])).toEqual([
      ['sub', 0, 0, 0],
      ['mate', 1, 0, 2],
    ])
    expect(m.laneCount).toBe(2)
  })

  test('a cache miss is its own part, with the gap and what a read would have cost', () => {
    expect(m.rereads).toHaveLength(1)
    const r = m.rereads[0]
    expect(r.tokens).toBe(53_000)
    expect(r.expired).toBe(true)
    expect(r.gapMs).toBe(35 * 60_000)
    expect(r.usd).toBeCloseTo(53_000 * 1.25 * IN, 10)
    expect(r.cachedUSD).toBeCloseTo(53_000 * READ, 10)
    const parts = Object.fromEntries(stepParts(m.cols[3], 'kind').map((p) => [p.key, p.usd]))
    expect(parts.reread).toBeCloseTo(r.usd, 10)
    expect(parts.main).toBeCloseTo(m.cols[3].usd - r.usd, 10)
    expect(m.cols[3].step.byClass.reread).toBeCloseTo(r.usd, 10)
    expect(m.cols[3].mainRereadTokens).toBe(53_000)
    expect(m.cols[3].step.tokens.write).toBe(1000)
    expect(m.cols[3].idleMs).toBe(35 * 60_000)
    expect(CLASS_SERIES.map((s) => s.key)).toContain('reread')
  })

  test('a decision is a typed prompt with everything that followed until the next one', () => {
    expect(m.decisions.map((x) => [x.start, x.end, x.units])).toEqual([
      [0, 2, 3],
      [3, 3, 0],
    ])
    const [a, b] = m.decisions
    expect(a.stepsUSD).toBeCloseTo(m.cols[0].usd + m.cols[1].usd + m.cols[2].usd, 10)
    expect(a.unitsUSD).toBeCloseTo(sum(m.units.map((u) => u.bucket)), 10)
    expect(a.usd + b.usd).toBeCloseTo(m.total, 10)
    expect(sum(a.parts)).toBeCloseTo(a.usd, 10)
    expect(b.rereadUSD).toBeCloseTo(m.rereads[0].usd, 10)
    expect(m.cols.map((c) => c.decision)).toEqual([0, 0, 0, 1])
    expect(topDecisions(m, 1).map((x) => x.start)).toEqual([a.usd > b.usd ? 0 : 3])
  })

  test('the items of a decision are its steps and its units, and add up to it', () => {
    const [a, b] = m.decisions
    const items = decisionItems(m, a)
    expect(items.filter((x) => x.kind === 'step').map((x) => x.kind === 'step' && x.col.index)).toHaveLength(3)
    expect(items.filter((x) => x.kind === 'unit')).toHaveLength(3)
    expect(sum(items)).toBeCloseTo(a.usd, 10)
    expect(items.map((x) => x.usd)).toEqual([...items.map((x) => x.usd)].sort((p, q) => q - p))
    expect(decisionItems(m, b).map((x) => x.kind)).toEqual(['step'])
  })

  test('inherited turns are drawn but not counted', () => {
    const own = buildSpend(detail(turns, messages, agents, [0]))
    expect(own.cols[0].inherited).toBe(true)
    expect(stepParts(own.cols[0], 'kind')).toEqual([])
    const first = m.cols[0].usd + sum(m.cols[0].launched.map((u) => u.bucket))
    expect(own.inheritedUSD).toBeCloseTo(first, 10)
    expect(own.total).toBeCloseTo(m.total - first, 10)
  })

  test('without messages: dollars only, one unit per agent', () => {
    const t = [turn(0, 0, 1, { cost: { usd: 2 }, costWithAgents: 5 })]
    const a = [
      agent('x', { spawnTurn: 0, startedAt: at(0), cost: { usd: 2 }, inbox: [{ at: at(1), text: 'more' }] }),
      agent('y', { spawnTurn: 0, parentAgentId: 'x', startedAt: at(0), cost: { usd: 1 } }),
    ]
    const f = buildSpend(detail(t, [], a))
    expect(f.fromMessages).toBe(false)
    expect(f.cols[0].usd).toBe(2)
    expect(f.units.map((u) => [u.id, u.bucket.usd, u.nestedUSD])).toEqual([['x#0', 3, 1]])
    expect(f.total).toBe(5)
    expect(buildSpend(detail([], [])).cols).toEqual([])
  })
})

describe('workflows, compactions and prompts typed while a turn ran', () => {
  // turn 0 launches a workflow run of two agents (one with a helper of its own); its task
  // notification is turn 2. A compaction on a cold cache follows turn 1, a warm one turn 2, and
  // one without an estimate turn 3. A prompt is typed while turn 1 runs.
  const turns = [
    turn(0, 0, 1),
    turn(1, 2, 3, { origin: 'peer', userText: '', queued: [{ at: at(2), origin: 'human', text: 'also this' }] }),
    turn(2, 4, 5, {
      origin: 'task-notification',
      userText: '',
      inbox: [{ at: at(4), kind: 'task', taskId: 'task-1', status: 'completed', summary: 'run done' }],
    }),
    turn(3, 6, 7),
  ]
  const agents = [
    agent('w1', { kind: 'workflow', runId: 'run-1', linkage: 'run', spawnTurn: 0, startedAt: at(1), endedAt: at(3) }),
    agent('w2', { kind: 'workflow', runId: 'run-1', linkage: 'run', spawnTurn: 0, startedAt: at(1), endedAt: at(3) }),
    agent('help', { parentAgentId: 'w2', depth: 2, spawnTurn: 0, startedAt: at(2) }),
  ]
  const messages = [
    msg(0, { output: 100, cacheWrite5m: 1000 }, { turn: 0 }),
    msg(1, { output: 200 }, { agentId: 'w1', turn: 0 }),
    msg(2, { output: 300 }, { agentId: 'w2', turn: 0 }),
    msg(3, { output: 50 }, { agentId: 'help', turn: 0 }),
    msg(2, { output: 100, cacheRead: 1000 }, { turn: 1 }),
    msg(4, { output: 100, cacheRead: 1000 }, { turn: 2 }),
    msg(6, { output: 100, cacheRead: 1000 }, { turn: 3 }),
  ]
  const call = (cache: 'warm' | 'cold', usd: number, warmUSD: number) => ({
    model: 'model-a',
    idleMs: cache === 'cold' ? 3_600_000 : 60_000,
    cache,
    billing: cache === 'cold' ? 'cache-write-5m' : 'cache-read',
    inputTokens: 1000,
    outputTokens: 100,
    usd,
    warmUSD,
  })
  const det = detail(turns, messages, agents)
  det.digest.workflows = [
    { id: 'run-1', name: 'sweep', taskId: 'task-1', turn: 0, status: 'completed', agents: 2, usd: 0, startedAt: at(1) },
  ]
  det.digest.compactions = [
    { at: at(3), turn: 1, call: call('cold', 2, 0.5) },
    { at: at(5), turn: 2, call: call('warm', 0.4, 0.4) },
    { at: at(7), turn: 3 },
  ]
  const m = buildSpend(det)

  test('a workflow run is one piece of work, with its agents and their helpers inside', () => {
    expect(m.units.map((u) => u.agent.kind)).toEqual(['workflow'])
    const u = m.units[0]
    expect(u.agent.name).toBe('workflow sweep')
    expect(u.bucket.usd).toBeCloseTo(messages[1].usd + messages[2].usd + messages[3].usd, 10)
    expect(u.nested.map((a) => a.id).sort()).toEqual(['help', 'w1', 'w2'])
    expect([u.launch, u.ret, u.returned]).toEqual([0, 2, true])
    expect(m.total).toBeCloseTo(sum(messages), 10)
    expect(unitParts(u, 'kind').map((p) => p.key)).toEqual(['subagent', 'reread'])
  })

  test('compactions sit on the turn they followed and on its decision, outside every total', () => {
    expect(m.cols.map((c) => c.compactions.length)).toEqual([0, 1, 1, 1])
    expect(m.compactions).toHaveLength(3)
    expect(m.decisions.map((x) => x.compactions.length)).toEqual([2, 1])
    const t = compactionTally(m.compactions)
    expect([t.calls, t.cold, t.unknown]).toEqual([2, 1, 1])
    expect(t.usd).toBeCloseTo(2.4, 10)
    expect(t.warmUSD).toBeCloseTo(0.9, 10)
    expect(m.total).toBeCloseTo(sum(messages), 10)
  })

  test('a prompt typed while a turn ran is counted on that turn, and starts no decision', () => {
    expect(m.cols.map((c) => c.typedWhileRunning)).toEqual([0, 1, 0, 0])
    expect(m.decisions.map((x) => x.start)).toEqual([0, 3])
  })
})

describe("compactions of an agent's own conversation", () => {
  // a teammate launched in turn 0 is sent more work in turn 2; its conversation is compacted in
  // each piece of work, and its helper's once during the first
  const turns = [turn(0, 0, 1), turn(1, 2, 3), turn(2, 4, 5), turn(3, 6, 7)]
  const cp = (min: number, cache?: 'warm' | 'cold') => ({
    at: at(min),
    turn: -1,
    trigger: 'auto' as const,
    preTokens: 900_000,
    postTokens: 15_000,
    call: cache && {
      model: 'model-a',
      idleMs: 60_000,
      cache,
      billing: 'cache-read',
      inputTokens: 900_000,
      outputTokens: 2000,
      usd: 0.3,
      warmUSD: 0.3,
    },
  })
  const agents = [
    agent('mate', {
      kind: 'teammate',
      name: 'builder',
      spawnTurn: 0,
      startedAt: at(0),
      endedAt: at(7),
      inbox: [{ at: at(4), from: 'team-lead', text: 'next' }],
      compactions: [cp(2, 'warm'), cp(6, 'cold')],
    }),
    agent('helper', { parentAgentId: 'mate', depth: 2, spawnTurn: 0, startedAt: at(1), compactions: [cp(3)] }),
  ]
  const messages = [
    msg(0, { output: 100 }, { turn: 0 }),
    msg(1, { output: 100 }, { agentId: 'mate', turn: 0 }),
    msg(1, { output: 100 }, { agentId: 'helper', turn: 0 }),
    msg(5, { output: 100 }, { agentId: 'mate', turn: 0 }),
    msg(2, { output: 100 }, { turn: 1 }),
    msg(4, { output: 100 }, { turn: 2 }),
    msg(6, { output: 100 }, { turn: 3 }),
  ]
  const m = buildSpend(detail(turns, messages, agents))

  test('each lands on the piece of work that was running, with the turn it fell in', () => {
    expect(m.units.map((u) => u.compactions.map((x) => [x.agent.id, x.turn]))).toEqual([
      [
        ['mate', 1],
        ['helper', 1],
      ],
      [['mate', 3]],
    ])
    expect(m.agentCompactions).toHaveLength(3)
    expect(m.compactions).toHaveLength(0)
    expect(m.decisions.map((x) => x.agentCompactions.length)).toEqual([2, 0, 1, 0])
    expect(m.total).toBeCloseTo(sum(messages), 10)
  })
})

describe('packRows', () => {
  const row = (id: string, first: number, last: number): Row => ({
    agent: agent(id),
    lane: 0,
    first,
    last,
    units: [],
    usd: 0,
  })
  test('agents that do not overlap share a row', () => {
    const rows = [row('a', 0, 3), row('b', 2, 5), row('c', 4, 6), row('d', 6, 7)]
    expect(packRows(rows)).toBe(2)
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 1])
  })
})
