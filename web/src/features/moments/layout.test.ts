import { describe, expect, test } from 'bun:test'
import type { MomentView, SessionKey } from '../../api/types'
import { dayStart } from '../../lib/time'
import {
  activityArea,
  bucketDays,
  bucketTicks,
  daysPerBucket,
  EDGE_COL,
  EDGE_DAYS,
  FUTURE_W,
  LABEL_SPACE,
  layoutTimeline,
  monthTicks,
  seenMoments,
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

describe('layoutTimeline', () => {
  test('moments in the first week go to the edge stack, the others to markers by time', () => {
    const l = layoutTimeline(
      [moment('a', 0), moment('b', EDGE_DAYS - 1), moment('c', 20), moment('d', 40)],
      SINCE,
      NOW,
      1000,
    )
    expect(l.edge.map((m) => m.id)).toEqual(['a', 'b'])
    expect(l.markers.map((m) => m.moment.id)).toEqual(['c', 'd'])
    expect(l.markers[0].x).toBeLessThan(l.markers[1].x)
    expect(l.lanes).toBe(1)
  })

  test('unseen moments are not drawn', () => {
    const u = { ...moment('u', 30), status: 'unseen' as const, first: undefined }
    const l = layoutTimeline([u, moment('a', 30)], SINCE, NOW, 1000)
    expect(l.markers).toHaveLength(1)
  })

  test('markers whose labels would overlap stack in lanes, greedily', () => {
    // 600 px over about 70 days: a day is about 8 px, so these are 1 day apart
    const ms = [moment('a', 20), moment('b', 21), moment('c', 22), moment('d', 40)]
    const l = layoutTimeline(ms, SINCE, NOW, 600)
    expect(l.markers[0].lane).toBe(0)
    expect(l.markers[1].lane).toBe(1)
    expect(l.lanes).toBeGreaterThan(1)
    for (let lane = 0; lane < l.lanes; lane++) {
      const spans = l.markers
        .filter((m) => m.lane === lane)
        .map((m) => (m.flip ? [m.labelX - m.labelW, m.x] : [m.x, m.labelX + m.labelW]))
      for (let i = 1; i < spans.length; i++) expect(spans[i][0] - spans[i - 1][1]).toBeGreaterThanOrEqual(LABEL_SPACE)
    }
  })

  test('a label that would pass the right edge goes to the left of its marker', () => {
    const l = layoutTimeline([moment('a', 20), moment('z', 69)], SINCE, NOW, 600)
    expect(l.markers[0].flip).toBe(false)
    expect(l.markers[1].flip).toBe(true)
    expect(l.markers[1].labelX).toBeLessThan(l.markers[1].x)
  })

  test('x runs from the left pad to the right pad', () => {
    const l = layoutTimeline([], SINCE, NOW, 800)
    expect(xOf(l, Date.parse(SINCE))).toBe(12)
    expect(xOf(l, Date.parse(NOW))).toBe(788)
    expect(xOf(l, Date.parse(NOW) + DAY)).toBe(788)
  })
})

describe('activityArea', () => {
  const l = layoutTimeline([], SINCE, NOW, 800)
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
    const l = layoutTimeline([], SINCE, NOW, 1000)
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
    const k = (w: number) => daysPerBucket(layoutTimeline([], SINCE, NOW, w))
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
    const l = layoutTimeline([], SINCE, NOW, 1000)
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
    const l = layoutTimeline([], SINCE, NOW, 200)
    const m = (ds: string[]) => ({ ...moment('a', 20), days: days(ds.map((x) => [x, 2] as [string, number])) })
    const lone = bucketTicks(m(['2026-09-10']), l, SINCE)[0]
    expect(lone.x1 - lone.x0).toBeGreaterThanOrEqual(8)
    const [a, b] = bucketTicks(m(['2026-09-10', '2026-09-11']), l, SINCE)
    expect(a.x1).toBeLessThanOrEqual(b.x0 + 0.001)
  })

  test('the plot starts right of the edge column and stops before the future zone', () => {
    const edge = [moment('a', 0)]
    const l = layoutTimeline(edge, SINCE, NOW, 1000, true)
    expect(l.left).toBe(EDGE_COL)
    expect(l.right).toBe(1000 - FUTURE_W)
    expect(xOf(l, Date.parse(SINCE))).toBe(EDGE_COL + 12)
    expect(xOf(l, Date.parse(NOW))).toBe(1000 - FUTURE_W - 12)
    expect(layoutTimeline([], SINCE, NOW, 1000).left).toBe(0)
  })

  test('label widths come from the measure given: the flip and the lanes follow them', () => {
    const ms = [moment('a', 20), moment('b', 40)]
    const narrow = layoutTimeline(ms, SINCE, NOW, 800, false, () => 10)
    const wide = layoutTimeline(ms, SINCE, NOW, 800, false, () => 300)
    expect(narrow.markers[0].labelW).toBe(10)
    expect(narrow.lanes).toBe(1)
    expect(wide.markers[0].labelW).toBe(300)
    expect(wide.lanes).toBeGreaterThan(1)
  })
})
