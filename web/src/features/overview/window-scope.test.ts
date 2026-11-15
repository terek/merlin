import { describe, expect, test } from 'bun:test'
import {
  customLabel,
  customPhrase,
  customWindow,
  formatCustom,
  instantRange,
  isWindowRange,
  parseCustom,
  parseInstant,
  stampText,
  windowLength,
} from './model'

const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m).getTime()

describe('a limit window as a scope', () => {
  test('parseInstant takes RFC 3339 instants only', () => {
    expect(parseInstant('2026-11-13T10:00:00Z')).toBe(Date.parse('2026-11-13T10:00:00Z'))
    expect(parseInstant('2026-11-13')).toBeNull()
    expect(parseInstant('nonsense')).toBeNull()
    expect(parseInstant(null)).toBeNull()
  })

  test('parseCustom reads an instant pair and the harness; a day pair stays a day range', () => {
    const r = parseCustom('2026-11-13T10:00:00Z', '2026-11-13T15:00:00Z', 'codex')
    expect(r?.fromMs).toBe(Date.parse('2026-11-13T10:00:00Z'))
    expect(r?.toMs).toBe(Date.parse('2026-11-13T15:00:00Z'))
    expect(r?.harness).toBe('codex')
    expect(r && isWindowRange(r)).toBe(true)
    const d = parseCustom('2026-11-10', '2026-11-12', 'codex')
    expect(d).toEqual({ from: '2026-11-10', to: '2026-11-12' })
    expect(d && isWindowRange(d)).toBe(false)
  })

  test('out-of-order instants and a mixed pair are no range; a bad harness is dropped', () => {
    expect(parseCustom('2026-11-13T15:00:00Z', '2026-11-13T10:00:00Z')).toBeNull()
    expect(parseCustom('2026-11-13T10:00:00Z', '2026-11-14')).toBeNull()
    expect(parseCustom('2026-11-13T10:00:00Z', '2026-11-13T15:00:00Z', '../x')?.harness).toBeUndefined()
  })

  test('formatCustom round-trips a window and drops it for a day range', () => {
    const r = instantRange(Date.parse('2026-11-13T10:00:00Z'), Date.parse('2026-11-13T15:00:00Z'), 'claude')
    expect(formatCustom(r)).toEqual({ from: '2026-11-13T10:00:00Z', to: '2026-11-13T15:00:00Z', harness: 'claude' })
    const f = formatCustom(r)
    expect(parseCustom(f.from ?? null, f.to ?? null, f.harness)).toEqual(r)
    expect(formatCustom({ from: '2026-11-10', to: '2026-11-12' }).harness).toBeUndefined()
    expect(formatCustom(null).harness).toBeUndefined()
  })

  test('the days a window touches', () => {
    const r = instantRange(at(22), at(26))
    expect(r.from).toBe('2026-11-13')
    expect(r.to).toBe('2026-11-14')
  })

  test('label, phrase and window', () => {
    const r = instantRange(at(10), at(15), 'codex')
    expect(stampText(at(10))).toBe('Fri 13, 10:00')
    expect(customLabel(r, new Date(2026, 10, 15))).toBe('Fri 13, 10:00 → 5h')
    expect(customPhrase(r, new Date(2026, 10, 15))).toContain('window')
    expect(customWindow(r, at(23))).toEqual({ fromMs: at(10), toMs: at(15) })
    expect(customWindow(r, at(12))).toEqual({ fromMs: at(10), toMs: at(12) })
  })

  test('windowLength', () => {
    expect(windowLength(45 * 60_000)).toBe('45m')
    expect(windowLength(5 * 3_600_000)).toBe('5h')
    expect(windowLength(7 * 86_400_000)).toBe('7d')
  })
})
