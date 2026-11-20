import { describe, expect, test } from 'bun:test'
import type { Agent, Message, SessionDetail, Turn } from '../../api/types'
import {
  addMessage,
  buildSpend,
  CLASS_SERIES,
  compactionTally,
  fitPrices,
  groupTurns,
  missCause,
  missText,
  newBucket,
  promptLine,
  rereadTokens,
  stepParts,
  turnAt,
  turnList,
  UNIT_JOIN_MS,
  UNIT_SPLIT_MS,
  UNIT_TINY_MS,
  unitParts,
  unitUnrecorded,
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
  // Codex: no cache writes; a miss is the cached context charged as plain input
  const codexPrev = msg(0, { input: 500, cacheRead: 41_500 })
  test('a cache without writes: a warm call reads the previous prompt, pays input for what is new', () => {
    expect(rereadTokens(codexPrev, msg(1, { input: 900, cacheRead: 41_984 }))).toBe(0)
  })
  test('a cache without writes: a miss is the previous prompt charged as input', () => {
    expect(rereadTokens(codexPrev, msg(1, { input: 31_000, cacheRead: 12_032 }))).toBe(29_968)
  })
})

describe('missCause', () => {
  const prev = msg(0, { input: 500, cacheRead: 40_000 })
  test('a model switch, a fast-mode switch, idle time, or no visible cause', () => {
    expect(missCause(prev, msg(1, { input: 40_000 }, { model: 'model-b' }))).toBe('model')
    expect(missCause(prev, msg(1, { input: 40_000 }, { fast: true }))).toBe('fast')
    expect(missCause(prev, msg(5, { input: 40_000 }))).toBe('idle')
    expect(missCause(prev, msg(1, { input: 40_000 }))).toBe('unexplained')
  })
  test('an hour-long cache write keeps the entry for an hour', () => {
    expect(missCause(prev, msg(30, { cacheWrite1h: 40_000 }))).toBe('unexplained')
    expect(missCause(prev, msg(60, { cacheWrite1h: 40_000 }))).toBe('idle')
  })
})

describe('cache misses without cache writes (Codex)', () => {
  // turn 0: two calls, the second warm; turn 1, a minute later: fast mode on, the context
  // charged as input; turn 2: the same agent switches model, then misses with no visible cause
  const messages = [
    msg(0, { input: 30_000, output: 100 }, { turn: 0 }),
    msg(0, { input: 600, cacheRead: 29_952, output: 100 }, { turn: 0 }),
    msg(
      1,
      { input: 30_700, cacheRead: 0, output: 100 },
      { turn: 1, fast: true, usd: 2 * price({ input: 30_700, output: 100 }) },
    ),
    msg(2, { input: 30_900, output: 100 }, { turn: 2, model: 'model-b', fast: true }),
    msg(2, { input: 25_000, cacheRead: 6_000, output: 100 }, { turn: 2, model: 'model-b', fast: true }),
  ]
  const m = buildSpend(detail([turn(0, 0, 0), turn(1, 1, 1), turn(2, 2, 2)], messages))
  test('each miss has its cause', () => {
    expect(m.rereads.map((r) => [r.tokens, r.cause, r.fromModel])).toEqual([
      [30_552, 'fast', undefined],
      [30_700, 'model', 'model-a'],
      [24_900, 'unexplained', undefined],
    ])
    expect(missText(m.rereads[0])).toBe('on turning fast mode on')
    expect(missText(m.rereads[1])).toBe('on a switch from model-a')
    expect(missText(m.rereads[2])).toMatch(/^only .* after the last call, with no visible cause$/)
  })
  test("a miss is taken out of the uncached input, at the call's own price (fast doubles it)", () => {
    const c = m.cols[1].step
    expect(c.tokens.reread).toBe(30_552)
    expect(c.tokens.input).toBe(30_700 - 30_552)
    expect(c.tokens.write).toBe(0)
    expect(c.byClass.reread).toBeCloseTo(2 * 30_552 * IN, 10)
    expect(c.byClass.input).toBeCloseTo(2 * (30_700 - 30_552) * IN, 10)
    expect(m.rereads[0].cachedUSD).toBeCloseTo(2 * 30_552 * READ, 10)
    expect(c.usd).toBeCloseTo(messages[2].usd, 10)
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
    // an agent that finished more than once: the same summary each time, a report of its own
    const done = (text: string) =>
      promptLine({
        userText: '',
        inbox: [{ at: at(0), kind: 'task', status: 'completed', summary: 'Agent "build" finished', text }],
      })
    expect(done('## Report\n\nall green')).toBe('task completed: Agent "build" finished · Report')
    expect(done('A stale notice; nothing to do.')).toBe(
      'task completed: Agent "build" finished · A stale notice; nothing to do.',
    )
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
  })

  test('rows: one per agent the main session launched, with its pieces of work', () => {
    expect(m.rows.map((r) => [r.agent.id, r.units.map((u) => u.id)])).toEqual([
      ['sub', ['sub#0']],
      ['mate', ['mate#0', 'mate#1']],
    ])
  })

  test('a cache miss is its own part, with the gap and what a read would have cost', () => {
    expect(m.rereads).toHaveLength(1)
    const r = m.rereads[0]
    expect(r.tokens).toBe(53_000)
    expect(r.cause).toBe('idle')
    expect(missText(r)).toBe('after 35 min idle')
    expect(r.gapMs).toBe(35 * 60_000)
    expect(r.usd).toBeCloseTo(53_000 * 1.25 * IN, 10)
    expect(r.cachedUSD).toBeCloseTo(53_000 * READ, 10)
    const parts = Object.fromEntries(stepParts(m.cols[3], 'kind').map((p) => [p.key, p.usd]))
    expect(parts.reread).toBeCloseTo(r.usd, 10)
    expect(parts.main).toBeCloseTo(m.cols[3].usd - r.usd, 10)
    expect(m.cols[3].step.byClass.reread).toBeCloseTo(r.usd, 10)
    expect(m.cols[3].step.tokens.write).toBe(1000)
    expect(m.cols[3].idleMs).toBe(35 * 60_000)
    expect(CLASS_SERIES.map((s) => s.key)).toContain('reread')
  })

  test('a decision is the turns grouped by time, with everything that followed in them', () => {
    // the 35-minute pause before turn 3 joins it to the others
    expect(m.decisions.map((x) => [x.start, x.end])).toEqual([[0, 3]])
    // four hours later it is a decision of its own
    const far = buildSpend(
      detail(
        [...turns.slice(0, 3), turn(3, 283, 285)],
        [...messages.slice(0, -1), msg(283, { output: 200, cacheWrite5m: 54_000 }, { turn: 3 })],
        agents,
      ),
    )
    expect(far.decisions.map((x) => [x.start, x.end, x.units])).toEqual([
      [0, 2, 3],
      [3, 3, 0],
    ])
    const [a, b] = far.decisions
    expect(a.stepsUSD).toBeCloseTo(far.cols[0].usd + far.cols[1].usd + far.cols[2].usd, 10)
    expect(a.unitsUSD).toBeCloseTo(sum(far.units.map((u) => u.bucket)), 10)
    expect(a.usd + b.usd).toBeCloseTo(far.total, 10)
    expect(sum(a.parts)).toBeCloseTo(a.usd, 10)
    expect(b.rereadUSD).toBeCloseTo(far.rereads[0].usd, 10)
    expect(far.cols.map((c) => c.decision)).toEqual([0, 0, 0, 1])
  })

  describe('calls count for the turn they fall in, by time', () => {
    const turns3 = [turn(0, 0, 10), turn(1, 80, 90), turn(2, 150, 160)]
    const bg = agent('bg', { spawnTurn: 0, startedAt: at(1), endedAt: at(130) })
    const main = [
      msg(0, { output: 100 }, { turn: 0 }),
      msg(4, { output: 100 }, { turn: 0 }),
      msg(8, { output: 100 }, { turn: 0 }),
      msg(81, { output: 100 }, { turn: 1 }),
      msg(85, { output: 100 }, { turn: 1 }),
      msg(89, { output: 100 }, { turn: 1 }),
      msg(151, { output: 100 }, { turn: 2 }),
      msg(155, { output: 100 }, { turn: 2 }),
      msg(159, { output: 100 }, { turn: 2 }),
    ]
    const agentCalls = (upto: number) =>
      Array.from({ length: Math.floor(upto / 2) }, (_, k) => msg(1 + 2 * k, { output: 10 }, { agentId: 'bg', turn: 0 }))

    test('an agent that works through the gaps keeps them one decision', () => {
      const r = buildSpend(detail(turns3, [...main, ...agentCalls(160)], [bg]))
      expect(r.decisions.map((x) => [x.start, x.end])).toEqual([[0, 2]])
    })

    test('an agent that stopped early does not stretch its launch turn over the later ones', () => {
      const r = buildSpend(detail(turns3, [...main, ...agentCalls(10)], [bg]))
      expect(r.decisions.map((x) => [x.start, x.end])).toEqual([
        [0, 0],
        [1, 1],
        [2, 2],
      ])
    })
  })

  test('turns minutes apart are one decision with several typed prompts; an overnight gap makes two', () => {
    const day = [turn(0, 0, 3), turn(1, 10, 12), turn(2, 20, 22)]
    const calls = [msg(1, { output: 100 }, { turn: 0 }), msg(11, { output: 100 }, { turn: 1 })]
    const one = buildSpend(detail(day, calls))
    expect(one.decisions.map((x) => [x.start, x.end])).toEqual([[0, 2]])
    expect(one.cols.filter((c) => c.human)).toHaveLength(3)
    expect(one.decisions[0].prompt).toBe(one.cols[0].prompt)
    const night = buildSpend(
      detail([...day, turn(3, 600, 602), turn(4, 610, 612)], [...calls, msg(601, { output: 100 }, { turn: 3 })]),
    )
    expect(night.decisions.map((x) => [x.start, x.end])).toEqual([
      [0, 2],
      [3, 4],
    ])
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
    turn(3, 246, 247),
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
    msg(246, { output: 100, cacheRead: 1000 }, { turn: 3 }),
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
    { at: at(247), turn: 3 },
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
    expect([t.calls, t.cold, t.unknown, t.recorded]).toEqual([2, 1, 1, 0])
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
  // each turn is five hours after the one before, so each is a decision of its own
  const f = (min: number) => min + 298 * Math.floor(min / 2)
  const turns = [turn(0, f(0), f(1)), turn(1, f(2), f(3)), turn(2, f(4), f(5)), turn(3, f(6), f(7))]
  const cp = (min: number, cache?: 'warm' | 'cold') => ({
    at: at(f(min)),
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
      startedAt: at(f(0)),
      endedAt: at(f(7)),
      inbox: [{ at: at(f(4)), from: 'team-lead', text: 'next' }],
      compactions: [cp(2, 'warm'), cp(6, 'cold')],
    }),
    agent('helper', { parentAgentId: 'mate', depth: 2, spawnTurn: 0, startedAt: at(f(1)), compactions: [cp(3)] }),
  ]
  const messages = [
    msg(f(0), { output: 100 }, { turn: 0 }),
    msg(f(1), { output: 100 }, { agentId: 'mate', turn: 0 }),
    msg(f(1), { output: 100 }, { agentId: 'helper', turn: 0 }),
    msg(f(5), { output: 100 }, { agentId: 'mate', turn: 0 }),
    msg(f(2), { output: 100 }, { turn: 1 }),
    msg(f(4), { output: 100 }, { turn: 2 }),
    msg(f(6), { output: 100 }, { turn: 3 }),
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

describe('agent turns', () => {
  // A Codex-style agent: launched in turn 0, sent a follow-up from turn 2 (it records that
  // exactly); its turns say which main turn they belong to, its messages which turn they are in.
  const turns = [turn(0, 0, 5), turn(1, 10, 12), turn(2, 20, 30)]
  const messages = [
    msg(1, { input: 1000 }),
    msg(2, { input: 2000, output: 10 }, { agentId: 'cx', agentTurn: 0 }),
    msg(21, { input: 4000, output: 20 }, { agentId: 'cx', agentTurn: 1 }),
    msg(22, { input: 8000 }, { agentId: 'cx', agentTurn: 1 }),
  ]
  const cx = agent('cx', {
    spawnTurn: 0,
    addressable: true,
    startedAt: at(2),
    endedAt: at(23),
    turns: [
      {
        index: 0,
        origin: 'spawn',
        prompt: 'part one',
        startedAt: at(2),
        endedAt: at(3),
        rootTurn: 0,
        assistantMessages: 1,
        toolCalls: 0,
        cost: { usd: 0 },
      },
      {
        index: 1,
        origin: 'peer',
        startedAt: at(21),
        endedAt: at(23),
        rootTurn: 2,
        inbox: [{ at: at(20), kind: 'assignment', text: 'part two' }],
        assistantMessages: 2,
        toolCalls: 0,
        cost: { usd: 0 },
      },
    ],
  })
  const m = buildSpend(detail(turns, messages, [cx]))
  const unit = (id: string) => m.units.find((u) => u.id === id)

  test('one unit per agent turn, launched in its root turn, billed by agentTurn', () => {
    expect(m.units.map((u) => [u.id, u.launch])).toEqual([
      ['cx#0', 0],
      ['cx#1', 2],
    ])
    expect(unit('cx#0')?.bucket.usd).toBeCloseTo(messages[1].usd, 10)
    expect(unit('cx#1')?.bucket.usd).toBeCloseTo(messages[2].usd + messages[3].usd, 10)
    expect([unit('cx#0')?.asked, unit('cx#1')?.asked]).toEqual(['part one', 'part two'])
  })

  test('an addressable agent is drawn in its own series', () => {
    const u = unit('cx#1')
    expect(u && unitParts(u, 'kind')[0].key).toBe('addressable')
  })
})

describe('an agent that reported more than once', () => {
  // a background agent launched in turn 0 finishes three times (woken again after it reported): each
  // report starts a turn of the main agent
  const done = (index: number, min: number) =>
    turn(index, min, min + 1, {
      origin: 'task-notification',
      userText: '',
      inbox: [{ at: at(min), kind: 'task', agentId: 'bg', status: 'completed', summary: 'Agent "bg" finished' }],
    })
  const m = buildSpend(
    detail(
      [turn(0, 0, 1), done(1, 5), done(2, 8), turn(3, 9, 10), done(4, 12)],
      [msg(0, { output: 10 }), msg(2, { output: 10 }, { agentId: 'bg' }), msg(11, { output: 10 }, { agentId: 'bg' })],
      [agent('bg', { background: true, spawnTurn: 0, startedAt: at(1), endedAt: at(12) })],
    ),
  )
  const u = m.units[0]

  test('every turn a report of it came in is known, and arrived there', () => {
    expect([u.launch, u.ret, u.reports]).toEqual([0, 4, [1, 2, 4]])
    expect(m.cols.map((c) => c.arrived.map((x) => x.id))).toEqual([[], ['bg#0'], ['bg#0'], [], ['bg#0']])
  })

  test('in words', () => {
    expect(turnList([5, 6, 7])).toBe('turns 5 to 7')
    expect(turnList([3])).toBe('turn 3')
  })
})

test('a bucket counts its truncated and unpriced messages and carries the estimates', () => {
  const b = newBucket()
  const fit = { input: IN, read: READ }
  const msg = (id: string, extra: Partial<Message>): Message => ({
    id,
    at: '2026-09-16T10:00:00Z',
    model: 'm',
    usd: 0,
    ...extra,
  })
  addMessage(b, msg('a', { usd: 1, input: 10, truncated: true, estimatedUSD: 0.5 }), fit, undefined)
  addMessage(b, msg('b', { input: 10, unpriced: true }), fit, undefined)
  addMessage(b, msg('c', { usd: 2, input: 10 }), fit, undefined)
  expect([b.messages, b.truncated, b.unpriced, b.estimated, b.usd]).toEqual([3, 1, 1, 0.5, 3.5])
  // the estimate is missing output
  expect(b.byClass.output).toBeGreaterThanOrEqual(0.5)
})

test('an unrecorded run nested under a recorded agent makes its decision "at least", though no piece of work is itself unrecorded', () => {
  const m = buildSpend(
    detail(
      [turn(0, 0, 5)],
      [msg(0, { turn: 0 }), msg(1, { agentId: 'p' })],
      [
        agent('p', { spawnTurn: 0, startedAt: at(1), endedAt: at(4) }),
        agent('n', {
          parentAgentId: 'p',
          depth: 2,
          spawnTurn: 0,
          startedAt: at(2),
          endedAt: at(3),
          unrecorded: true,
          cost: { usd: 0, unrecordedAgents: 1 },
        }),
      ],
    ),
  )
  const [dec] = m.decisions
  expect(dec.unrecorded).toBe(0)
  expect(dec.unrecordedRuns).toBe(1)
  expect(m.cols[0].launched.map(unitUnrecorded)).toEqual([1])
})

describe('groupTurns', () => {
  const MIN = 60_000
  // a turn from minute `a` to `b`, with `active` minutes of work
  const span = (a: number, b: number, active = 10, inherited = false) => ({
    a: a * MIN,
    b: b * MIN,
    active: active * MIN,
    inherited,
  })

  test('nothing, and one turn', () => {
    expect(groupTurns([])).toEqual([])
    expect(groupTurns([span(0, 1, 0)])).toEqual([0])
  })

  test('a gap of 3 hours or more separates even two tiny turns', () => {
    expect(UNIT_SPLIT_MS).toBe(3 * 3_600_000)
    expect(groupTurns([span(0, 1, 0), span(181, 182, 0)])).toEqual([0, 1])
    expect(groupTurns([span(0, 1, 0), span(180, 181, 0)])).toEqual([0, 0])
  })

  test('60 minutes joins; 61 minutes with enough work on both sides stays apart', () => {
    expect(UNIT_JOIN_MS).toBe(60 * MIN)
    expect(groupTurns([span(0, 10), span(70, 80)])).toEqual([0, 0])
    expect(groupTurns([span(0, 10), span(71, 80)])).toEqual([0, 1])
  })

  test('a tiny decision joins its nearer neighbour, the earlier one on a tie', () => {
    expect(UNIT_TINY_MS).toBe(5 * MIN)
    // the middle one is 100 minutes from the first and 90 from the last
    expect(groupTurns([span(0, 10), span(110, 111, 1), span(200, 210)])).toEqual([0, 1, 1])
    // 100 and 100
    expect(groupTurns([span(0, 10), span(110, 111, 1), span(211, 221)])).toEqual([0, 0, 1])
  })

  test('absorption repeats, the smallest first, and stops at the segment edge', () => {
    // 1 and 2 minutes of work: the smaller (second) goes to the nearer neighbour, then the bigger
    // one is still under 5 minutes in total and goes on
    expect(groupTurns([span(0, 10), span(100, 101, 2), span(160, 161, 1), span(300, 310)])).toEqual([0, 0, 0, 1])
    // a tiny one alone in its segment stays
    expect(groupTurns([span(0, 10), span(400, 401, 0)])).toEqual([0, 1])
  })

  test('inherited and own turns never share a decision', () => {
    expect(groupTurns([span(0, 1, 0, true), span(2, 3, 0, false)])).toEqual([0, 1])
    expect(groupTurns([span(0, 10, 10, true), span(11, 12, 10, true), span(13, 20, 10, false)])).toEqual([0, 0, 1])
  })
})
