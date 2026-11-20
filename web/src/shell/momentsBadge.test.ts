import { describe, expect, test } from 'bun:test'
import type { MomentsReport, MomentView } from '../api/types'
import { badgeCount, parseSeen } from './momentsBadge'

function moment(id: string, first?: string): MomentView {
  return {
    id,
    persona: 'boris',
    title: id,
    what: '',
    try: '',
    status: first ? 'habit' : 'unseen',
    hits: first ? 1 : 0,
    sessions: 0,
    weeks: 0,
    recentHits: 0,
    first,
  }
}

const report = (moments: MomentView[], suggestions: string[]): MomentsReport => ({
  now: '2026-11-01T00:00:00Z',
  windowDays: 28,
  sessions: 10,
  scripted: 0,
  projects: 1,
  personas: [],
  moments,
  suggestions: suggestions.map((moment) => ({ moment })),
})

describe('badgeCount', () => {
  const r = report([moment('a', '2026-09-01T00:00:00Z'), moment('b', '2026-10-20T00:00:00Z'), moment('c')], ['x', 'y'])
  test('the first visit counts the suggestions', () => {
    expect(badgeCount(r, undefined)).toBe(2)
  })
  test('moments first seen after the visit, and suggestions not seen yet', () => {
    expect(badgeCount(r, { at: '2026-10-01T00:00:00Z', suggestions: ['x'] })).toBe(2)
  })
  test('nothing new, nothing shown', () => {
    expect(badgeCount(r, { at: '2026-11-01T00:00:00Z', suggestions: ['x', 'y'] })).toBe(0)
  })
  test('an unseen moment never counts', () => {
    expect(badgeCount(report([moment('c')], []), { at: '2020-01-01T00:00:00Z', suggestions: [] })).toBe(0)
  })
})

describe('parseSeen', () => {
  test('reads what markSeen wrote', () => {
    expect(parseSeen('{"at":"2026-11-01T00:00:00Z","suggestions":["x"]}')).toEqual({
      at: '2026-11-01T00:00:00Z',
      suggestions: ['x'],
    })
  })
  test('anything else is no visit', () => {
    for (const raw of [null, '', 'x', '{}', '{"at":"nope","suggestions":[]}', '{"at":"2026-11-01T00:00:00Z"}'])
      expect(parseSeen(raw)).toBeUndefined()
  })
})
