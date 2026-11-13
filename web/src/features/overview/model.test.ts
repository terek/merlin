import { describe, expect, test } from 'bun:test'
import type { OverviewGroup, OverviewLane, OverviewSpan } from '../../api/types'
import {
  activeMs,
  activeSlots,
  activityRuns,
  ancestorIds,
  axisTicks,
  bandAt,
  blockWidth,
  buildPlaceTree,
  buildRows,
  CTX_MAX,
  chooseSlot,
  comparePlace,
  displayPath,
  earliestStart,
  filterOverview,
  fitLabels,
  fitTail,
  formatIn,
  formatSort,
  formatView,
  groupDescription,
  groupHarnesses,
  groupScale,
  groupsHome,
  heldContext,
  type IndexItem,
  inferHome,
  keepSelection,
  keyText,
  type Layout,
  laneDescription,
  laneHead,
  laneMatches,
  laneScale,
  lanesByGroup,
  lastLabel,
  lifeSpan,
  MERGE_GAP,
  MIN_SPINE,
  makeAxis,
  markedNode,
  midnights,
  NONE_SEL,
  nextSort,
  nodeForPath,
  type PlaceNode,
  parseBy,
  parseIn,
  parseShow,
  parseSort,
  parseView,
  placeSegs,
  type Row,
  type Sort,
  type SortKey,
  selectOverview,
  slotX,
  sortGroups,
  sortLanes,
  spineLanes,
  stepAreaPath,
  totalOf,
  underPath,
  visibleRows,
  xOf,
} from './model'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

function group(p: Partial<OverviewGroup> & { key: string }): OverviewGroup {
  return {
    name: p.key,
    sessions: 1,
    turns: 0,
    agents: 0,
    usd: 0,
    usdSlots: [0, 0, 0, 0],
    contextPeak: [0, 0, 0, 0],
    contextSum: [0, 0, 0, 0],
    idlePeak: [0, 0, 0, 0],
    idleSum: [0, 0, 0, 0],
    active: [0, 0, 0, 0],
    spans: [],
    ...p,
  }
}

function lane(p: Partial<OverviewLane> & { id: string }): OverviewLane {
  return {
    harness: 'claude',
    group: '',
    usd: 0,
    turns: 0,
    agents: 0,
    slot0: 0,
    usdSlots: [],
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
  test('the group rows share one scale of total context, idle included', () => {
    const a = group({ key: 'a', contextSum: [100, 400, 0, 0], idleSum: [0, 0, 800, 0], contextPeak: [50, 200, 0, 0] })
    const b = group({ key: 'b', contextSum: [0, 40, 0, 0] })
    const s = groupScale([a, b])
    expect(s.maxTok).toBe(800)
    expect(s.pxPerTok).toBeCloseTo(CTX_MAX / 800, 9)
  })

  test('the session rows have their own', () => {
    const s = laneScale([lane({ id: 'a', context: [10, 90] }), lane({ id: 'b', context: [5], idle: [300] })])
    expect(s.maxTok).toBe(300)
    expect(s.pxPerTok).toBeCloseTo(CTX_MAX / 300, 9)
  })

  test('nothing carried, no scale', () => {
    expect(groupScale([group({ key: 'a' })])).toEqual({ maxTok: 0, pxPerTok: 0 })
    expect(laneScale([])).toEqual({ maxTok: 0, pxPerTok: 0 })
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
  const a = group({
    key: 'a',
    usd: 10,
    sessions: 5,
    turns: 3,
    agents: 9,
    lastActivityAt: '2026-11-01T00:00:00Z',
  })
  const b = group({ key: 'b', usd: 5, sessions: 9, turns: 8, agents: 1, lastActivityAt: '2026-11-03T00:00:00Z' })
  const c = group({ key: 'c', usd: 5, sessions: 1, turns: 8, agents: 4, lastActivityAt: '2026-11-02T00:00:00Z' })
  const keys = (gs: OverviewGroup[]) => gs.map((g) => g.key)
  const desc = (key: SortKey): Sort => ({ key, desc: true })
  const asc = (key: SortKey): Sort => ({ key, desc: false })

  test('groups by each column and direction; ties by spend, then key', () => {
    expect(keys(sortGroups([c, b, a], desc('spend')))).toEqual(['a', 'b', 'c'])
    expect(keys(sortGroups([a, b, c], asc('spend')))).toEqual(['b', 'c', 'a'])
    expect(keys(sortGroups([a, b, c], desc('turns')))).toEqual(['b', 'c', 'a'])
    expect(keys(sortGroups([a, b, c], asc('turns')))).toEqual(['a', 'b', 'c'])
    expect(keys(sortGroups([a, b, c], desc('agents')))).toEqual(['a', 'c', 'b'])
    expect(keys(sortGroups([a, b, c], desc('last')))).toEqual(['b', 'c', 'a'])
    expect(keys(sortGroups([a, b, c], asc('last')))).toEqual(['a', 'c', 'b'])
  })

  test('groups by start (the earliest of their sessions) and by running time', () => {
    const lanes = new Map([
      [
        'a',
        [lane({ id: '1', startedAt: '2026-11-05T00:00:00Z' }), lane({ id: '2', startedAt: '2026-11-02T00:00:00Z' })],
      ],
      ['b', [lane({ id: '3', startedAt: '2026-11-04T00:00:00Z' })]],
      ['c', [lane({ id: '4', startedAt: '2026-11-03T00:00:00Z' })]],
    ])
    expect(keys(sortGroups([a, b, c], desc('start'), { lanes }))).toEqual(['b', 'c', 'a'])
    expect(keys(sortGroups([a, b, c], asc('start'), { lanes }))).toEqual(['a', 'c', 'b'])
    const run = (key: string, active: number[]) => group({ key, usd: 1, active })
    const g1 = run('g1', [0, 1, 0, 2, 0])
    const g2 = run('g2', [1, 1, 1, 0, 0])
    const g3 = run('g3', [])
    expect(keys(sortGroups([g3, g1, g2], desc('active')))).toEqual(['g2', 'g1', 'g3'])
    expect(keys(sortGroups([g1, g2, g3], asc('active')))).toEqual(['g3', 'g1', 'g2'])
  })

  test('running time: the slots with a call running, times the slot', () => {
    expect(activeSlots([0, 1, 0, 3, 2])).toBe(3)
    expect(activeMs([0, 1, 0, 3, 2], 600_000)).toBe(1_800_000)
    expect(activeMs([], 600_000)).toBe(0)
    expect(earliestStart([lane({ id: 'x', startedAt: '2026-11-03T00:00:00Z' }), lane({ id: 'y' })])).toBe(
      '2026-11-03T00:00:00Z',
    )
    expect(earliestStart(undefined)).toBe('')
  })

  test('does not change its input', () => {
    const input = [c, a]
    sortGroups(input, desc('spend'))
    expect(input.map((g) => g.key)).toEqual(['c', 'a'])
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

  test('lanes by group', () => {
    const m = lanesByGroup([lane({ id: 'a', group: 'x' }), lane({ id: 'b', group: '' }), lane({ id: 'c', group: 'x' })])
    expect(m.get('x')?.map((l) => l.id)).toEqual(['a', 'c'])
    expect(m.get('')?.map((l) => l.id)).toEqual(['b'])
  })
})

describe('rows by mode', () => {
  const gx = group({ key: 'x', name: 'proj-x', usd: 6, sessions: 2 })
  const gy = group({ key: 'y', name: 'proj-y', usd: 9, sessions: 1 })
  const lanes = [
    lane({ id: 'a', group: 'x', usd: 1 }),
    lane({ id: 'b', group: 'x', usd: 5 }),
    lane({ id: 'c', group: 'y', usd: 9 }),
  ]
  const o = { groups: [gx, gy], lanes }
  const spend: Sort = { key: 'spend', desc: true }
  const tag = (r: Row) => (r.kind === 'group' ? `g:${r.g.key}` : r.l.id)

  test('sessions: every session flat, by the sort, with its project name', () => {
    const rows = buildRows(o, 'sessions', spend)
    expect(rows.map(tag)).toEqual(['c', 'b', 'a'])
    expect(rows.map((r) => (r.kind === 'session' ? r.groupName : ''))).toEqual(['proj-y', 'proj-x', 'proj-x'])
    expect(rows.every((r) => r.kind === 'session' && !r.nested)).toBe(true)
  })

  test('grouped: each group row then all its sessions, both by the sort', () => {
    expect(buildRows(o, 'grouped', spend).map(tag)).toEqual(['g:y', 'c', 'g:x', 'b', 'a'])
    expect(buildRows(o, 'grouped', { key: 'spend', desc: false }).map(tag)).toEqual(['g:x', 'a', 'b', 'g:y', 'c'])
    expect(
      buildRows(o, 'grouped', spend)
        .filter((r) => r.kind === 'session')
        .every((r) => r.kind === 'session' && r.nested),
    ).toBe(true)
  })

  test('groups: the group rows alone', () => {
    expect(buildRows(o, 'groups', spend).map(tag)).toEqual(['g:y', 'g:x'])
    expect(buildRows(o, 'groups', { key: 'turns', desc: true }).map(tag)).toEqual(['g:y', 'g:x'])
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

  test('the group description names the priciest session', () => {
    const g = group({ key: 'k', sessions: 18, priciest: { harness: 'claude', id: 'abcdef123456', usd: 96.2 } })
    expect(groupDescription(g, 'big refactor')).toBe('18 sessions · priciest: big refactor $96.20')
    expect(groupDescription(g)).toBe('18 sessions · priciest: abcdef12 $96.20')
    expect(groupDescription(group({ key: 'k', sessions: 1 }))).toBe('1 session')
  })
})

describe('URL state', () => {
  test('by and show, defaults for anything else', () => {
    expect(parseBy('repo')).toBe('repo')
    expect(parseBy('project')).toBe('dir')
    expect(parseBy(null)).toBe('dir')
    expect(parseShow('groups')).toBe('groups')
    expect(parseShow('sessions')).toBe('sessions')
    expect(parseShow('x')).toBe('grouped')
    expect(parseShow(null)).toBe('grouped')
  })

  test('an old flat link (by=none) is the folder key shown as sessions', () => {
    expect(parseView('none', null)).toEqual({ by: 'dir', show: 'sessions' })
    expect(parseView('none', 'groups')).toEqual({ by: 'dir', show: 'sessions' })
    expect(parseView(null, null)).toEqual({ by: 'dir', show: 'grouped' })
    expect(parseView('remote', 'groups')).toEqual({ by: 'remote', show: 'groups' })
  })

  test('a view writes only what is not the default, and reads back', () => {
    expect(formatView('dir', 'grouped')).toEqual({ by: undefined, show: undefined })
    expect(formatView('repo', 'sessions')).toEqual({ by: 'repo', show: 'sessions' })
    const f = formatView('checkout', 'groups')
    expect(parseView(f.by ?? null, f.show ?? null)).toEqual({ by: 'checkout', show: 'groups' })
  })

  test('in: empty is no selection; written as it is', () => {
    expect(parseIn(null)).toBeNull()
    expect(parseIn('')).toBeNull()
    expect(parseIn('/Users/a/work')).toBe('/Users/a/work')
    expect(parseIn('-')).toBe(NONE_SEL)
    expect(formatIn(null)).toBeUndefined()
    expect(formatIn('/Users/a/work')).toBe('/Users/a/work')
  })

  test('sort and dir', () => {
    expect(parseSort(null, null)).toEqual({ key: 'spend', desc: true })
    expect(parseSort('turns', null)).toEqual({ key: 'turns', desc: true })
    expect(parseSort('last', 'asc')).toEqual({ key: 'last', desc: false })
    expect(parseSort('bogus', 'asc')).toEqual({ key: 'spend', desc: false })
    // the timeline sorts start newest / most recent / longest first; an old link's `session` is `start`
    expect(parseSort('active', null)).toEqual({ key: 'active', desc: true })
    expect(parseSort('start', 'asc')).toEqual({ key: 'start', desc: false })
    expect(parseSort('session', null)).toEqual({ key: 'start', desc: true })
    expect(parseSort('session', 'asc')).toEqual({ key: 'start', desc: false })
    expect(formatSort({ key: 'start', desc: true })).toEqual({ sort: 'start', dir: undefined })
    expect(formatSort({ key: 'spend', desc: true })).toEqual({ sort: undefined, dir: undefined })
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
    const item = (key: string): IndexItem => ({ key, name: key, count: 1, usd: 1 })
    const t = buildPlaceTree([item('/Users/a/work/yimple'), item('/Users/a/work'), item('/Users/a/work/merlin')], 'dir')
    expect(t.nodes[0].label).toBe('~/work')
    expect(t.nodes[0].children.map((n) => n.label)).toEqual(['merlin', 'yimple'])
  })

  const gA = group({ key: '/Users/a/work/yimple', usd: 1 })
  const gB = group({ key: '/Users/a/work/merlin', usd: 9 })
  const gC = group({ key: '/Users/a/work', usd: 5 })
  const gN = group({ key: '', usd: 100 })
  const lanes = [
    lane({ id: '1', group: gA.key, usd: 2 }),
    lane({ id: '2', group: gB.key, usd: 3 }),
    lane({ id: '3', group: gB.key, usd: 7 }),
    lane({ id: '4', group: gC.key, usd: 1 }),
    lane({ id: '5', group: '', usd: 50 }),
  ]
  const o = { groups: [gA, gB, gC, gN], lanes }
  const home = '/Users/a'
  const placeOf = (k: string) => placeSegs(k, 'dir', home)
  const tag = (r: Row) => (r.kind === 'group' ? `g:${r.g.key.split('/').pop() || '-'}` : r.l.id)
  const keyAsc: Sort = { key: 'key', desc: false }

  test('sessions cluster by place in the tree order; (none) last, ties by spend', () => {
    expect(buildRows(o, 'sessions', keyAsc, { placeOf }).map(tag)).toEqual(['4', '3', '2', '1', '5'])
    // descending reverses the places, (none) stays last
    expect(buildRows(o, 'sessions', { key: 'key', desc: true }, { placeOf }).map(tag)).toEqual([
      '1',
      '3',
      '2',
      '4',
      '5',
    ])
  })

  test('grouped and groups: groups by place, the sessions inside by spend', () => {
    expect(buildRows(o, 'grouped', keyAsc, { placeOf }).map(tag)).toEqual([
      'g:work',
      '4',
      'g:merlin',
      '3',
      '2',
      'g:yimple',
      '1',
      'g:-',
      '5',
    ])
    expect(buildRows(o, 'groups', keyAsc, { placeOf }).map(tag)).toEqual(['g:work', 'g:merlin', 'g:yimple', 'g:-'])
    expect(buildRows(o, 'groups', { key: 'key', desc: true }, { placeOf }).map(tag)).toEqual([
      'g:yimple',
      'g:merlin',
      'g:work',
      'g:-',
    ])
  })

  test('sessions sort by the folder they ran in, falling back to their group', () => {
    const ls = [
      lane({ id: 'a', group: gC.key, dir: '/Users/a/work/yimple', usd: 1 }),
      lane({ id: 'b', group: gC.key, dir: '/Users/a/work/merlin/web', usd: 1 }),
      lane({ id: 'c', group: gC.key, dir: '/Users/a/work/merlin', usd: 1 }),
      lane({ id: 'd', group: gC.key, usd: 9 }),
    ]
    const lanePlaceOf = (l: OverviewLane) => (l.dir ? placeSegs(l.dir, 'dir', home) : placeOf(l.group))
    const order = (desc: boolean) => sortLanes(ls, { key: 'key', desc }, { placeOf, lanePlaceOf }).map((l) => l.id)
    // the group's own place ~/work comes first
    expect(order(false)).toEqual(['d', 'c', 'b', 'a'])
    expect(order(true)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('the place and the text of a key', () => {
    expect(placeSegs('/Users/a/work/merlin', 'dir', home)).toEqual(['~', 'work', 'merlin'])
    expect(placeSegs('', 'dir', home)).toBeNull()
    expect(keyText('/Users/a/work/merlin', 'dir', home)).toBe('~/work/merlin')
    expect(keyText('/Users/a/work/merlin/.bare', 'repo', home)).toBe('~/work/merlin')
    expect(keyText('/srv/x/y', 'dir', home)).toBe('/srv/x/y')
    expect(keyText('github.com/acme/api', 'remote', undefined)).toBe('github.com/acme/api')
    expect(keyText('', 'dir', home)).toBe('(none)')
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

describe('lastLabel', () => {
  const now = new Date(2026, 10, 12, 15, 0).getTime()
  const ago = (ms: number) => new Date(now - ms).toISOString()
  test('compact forms', () => {
    expect(lastLabel(ago(20_000), now)).toBe('now')
    expect(lastLabel(ago(5 * MIN), now)).toBe('5 min')
    expect(lastLabel(ago(2 * HOUR), now)).toBe('2 h')
    expect(lastLabel(new Date(2026, 10, 11, 9, 0).toISOString(), now)).toBe('yesterday')
    expect(lastLabel(new Date(2026, 10, 9, 9, 0).toISOString(), now)).toBe('9 Nov')
    expect(lastLabel(undefined, now)).toBe('–')
  })
})

describe('search', () => {
  const g1 = group({ key: 'a', name: 'payments', sessions: 2 })
  const g2 = group({ key: 'b', name: 'website', sessions: 1 })
  const l1 = lane({
    id: 'aaaa1111',
    group: 'a',
    title: 'Fix the retry loop',
    recap: { text: 'Working on BACKOFF' } as never,
  })
  const l2 = lane({ id: 'bbbb2222', group: 'a', name: 'migration' })
  const l3 = lane({
    id: 'cccc3333',
    group: 'b',
    harness: 'codex',
    firstPrompt: { text: 'Make the header sticky' } as never,
  })
  const o = { groups: [g1, g2], lanes: [l1, l2, l3] }

  test('matches head, description and group name, case-insensitively', () => {
    expect(laneMatches(l1, 'payments', 'retry')).toBe(true)
    expect(laneMatches(l1, 'payments', 'backoff')).toBe(true)
    expect(laneMatches(l3, 'website', 'sticky')).toBe(true)
    expect(laneMatches(l2, 'payments', 'bbbb')).toBe(true)
    expect(laneMatches(l2, 'payments', 'PAYM'.toLowerCase())).toBe(true)
    expect(laneMatches(l2, 'payments', 'sticky')).toBe(false)
  })

  test('server hits count for terms of two characters or more', () => {
    const hits = new Set(['claude/bbbb2222'])
    expect(laneMatches(l2, 'payments', 'zz', hits)).toBe(true)
    expect(laneMatches(l2, 'payments', 'z', hits)).toBe(false)
    expect(laneMatches(l1, 'payments', 'zz', hits)).toBe(false)
  })

  test('an empty term keeps everything', () => {
    const f = filterOverview(o, '  ')
    expect(f.groups).toHaveLength(2)
    expect(f.lanes).toHaveLength(3)
    expect(f.shown.get('a')).toBe(2)
  })

  test('only groups with a match remain, with only matching sessions', () => {
    const f = filterOverview(o, 'sticky')
    expect(f.groups.map((g) => g.key)).toEqual(['b'])
    expect(f.lanes.map((l) => l.id)).toEqual(['cccc3333'])
    expect(f.shown.get('b')).toBe(1)
  })

  test('a group whose name matches counts all its sessions', () => {
    const f = filterOverview(o, 'Payments')
    expect(f.groups.map((g) => g.key)).toEqual(['a'])
    expect(f.shown.get('a')).toBe(2)
  })

  test('nothing matches: empty', () => {
    const f = filterOverview(o, 'nope')
    expect(f.groups).toEqual([])
    expect(f.lanes).toEqual([])
  })

  test('the group description says how many sessions match', () => {
    const g = group({ key: 'k', sessions: 18 })
    expect(groupDescription(g, undefined, 3)).toBe('3 of 18 sessions match')
    expect(groupDescription(g, undefined, 18)).toBe('18 sessions')
  })
})

describe('group harnesses', () => {
  test('distinct, most sessions first, at most three', () => {
    const ls = ['codex', 'claude', 'pi', 'codex', 'claude', 'claude', 'x'].map((harness) => ({ harness }))
    expect(groupHarnesses(ls)).toEqual(['claude', 'codex', 'pi'])
    expect(groupHarnesses([])).toEqual([])
  })
})

describe('hover geometry', () => {
  const L: Layout = { harness: 44, pad: 12, turns: 64, agents: 70, spend: 84, gap: 8 }
  const BLOCK = 1 + 24 + 44 + 64 + 70 + 84 + 24

  test('the block is the rule, the padding and four columns with their gaps', () => {
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
  const item = (key: string, count = 1, usd = 1): IndexItem => ({ key, name: key.split('/').pop() ?? key, count, usd })
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
    )
    expect(shape(t.nodes)).toEqual([
      '/tmp/scratch',
      ['~', ['old/Merlin', 'src/github.com/acme/api', ['work/merlin', ['web']]]],
    ])
  })

  test('a group that has children is both: its figures are the subtree sums', () => {
    const t = buildPlaceTree([item('/Users/a/x', 2, 10), item('/Users/a/x/web', 3, 5), item('/Users/a/y', 1, 1)], 'dir')
    const [home] = t.nodes
    expect(home.label).toBe('~')
    const x = home.children.find((n) => n.label === 'x')
    expect(x?.group?.key).toBe('/Users/a/x')
    expect(x?.count).toBe(5)
    expect(x?.usd).toBe(15)
    expect(home.count).toBe(6)
    expect(home.usd).toBe(16)
  })

  test('a repository sits at its working directory, a bare container too', () => {
    const t = buildPlaceTree(
      [item('/Users/a/w/merlin/.bare'), item('/Users/a/o/merlin/.git'), item('/Users/a/merlin/.git')],
      'repo',
    )
    expect(shape(t.nodes)).toEqual([['~', ['merlin', 'o/merlin', 'w/merlin']]])
    expect(t.nodes[0].children[0].group?.key).toBe('/Users/a/merlin/.git')
  })

  test('remotes split into host, owner and name; local paths stay paths', () => {
    const t = buildPlaceTree(
      [item('github.com/acme/api'), item('github.com/acme/web'), item('git.example.test/x/y'), item('/srv/git/app')],
      'remote',
    )
    expect(shape(t.nodes)).toEqual(['/srv/git/app', 'git.example.test/x/y', ['github.com/acme', ['api', 'web']]])
    expect(t.nodes.map((n) => !!n.host)).toEqual([false, true, true])
  })

  test('the group with no value is apart, not in the tree', () => {
    const t = buildPlaceTree([item('', 4, 2), item('/tmp/a')], 'dir')
    expect(t.none?.count).toBe(4)
    expect(shape(t.nodes)).toEqual(['/tmp/a'])
    expect(t.nodes[0].count).toBe(1)
  })

  test('paths with no shared home stay absolute', () => {
    expect(shape(buildPlaceTree([item('/srv/a/x'), item('/srv/a/y')], 'dir').nodes)).toEqual([['/srv/a', ['x', 'y']]])
  })

  test('visible rows follow the open state; a hidden group is marked by its closed folder', () => {
    const t = buildPlaceTree([item('/Users/a/x'), item('/Users/a/x/web'), item('/Users/a/y')], 'dir')
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
  const item = (key: string, count = 1, usd = 1): IndexItem => ({ key, name: key.split('/').pop() ?? key, count, usd })
  const g = (key: string) => ({ key })

  test('a group is under a path when its segments start with the path, not its characters', () => {
    expect(underPath(g('/Users/a/work/merlin'), '/Users/a/work', 'dir')).toBe(true)
    expect(underPath(g('/Users/a/work'), '/Users/a/work', 'dir')).toBe(true)
    expect(underPath(g('/Users/a/workshop'), '/Users/a/work', 'dir')).toBe(false)
    expect(underPath(g('/Users/a'), '/Users/a/work', 'dir')).toBe(false)
    expect(underPath(g('/Users/a/work/merlin'), null, 'dir')).toBe(true)
    expect(underPath(g(''), null, 'dir')).toBe(true)
  })

  test('(none) selects the group with the empty key alone', () => {
    expect(underPath(g(''), NONE_SEL, 'dir')).toBe(true)
    expect(underPath(g('/Users/a'), NONE_SEL, 'dir')).toBe(false)
    expect(underPath(g(''), '/Users/a', 'dir')).toBe(false)
  })

  test('a repository stands at its directory: .git and .bare do not count', () => {
    expect(underPath(g('/Users/a/work/merlin/.bare'), '/Users/a/work', 'repo')).toBe(true)
    expect(underPath(g('/Users/a/work/merlin/.bare'), '/Users/a/work/merlin', 'repo')).toBe(true)
    expect(underPath(g('/Users/a/work/merlin/.bare'), '/Users/a/work/merlin/.bare', 'repo')).toBe(false)
    expect(underPath(g('/Users/a/merlin/.git'), '/Users/a/merlin', 'repo')).toBe(true)
  })

  test('a remote is under its host and owner', () => {
    expect(underPath(g('github.com/acme/api'), 'github.com/acme', 'remote')).toBe(true)
    expect(underPath(g('github.com/acme/api'), 'github.com', 'remote')).toBe(true)
    expect(underPath(g('github.com/acme/api'), 'github.com/acm', 'remote')).toBe(false)
    expect(underPath(g('gitlab.com/acme/api'), 'github.com/acme', 'remote')).toBe(false)
  })

  const o = {
    groups: [
      group({ key: '/Users/a/work/merlin', usd: 5, sessions: 2 }),
      group({ key: '/Users/a/work/yimple', usd: 3, sessions: 1 }),
      group({ key: '/Users/a/play', usd: 1, sessions: 1 }),
      group({ key: '', usd: 2, sessions: 1 }),
    ],
    lanes: [
      lane({ id: '1', group: '/Users/a/work/merlin' }),
      lane({ id: '2', group: '/Users/a/work/merlin' }),
      lane({ id: '3', group: '/Users/a/work/yimple' }),
      lane({ id: '4', group: '/Users/a/play' }),
      lane({ id: '5', group: '' }),
    ],
  }

  test('the overview narrows to the groups at or under the selection, with their sessions', () => {
    const all = filterOverview(o, '')
    expect(selectOverview(all, null, 'dir')).toBe(all)
    const w = selectOverview(all, '/Users/a/work', 'dir')
    expect(w.groups.map((x) => x.key)).toEqual(['/Users/a/work/merlin', '/Users/a/work/yimple'])
    expect(w.lanes.map((l) => l.id)).toEqual(['1', '2', '3'])
    expect([...w.shown]).toEqual([
      ['/Users/a/work/merlin', 2],
      ['/Users/a/work/yimple', 1],
    ])
    expect(selectOverview(all, '-', 'dir').lanes.map((l) => l.id)).toEqual(['5'])
    expect(selectOverview(all, '/nope', 'dir').groups).toEqual([])
  })

  test('the selection follows the search: it narrows what the search left', () => {
    const found = filterOverview(o, 'yimple')
    expect(selectOverview(found, '/Users/a/work', 'dir').groups.map((x) => x.key)).toEqual(['/Users/a/work/yimple'])
    expect(selectOverview(found, '/Users/a/play', 'dir').groups).toEqual([])
  })

  test('All is the sum of what the items list', () => {
    expect(totalOf([item('a', 2, 10), item('b', 3, 5.5), item('', 1, 1)])).toEqual({ count: 6, usd: 16.5 })
    expect(totalOf([])).toEqual({ count: 0, usd: 0 })
  })

  test('a selection is kept on a new key only where a group sits under it', () => {
    const repos = [g('/Users/a/work/merlin/.bare'), g('/Users/a/play/x/.git')]
    expect(keepSelection('/Users/a/work', repos, 'repo')).toBe('/Users/a/work')
    expect(keepSelection('/Users/a/other', repos, 'repo')).toBeNull()
    expect(keepSelection('github.com/acme', repos, 'remote')).toBeNull()
    expect(keepSelection('-', [g('')], 'remote')).toBe('-')
    expect(keepSelection(null, repos, 'repo')).toBeNull()
  })

  test('the tree nodes carry the real path; the home is spelled out', () => {
    const t = buildPlaceTree([item('/Users/a/work/merlin'), item('/Users/a/work/yimple'), item('/Users/a/play')], 'dir')
    expect(t.home).toBe('/Users/a')
    const [home] = t.nodes
    expect(home.path).toBe('/Users/a')
    expect(home.children.map((n) => n.path)).toEqual(['/Users/a/play', '/Users/a/work'])
    expect(home.children[1].children.map((n) => n.path)).toEqual(['/Users/a/work/merlin', '/Users/a/work/yimple'])
    // a compacted chain is its deepest path
    const c = buildPlaceTree([item('/Users/a/src/github.com/acme/api'), item('/Users/a/x')], 'dir')
    expect(c.nodes[0].children.map((n) => [n.label, n.path])).toEqual([
      ['src/github.com/acme/api', '/Users/a/src/github.com/acme/api'],
      ['x', '/Users/a/x'],
    ])
    const r = buildPlaceTree([item('github.com/acme/api'), item('github.com/acme/web')], 'remote')
    expect(r.nodes[0].path).toBe('github.com/acme')
    expect(r.nodes[0].children.map((n) => n.path)).toEqual(['github.com/acme/api', 'github.com/acme/web'])
    const b = buildPlaceTree([item('/Users/a/w/merlin/.bare'), item('/Users/a/x/.git')], 'repo')
    expect(b.nodes[0].children.map((n) => n.path)).toEqual(['/Users/a/w/merlin', '/Users/a/x'])
  })

  test("a fixed home is used instead of the items' own", () => {
    const t = buildPlaceTree([item('/srv/a/x')], 'dir', { home: undefined })
    expect(t.home).toBeUndefined()
    expect(groupsHome(['/Users/a/x', '/Users/a/y'], 'dir')).toBe('/Users/a')
    expect(groupsHome(['/Users/a/w/m/.bare', '/Users/a/y/.git'], 'repo')).toBe('/Users/a')
  })

  test('the node of a path and the folders to open above it', () => {
    const t = buildPlaceTree(
      [item('/Users/a/x/web'), item('/Users/a/x/api'), item('/Users/a/y/z/deep'), item('/Users/a/y/z/also')],
      'dir',
    )
    const web = nodeForPath(t.nodes, '/Users/a/x/web')
    expect(web?.label).toBe('web')
    expect(nodeForPath(t.nodes, '/Users/a/x')?.label).toBe('x')
    expect(nodeForPath(t.nodes, '/nope')).toBeNull()
    // a folder inside a compacted chain is the chain's node
    const chain = buildPlaceTree([item('/Users/a/work/m/web'), item('/Users/a/work/m'), item('/Users/a/x')], 'dir')
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
