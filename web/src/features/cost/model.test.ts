import { describe, expect, test } from 'bun:test'
import type { CostRow, CostSplitEntry, CostTable } from '../../api/types'
import { HATCH, modelColor } from '../../lib/palette'
import {
  addDays,
  type Bucket,
  barTotal,
  bucketsFor,
  dayName,
  disagreements,
  grainFor,
  hourLabelEvery,
  hourTick,
  hourTitle,
  isWeekly,
  labelEvery,
  listDays,
  makeBuckets,
  makeHourBuckets,
  niceTicks,
  parseStack,
  splitOf,
  stackOf,
  tickLabel,
  topModels,
  weekStart,
} from './model'

const part = (key: string, usd: number, reported = 0): CostSplitEntry => ({
  key,
  totalUSD: usd,
  reportedUSD: reported,
  attributedUSD: usd - reported,
})
const row = (key: string, parts: CostSplitEntry[]): CostRow => ({
  key,
  sessions: 1,
  totalUSD: parts.reduce((a, p) => a + p.totalUSD, 0),
  reportedUSD: parts.reduce((a, p) => a + p.reportedUSD, 0),
  attributedUSD: parts.reduce((a, p) => a + p.attributedUSD, 0),
  split: parts,
})

describe('windows', () => {
  test('day arithmetic crosses months and DST', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(listDays('2026-03-27', '2026-03-30')).toEqual(['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30'])
    expect(listDays('2026-10-25', '2026-10-27')).toHaveLength(3)
    expect(weekStart('2026-09-20')).toBe('2026-09-14')
    expect(weekStart('2026-09-14')).toBe('2026-09-14')
  })
})

describe('buckets', () => {
  const rows = [
    row('2026-09-28', [part('a', 2, 2), part('b', 1)]),
    row('2026-09-30', [part('a', 4, 1), part('(overhead)', 1, 1)]),
  ]
  test('empty days are filled in', () => {
    const b = makeBuckets(rows, { since: '2026-09-27', until: '2026-10-01' }, false)
    expect(b.map((x) => x.key)).toEqual(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'])
    expect(b.map((x) => x.total)).toEqual([0, 3, 0, 5, 0])
    expect(b[0].parts).toEqual([])
  })
  test('"all" starts at the first day with spend', () => {
    const b = makeBuckets(rows, { until: '2026-09-30' }, false)
    expect(b[0].key).toBe('2026-09-28')
    expect(b).toHaveLength(3)
    expect(makeBuckets([], { until: '2026-09-30' }, false)).toEqual([])
  })
  test('weeks run Monday to Sunday and are cut at the window; parts are merged', () => {
    const b = makeBuckets(rows, { since: '2026-09-23', until: '2026-10-01' }, true)
    expect(b.map((x) => [x.key, x.to])).toEqual([
      ['2026-09-23', '2026-09-27'],
      ['2026-09-28', '2026-10-01'],
    ])
    expect(b[1].total).toBe(8)
    expect(b[1].parts.map((p) => [p.key, p.totalUSD])).toEqual([
      ['a', 6],
      ['(overhead)', 1],
      ['b', 1],
    ])
  })
  test('weekly only over 120 days', () => {
    expect(isWeekly(121)).toBe(true)
    expect(isWeekly(120)).toBe(false)
    const long = [row('2026-01-01', [part('a', 1)]), row('2026-09-30', [part('a', 1)])]
    const b = bucketsFor(long, { until: '2026-09-30' })
    expect(b[0].weekly).toBe(true)
    expect(b.length).toBeLessThan(45)
    expect(b.reduce((a, x) => a + x.total, 0)).toBe(2)
    expect(bucketsFor(long, { since: '2026-09-01', until: '2026-09-30' })[0].weekly).toBe(false)
  })
})

describe('stacks', () => {
  // ten models: the cap is eight, the stack goes heavy to light, newest first
  const models = [
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-fable-5-1',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5',
    'claude-opus-4-1',
    'mystery-1',
    'tiny-a',
    'tiny-b',
  ]
  const b: Bucket = {
    key: '2026-09-28',
    to: '2026-09-28',
    weekly: false,
    total: 0,
    reported: 6,
    attributed: 4,
    parts: [...models.map((m, i) => part(m, 10 - i)), part('(overhead)', 20)].sort((x, y) => y.totalUSD - x.totalUSD),
  }
  test('the top models by spend, (overhead) never among them, in stack order', () => {
    expect(topModels([b])).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-opus-4-1',
      'claude-sonnet-5-5',
      'claude-sonnet-4-5',
      'claude-haiku-5-5',
      'claude-haiku-4-5-20251001',
      'mystery-1',
    ])
  })
  test('the rest is "other", overhead on top, colours by model and not by rank, and the stack adds up', () => {
    const top = topModels([b])
    const s = stackOf(b, 'model', top)
    expect(s.map((x) => x.key)).toEqual([...top, 'other', '(overhead)'])
    for (const x of s.filter((x) => top.includes(x.key))) expect(x.color).toBe(modelColor(x.key))
    expect(s.find((x) => x.key === 'other')?.color).toBe('var(--series-other)')
    expect(s.find((x) => x.key === '(overhead)')?.color).toBe(HATCH)
    // the same model has the same colour whatever else is in the scope
    const alone = stackOf({ ...b, parts: [part('claude-sonnet-5-5', 3)] }, 'model', ['claude-sonnet-5-5'])
    expect(alone[0].color).toBe(modelColor('claude-sonnet-5-5'))
    expect(s.find((x) => x.key === 'other')?.usd).toBe(2 + 1)
    expect(s.reduce((a, x) => a + x.usd, 0)).toBe(b.parts.reduce((a, p) => a + p.totalUSD, 0))
  })
})

describe('axis', () => {
  test('ticks are round and cover the maximum', () => {
    expect(niceTicks(0)).toEqual({ ticks: [0, 1], top: 1 })
    expect(niceTicks(93).ticks).toEqual([0, 25, 50, 75, 100])
    expect(niceTicks(7.3).ticks).toEqual([0, 2, 4, 6, 8])
    expect(niceTicks(0.37).ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4])
    expect(niceTicks(1234).top).toBeGreaterThanOrEqual(1234)
    for (const m of [0.003, 0.9, 4, 18, 55, 240, 2600]) {
      const { ticks, top } = niceTicks(m)
      expect(top).toBeGreaterThanOrEqual(m)
      expect(ticks.length).toBeLessThanOrEqual(7)
    }
  })
  test('labels', () => {
    expect(tickLabel(0)).toBe('$0')
    expect(tickLabel(25)).toBe('$25')
    expect(tickLabel(0.25)).toBe('$0.25')
    expect(tickLabel(1500)).toBe('$1,500')
  })
  test('x labels keep their distance', () => {
    expect(labelEvery(7, 1300)).toBe(1)
    expect(labelEvery(90, 1300)).toBe(5)
    expect(labelEvery(0, 100)).toBe(1)
  })
})

describe('agreement', () => {
  test('equal totals and rows that add up', () => {
    const rows = [{ totalUSD: 1.5 }, { totalUSD: 2.5 }]
    expect(
      disagreements([
        { name: 'kind', total: 4, rows },
        { name: 'model', total: 4 + 1e-9, rows },
      ]),
    ).toEqual([])
  })
  test('reports a cut that differs or does not add up; a truncated one only needs the total', () => {
    const out = disagreements([
      { name: 'kind', total: 4, rows: [{ totalUSD: 4 }] },
      { name: 'project', total: 5, rows: [{ totalUSD: 4 }] },
      { name: 'session', total: 4, rows: [{ totalUSD: 1 }], truncated: true },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('project')
  })
})

// The mock API is a server script, so the test starts it on a free port and asks it for every cut.
describe('every cut of the mock data adds up to one total', async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  await probe.stop(true)
  const proc = Bun.spawn(['bun', 'dev/mock.ts'], {
    cwd: new URL('../../..', import.meta.url).pathname,
    env: { ...process.env, MOCK_PORT: String(port) },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const base = `http://127.0.0.1:${port}/api/cost`
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    try {
      up = (await fetch(`${base}?by=kind&limit=1`)).ok
    } catch {
      await Bun.sleep(100)
    }
  }
  const get = async (q: string) => (await (await fetch(`${base}?${q}`)).json()) as CostTable

  const windows = ['', 'since=2026-09-26', 'since=2026-09-03&until=2026-10-02', 'since=2026-09-20&until=2026-09-20']
  for (const w of windows) {
    test(`window "${w || 'all'}"`, async () => {
      expect(up).toBe(true)
      const [kind, project, model, day, session, dayModel] = await Promise.all([
        get(`by=kind&${w}`),
        get(`by=project&${w}`),
        get(`by=model&${w}`),
        get(`by=day&${w}`),
        get(`by=session&limit=50&${w}`),
        get(`by=day&split=model&${w}`),
      ])
      const cuts = [kind, project, model, day, dayModel].map((t, i) => ({
        name: ['kind', 'project', 'model', 'day', 'day+model'][i],
        total: t.total.totalUSD,
        rows: t.rows,
      }))
      expect(disagreements(cuts)).toEqual([])
      // by=session bounds sessions by last activity, so it is the same sum only without a window
      if (!w) expect(session.total.totalUSD).toBeCloseTo(kind.total.totalUSD, 6)
      // the chart's own stack adds up to its bars
      const buckets = makeBuckets(dayModel.rows, { until: '2026-10-02' }, false)
      const top = topModels(buckets)
      for (const b of buckets) {
        const s = stackOf(b, 'model', top).reduce((a, x) => a + x.usd, 0)
        expect(Math.abs(s - b.total)).toBeLessThan(1e-6)
      }
      expect(kind.total.reportedUSD + kind.total.attributedUSD).toBeCloseTo(kind.total.totalUSD, 6)
    })
  }
  test('stop the mock', () => {
    proc.kill()
  })
})

describe('the compaction stack', () => {
  const b: Bucket = {
    key: '2026-10-02',
    to: '2026-10-02',
    weekly: false,
    total: 40,
    reported: 10,
    attributed: 30,
    parts: [],
    compactions: { calls: 3, cold: 2, usd: 11.8, warmUSD: 1.21, uncoveredUSD: 11.8 },
  }
  test('the warm-cache cost, then the cold extra; they add up to the estimate, not to the spend', () => {
    const segs = stackOf(b, 'compaction', [])
    expect(segs.map((s) => s.key)).toEqual(['compaction-warm', 'compaction-cold'])
    expect(segs.map((s) => s.color)).toEqual(['var(--warn)', 'var(--bad)']) // amber warm, red cold
    expect(segs[0].usd).toBeCloseTo(1.21)
    expect(segs[1].usd).toBeCloseTo(10.59)
    expect(barTotal(b)).toBe(40) // the bar stays the day's spend: the stack only colours what compactions cost
  })
  test('all warm: no cold segment; no compactions: an empty bar', () => {
    const warm = { ...b, compactions: { calls: 1, cold: 0, usd: 0.7, warmUSD: 0.7, uncoveredUSD: 0 } }
    expect(stackOf(warm, 'compaction', []).map((s) => s.key)).toEqual(['compaction-warm'])
    expect(stackOf({ ...b, compactions: undefined }, 'compaction', [])).toEqual([])
  })
  test('the URL value', () => {
    expect(parseStack('compaction')).toBe('compaction')
    expect(parseStack('nonsense')).toBe('model')
    expect(parseStack('source')).toBe('model') // an old link: the reported / attributed stack is gone
  })
})

describe('the time axis', () => {
  test('the bar width by the number of days', () => {
    expect([1, 2, 3, 7, 8, 14, 15, 120, 121].map(grainFor)).toEqual([1, 1, 3, 3, 6, 6, 'day', 'day', 'week'])
  })

  const hourRow = (key: string, usd: number, split: CostSplitEntry[] = [part('m', usd)]): CostRow => ({
    ...row(key, split),
    totalUSD: usd,
  })

  test('hours fill the window, the empty ones too, and add up', () => {
    const rows = [
      hourRow('2026-11-13T00', 1),
      hourRow('2026-11-13T02', 2),
      hourRow('2026-11-13T14', 4),
      hourRow('2026-11-14T23', 8),
    ]
    const one = makeHourBuckets(rows, { since: '2026-11-13', until: '2026-11-14' }, 1)
    expect(one).toHaveLength(48)
    expect(one[0].key).toBe('2026-11-13T00')
    expect(one[47].key).toBe('2026-11-14T23')
    expect(one.every((b) => b.to === b.key.slice(0, 10))).toBe(true)
    const three = makeHourBuckets(rows, { since: '2026-11-13', until: '2026-11-14' }, 3)
    expect(three).toHaveLength(16)
    expect(three[0].total).toBe(3) // 00:00-03:00: the hours 0 and 2
    expect(three.find((b) => b.key === '2026-11-13T12')?.total).toBe(4)
    expect(three[15].total).toBe(8)
    expect(three[0].parts).toEqual([expect.objectContaining({ key: 'm', totalUSD: 3 })])
    const six = makeHourBuckets(rows, { since: '2026-11-13', until: '2026-11-13' }, 6)
    expect(six.map((b) => b.total)).toEqual([3, 0, 4, 0])
    const sum = (g: Bucket[]) => g.reduce((a, b) => a + b.total, 0)
    expect([sum(one), sum(three), sum(six)]).toEqual([15, 15, 7])
  })

  test('a day of 23 or 25 hours has the same 24 clock hours', () => {
    // 2026-03-08 and 2026-11-01 in America/New_York: the missing 02:00 is an empty bar, the repeated 01:00 one row
    const rows = [hourRow('2026-03-08T01', 1), hourRow('2026-03-08T03', 2), hourRow('2026-11-01T01', 5)]
    const spring = makeHourBuckets(rows, { since: '2026-03-08', until: '2026-03-08' }, 1)
    expect(spring).toHaveLength(24)
    expect(spring[2].total).toBe(0)
    expect(spring[3].total).toBe(2)
    const autumn = makeHourBuckets(rows, { since: '2026-11-01', until: '2026-11-01' }, 1)
    expect(autumn).toHaveLength(24)
    expect(autumn[1].total).toBe(5)
  })

  test('hours outside the window are ignored; no window start begins at the first hour with spend', () => {
    const rows = [hourRow('2026-11-12T10', 1), hourRow('2026-11-13T10', 2)]
    expect(
      makeHourBuckets(rows, { since: '2026-11-13', until: '2026-11-13' }, 6).reduce((a, b) => a + b.total, 0),
    ).toBe(2)
    expect(makeHourBuckets(rows, { until: '2026-11-13' }, 6)).toHaveLength(8)
    expect(makeHourBuckets([], { until: '2026-11-13' }, 6)).toEqual([])
  })

  test('a partial first and last week are cut at the window', () => {
    const w = makeBuckets(
      [row('2026-09-23', [part('a', 1)]), row('2026-10-01', [part('a', 2)])],
      { since: '2026-09-23', until: '2026-10-01' },
      true,
    )
    expect(w.map((b) => [b.key, b.to])).toEqual([
      ['2026-09-23', '2026-09-27'],
      ['2026-09-28', '2026-10-01'],
    ])
  })

  test('labels: the clock, and the day at midnight', () => {
    const [mid, nine, three] = makeHourBuckets([], { since: '2026-11-13', until: '2026-11-13' }, 3)
    expect(dayName('2026-11-13')).toBe('Fri 13')
    expect(hourTick(mid)).toBe('Fri 13')
    expect(hourTick(three)).toBe('06:00')
    expect(hourTick(nine)).toBe('03:00')
    const last = makeHourBuckets([], { since: '2026-11-13', until: '2026-11-13' }, 3)[7]
    expect(hourTitle(last)).toBe('Fri 13, 21:00–24:00')
    expect(hourTitle(makeHourBuckets([], { since: '2026-11-13', until: '2026-11-13' }, 1)[14])).toBe(
      'Fri 13, 14:00–15:00',
    )
  })

  test('hourly labels always include midnight', () => {
    for (const hours of [1, 3, 6] as const)
      for (const width of [200, 400, 900, 1600]) {
        const every = hourLabelEvery(48, width, hours)
        expect((24 / hours) % every).toBe(0)
      }
  })
})

describe('the stacks by who and by tier', () => {
  const prices = { 'big-1': { input: 5 }, 'mid-1': { input: 3 }, 'tiny-1': { input: 0.8 } } as never
  const bucket = (parts: CostSplitEntry[]): Bucket => ({
    key: '2026-11-13',
    to: '2026-11-13',
    weekly: false,
    total: parts.reduce((a, p) => a + p.totalUSD, 0),
    reported: 0,
    attributed: 0,
    parts,
  })

  test('the url words and the splits', () => {
    expect(parseStack('who')).toBe('who')
    expect(parseStack('tier')).toBe('tier')
    expect([splitOf('model'), splitOf('who'), splitOf('tier'), splitOf('class'), splitOf('compaction')]).toEqual([
      'model',
      'agent',
      'model',
      'class',
      'model',
    ])
  })

  test('who: the main thread at the bottom, then the agents, then what no message explains', () => {
    const s = stackOf(bucket([part('agents', 1), part('(unsplit)', 0.5), part('main', 3)]), 'who', [])
    expect(s.map((x) => [x.key, x.usd])).toEqual([
      ['main', 3],
      ['agents', 1],
      ['(unsplit)', 0.5],
    ])
    expect(s[0].color).toBe('var(--series-1)')
    expect(s[1].color).toBe('var(--series-2)')
  })

  test('tier: heavy at the bottom, models grouped by their price, the overhead a hatch on top', () => {
    const s = stackOf(
      bucket([part('tiny-1', 1), part('big-1', 4), part('mid-1', 2), part('(overhead)', 0.5), part('big-2', 1)]),
      'tier',
      [],
      prices,
    )
    expect(s.map((x) => [x.key, x.usd])).toEqual([
      ['heavy', 4],
      ['mid', 2],
      ['light', 1],
      ['unknown', 1],
      ['(overhead)', 0.5],
    ])
    expect(s[0].color).toBe('var(--series-4)')
    expect(s[4].color).toBe(HATCH)
    expect(s.reduce((a, x) => a + x.usd, 0)).toBe(8.5)
  })
})
