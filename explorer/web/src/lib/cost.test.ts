import { expect, test } from 'bun:test'
import type { Agent, SessionCost } from '../api/types'
import { agentCostSplit, backingSentence, flagExplanation, flagMarkers, sessionCostSegments, weakestFlag } from './cost'

test('flag markers', () => {
  expect(flagMarkers('exact')).toEqual({ prefix: '', suffix: '' })
  expect(flagMarkers('partial')).toEqual({ prefix: '', suffix: '+est' })
  expect(flagMarkers('estimated')).toEqual({ prefix: '~', suffix: '' })
  expect(flagMarkers(undefined)).toEqual({ prefix: '', suffix: '' })
  expect(flagExplanation('partial')).toContain('Partly reported')
  expect(flagExplanation(undefined)).toBe('')
})

test('segments add up to the best cost', () => {
  const c = { bestUSD: 1.1, coveredUSD: 0.9, uncoveredUSD: 0.1, overheadUSD: 0.1 } as SessionCost
  const segs = sessionCostSegments(c)
  expect(segs.map((s) => s.key)).toEqual(['reported', 'overhead', 'attributed'])
  expect(segs.reduce((a, s) => a + s.usd, 0)).toBeCloseTo(c.bestUSD)
})

test('agent split', () => {
  const agents = [{ cost: { usd: 0.25 } }, { cost: { usd: 0.25 } }] as Agent[]
  expect(agentCostSplit({ cost: { usd: 1 }, agents })).toEqual({ main: 0.5, agents: 0.5 })
  expect(agentCostSplit({ cost: { usd: 1 } })).toEqual({ main: 1, agents: 0 })
  expect(agentCostSplit({ cost: { usd: 0.1 }, agents }).main).toBe(0)
})

test('backing sentence', () => {
  expect(backingSentence({ exact: 69, partial: 5, estimated: 149, scriptedRuns: 3132 })).toBe(
    '69 sessions exact, 5 partial, 149 estimated, 3,132 scripted runs',
  )
  expect(backingSentence({ exact: 0, partial: 0, estimated: 1, scriptedRuns: 1 })).toBe(
    '1 session estimated, 1 scripted run',
  )
  expect(backingSentence({ exact: 0, partial: 0, estimated: 0, scriptedRuns: 0 })).toBe('no sessions')
})

test('weakest flag', () => {
  expect(weakestFlag(['exact', 'partial'])).toBe('partial')
  expect(weakestFlag(['exact', 'estimated', 'partial'])).toBe('estimated')
  expect(weakestFlag([])).toBeUndefined()
})
