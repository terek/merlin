import { describe, expect, test } from 'bun:test'
import { instantRange } from '../overview/model'
import { changeAgainst, costRange, previousWindow } from './lens'

const H = 3_600_000
const w = instantRange(Date.parse('2026-11-13T10:00:00Z'), Date.parse('2026-11-13T15:00:00Z'), 'codex')

describe('a limit window on the Cost page', () => {
  test('costRange asks for instants, the end capped at now; days stay days', () => {
    expect(costRange(w)).toEqual({ since: '2026-11-13T10:00:00.000Z', until: '2026-11-13T15:00:00.000Z' })
    expect(costRange(w, Date.parse('2026-11-13T12:00:00Z')).until).toBe('2026-11-13T12:00:00.000Z')
    expect(costRange({ from: '2026-11-10', to: '2026-11-12' })).toEqual({ since: '2026-11-10', until: '2026-11-12' })
  })

  test('the window before is as long, ends where it starts, and keeps the harness', () => {
    const p = previousWindow(w)
    expect(p.toMs).toBe(w.fromMs)
    expect((p.toMs ?? 0) - (p.fromMs ?? 0)).toBe(5 * H)
    expect(p.harness).toBe('codex')
  })

  test('the change can name the period before', () => {
    expect(changeAgainst(150, 100, 1, 'the 5h before')?.text).toContain('the 5h before')
  })
})
