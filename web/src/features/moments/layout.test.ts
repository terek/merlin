import { describe, expect, test } from 'bun:test'
import type { MomentView } from '../../api/types'
import { activityArea, dayTicks, EDGE_DAYS, layoutTimeline, MARKER_GAP, monthTicks, seenMoments, xOf } from './layout'

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

  test('markers that would overlap stack in lanes, greedily', () => {
    // 600 px over about 70 days: a day is about 8 px, so these are 1 day apart
    const ms = [moment('a', 20), moment('b', 21), moment('c', 22), moment('d', 40)]
    const l = layoutTimeline(ms, SINCE, NOW, 600)
    expect(l.markers.map((m) => m.lane)).toEqual([0, 1, 0, 0])
    expect(l.lanes).toBe(2)
    for (const lane of [0, 1]) {
      const xs = l.markers.filter((m) => m.lane === lane).map((m) => m.x)
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(MARKER_GAP)
    }
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
  test('day ticks scale to the busiest day', () => {
    const l = layoutTimeline([], SINCE, NOW, 1000)
    const m = {
      ...moment('a', 0),
      days: [
        { day: '2026-09-01', hits: 2 },
        { day: '2026-09-02', hits: 4 },
      ],
    }
    expect(dayTicks(m, l).map((t) => t.h)).toEqual([0.5, 1])
  })
  test('seenMoments is ordered by first hit', () => {
    expect(seenMoments([moment('b', 5), moment('a', 1)]).map((m) => m.id)).toEqual(['a', 'b'])
  })
})
