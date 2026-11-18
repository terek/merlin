import { describe, expect, test } from 'bun:test'
import type { Agent } from '../../api/types'
import { type FindBranch, findHits, hitIndex, matchRanges, stepIndex } from './find'

const agent = (over: Partial<Agent>): Agent => ({ id: 'a1', ...over }) as Agent

function branch(): FindBranch {
  const a1 = agent({
    id: 'a1',
    startedAt: '2026-11-01T10:05:00Z',
    turns: [
      { index: 0, startedAt: '2026-11-01T10:05:00Z', prompt: 'Survey the Parser module', finalText: 'done' },
      { index: 1, startedAt: '2026-11-01T10:30:00Z', prompt: 'more', finalText: 'the parser is fine' },
    ] as Agent['turns'],
  })
  return {
    index: 0,
    model: {
      cols: [
        {
          index: 0,
          inherited: true,
          turn: { userText: 'parser from the parent', startedAt: '2026-11-01T09:00:00Z' },
          compactions: [],
        },
        {
          index: 1,
          inherited: false,
          turn: {
            userText: 'fix the PARSER',
            startedAt: '2026-11-01T10:00:00Z',
            queued: [{ at: '2026-11-01T10:01:00Z', origin: 'human', text: 'and the lexer' }],
            finalText: 'Fixed.',
          },
          compactions: [],
        },
        {
          index: 2,
          inherited: false,
          turn: { userText: 'next', startedAt: '2026-11-01T11:00:00Z', finalText: 'Now the lexer works' },
          compactions: [
            {
              at: '2026-11-01T11:30:00Z',
              turn: 2,
              summary: 'This session is being continued. The lexer was split.',
              boilerplate: [{ from: 0, to: 29 }],
            },
          ],
        },
      ],
      agentsById: new Map([['a1', a1]]),
      units: [
        { id: 'u1', launch: 1, ordinal: 1, agent: a1, nested: [] },
        { id: 'u2', launch: 2, ordinal: 2, agent: a1, nested: [] },
      ],
    },
  } as FindBranch
}

describe('matchRanges', () => {
  test('case-insensitive, non-overlapping', () => {
    expect(matchRanges('Aa aA', 'aa')).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 5 },
    ])
    expect(matchRanges('abc', '')).toEqual([])
  })
  test('a range of fixed wording is skipped', () => {
    expect(matchRanges('is being the', 'the', [{ from: 9, to: 12 }])).toEqual([])
  })
})

describe('findHits', () => {
  test('one hit per turn or piece of work, in time order; inherited turns are not searched', () => {
    const hits = findHits([branch()], 'parser')
    expect(hits.map((h) => [h.col, h.unit ?? null])).toEqual([
      [1, null],
      [1, 'u1'],
      [2, 'u2'],
    ])
  })
  test('queued prompts, final answers and summaries count; fixed wording does not', () => {
    expect(findHits([branch()], 'lexer').map((h) => [h.col, h.unit ?? null])).toEqual([
      [1, null],
      [2, null],
    ])
    expect(findHits([branch()], 'continued')).toEqual([])
    expect(findHits([branch()], '  ')).toEqual([])
    expect(findHits([branch()], 'nothing here')).toEqual([])
  })
})

describe('stepping', () => {
  test('wraps in both directions', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0)
    expect(stepIndex(-1, 3, -1)).toBe(2)
    expect(stepIndex(2, 3, 1)).toBe(0)
    expect(stepIndex(0, 3, -1)).toBe(2)
    expect(stepIndex(0, 0, 1)).toBe(-1)
  })
  test('the current hit is the pinned one', () => {
    const hits = findHits([branch()], 'parser')
    expect(hitIndex(hits, { branch: 0, col: 1 }, 'u1')).toBe(1)
    expect(hitIndex(hits, { branch: 0, col: 1 }, null)).toBe(0)
    expect(hitIndex(hits, null, null)).toBe(-1)
  })
})
