import { describe, expect, test } from 'bun:test'
import type { OverviewLane, OverviewSpan } from '../../api/types'
import {
  activeMs,
  activeSlots,
  activityRuns,
  ancestorIds,
  axisTicks,
  type Beads,
  bandAt,
  bandLabel,
  bandTimes,
  beadLabel,
  beadPath,
  beadPrefix,
  blockWidth,
  brushRange,
  buildPlaceTree,
  CTX_MAX,
  chooseSlot,
  clipToActivity,
  comparePath,
  comparePlace,
  customAction,
  customDays,
  customLabel,
  customPhrase,
  customWindow,
  dailySpend,
  dayIndexAt,
  displayPath,
  drawBrush,
  firstSpendDay,
  fitLabels,
  fitTail,
  folderText,
  formatCustom,
  formatSort,
  heldContext,
  idLess,
  inferHome,
  keepSelection,
  type Layout,
  laneDescription,
  laneHead,
  laneMatches,
  laneScale,
  lifeSpan,
  MERGE_GAP,
  MIN_SPINE,
  makeAxis,
  markedNode,
  midnights,
  monthRange,
  moveBrush,
  NONE_SEL,
  nextSort,
  nodeForPath,
  type PlaceItem,
  type PlaceNode,
  parseBy,
  parseCustom,
  parseDay,
  parseIn,
  parseSort,
  parseStoredCustom,
  placeItems,
  placeOf,
  presetRange,
  rangeBrush,
  resizeBrush,
  type Sort,
  type SortKey,
  searchLanes,
  selectLanes,
  sessionStretchUrl,
  slotX,
  sortLanes,
  spineLanes,
  stepAreaPath,
  stripOf,
  stripTicks,
  sumLanes,
  tokenScale,
  totalsOf,
  underPath,
  visibleRows,
  xOf,
} from './model'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

function lane(p: Partial<OverviewLane> & { id: string }): OverviewLane {
  return {
    harness: 'claude',
    usd: 0,
    turns: 0,
    agents: 0,
    slot0: 0,
    context: [],
    idle: [],
    active: [],
    spans: [],
    ...p,
  }
}

const T0 = new Date(2026, 10, 4, 0, 0).getTime()

describe('chooseSlot', () => {
  test('the smallest slot that gives at most one slot per pixel', () => {
    expect(chooseSlot(7 * DAY, 1200)).toBe('10m') // 504 s per pixel
    expect(chooseSlot(DAY, 1200)).toBe('2m') // 72 s per pixel
    expect(chooseSlot(30 * DAY, 1200)).toBe('1h') // 2160 s per pixel
    expect(chooseSlot(DAY, 100)).toBe('15m')
  })

  test('never finer than the API allows, never coarser than a day', () => {
    expect(chooseSlot(HOUR, 5000)).toBe('1m')
    expect(chooseSlot(365 * DAY, 100)).toBe('1d')
  })
})

describe('axis', () => {
  const axis = makeAxis(T0, T0 + 7 * DAY, 10 * MIN, 1008)

  test('time maps linearly to x', () => {
    expect(axis.slots).toBe(1008)
    expect(axis.slotW).toBe(1)
    expect(xOf(axis, T0)).toBe(0)
    expect(xOf(axis, T0 + 3.5 * DAY)).toBe(504)
    expect(xOf(axis, T0 + 7 * DAY)).toBe(1008)
    expect(slotX(axis, 144)).toBe(144)
  })

  test('midnights and day ticks sit one day apart, however empty the days', () => {
    const ms = midnights(T0, T0 + 7 * DAY)
    expect(ms).toHaveLength(7)
    const ticks = axisTicks(axis)
    expect(ticks.every((t) => t.day)).toBe(true)
    expect(ticks[1].x - ticks[0].x).toBeCloseTo(144, 5)
    expect(ticks[0].label).toBe('Wed 4')
  })

  test('a day has hour ticks, labelled at a step that keeps them apart', () => {
    const day = makeAxis(T0, T0 + DAY, 2 * MIN, 1200)
    const ticks = axisTicks(day)
    expect(ticks).toHaveLength(24)
    expect(ticks[1].x - ticks[0].x).toBeCloseTo(50, 5)
    expect(ticks.filter((t) => t.labelled).length).toBeLessThan(24)
    expect(ticks[0]).toMatchObject({ day: true, labelled: true })
  })
})

describe('heldContext', () => {
  const from = T0
  const slotMs = 10 * MIN
  const run = (calls: { at: number; ctx: number }[], slots: number) => heldContext(calls, from, slotMs, slots)

  test('a call is held to the next call within five minutes', () => {
    const { context, idle } = run(
      [
        { at: from + 2 * MIN, ctx: 100 },
        { at: from + 6 * MIN, ctx: 120 },
        { at: from + 14 * MIN, ctx: 90 },
      ],
      4,
    )
    // 100 over 2-6 min, 120 from 6 up to the 14 min call (8 min later: idle), 90 at 14 and nothing after
    expect(context).toEqual([120, 90, 0, 0])
    expect(idle).toEqual([0, 0, 0, 0])
  })

  test('a pause of 5 to 60 minutes holds the context as idle, never in a slot with context', () => {
    const { context, idle } = run(
      [
        { at: from + 1 * MIN, ctx: 50 },
        { at: from + 31 * MIN, ctx: 60 },
      ],
      5,
    )
    expect(context).toEqual([50, 0, 0, 60, 0])
    expect(idle).toEqual([0, 50, 50, 0, 0])
  })

  test('a pause over an hour holds nothing, and neither does the time after the last call', () => {
    const { context, idle } = heldContext(
      [
        { at: from + 1 * MIN, ctx: 50 },
        { at: from + 90 * MIN, ctx: 60 },
      ],
      from,
      slotMs,
      12,
    )
    expect(context.filter((v) => v > 0)).toHaveLength(2)
    expect(idle.every((v) => v === 0)).toBe(true)
  })

  test('held context carries over slot boundaries', () => {
    const { context } = run(
      [
        { at: from + 8 * MIN, ctx: 70 },
        { at: from + 12 * MIN, ctx: 40 },
        { at: from + 26 * MIN, ctx: 10 },
      ],
      4,
    )
    // 70 held 8-12 min: slots 0 and 1; 40 ends at its call, 10 at 26
    expect(context).toEqual([70, 70, 10, 0])
  })

  test('a hold ending exactly on a slot start does not enter it', () => {
    const { context } = run(
      [
        { at: from + 4 * MIN, ctx: 5 },
        { at: from + 10 * MIN, ctx: 7 },
        { at: from + 40 * MIN, ctx: 1 },
      ],
      5,
    )
    expect(context).toEqual([5, 7, 0, 0, 1])
  })
})

describe('lane arrays are trimmed', () => {
  test("the paths and runs start at the lane's first slot", () => {
    const axis = makeAxis(T0, T0 + 8 * HOUR, HOUR, 80)
    expect(stepAreaPath([5, 5], axis, 50, 2, 3)).toBe('M30,50V40H50V50Z')
    expect(activityRuns([1, 1, 0, 2], 4)).toEqual([
      { from: 4, to: 6, weight: 1 },
      { from: 7, to: 8, weight: 2 },
    ])
  })
})

describe('token scales', () => {
  test('the largest value of the arrays reaches the full height', () => {
    const s = tokenScale([
      [100, 400],
      [0, 800, 3],
    ])
    expect(s.maxTok).toBe(800)
    expect(s.pxPerTok).toBeCloseTo(CTX_MAX / 800, 9)
  })

  test('the session rows have their own, idle included', () => {
    const s = laneScale([lane({ id: 'a', context: [10, 90] }), lane({ id: 'b', context: [5], idle: [300] })])
    expect(s.maxTok).toBe(300)
    expect(s.pxPerTok).toBeCloseTo(CTX_MAX / 300, 9)
  })

  test('nothing carried, no scale', () => {
    expect(tokenScale([[0, 0], []])).toEqual({ maxTok: 0, pxPerTok: 0 })
    expect(laneScale([])).toEqual({ maxTok: 0, pxPerTok: 0 })
  })
})

describe('the summary', () => {
  test("the lanes' trimmed context and idle summed into dense arrays", () => {
    const a = lane({ id: 'a', slot0: 1, context: [10, 0, 30], idle: [0, 5, 0] })
    const b = lane({ id: 'b', slot0: 2, context: [1, 2], idle: [4, 0] })
    expect(sumLanes([a, b], 5)).toEqual({ context: [0, 10, 1, 32, 0], idle: [0, 0, 9, 0, 0] })
  })

  test('nothing in scope: zeros; a lane past the end is cut', () => {
    expect(sumLanes([], 3)).toEqual({ context: [0, 0, 0], idle: [0, 0, 0] })
    expect(sumLanes([lane({ id: 'a', slot0: 2, context: [7, 8], idle: [0, 0] })], 3).context).toEqual([0, 0, 7])
  })

  test('the totals: sessions, turns, agents and spend', () => {
    const t = totalsOf([lane({ id: 'a', turns: 3, agents: 1, usd: 2.5 }), lane({ id: 'b', turns: 4, usd: 1 })])
    expect(t).toEqual({ sessions: 2, turns: 7, agents: 1, usd: 3.5 })
    expect(totalsOf([])).toEqual({ sessions: 0, turns: 0, agents: 0, usd: 0 })
  })
})

describe('lifeSpan', () => {
  const axis = makeAxis(T0, T0 + 10 * HOUR, HOUR, 100)
  const iso = (h: number) => new Date(T0 + h * HOUR).toISOString()
  test('from start to last activity, clipped to the range', () => {
    expect(lifeSpan(iso(2), iso(5), axis)).toEqual([20, 50])
    expect(lifeSpan(iso(-3), iso(4), axis)).toEqual([0, 40])
    expect(lifeSpan(iso(8), iso(30), axis)).toEqual([80, 100])
  })
  test('nothing when wholly outside or without times', () => {
    expect(lifeSpan(iso(-5), iso(-1), axis)).toBeNull()
    expect(lifeSpan(iso(11), iso(12), axis)).toBeNull()
    expect(lifeSpan(undefined, undefined, axis)).toBeNull()
  })
})

describe('sorting', () => {
  const desc = (key: SortKey): Sort => ({ key, desc: true })
  const asc = (key: SortKey): Sort => ({ key, desc: false })

  test('running time: the slots with a call running, times the slot', () => {
    expect(activeSlots([0, 1, 0, 3, 2])).toBe(3)
    expect(activeMs([0, 1, 0, 3, 2], 600_000)).toBe(1_800_000)
    expect(activeMs([], 600_000)).toBe(0)
  })

  const l1 = lane({
    id: '1',
    usd: 5,
    turns: 2,
    agents: 0,
    startedAt: '2026-11-02T00:00:00Z',
    lastActivityAt: '2026-11-01T00:00:00Z',
  })
  const l2 = lane({
    id: '2',
    usd: 9,
    turns: 7,
    agents: 3,
    startedAt: '2026-11-03T00:00:00Z',
    lastActivityAt: '2026-11-02T00:00:00Z',
  })
  const l3 = lane({
    id: '3',
    usd: 9,
    turns: 7,
    agents: 1,
    startedAt: '2026-11-01T00:00:00Z',
    lastActivityAt: '2026-11-03T00:00:00Z',
  })
  const ids = (ls: OverviewLane[]) => ls.map((l) => l.id)

  test('sessions by each column and direction; ties by spend, then id', () => {
    expect(ids(sortLanes([l1, l3, l2], desc('spend')))).toEqual(['2', '3', '1'])
    expect(ids(sortLanes([l1, l3, l2], asc('spend')))).toEqual(['1', '2', '3'])
    expect(ids(sortLanes([l1, l2, l3], desc('turns')))).toEqual(['2', '3', '1'])
    expect(ids(sortLanes([l1, l2, l3], asc('turns')))).toEqual(['1', '2', '3'])
    expect(ids(sortLanes([l1, l2, l3], desc('agents')))).toEqual(['2', '3', '1'])
    expect(ids(sortLanes([l1, l2, l3], asc('agents')))).toEqual(['1', '3', '2'])
    expect(ids(sortLanes([l1, l2, l3], desc('start')))).toEqual(['2', '1', '3'])
    expect(ids(sortLanes([l1, l2, l3], asc('start')))).toEqual(['3', '1', '2'])
    expect(ids(sortLanes([l1, l2, l3], desc('last')))).toEqual(['3', '2', '1'])
    expect(ids(sortLanes([l1, l2, l3], asc('last')))).toEqual(['1', '2', '3'])
    const w = (id: string, active: number[]) => lane({ id, usd: 1, active })
    const [w1, w2, w3] = [w('1', [1, 0, 1]), w('2', [2, 2, 3]), w('3', [])]
    expect(ids(sortLanes([w3, w1, w2], desc('active')))).toEqual(['2', '1', '3'])
    expect(ids(sortLanes([w1, w2, w3], asc('active')))).toEqual(['3', '1', '2'])
  })

  test('does not change its input', () => {
    const input = [l1, l2]
    sortLanes(input, desc('spend'))
    expect(ids(input)).toEqual(['1', '2'])
  })
})

describe('row text', () => {
  test('the head: name, else title, else the first 8 characters of the id', () => {
    expect(laneHead({ id: 'abcdef123456', name: 'mine', title: 't' })).toBe('mine')
    expect(laneHead({ id: 'abcdef123456', title: 't' })).toBe('t')
    expect(laneHead({ id: 'abcdef123456' })).toBe('abcdef12')
    expect(laneHead({ id: 'abcdef123456', name: '', title: '' })).toBe('abcdef12')
  })

  test('the description: recap, else first prompt, else last prompt', () => {
    const p = (text: string) => ({ turn: 1, at: '2026-11-01T00:00:00Z', text, truncated: false })
    const recap = { at: '2026-11-01T00:00:00Z', text: 'recap', truncated: false }
    expect(laneDescription(lane({ id: 'a', recap, firstPrompt: p('first'), lastPrompt: p('last') }))).toBe('recap')
    expect(laneDescription(lane({ id: 'a', firstPrompt: p('first'), lastPrompt: p('last') }))).toBe('first')
    expect(laneDescription(lane({ id: 'a', lastPrompt: p('last') }))).toBe('last')
    expect(laneDescription(lane({ id: 'a' }))).toBe('')
  })

  test('the folder line: the directory as shown, (none) without one', () => {
    expect(folderText('/Users/a/work/merlin', '/Users/a')).toBe('~/work/merlin')
    expect(folderText('/srv/x/y', '/Users/a')).toBe('/srv/x/y')
    expect(folderText(undefined, '/Users/a')).toBe('(none)')
  })
})

describe('URL state', () => {
  test('by: the folder unless it names another key', () => {
    expect(parseBy('repo')).toBe('repo')
    expect(parseBy('project')).toBe('dir')
    expect(parseBy('none')).toBe('dir')
    expect(parseBy(null)).toBe('dir')
  })

  test('in: empty is no selection', () => {
    expect(parseIn(null)).toBeNull()
    expect(parseIn('')).toBeNull()
    expect(parseIn('/Users/a/work')).toBe('/Users/a/work')
    expect(parseIn('-')).toBe(NONE_SEL)
  })

  test('sort and dir', () => {
    // the default is the last activity, newest first
    expect(parseSort(null, null)).toEqual({ key: 'last', desc: true })
    expect(parseSort('spend', null)).toEqual({ key: 'spend', desc: true })
    expect(parseSort('turns', null)).toEqual({ key: 'turns', desc: true })
    expect(parseSort('last', 'asc')).toEqual({ key: 'last', desc: false })
    expect(parseSort('bogus', 'asc')).toEqual({ key: 'last', desc: false })
    // the timeline sorts start newest / most recent / longest first; an old link's `session` is `start`
    expect(parseSort('active', null)).toEqual({ key: 'active', desc: true })
    expect(parseSort('start', 'asc')).toEqual({ key: 'start', desc: false })
    expect(parseSort('session', null)).toEqual({ key: 'start', desc: true })
    expect(parseSort('session', 'asc')).toEqual({ key: 'start', desc: false })
    expect(formatSort({ key: 'start', desc: true })).toEqual({ sort: 'start', dir: undefined })
    expect(formatSort({ key: 'last', desc: true })).toEqual({ sort: undefined, dir: undefined })
    expect(formatSort({ key: 'last', desc: false })).toEqual({ sort: undefined, dir: 'asc' })
    expect(formatSort({ key: 'spend', desc: true })).toEqual({ sort: 'spend', dir: undefined })
    expect(formatSort({ key: 'agents', desc: false })).toEqual({ sort: 'agents', dir: 'asc' })
    const s: Sort = { key: 'start', desc: false }
    const f = formatSort(s)
    expect(parseSort(f.sort ?? null, f.dir ?? null)).toEqual(s)
  })

  test('the key sorts ascending by default; only the other direction is written', () => {
    expect(parseSort('key', null)).toEqual({ key: 'key', desc: false })
    expect(parseSort('key', 'desc')).toEqual({ key: 'key', desc: true })
    expect(formatSort({ key: 'key', desc: false })).toEqual({ sort: 'key', dir: undefined })
    expect(formatSort({ key: 'key', desc: true })).toEqual({ sort: 'key', dir: 'desc' })
    for (const desc of [true, false]) {
      const f = formatSort({ key: 'key', desc })
      expect(parseSort(f.sort ?? null, f.dir ?? null)).toEqual({ key: 'key', desc })
    }
  })

  test('a header click flips the active column, another starts in its own direction', () => {
    expect(nextSort({ key: 'spend', desc: true }, 'spend')).toEqual({ key: 'spend', desc: false })
    expect(nextSort({ key: 'spend', desc: false }, 'spend')).toEqual({ key: 'spend', desc: true })
    expect(nextSort({ key: 'spend', desc: false }, 'turns')).toEqual({ key: 'turns', desc: true })
    expect(nextSort({ key: 'spend', desc: true }, 'key')).toEqual({ key: 'key', desc: false })
    expect(nextSort({ key: 'key', desc: false }, 'key')).toEqual({ key: 'key', desc: true })
  })
})

describe('the key column', () => {
  const path = (p: string) => p.split('/')

  test('comparePlace: segment by segment, case-insensitive, a path before the paths under it', () => {
    const sorted = ['~/work/yimple', '~/work/merlin/web', '~/Work', '~/work/merlin', '~/work/Alpha', '~/play'].map(path)
    sorted.sort(comparePlace)
    expect(sorted.map((x) => x.join('/'))).toEqual([
      '~/play',
      '~/Work',
      '~/work/Alpha',
      '~/work/merlin',
      '~/work/merlin/web',
      '~/work/yimple',
    ])
    expect(comparePlace(path('~/work/merlin'), path('~/work/merlin'))).toBe(0)
    // not a string compare: `merlin-x` is a sibling of `merlin`, and `merlin/web` sorts under `merlin`
    expect(comparePlace(path('~/m/web'), path('~/m-x'))).toBeLessThan(0)
  })

  test('the tree orders its siblings with the same rule', () => {
    const item = (key: string): PlaceItem => ({ key, count: 1, usd: 1 })
    const t = buildPlaceTree(
      [item('/Users/a/work/yimple'), item('/Users/a/work'), item('/Users/a/work/merlin')],
      'dir',
      '/Users/a',
    )
    expect(t.nodes[0].label).toBe('~/work')
    expect(t.nodes[0].children.map((n) => n.label)).toEqual(['merlin', 'yimple'])
  })

  test('sessions cluster by their folder in the tree order; no folder last, ties by spend', () => {
    const ls = [
      lane({ id: 'a', dir: '/Users/a/work/yimple', usd: 2 }),
      lane({ id: 'b', dir: '/Users/a/work/merlin/web', usd: 1 }),
      lane({ id: 'c', dir: '/Users/a/work/merlin', usd: 3 }),
      lane({ id: 'd', dir: '/Users/a/work/merlin', usd: 7 }),
      lane({ id: 'e', dir: '/Users/a/work', usd: 1 }),
      lane({ id: 'f', usd: 50 }),
    ]
    const order = (desc: boolean) => sortLanes(ls, { key: 'key', desc }, '/Users/a').map((l) => l.id)
    expect(order(false)).toEqual(['e', 'd', 'c', 'b', 'a', 'f'])
    // descending reverses the folders, no folder stays last
    expect(order(true)).toEqual(['a', 'b', 'd', 'c', 'e', 'f'])
  })

  test('fitTail keeps the end, cuts at a slash, and falls back to the last segment', () => {
    const w = (n: number) => (s: string) => s.length <= n
    expect(fitTail('~/work/merlin', w(20))).toBe('~/work/merlin')
    expect(fitTail('~/work/merlin/web/src', w(17))).toBe('…/merlin/web/src')
    expect(fitTail('~/work/merlin/web', w(10))).toBe('…/web')
    expect(fitTail('~/a/very-long-final-segment', w(10))).toBe('…l-segment')
    expect(fitTail('~/work/merlin', w(0))).toBe('…')
  })
})

describe('activityRuns', () => {
  test('weights 1, 2 and 3 or more, merged while equal', () => {
    expect(activityRuns([1, 1, 2, 5, 0, 1])).toEqual([
      { from: 0, to: 2, weight: 1 },
      { from: 2, to: 3, weight: 2 },
      { from: 3, to: 4, weight: 3 },
      { from: 5, to: 6, weight: 1 },
    ])
  })
})

describe('stepAreaPath', () => {
  const axis = makeAxis(T0, T0 + 8 * HOUR, HOUR, 80)

  test('one shape per run above zero, steps merged', () => {
    const area = stepAreaPath([0, 5, 5, 3, 0, 0, 2, 0], axis, 50, 2)
    expect(area.match(/M/g)).toHaveLength(2)
    expect(area).toContain('M10,50V40H30V44H40V50Z')
  })

  test('nothing above zero gives nothing', () => {
    expect(stepAreaPath([0, 0, 0], axis, 50, 2)).toBe('')
  })

  test('idle and context are separate shapes of the same grammar', () => {
    expect(stepAreaPath([0, 0, 3, 3], axis, 20, 1)).toBe('M20,20V17H40V20Z')
  })
})

describe('spineLanes', () => {
  // 1 px = 10 minutes
  const axis = makeAxis(T0, T0 + 7 * DAY, 10 * MIN, 1008)
  const span = (startMin: number, lenMin: number, kind: OverviewSpan['kind'] = 'subagent'): OverviewSpan => ({
    kind,
    start: new Date(T0 + DAY + startMin * MIN).toISOString(),
    end: new Date(T0 + DAY + (startMin + lenMin) * MIN).toISOString(),
    session: { harness: 'claude', id: 's' },
  })

  test('a burst is one run with a vertical per spawn', () => {
    // 10 spawns a minute apart, each living 5 minutes: they land on the same pixel and merge
    const spans = Array.from({ length: 10 }, (_, i) => span(i, 5))
    const [k] = spineLanes(spans, axis)
    expect(k.kind).toBe('subagent')
    expect(k.runs).toHaveLength(1)
    expect(k.runs[0].n).toBe(10)
    expect(k.runs[0].x1 - k.runs[0].x0).toBeGreaterThanOrEqual(MIN_SPINE)
  })

  test('verticals: the first spawn of a run is its elbow, the others are ticks (one per half pixel)', () => {
    // spawns at +0, +40 min (4 px), +80 min (8 px): each 10 px long, so they merge into one run
    const [k] = spineLanes([span(0, 5), span(40, 5), span(80, 5), span(81, 5)], axis)
    expect(k.runs).toHaveLength(1)
    expect(k.ticks).toHaveLength(2)
    expect(k.ticks[0] - k.runs[0].x0).toBeCloseTo(4, 5)
  })

  test('a gap under the merge distance joins runs, a wider one separates them', () => {
    // a life of 100 min is 10 px: [144, 154]; the next starts MERGE_GAP px after, or a little more
    const close = spineLanes([span(0, 100), span((10 + MERGE_GAP) * 10, 100)], axis)[0]
    expect(close.runs).toHaveLength(1)
    const far = spineLanes([span(0, 100), span((10 + MERGE_GAP + 1) * 10, 100)], axis)[0]
    expect(far.runs).toHaveLength(2)
    expect(far.ticks).toHaveLength(0)
  })

  test('each kind has its own runs, in draw order', () => {
    const ks = spineLanes([span(0, 5, 'workflow'), span(0, 5, 'fork'), span(0, 5), span(0, 5, 'continuation')], axis)
    expect(ks.map((k) => k.kind)).toEqual(['subagent', 'fork', 'workflow', 'continuation'])
  })

  test('a branched session has a vertical at its start and no run', () => {
    const [k] = spineLanes([span(0, 1440, 'session-fork'), span(2000, 5, 'session-fork')], axis)
    expect(k.runs).toEqual([])
    expect(k.ticks).toHaveLength(2)
  })

  test('a real long life is its real length; a short one keeps the minimum', () => {
    const [k] = spineLanes([span(0, 1440), span(2000, 1)], axis)
    expect(k.runs[0].x1 - k.runs[0].x0).toBeCloseTo(144, 5)
    expect(k.runs[1].x1 - k.runs[1].x0).toBeCloseTo(MIN_SPINE, 5)
  })

  test('a spawn from before the range starts at the left edge and has no vertical', () => {
    const early: OverviewSpan = {
      ...span(0, 0),
      start: new Date(T0 - DAY).toISOString(),
      end: new Date(T0 + 2 * HOUR).toISOString(),
    }
    const [k] = spineLanes([early], axis)
    expect(k.runs[0]).toMatchObject({ x0: 0, clipped: true })
    expect(k.ticks).toHaveLength(0)
  })

  test('no spans, no lane', () => {
    expect(spineLanes(undefined, axis)).toEqual([])
  })
})

describe('fitLabels', () => {
  const tick = (x: number, label: string) => ({ x, label, day: false, labelled: true })
  test('drops a label that would touch the previous or pass the right edge', () => {
    const out = fitLabels([tick(0, '19:00'), tick(20, '20:00'), tick(80, '21:00'), tick(190, '22:00')], 200)
    expect(out.map((t) => t.labelled)).toEqual([true, false, true, false])
  })
})

describe('search', () => {
  const l1 = lane({ id: 'aaaa1111', title: 'Fix the retry loop', recap: { text: 'Working on BACKOFF' } as never })
  const l2 = lane({ id: 'bbbb2222', name: 'migration' })
  const l3 = lane({ id: 'cccc3333', harness: 'codex', firstPrompt: { text: 'Make the header sticky' } as never })
  const all = [l1, l2, l3]

  test('matches head and description, case-insensitively', () => {
    expect(laneMatches(l1, 'retry')).toBe(true)
    expect(laneMatches(l1, 'backoff')).toBe(true)
    expect(laneMatches(l3, 'sticky')).toBe(true)
    expect(laneMatches(l2, 'bbbb')).toBe(true)
    expect(laneMatches(l2, 'migr')).toBe(true)
    expect(laneMatches(l2, 'sticky')).toBe(false)
  })

  test('server hits count for terms of two characters or more', () => {
    const hits = new Set(['claude/bbbb2222'])
    expect(laneMatches(l2, 'zz', hits)).toBe(true)
    expect(laneMatches(l2, 'z', hits)).toBe(false)
    expect(laneMatches(l1, 'zz', hits)).toBe(false)
  })

  test('the matching sessions; an empty term keeps them all', () => {
    expect(searchLanes(all, '  ')).toBe(all)
    expect(searchLanes(all, ' Sticky ').map((l) => l.id)).toEqual(['cccc3333'])
    expect(searchLanes(all, 'nope')).toEqual([])
  })
})

describe('hover geometry', () => {
  const L: Layout = { pad: 12, turns: 64, agents: 70, spend: 84, gap: 8 }
  const BLOCK = 1 + 24 + 64 + 70 + 84 + 16

  test('the block is the rule, the padding and three columns with their gaps', () => {
    expect(blockWidth(L)).toBe(BLOCK)
  })

  test('the day under x, clipped to the plot; the hour in a short range', () => {
    const axis = makeAxis(T0 + 6 * HOUR, T0 + 6 * HOUR + 7 * DAY, 10 * MIN, 1008)
    const b = bandAt(axis, 100)
    expect(b).not.toBeNull()
    // the first day starts before the axis: clipped at 0, ends at midnight
    expect(b?.x0).toBe(0)
    expect(b?.x1).toBeCloseTo(xOf(axis, T0 + DAY), 5)
    const c = bandAt(axis, 500)
    expect((c?.x1 ?? 0) - (c?.x0 ?? 0)).toBeCloseTo(144, 5)
    expect(bandAt(axis, -1)).toBeNull()
    expect(bandAt(axis, 1009)).toBeNull()
    const day = makeAxis(T0, T0 + DAY, MIN, 960)
    const h = bandAt(day, 100)
    expect((h?.x1 ?? 0) - (h?.x0 ?? 0)).toBeCloseTo(40, 5)
  })
})

describe('the place tree', () => {
  const item = (key: string, count = 1, usd = 1): PlaceItem => ({ key, count, usd })
  const shape = (ns: PlaceNode[]): unknown[] =>
    ns.map((n) => (n.children.length ? [n.label, shape(n.children)] : n.label))

  test('infers the home from the paths that share one', () => {
    expect(inferHome(['/Users/ann/a', '/Users/ann/b/c', '/tmp/x'])).toBe('/Users/ann')
    expect(inferHome(['/home/bob', '/home/bob/x'])).toBe('/home/bob')
    expect(inferHome(['/srv/a', '/tmp/b'])).toBeUndefined()
    expect(inferHome([])).toBeUndefined()
  })

  test('dirs: the home is ~, a lone chain is compacted, children are ordered by name', () => {
    const t = buildPlaceTree(
      [
        item('/Users/ann/work/merlin'),
        item('/Users/ann/work/merlin/web'),
        item('/Users/ann/old/Merlin'),
        item('/Users/ann/src/github.com/acme/api'),
        item('/tmp/scratch'),
      ],
      'dir',
      '/Users/ann',
    )
    expect(shape(t.nodes)).toEqual([
      '/tmp/scratch',
      ['~', ['old/Merlin', 'src/github.com/acme/api', ['work/merlin', ['web']]]],
    ])
  })

  test('a group that has children is both: its figures are the subtree sums', () => {
    const t = buildPlaceTree(
      [item('/Users/a/x', 2, 10), item('/Users/a/x/web', 3, 5), item('/Users/a/y', 1, 1)],
      'dir',
      '/Users/a',
    )
    const [home] = t.nodes
    expect(home.label).toBe('~')
    const x = home.children.find((n) => n.label === 'x')
    expect(x?.place?.key).toBe('/Users/a/x')
    expect(x?.count).toBe(5)
    expect(x?.usd).toBe(15)
    expect(home.count).toBe(6)
    expect(home.usd).toBe(16)
  })

  test('a repository sits at its working directory, a bare container too', () => {
    const t = buildPlaceTree(
      [item('/Users/a/w/merlin/.bare'), item('/Users/a/o/merlin/.git'), item('/Users/a/merlin/.git')],
      'repo',
      '/Users/a',
    )
    expect(shape(t.nodes)).toEqual([['~', ['merlin', 'o/merlin', 'w/merlin']]])
    expect(t.nodes[0].children[0].place?.key).toBe('/Users/a/merlin/.git')
  })

  test('remotes split into host, owner and name; local paths stay paths', () => {
    const t = buildPlaceTree(
      [item('github.com/acme/api'), item('github.com/acme/web'), item('git.example.test/x/y'), item('/srv/git/app')],
      'remote',
      undefined,
    )
    expect(shape(t.nodes)).toEqual(['/srv/git/app', 'git.example.test/x/y', ['github.com/acme', ['api', 'web']]])
    expect(t.nodes.map((n) => !!n.host)).toEqual([false, true, true])
  })

  test('the empty place is apart, not in the tree', () => {
    const t = buildPlaceTree([item('', 4, 2), item('/tmp/a')], 'dir', undefined)
    expect(t.none?.count).toBe(4)
    expect(shape(t.nodes)).toEqual(['/tmp/a'])
    expect(t.nodes[0].count).toBe(1)
  })

  test('paths with no shared home stay absolute', () => {
    expect(shape(buildPlaceTree([item('/srv/a/x'), item('/srv/a/y')], 'dir', undefined).nodes)).toEqual([
      ['/srv/a', ['x', 'y']],
    ])
  })

  test('visible rows follow the open state; a hidden place is marked by its closed folder', () => {
    const t = buildPlaceTree([item('/Users/a/x'), item('/Users/a/x/web'), item('/Users/a/y')], 'dir', '/Users/a')
    const all = visibleRows(t.nodes, new Set())
    expect(all.map((r) => [r.node.label, r.depth])).toEqual([
      ['~', 0],
      ['x', 1],
      ['web', 2],
      ['y', 1],
    ])
    const x = t.nodes[0].children[0]
    const closed = new Set([x.id])
    expect(visibleRows(t.nodes, closed).map((r) => r.node.label)).toEqual(['~', 'x', 'y'])
    expect(markedNode(t.nodes, '/Users/a/x/web', new Set())).toBe(x.children[0].id)
    expect(markedNode(t.nodes, '/Users/a/x/web', closed)).toBe(x.id)
    expect(markedNode(t.nodes, '/Users/a/x', closed)).toBe(x.id)
    expect(markedNode(t.nodes, '/nope', closed)).toBeNull()
  })
})

describe('the selection', () => {
  const item = (key: string, count = 1, usd = 1): PlaceItem => ({ key, count, usd })

  test('a place is under a path when its segments start with the path, not its characters', () => {
    expect(underPath('/Users/a/work/merlin', '/Users/a/work', 'dir')).toBe(true)
    expect(underPath('/Users/a/work', '/Users/a/work', 'dir')).toBe(true)
    expect(underPath('/Users/a/workshop', '/Users/a/work', 'dir')).toBe(false)
    expect(underPath('/Users/a', '/Users/a/work', 'dir')).toBe(false)
    expect(underPath('/Users/a/work/merlin', null, 'dir')).toBe(true)
    expect(underPath('', null, 'dir')).toBe(true)
  })

  test('(none) selects the empty place alone', () => {
    expect(underPath('', NONE_SEL, 'dir')).toBe(true)
    expect(underPath('/Users/a', NONE_SEL, 'dir')).toBe(false)
    expect(underPath('', '/Users/a', 'dir')).toBe(false)
  })

  test('a repository stands at its directory: .git and .bare do not count', () => {
    expect(underPath('/Users/a/work/merlin/.bare', '/Users/a/work', 'repo')).toBe(true)
    expect(underPath('/Users/a/work/merlin/.bare', '/Users/a/work/merlin', 'repo')).toBe(true)
    expect(underPath('/Users/a/work/merlin/.bare', '/Users/a/work/merlin/.bare', 'repo')).toBe(false)
    expect(underPath('/Users/a/merlin/.git', '/Users/a/merlin', 'repo')).toBe(true)
  })

  test('a remote is under its host and owner', () => {
    expect(underPath('github.com/acme/api', 'github.com/acme', 'remote')).toBe(true)
    expect(underPath('github.com/acme/api', 'github.com', 'remote')).toBe(true)
    expect(underPath('github.com/acme/api', 'github.com/acm', 'remote')).toBe(false)
    expect(underPath('gitlab.com/acme/api', 'github.com/acme', 'remote')).toBe(false)
  })

  // the merlin sessions ran in two worktrees of one repository; 4 in no repository
  const lanes = [
    lane({
      id: '1',
      dir: '/Users/a/work/merlin/main',
      checkout: '/Users/a/work/merlin/main',
      repo: '/Users/a/work/merlin/.bare',
      remote: 'github.com/a/merlin',
      usd: 5,
    }),
    lane({
      id: '2',
      dir: '/Users/a/work/merlin/wt/web',
      checkout: '/Users/a/work/merlin/wt',
      repo: '/Users/a/work/merlin/.bare',
      remote: 'github.com/a/merlin',
      usd: 2,
    }),
    lane({
      id: '3',
      dir: '/Users/a/work/yimple',
      checkout: '/Users/a/work/yimple',
      repo: '/Users/a/work/yimple/.git',
      usd: 3,
    }),
    lane({ id: '4', dir: '/Users/a/play', usd: 1 }),
  ]
  const ids = (ls: OverviewLane[]) => ls.map((l) => l.id)

  test("a session's place is its value of the key", () => {
    expect(placeOf(lanes[1], 'dir')).toBe('/Users/a/work/merlin/wt/web')
    expect(placeOf(lanes[1], 'checkout')).toBe('/Users/a/work/merlin/wt')
    expect(placeOf(lanes[1], 'repo')).toBe('/Users/a/work/merlin/.bare')
    expect(placeOf(lanes[2], 'remote')).toBe('')
  })

  test('the places of the sessions, with counts and spend; the empty one too', () => {
    expect(placeItems(lanes, 'repo')).toEqual([
      { key: '/Users/a/work/merlin/.bare', count: 2, usd: 7 },
      { key: '/Users/a/work/yimple/.git', count: 1, usd: 3 },
      { key: '', count: 1, usd: 1 },
    ])
    expect(placeItems(lanes, 'remote').map((i) => [i.key, i.count])).toEqual([
      ['github.com/a/merlin', 2],
      ['', 2],
    ])
  })

  test('the scope is the sessions whose place sits at or under the selection, under the key', () => {
    expect(selectLanes(lanes, null, 'dir')).toBe(lanes)
    expect(ids(selectLanes(lanes, '/Users/a/work', 'dir'))).toEqual(['1', '2', '3'])
    expect(ids(selectLanes(lanes, '/Users/a/work/merlin', 'repo'))).toEqual(['1', '2'])
    expect(ids(selectLanes(lanes, '/Users/a/work/merlin/wt', 'checkout'))).toEqual(['2'])
    expect(ids(selectLanes(lanes, '-', 'remote'))).toEqual(['3', '4'])
    expect(selectLanes(lanes, '/nope', 'dir')).toEqual([])
  })

  test('a selection is kept on a new key only where a session sits under it', () => {
    expect(keepSelection('/Users/a/work', lanes, 'repo')).toBe('/Users/a/work')
    expect(keepSelection('/Users/a/play', lanes, 'repo')).toBeNull()
    expect(keepSelection('github.com/a', lanes, 'remote')).toBe('github.com/a')
    expect(keepSelection('github.com/a', lanes, 'dir')).toBeNull()
    expect(keepSelection('-', lanes, 'repo')).toBe('-')
    expect(keepSelection(null, lanes, 'repo')).toBeNull()
  })

  test('the tree nodes carry the real path; the home is spelled out', () => {
    const t = buildPlaceTree(
      [item('/Users/a/work/merlin'), item('/Users/a/work/yimple'), item('/Users/a/play')],
      'dir',
      '/Users/a',
    )
    const [home] = t.nodes
    expect(home.path).toBe('/Users/a')
    expect(home.children.map((n) => n.path)).toEqual(['/Users/a/play', '/Users/a/work'])
    expect(home.children[1].children.map((n) => n.path)).toEqual(['/Users/a/work/merlin', '/Users/a/work/yimple'])
    // a compacted chain is its deepest path
    const c = buildPlaceTree([item('/Users/a/src/github.com/acme/api'), item('/Users/a/x')], 'dir', '/Users/a')
    expect(c.nodes[0].children.map((n) => [n.label, n.path])).toEqual([
      ['src/github.com/acme/api', '/Users/a/src/github.com/acme/api'],
      ['x', '/Users/a/x'],
    ])
    const r = buildPlaceTree([item('github.com/acme/api'), item('github.com/acme/web')], 'remote', undefined)
    expect(r.nodes[0].path).toBe('github.com/acme')
    expect(r.nodes[0].children.map((n) => n.path)).toEqual(['github.com/acme/api', 'github.com/acme/web'])
    const b = buildPlaceTree([item('/Users/a/w/merlin/.bare'), item('/Users/a/x/.git')], 'repo', '/Users/a')
    expect(b.nodes[0].children.map((n) => n.path)).toEqual(['/Users/a/w/merlin', '/Users/a/x'])
  })

  test('the node of a path and the folders to open above it', () => {
    const t = buildPlaceTree(
      [item('/Users/a/x/web'), item('/Users/a/x/api'), item('/Users/a/y/z/deep'), item('/Users/a/y/z/also')],
      'dir',
      '/Users/a',
    )
    const web = nodeForPath(t.nodes, '/Users/a/x/web')
    expect(web?.label).toBe('web')
    expect(nodeForPath(t.nodes, '/Users/a/x')?.label).toBe('x')
    expect(nodeForPath(t.nodes, '/nope')).toBeNull()
    // a folder inside a compacted chain is the chain's node
    const chain = buildPlaceTree(
      [item('/Users/a/work/m/web'), item('/Users/a/work/m'), item('/Users/a/x')],
      'dir',
      '/Users/a',
    )
    expect(nodeForPath(chain.nodes, '/Users/a/work')).toBe(nodeForPath(chain.nodes, '/Users/a/work/m'))
    expect(nodeForPath(chain.nodes, '/Users/a/work')?.label).toBe('work/m')
    const ids = ancestorIds(t.nodes, '/Users/a/x/web')
    expect(ids).toEqual(['~', '~/x'])
    expect(visibleRows(t.nodes, new Set(ids.slice(1))).map((r) => r.node.label)).toContain('x')
    expect(ancestorIds(t.nodes, '/Users/a')).toEqual([])
    expect(ancestorIds(t.nodes, '/nope')).toEqual([])
  })

  test('a path as shown', () => {
    expect(displayPath('/Users/a/work', '/Users/a')).toBe('~/work')
    expect(displayPath('/Users/a', '/Users/a')).toBe('~')
    expect(displayPath('/Users/ab/work', '/Users/a')).toBe('/Users/ab/work')
    expect(displayPath('github.com/acme', undefined)).toBe('github.com/acme')
    expect(displayPath('-', '/Users/a')).toBe('(none)')
  })
})

describe('the custom range', () => {
  const now = new Date(2026, 10, 13, 15, 30)
  const local = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime()

  test('parse and format', () => {
    expect(parseDay('2026-05-20')).toBe('2026-05-20')
    expect(parseDay('2026-02-30')).toBeNull()
    expect(parseDay('5/20')).toBeNull()
    expect(parseDay(null)).toBeNull()
    expect(parseCustom('2026-05-20', '2026-05-29')).toEqual({ from: '2026-05-20', to: '2026-05-29' })
    expect(parseCustom('2026-05-20', '2026-05-20')).toEqual({ from: '2026-05-20', to: '2026-05-20' })
    // both days, in order
    expect(parseCustom('2026-05-29', '2026-05-20')).toBeNull()
    expect(parseCustom('2026-05-20', null)).toBeNull()
    expect(parseCustom('x', '2026-05-20')).toBeNull()
    expect(formatCustom({ from: '2026-05-20', to: '2026-05-29' })).toEqual({ from: '2026-05-20', to: '2026-05-29' })
    expect(formatCustom(null)).toEqual({ from: undefined, to: undefined })
  })

  test('the label and the empty phrase', () => {
    expect(customDays({ from: '2026-05-20', to: '2026-05-29' })).toBe(10)
    expect(customLabel({ from: '2026-05-20', to: '2026-05-29' }, now)).toBe('May 20 → 10d')
    expect(customLabel({ from: '2026-05-20', to: '2026-05-20' }, now)).toBe('May 20 → 1d')
    // the year when it is not this one; days count across a month and a year
    expect(customLabel({ from: '2025-12-30', to: '2026-01-02' }, now)).toBe('Dec 30, 2025 → 4d')
    expect(customPhrase({ from: '2026-05-20', to: '2026-05-29' }, now)).toBe('between May 20 and May 29')
    expect(customPhrase({ from: '2026-05-20', to: '2026-05-20' }, now)).toBe('on May 20')
  })

  test('the query window: local midnights, capped at now', () => {
    const nowMs = now.getTime()
    expect(customWindow({ from: '2026-05-20', to: '2026-05-29' }, nowMs)).toEqual({
      fromMs: local(2026, 5, 20),
      toMs: local(2026, 5, 30),
    })
    // today is cut at now
    expect(customWindow({ from: '2026-11-10', to: '2026-11-13' }, nowMs)).toEqual({
      fromMs: local(2026, 11, 10),
      toMs: nowMs,
    })
    // a day that has not begun still has a window
    const w = customWindow({ from: '2026-11-20', to: '2026-11-20' }, nowMs)
    expect(w.toMs).toBeGreaterThan(w.fromMs)
  })

  test('the presets as ranges', () => {
    expect(presetRange('1d', now)).toEqual({ from: '2026-11-13', to: '2026-11-13' })
    expect(presetRange('7d', now)).toEqual({ from: '2026-11-07', to: '2026-11-13' })
    expect(presetRange('30d', now)).toEqual({ from: '2026-10-15', to: '2026-11-13' })
  })
})

describe('the locator', () => {
  const now = new Date(2026, 10, 13, 15, 30)
  const strip = stripOf('2026-10-01', now, null)

  test('the strip spans the first day with spend to today, grown to hold the range', () => {
    expect(strip.first).toBe(new Date(2026, 9, 1).getTime())
    expect(strip.days).toBe(44)
    expect(stripOf(undefined, now, null).days).toBe(1)
    expect(stripOf('2026-10-01', now, { from: '2026-09-28', to: '2026-10-02' }).days).toBe(47)
    expect(stripOf('2026-10-01', now, { from: '2026-11-10', to: '2026-11-20' }).days).toBe(51)
  })

  test('a brush is whole days of the strip', () => {
    expect(rangeBrush(strip, { from: '2026-10-05', to: '2026-10-09' })).toEqual({ lo: 4, hi: 8 })
    expect(brushRange(strip, { lo: 4, hi: 8 })).toEqual({ from: '2026-10-05', to: '2026-10-09' })
    // outside the strip it is clipped
    expect(rangeBrush(strip, { from: '2026-01-01', to: '2027-01-01' })).toEqual({ lo: 0, hi: 43 })
    // across a DST change a day is still a day
    const long = stripOf('2026-03-20', new Date(2026, 3, 5), null)
    expect(brushRange(long, { lo: 0, hi: 16 })).toEqual({ from: '2026-03-20', to: '2026-04-05' })
  })

  test('the day under x', () => {
    expect(dayIndexAt(strip, 440, 0)).toBe(0)
    expect(dayIndexAt(strip, 440, 19.9)).toBe(1)
    expect(dayIndexAt(strip, 440, 439.9)).toBe(43)
    expect(dayIndexAt(strip, 440, -5)).toBe(0)
    expect(dayIndexAt(strip, 440, 900)).toBe(43)
  })

  test('drawing, moving and resizing snap to days, one at least', () => {
    expect(drawBrush(9, 3)).toEqual({ lo: 3, hi: 9 })
    expect(drawBrush(5, 5)).toEqual({ lo: 5, hi: 5 })
    expect(moveBrush({ lo: 10, hi: 14 }, 12, 15, 44)).toEqual({ lo: 13, hi: 17 })
    // kept inside the strip, its length kept
    expect(moveBrush({ lo: 10, hi: 14 }, 12, 50, 44)).toEqual({ lo: 39, hi: 43 })
    expect(moveBrush({ lo: 10, hi: 14 }, 12, -30, 44)).toEqual({ lo: 0, hi: 4 })
    expect(resizeBrush({ lo: 10, hi: 14 }, 'lo', 6)).toEqual({ lo: 6, hi: 14 })
    expect(resizeBrush({ lo: 10, hi: 14 }, 'hi', 20)).toEqual({ lo: 10, hi: 20 })
    // the edges do not cross
    expect(resizeBrush({ lo: 10, hi: 14 }, 'lo', 30)).toEqual({ lo: 14, hi: 14 })
    expect(resizeBrush({ lo: 10, hi: 14 }, 'hi', 2)).toEqual({ lo: 10, hi: 10 })
  })

  test('daily spend on the strip', () => {
    const rows = [
      { key: '2026-10-01', totalUSD: 2 },
      { key: '2026-10-03', totalUSD: 1.5 },
      { key: '2026-09-01', totalUSD: 9 },
      { key: 'junk', totalUSD: 9 },
    ]
    const d = dailySpend(rows, strip)
    expect(d).toHaveLength(44)
    expect(d[0]).toBe(2)
    expect(d[2]).toBe(1.5)
    expect(d.reduce((a, b) => a + b, 0)).toBe(3.5)
    expect(
      firstSpendDay([
        { key: '2026-10-03', totalUSD: 1 },
        { key: '2026-10-01', totalUSD: 0 },
        { key: '2026-10-02', totalUSD: 2 },
      ]),
    ).toBe('2026-10-02')
    expect(firstSpendDay([])).toBeUndefined()
  })

  test('the axis labels the months and keeps its labels apart', () => {
    const t = stripTicks(strip, 440)
    expect(t.map((x) => x.label)).toEqual(['Oct', 'Nov'])
    expect(t[0].x).toBe(0)
    expect(t[1].x).toBeCloseTo(31 * (440 / 44), 5)
    // a wide strip also numbers its days
    const wide = stripTicks(strip, 1000)
    expect(wide.some((x) => x.label === '5')).toBe(true)
    for (let i = 1; i < wide.length; i++) expect(wide[i].x).toBeGreaterThan(wide[i - 1].x)
    // January carries the year
    expect(stripTicks(stripOf('2026-12-20', new Date(2027, 0, 10), null), 500).map((x) => x.label)).toContain(
      'Jan 2027',
    )
  })
})

describe('a click on a row graph', () => {
  const t0 = new Date(2026, 10, 7).getTime()
  const axis = makeAxis(t0, t0 + 7 * DAY, HOUR, 700)
  const at = (day: number, hour = 12) => (day * DAY + hour * HOUR) * axis.pxPerMs
  const l = lane({
    id: 'abc 1',
    harness: 'claude',
    // active in the slots of day 2, 10:00 to 12:00 (slot0 counts from the axis start)
    slot0: 2 * 24 + 10,
    active: [1, 1, 0, 0],
    context: [5, 6, 6, 0],
  })

  test('the stretch is the local day, or the hour in a range of two days or less', () => {
    expect(bandTimes(axis, at(2))).toEqual({
      fromMs: new Date(2026, 10, 9).getTime(),
      toMs: new Date(2026, 10, 10).getTime(),
    })
    expect(bandTimes(axis, -1)).toBeNull()
    const hourly = makeAxis(t0, t0 + DAY, MIN, 960)
    expect(bandTimes(hourly, 13.5 * 40)).toEqual({ fromMs: t0 + 13 * HOUR, toMs: t0 + 14 * HOUR })
    expect(bandLabel(axis, at(2))).toBe('Mon, Nov 9')
    expect(bandLabel(hourly, 13.5 * 40)).toBe('Nov 7, 13:00')
  })

  test("the window is cut to the session's activity in the stretch", () => {
    const [a, b] = clipToActivity(l, axis, new Date(2026, 10, 9).getTime(), new Date(2026, 10, 10).getTime())
    expect(a).toBe(new Date(2026, 10, 9, 10).getTime())
    expect(b).toBe(new Date(2026, 10, 9, 13).getTime())
    // a day where it did nothing: the day itself
    const day = [new Date(2026, 10, 11).getTime(), new Date(2026, 10, 12).getTime()] as const
    expect(clipToActivity(l, axis, ...day)).toEqual([...day])
  })

  test('the URL', () => {
    const url = sessionStretchUrl(l, axis, at(2))
    const [path, query] = url.split('?')
    expect(path).toBe('/s/claude/abc%201')
    const q = new URLSearchParams(query)
    expect(q.get('from')).toBe(new Date(2026, 10, 9, 10).toISOString())
    expect(q.get('to')).toBe(new Date(2026, 10, 9, 13).toISOString())
    // a day it did nothing on still opens that day
    const idle = new URLSearchParams(sessionStretchUrl(l, axis, at(5)).split('?')[1])
    expect(idle.get('from')).toBe(new Date(2026, 10, 12).toISOString())
    expect(idle.get('to')).toBe(new Date(2026, 10, 13).toISOString())
    // outside the plot: the session whole
    expect(sessionStretchUrl(l, axis, -5)).toBe('/s/claude/abc%201')
  })
})

describe('remembering the custom range', () => {
  const r = { from: '2026-05-20', to: '2026-05-29' }
  test('what is stored', () => {
    expect(parseStoredCustom(JSON.stringify(r))).toEqual(r)
    expect(parseStoredCustom(null)).toBeNull()
    expect(parseStoredCustom('not json')).toBeNull()
    expect(parseStoredCustom('{"from":"2026-05-29","to":"2026-05-20"}')).toBeNull()
    expect(parseStoredCustom('{"from":1,"to":2}')).toBeNull()
    expect(parseStoredCustom('[]')).toBeNull()
  })
  test('what a click on Custom does', () => {
    // a preset is active and a range is remembered: apply it, no locator
    expect(customAction(false, r)).toBe('apply')
    // already active: the locator toggles
    expect(customAction(true, r)).toBe('toggle')
    // nothing remembered: the locator opens
    expect(customAction(false, null)).toBe('toggle')
    expect(customAction(true, null)).toBe('toggle')
  })
})

describe('the bead key', () => {
  const beads: Beads = {
    'merlin-lce': { title: 'Overview page', status: 'open', type: 'epic' },
    'merlin-lce.2': { title: 'Locator', parent: 'merlin-lce', status: 'closed' },
    'merlin-lce.10': { title: 'Beads', parent: 'merlin-lce', status: 'open' },
    'merlin-lce.10.1': { title: 'Tree', parent: 'merlin-lce.10', status: 'open' },
    'merlin-q1.1': { title: 'Child of an unknown parent', parent: 'merlin-q1', status: 'open' },
    'merlin-q1': { parent: undefined, status: 'open' },
    'a-b': { parent: 'a-c' },
    'a-c': { parent: 'a-b' },
  }

  test('prefix and ids in order', () => {
    expect(beadPrefix('merlin-t8s.48.1')).toBe('merlin')
    expect(beadPrefix('my-app-k2')).toBe('my-app')
    expect(beadPrefix('nodash')).toBe('')
    expect(idLess('merlin-lce.2', 'merlin-lce.10')).toBe(true)
    expect(idLess('merlin-lce.10', 'merlin-lce.2')).toBe(false)
    expect(idLess('merlin-lce', 'merlin-lce.1')).toBe(true)
    expect(comparePath(idLess)(['m', 'x.2'], ['m', 'x.10'])).toBeLessThan(0)
    expect(comparePath(idLess)(['m'], ['m', 'x'])).toBeLessThan(0)
  })

  test('the path: prefix, family root, ancestors, the bead', () => {
    expect(beadPath('merlin-lce.10.1', beads)).toEqual(['merlin', 'merlin-lce', 'merlin-lce.10', 'merlin-lce.10.1'])
    expect(beadPath('merlin-lce', beads)).toEqual(['merlin', 'merlin-lce'])
    // where a parent is unknown the chain stops there
    expect(beadPath('x-y.1', { 'x-y.1': { parent: 'x-y' } })).toEqual(['x', 'x-y.1'])
    // a loop does not run away
    expect(beadPath('a-b', beads).length).toBeLessThanOrEqual(3)
    expect(beadPath('merlin-zz', undefined)).toEqual(['merlin', 'merlin-zz'])
  })

  test('labels: the title with the id apart, the id alone without a title, closed beads muted', () => {
    expect(beadLabel('merlin-lce', beads)).toEqual({
      text: 'Overview page',
      id: 'merlin-lce',
      title: 'Overview page',
      closed: false,
    })
    expect(beadLabel('merlin-lce.2', beads).closed).toBe(true)
    expect(beadLabel('merlin-q1', beads)).toEqual({ text: 'merlin-q1', id: undefined, title: undefined, closed: false })
    // a prefix heading is no bead
    expect(beadLabel('merlin', beads)).toEqual({ text: 'merlin', closed: false })
  })

  const l = (id: string, bead?: string, usd = 1) => lane({ id, bead, usd })
  const lanes = [
    l('s1', 'merlin-lce.10.1'),
    l('s2', 'merlin-lce.2'),
    l('s3', 'merlin-lce'),
    l('s4'),
    l('s5', 'merlin-lce.10'),
  ]

  test('placeOf is the bead path; the tree puts a bead with children on one node', () => {
    expect(placeOf(lanes[0], 'bead', beads)).toBe('merlin/merlin-lce/merlin-lce.10/merlin-lce.10.1')
    expect(placeOf(lanes[3], 'bead', beads)).toBe('')
    const tree = buildPlaceTree(placeItems(lanes, 'bead', beads), 'bead', undefined)
    // the prefix is a heading of its own, though it has one child
    expect(tree.nodes.map((n) => n.label)).toEqual(['merlin'])
    const [root] = tree.nodes[0].children
    expect(root.label).toBe('merlin-lce')
    expect(root.place?.count).toBe(1) // s3 sits on the root itself
    // id order: .2 before .10
    expect(root.children.map((n) => n.label)).toEqual(['merlin-lce.2', 'merlin-lce.10'])
    // a bead that is a session's bead and a parent: one node, its sessions and its children's
    const b10 = root.children[1]
    expect(b10.place?.count).toBe(1)
    expect(b10.children.map((n) => n.label)).toEqual(['merlin-lce.10.1'])
    expect(b10.count).toBe(2)
    expect(tree.none?.count).toBe(1)
  })

  test('selecting a node takes what is at or under it', () => {
    const ids = (sel: string) => selectLanes(lanes, sel, 'bead', beads).map((x) => x.id)
    expect(ids('merlin/merlin-lce/merlin-lce.10')).toEqual(['s1', 's5'])
    expect(ids('merlin/merlin-lce')).toEqual(['s1', 's2', 's3', 's5'])
    expect(ids('merlin')).toEqual(['s1', 's2', 's3', 's5'])
    expect(ids(NONE_SEL)).toEqual(['s4'])
    expect(keepSelection('merlin/merlin-lce/merlin-lce.2', lanes, 'bead', beads)).toBe('merlin/merlin-lce/merlin-lce.2')
    expect(keepSelection('merlin/other', lanes, 'bead', beads)).toBeNull()
    expect(displayPath('merlin/merlin-lce/merlin-lce.10', undefined, 'bead')).toBe('merlin-lce.10')
  })

  test('sort=key follows the tree order of the bead path, (none) last', () => {
    const asc = sortLanes(lanes, { key: 'key', desc: false }, undefined, { by: 'bead', beads }).map((x) => x.id)
    expect(asc).toEqual(['s3', 's2', 's5', 's1', 's4'])
    const desc = sortLanes(lanes, { key: 'key', desc: true }, undefined, { by: 'bead', beads }).map((x) => x.id)
    expect(desc).toEqual(['s1', 's5', 's2', 's3', 's4'])
  })
})

describe('a month on the locator', () => {
  const today = new Date(2026, 10, 13, 15, 30)
  const strip = stripOf('2026-09-12', today, null)
  const dayOf = (day: string) => Math.round((new Date(day + 'T00:00:00').getTime() - strip.first) / DAY)

  test('the whole month, first to last day', () => {
    expect(monthRange(strip, dayOf('2026-10-01'), today)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    // 28 days, and the days of a leap February
    const feb = stripOf('2028-01-10', new Date(2028, 3, 2), null)
    expect(
      monthRange(feb, Math.round((new Date(2028, 1, 1).getTime() - feb.first) / DAY), new Date(2028, 3, 2)),
    ).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    })
  })

  test('the current month ends today', () => {
    expect(monthRange(strip, dayOf('2026-11-01'), today)).toEqual({ from: '2026-11-01', to: '2026-11-13' })
  })

  test('a month that starts before the strip is clipped to its first day', () => {
    expect(monthRange(strip, 0, today)).toEqual({ from: '2026-09-12', to: '2026-09-30' })
  })

  test('the month ticks carry their day and title', () => {
    const t = stripTicks(strip, 440).filter((x) => x.month)
    expect(t.map((x) => x.title)).toEqual(['Show Oct 2026', 'Show Nov 2026'])
    expect(t.map((x) => monthRange(strip, x.day, today).from)).toEqual(['2026-10-01', '2026-11-01'])
  })
})
