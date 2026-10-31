import { expect, test } from 'bun:test'
import type { Agent, SessionCost } from '../api/types'
import {
  agentCostSplit,
  backingLowerBound,
  backingSentence,
  estimateNote,
  flagExplanation,
  flagMarkers,
  lowerBoundNote,
  sessionCostSegments,
  sessionsLowerBound,
  weakestFlag,
} from './cost'

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
  expect(backingSentence({ exact: 2, partial: 0, estimated: 3, scriptedRuns: 0, lowerBound: 2 })).toBe(
    '2 sessions exact, 3 estimated; 2 only a lower bound',
  )
})

test('lower bound notes', () => {
  expect(lowerBoundNote()).toBe('')
  expect(lowerBoundNote(3)).toBe('A lower bound: 3 messages cut short in the transcript (partial output tokens).')
  expect(lowerBoundNote(0, 1)).toBe('A lower bound: 1 message on a model without a price (counted as $0).')
  // only sessions flagged lowerBound count: inside a reported window an unpriced message does not matter
  expect(
    sessionsLowerBound([
      { lowerBound: true, unpricedMessages: 1 },
      { unpricedMessages: 5 },
      { lowerBound: true, unpricedMessages: 3 },
    ]),
  ).toBe('A lower bound: 4 messages on a model without a price (counted as $0).')
  expect(sessionsLowerBound([{ unpricedMessages: 5 }])).toBe('')
  expect(backingLowerBound({ exact: 1, partial: 0, estimated: 0, scriptedRuns: 0 })).toBe('')
})

test('estimate notes', () => {
  expect(estimateNote(0, 3)).toBe('')
  expect(estimateNote(0.004, 1)).toBe(
    'Includes <$0.01 estimated for the output of 1 message cut short in the transcript.',
  )
  expect(estimateNote(0.25, 2)).toBe(
    'Includes ~$0.25 estimated for the output of 2 messages cut short in the transcript.',
  )
})

test('cost segments carry the estimates', () => {
  const cost = {
    bestUSD: 6.5,
    flag: 'partial',
    reportedUSD: 5,
    ownUSD: 5.5,
    coveredUSD: 4,
    uncoveredUSD: 1,
    overheadUSD: 1,
    estimatedCoveredUSD: 0.75,
    estimatedUncoveredUSD: 0.5,
    rateDiffUSD: 0.125,
    inheritedUSD: 0,
    ownMessages: 3,
    inheritedMessages: 0,
  } satisfies SessionCost
  const segs = sessionCostSegments(cost)
  expect(segs.map((s) => s.usd)).toEqual([4.875, 0.125, 1.5])
  expect(segs.reduce((a, s) => a + s.usd, 0)).toBe(cost.bestUSD)
})

test('weakest flag', () => {
  expect(weakestFlag(['exact', 'partial'])).toBe('partial')
  expect(weakestFlag(['exact', 'estimated', 'partial'])).toBe('estimated')
  expect(weakestFlag([])).toBeUndefined()
})
