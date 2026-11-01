import { describe, expect, test } from 'bun:test'
import type { MomentsReport, MomentView, PersonaView } from '../../api/types'
import {
  cardColumns,
  cardHandle,
  cardStats,
  cardSummary,
  decodePayload,
  encodePayload,
  groupByStatus,
  historyLength,
  sharePayload,
} from './model'

function moment(
  id: string,
  persona: MomentView['persona'],
  status: MomentView['status'],
  weeks = 0,
  extra = {},
): MomentView {
  return {
    id,
    persona,
    title: id,
    what: '',
    try: '',
    status,
    hits: weeks * 2,
    sessions: weeks,
    weeks,
    recentHits: 0,
    ...extra,
  }
}

function persona(id: PersonaView['id'], reaction: string): PersonaView {
  return { id, name: id, focus: '', reaction, reason: '', habits: 0, explored: 0, unseen: 0, new: 0 }
}

const report: MomentsReport = {
  now: '2026-11-01T00:00:00Z',
  windowDays: 28,
  sessions: 10,
  scripted: 0,
  projects: 3,
  personas: [persona('karpathy', '👏'), persona('boris', '🚀'), persona('yegge', '👀')],
  moments: [
    moment('k1', 'karpathy', 'habit', 3),
    moment('k2', 'karpathy', 'habit', 9),
    moment('k3', 'karpathy', 'habit', 5),
    moment('k4', 'karpathy', 'habit', 4),
    moment('k5', 'karpathy', 'explored', 1, { new: true }),
    moment('b1', 'boris', 'explored', 1),
    moment('b2', 'boris', 'unseen'),
    moment('y1', 'yegge', 'unseen'),
  ],
  suggestions: [],
}

describe('groupByStatus', () => {
  test('orders habits by weeks', () => {
    const g = groupByStatus(report.moments)
    expect(g.habits.map((m) => m.id)).toEqual(['k2', 'k3', 'k4', 'k1'])
    expect(g.explored.map((m) => m.id)).toEqual(['b1', 'k5'])
    expect(g.unseen.map((m) => m.id)).toEqual(['b2', 'y1'])
  })
})

describe('cardColumns', () => {
  test('keeps room for a new moment', () => {
    const [k, b, y] = cardColumns(report)
    expect(k.items.map((i) => i.id)).toEqual(['k2', 'k3', 'k5'])
    expect(k.more).toBe(2)
    expect(b.items.map((i) => i.id)).toEqual(['b1'])
    expect(y.items).toEqual([])
  })
  test('summary', () => {
    expect(cardSummary(report)).toEqual({ seen: 6, total: 8, habits: 4, fresh: 1 })
  })
})

describe('card stats', () => {
  const now = '2026-11-01T00:00:00Z'
  const ago = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString()
  test('history length picks a readable unit', () => {
    expect(historyLength(undefined, now)).toBeNull()
    expect(historyLength(ago(0), now)).toEqual({ value: '1', label: 'day' })
    expect(historyLength(ago(10), now)).toEqual({ value: '10', label: 'days' })
    expect(historyLength(ago(30), now)).toEqual({ value: '4', label: 'weeks' })
    expect(historyLength(ago(420), now)).toEqual({ value: '14', label: 'months' })
    expect(historyLength(ago(1000), now)).toEqual({ value: '2.5', label: 'years' })
  })
  test('sessions leave scripted runs out', () => {
    const r = { ...report, sessions: 1250, scripted: 50, since: ago(30) }
    expect(cardStats(r)).toEqual([
      { value: '1,200', label: 'sessions' },
      { value: '3', label: 'projects' },
      { value: '4', label: 'weeks' },
    ])
  })
})

describe('share payload', () => {
  test('carries ids and statuses only, and survives a round trip', () => {
    const p = sharePayload(report, ' @zs ')
    expect(p).toEqual({
      h: '@zs',
      r: ['👏', '🚀', '👀'],
      m: { k1: 'h', k2: 'h', k3: 'h', k4: 'h', k5: 'e', b1: 'e' },
      n: ['k5'],
    })
    const known = new Set(report.moments.map((m) => m.id))
    expect(decodePayload(encodePayload(p), known)).toEqual(p)
  })
  test('drops ids it does not know', () => {
    const p = sharePayload(report, '')
    const d = decodePayload(encodePayload(p), new Set(['k1', 'k5']))
    expect(d?.m).toEqual({ k1: 'h', k5: 'e' })
    expect(d?.n).toEqual(['k5'])
    expect(d?.h).toBeUndefined()
  })
  test('rejects garbage', () => {
    expect(decodePayload('not base64 !!', new Set())).toBeUndefined()
    expect(decodePayload(encodePayload({ r: [], m: {}, n: [] }).slice(0, 3), new Set())).toBeUndefined()
  })
})

test('cardHandle', () => {
  expect(cardHandle('  @@zsolt ')).toBe('@zsolt')
  expect(cardHandle('')).toBe('')
  expect(cardHandle('x'.repeat(40))).toHaveLength(25)
})
