import { describe, expect, test } from 'bun:test'
import type { CostRow, CostSplitEntry, CostTable } from '../../api/types'
import {
  addDays,
  type Bucket,
  barTotal,
  bucketsFor,
  disagreements,
  isWeekly,
  labelEvery,
  listDays,
  makeBuckets,
  niceTicks,
  parseDay,
  parseRange,
  parseStack,
  rangeWindow,
  selectedWindow,
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
  const now = new Date(2026, 9, 2, 15, 0)
  test('ranges are whole local days, today included', () => {
    expect(rangeWindow('7d', now)).toEqual({ since: '2026-09-26', until: '2026-10-02' })
    expect(rangeWindow('30d', now).since).toBe('2026-09-03')
    expect(rangeWindow('all', now)).toEqual({ since: undefined, until: '2026-10-02' })
  })
  test('parsing', () => {
    expect(parseRange('90d')).toBe('90d')
    expect(parseRange('x')).toBe('7d')
    expect(parseDay('2026-02-30')).toBeUndefined()
    expect(parseDay('2026-09-16')).toBe('2026-09-16')
    expect(selectedWindow('2026-09-14', '2026-09-20')).toEqual({ since: '2026-09-14', until: '2026-09-20' })
    expect(selectedWindow('2026-09-14', undefined)).toEqual({ since: '2026-09-14', until: '2026-09-14' })
    expect(selectedWindow(undefined, '2026-09-20')).toBeUndefined()
  })
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
  test('weekly only for "all" and over 120 days', () => {
    expect(isWeekly('all', 121)).toBe(true)
    expect(isWeekly('all', 120)).toBe(false)
    expect(isWeekly('90d', 500)).toBe(false)
    const long = [row('2026-01-01', [part('a', 1)]), row('2026-09-30', [part('a', 1)])]
    const b = bucketsFor(long, { until: '2026-09-30' }, 'all')
    expect(b[0].weekly).toBe(true)
    expect(b.length).toBeLessThan(45)
    expect(b.reduce((a, x) => a + x.total, 0)).toBe(2)
    expect(bucketsFor(long, { since: '2026-09-01', until: '2026-09-30' }, '30d')[0].weekly).toBe(false)
  })
})

describe('stacks', () => {
  const models = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']
  const b: Bucket = {
    key: '2026-09-28',
    to: '2026-09-28',
    weekly: false,
    total: 0,
    reported: 6,
    attributed: 4,
    parts: [...models.map((m, i) => part(m, 10 - i)), part('(overhead)', 20)].sort((x, y) => y.totalUSD - x.totalUSD),
  }
  test('top five models by spend, (overhead) never among them', () => {
    expect(topModels([b])).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
  })
  test('the rest is "other", overhead on top, and the stack adds up', () => {
    const top = topModels([b])
    const s = stackOf(b, 'model', top)
    expect(s.map((x) => [x.key, x.tone])).toEqual([
      ['m1', 'series-1'],
      ['m2', 'series-2'],
      ['m3', 'series-3'],
      ['m4', 'series-4'],
      ['m5', 'series-5'],
      ['other', 'series-other'],
      ['(overhead)', 'overhead'],
    ])
    expect(s.find((x) => x.key === 'other')?.usd).toBe(5 + 4)
    expect(s.reduce((a, x) => a + x.usd, 0)).toBe(b.parts.reduce((a, p) => a + p.totalUSD, 0))
  })
  test('by source', () => {
    expect(stackOf(b, 'source', []).map((x) => [x.key, x.usd])).toEqual([
      ['reported', 6],
      ['attributed', 4],
    ])
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
    expect(segs[0].usd).toBeCloseTo(1.21)
    expect(segs[1].usd).toBeCloseTo(10.59)
    expect(barTotal(b, 'compaction')).toBeCloseTo(11.8)
    expect(barTotal(b, 'model')).toBe(40)
  })
  test('all warm: no cold segment; no compactions: an empty bar', () => {
    const warm = { ...b, compactions: { calls: 1, cold: 0, usd: 0.7, warmUSD: 0.7, uncoveredUSD: 0 } }
    expect(stackOf(warm, 'compaction', []).map((s) => s.key)).toEqual(['compaction-warm'])
    expect(stackOf({ ...b, compactions: undefined }, 'compaction', [])).toEqual([])
    expect(barTotal({ ...b, compactions: undefined }, 'compaction')).toBe(0)
  })
  test('the URL value', () => {
    expect(parseStack('compaction')).toBe('compaction')
    expect(parseStack('nonsense')).toBe('model')
  })
})
