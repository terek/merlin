import { describe, expect, test } from 'bun:test'
import { callLine, coldExtra, idleText, tallyLine, warmLine } from './compaction'

describe('compaction cost text', () => {
  const cold = {
    model: 'm',
    idleMs: 31_380_000,
    cache: 'cold' as const,
    billing: 'input',
    inputTokens: 1,
    outputTokens: 1,
    usd: 5.02,
    warmUSD: 0.4,
  }
  const warm = { ...cold, cache: 'warm' as const, billing: 'cache-read', usd: 0.4, idleMs: 120_000 }
  test('idle gaps', () => {
    expect(idleText(120_000)).toBe('2 min')
    expect(idleText(20_000)).toBe('1 min')
    expect(idleText(31_380_000)).toBe(formatDurationLike(31_380_000))
  })
  test('a cold call says why and what warm would have cost', () => {
    expect(callLine(cold)).toBe(
      `call ~$5.02: cold cache after ${idleText(31_380_000)} idle, the context was read again at the plain input price; warm it would have cost ~$0.40`,
    )
    expect(callLine(warm)).toBe('call ~$0.40, cache warm')
    expect(coldExtra(cold)).toBeCloseTo(4.62)
    expect(coldExtra(warm)).toBe(0)
  })
  test('tallies', () => {
    const t = { calls: 81, cold: 34, usd: 125.64, warmUSD: 22.08, uncoveredUSD: 78.94 }
    expect(tallyLine(t)).toBe('~$126 for 81 compactions, 34 cold')
    expect(warmLine(t)).toBe('with a warm cache every time: ~$22.08')
    expect(tallyLine({ ...t, calls: 1, cold: 0 })).toBe('~$126 for 1 compaction')
    expect(warmLine({ ...t, cold: 0 })).toBe('')
  })
})

function formatDurationLike(ms: number): string {
  // the same helper the module uses; the test only pins that long gaps use it
  return idleText(ms)
}
