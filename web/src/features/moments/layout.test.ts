import { describe, expect, test } from 'bun:test'
import type { MomentView, SessionKey } from '../../api/types'
import { dayStart } from '../../lib/time'
import {
  activityArea,
  bucketDays,
  bucketTicks,
  clickSort,
  DEFAULT_SORT,
  daysPerBucket,
  firstDir,
  fitText,
  formatSort,
  layoutRows,
  MAX_DAYS,
  monthTicks,
  parseSort,
  placeSuggestions,
  plotStart,
  ROW_GLYPH_W,
  seenMoments,
  sortMoments,
  TITLE_MAX,
  TITLE_MIN,
  xOf,
} from './layout'

const SINCE = '2026-08-24T09:00:00Z'
const NOW = '2026-11-01T18:00:00Z'
const DAY = 86_400_000

function moment(id: string, daysIn: number, status: MomentView['status'] = 'habit'): MomentView {
  return {
    id,
    persona: 'boris',
    title: id,
    what: '',
    try: '',
    status,
    hits: 1,
    sessions: 1,
    weeks: 1,
    recentHits: 0,
    first: new Date(Date.parse(SINCE) + daysIn * DAY).toISOString(),
  }
}

/** A layout without a label column, to test the arithmetic of the plot by itself. */
const plain = (w: number) => ({ ...layoutRows([], SINCE, NOW, w), left: 0 })

describe('layoutRows', () => {
  test('x runs from the left pad to the right pad', () => {
    const l = plain(800)
    expect(xOf(l, Date.parse(SINCE))).toBe(12)
    expect(xOf(l, Date.parse(NOW))).toBe(788)
    expect(xOf(l, Date.parse(NOW) + DAY)).toBe(788)
  })
  test('one row per seen moment, by first hit; unseen moments have none', () => {
    const rows = layoutRows(
      [
        moment('late', 40),
        moment('edge', 2),
        { ...moment('u', 0), status: 'unseen', first: undefined },
        moment('mid', 20),
      ],
      SINCE,
      NOW,
      900,
    ).rows
    expect(rows.map((m) => m.id)).toEqual(['edge', 'mid', 'late'])
  })
  test('the title column follows the longest label, within bounds, and the plot runs to now', () => {
    const ms = [moment('a', 1)]
    const title = (l: ReturnType<typeof layoutRows>) => l.cols.category - ROW_GLYPH_W
    expect(title(layoutRows(ms, SINCE, NOW, 900, () => 10))).toBe(TITLE_MIN)
    expect(title(layoutRows(ms, SINCE, NOW, 900, () => 1000))).toBe(TITLE_MAX)
    const l = layoutRows(ms, SINCE, NOW, 900, () => 150)
    expect(title(l)).toBe(158)
    expect(l.left).toBeGreaterThan(l.cols.countRight)
    expect(l.right).toBe(900)
  })
  test('sorting: by column, ties by start then title, the input untouched', () => {
    const mk = (id: string, hits: number, first: string, last: string, category: string) =>
      ({ id, title: id, status: 'habit', hits, first, last, category, weeks: 1 }) as unknown as MomentView
    const ms = [
      mk('b', 5, '2026-09-02T00:00:00Z', '2026-10-30T00:00:00Z', 'harness'),
      mk('a', 9, '2026-09-05T00:00:00Z', '2026-10-01T00:00:00Z', 'prompt'),
      mk('c', 5, '2026-09-01T00:00:00Z', '2026-10-15T00:00:00Z', 'harness'),
    ]
    const ids = (s: Parameters<typeof sortMoments>[1]) => sortMoments(ms, s).map((m) => m.id)
    expect(ids(DEFAULT_SORT)).toEqual(['c', 'b', 'a'])
    expect(ids({ key: 'moment', dir: 'asc' })).toEqual(['a', 'b', 'c'])
    expect(ids({ key: 'count', dir: 'desc' })).toEqual(['a', 'c', 'b'])
    expect(ids({ key: 'category', dir: 'asc' })).toEqual(['c', 'b', 'a'])
    expect(ids({ key: 'end', dir: 'desc' })).toEqual(['b', 'c', 'a'])
    expect(ids({ key: 'end', dir: 'asc' })).toEqual(['a', 'c', 'b'])
    expect(ms.map((m) => m.id)).toEqual(['b', 'a', 'c'])
  })
  test('the sort in the URL: parsed, formatted, dropped at the default, flipped by a second click', () => {
    expect(parseSort(null)).toEqual(DEFAULT_SORT)
    expect(parseSort('-count')).toEqual({ key: 'count', dir: 'desc' })
    expect(parseSort('bogus')).toEqual(DEFAULT_SORT)
    expect(parseSort('depth')).toEqual({ key: 'depth', dir: 'asc' })
    expect(formatSort({ key: 'depth', dir: 'desc' })).toBe('-depth')
    expect(formatSort(DEFAULT_SORT)).toBeNull()
    expect(formatSort({ key: 'start', dir: 'desc' })).toBe('-start')
    expect(formatSort({ key: 'count', dir: 'desc' })).toBe('-count')
    expect(clickSort(DEFAULT_SORT, 'count')).toEqual({ key: 'count', dir: 'desc' })
    expect(clickSort({ key: 'count', dir: 'desc' }, 'count')).toEqual({ key: 'count', dir: 'asc' })
    expect(clickSort(DEFAULT_SORT, 'start')).toEqual({ key: 'start', dir: 'desc' })
  })
  test('a suggestion for a seen moment adds no row and marks the seen row', () => {
    const mk = (id: string, status: 'habit' | 'unseen', first?: string) =>
      ({ id, title: id, status, first, hits: 1, weeks: 1 }) as unknown as MomentView
    const ms = [mk('a', 'habit', '2026-09-01T00:00:00Z'), mk('b', 'unseen')]
    const out = placeSuggestions(ms, [{ moment: 'a' }, { moment: 'b' }, { moment: 'gone' }])
    expect([...out.again.keys()]).toEqual(['a'])
    expect(out.rows.map((r) => r.m.id)).toEqual(['b'])
  })
  test('depth sorts deepest first, ties by start', () => {
    const mk = (id: string, depth: string, first: string) =>
      ({ id, title: id, status: 'habit', depth, first, hits: 1, weeks: 1 }) as unknown as MomentView
    const ms = [
      mk('t', 'tried', '2026-09-01T00:00:00Z'),
      mk('n', 'new', '2026-09-02T00:00:00Z'),
      mk('r2', 'routine', '2026-09-05T00:00:00Z'),
      mk('p', 'paused', '2026-09-03T00:00:00Z'),
      mk('r1', 'routine', '2026-09-04T00:00:00Z'),
    ]
    const ids = (dir: 'asc' | 'desc') => sortMoments(ms, { key: 'depth', dir }).map((m) => m.id)
    expect(ids('asc')).toEqual(['r1', 'r2', 'p', 'n', 't'])
    expect(ids('desc')).toEqual(['t', 'n', 'p', 'r1', 'r2'])
    expect(firstDir('depth')).toBe('asc')
  })
  test('rows are ordered by the real first hit, not by the clamped x', () => {
    const mk = (id: string, first: string) =>
      ({ id, title: id, status: 'habit', first, hits: 1, weeks: 1, days: [] }) as unknown as MomentView
    // all three began before the plot start (a year before NOW), so their x positions are equal
    const ms = [mk('c', '2024-03-01T00:00:00Z'), mk('a', '2024-05-01T00:00:00Z'), mk('b', '2024-04-01T00:00:00Z')]
    const l = layoutRows(ms, '2024-01-01T00:00:00Z', NOW, 900, (t) => t.length * 7)
    expect(l.rows.map((m) => m.id)).toEqual(['c', 'b', 'a'])
  })
  test('the axis never covers more than a year', () => {
    // a history of 70 days is drawn whole; one of 500 days from a year before now
    expect(plotStart(SINCE, NOW)).toBe(new Date(SINCE).toISOString())
    const old = '2025-06-01T00:00:00Z'
    expect(Date.parse(NOW) - Date.parse(plotStart(old, NOW))).toBe(MAX_DAYS * DAY)
    expect(layoutRows([], old, NOW, 900).from).toBe(Date.parse(NOW) - MAX_DAYS * DAY)
    expect(layoutRows([], SINCE, NOW, 900).from).toBe(Date.parse(SINCE))
  })
  test('days before the plot start are not bucketed', () => {
    const d = (day: string) => ({ day, hits: 1 })
    const out = bucketDays([d('2026-08-20'), d('2026-08-25'), d('2026-08-26')], '2026-08-24T09:00:00Z', 1)
    expect(out.map((b) => b.day)).toEqual(['2026-08-25', '2026-08-26'])
  })
  test('fitText ellipsises to the room', () => {
    const m = (t: string) => t.length * 10
    expect(fitText('short', 100, m)).toBe('short')
    expect(fitText('a long label here', 100, m)).toBe('a long la…')
    expect(m(fitText('a long label here', 100, m))).toBeLessThanOrEqual(100)
  })
})

describe('activityArea', () => {
  const l = plain(800)
  test('empty without prompts', () => {
    expect(activityArea([], l, SINCE, NOW)).toEqual([])
  })
  test('one point per day, scaled to the busiest', () => {
    const pts = activityArea([{ day: '2026-08-30', prompts: 10 }], l, SINCE, NOW, 1)
    expect(pts.length).toBeGreaterThan(60)
    expect(Math.max(...pts.map((p) => p.v))).toBe(1)
    expect(pts[0].v).toBe(0)
  })
  test('averages over the window', () => {
    const pts = activityArea([{ day: '2026-08-30', prompts: 7 }], l, SINCE, NOW, 7)
    expect(Math.max(...pts.map((p) => p.v))).toBe(1)
    expect(pts.filter((p) => p.v > 0)).toHaveLength(7)
  })
})

describe('month labels and ticks', () => {
  test('a label at the start of each month inside the axis, the year on the first', () => {
    const l = plain(1000)
    expect(monthTicks(l).map((t) => t.label)).toEqual(['Sep 2026', 'Oct', 'Nov'])
  })
  test('seenMoments is ordered by first hit', () => {
    expect(seenMoments([moment('b', 5), moment('a', 1)]).map((m) => m.id)).toEqual(['a', 'b'])
  })
})

describe('event strip buckets', () => {
  const days = (xs: [string, number][]) =>
    xs.map(([day, hits]) => ({ day, hits, example: { at: day, session: day as unknown as SessionKey, turn: hits } }))
  test('days per bucket follows the width: a square is at least 4 px wide', () => {
    const k = (w: number) => daysPerBucket(plain(w))
    expect(k(1200)).toBe(1)
    expect(k(400)).toBe(1)
    expect(k(200)).toBe(2)
    expect(k(100)).toBe(4)
  })
  test('buckets are aligned to the first day, sum their hits and keep the busiest day example (the latest on a tie)', () => {
    const d = days([
      ['2026-08-24', 1],
      ['2026-08-25', 3],
      ['2026-08-26', 3],
      ['2026-08-28', 2],
      ['2026-09-10', 5],
    ])
    const b = bucketDays(d, SINCE, 3)
    expect(b.map((x) => [x.day, x.end, x.hits])).toEqual([
      ['2026-08-24', '2026-08-26', 7],
      ['2026-08-27', '2026-08-29', 2],
      ['2026-09-08', '2026-09-10', 5],
    ])
    expect(b[0].example?.at).toBe('2026-08-26')
    expect(b[0].h).toBeCloseTo(1)
    expect(b[1].h).toBeCloseTo(2 / 7)
  })
  test('with k = 1 every active day is a bucket, centred in its day when the day is wider than a square', () => {
    const l = plain(1000)
    const m = {
      ...moment('a', 20),
      days: days([
        ['2026-09-10', 2],
        ['2026-09-11', 2],
      ]),
    }
    const [a, c] = bucketTicks(m, l, SINCE)
    expect(a.day).toBe('2026-09-10')
    expect(a.x).toBeGreaterThan(xOf(l, dayStart('2026-09-10').getTime()))
    expect(c.x - a.x).toBeGreaterThan(4)
  })
  test('a lone bucket is at least 8 px wide; neighbours share the gap, the nearest winning', () => {
    const l = plain(200)
    const m = (ds: string[]) => ({ ...moment('a', 20), days: days(ds.map((x) => [x, 2] as [string, number])) })
    const lone = bucketTicks(m(['2026-09-10']), l, SINCE)[0]
    expect(lone.x1 - lone.x0).toBeGreaterThanOrEqual(8)
    const [a, b] = bucketTicks(m(['2026-09-10', '2026-09-11']), l, SINCE)
    expect(a.x1).toBeLessThanOrEqual(b.x0 + 0.001)
  })
})
