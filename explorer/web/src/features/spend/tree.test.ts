import { describe, expect, test } from 'bun:test'
import type { Message, SessionDetail, Turn } from '../../api/types'
import { buildTree, shortTitle, topTreeDecisions } from './tree'

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, min)).toISOString()

const turn = (index: number, contextTokens: number, extra: Partial<Turn> = {}): Turn => ({
  index,
  epoch: 0,
  origin: 'human',
  userText: `prompt ${index}`,
  startedAt: at(index * 2),
  endedAt: at(index * 2 + 1),
  assistantMessages: 1,
  toolCalls: 0,
  cost: { usd: 0 },
  costWithAgents: 0,
  contextTokens,
  ...extra,
})

const msg = (id: string, turnIndex: number, usd: number): Message => ({
  id,
  at: at(turnIndex * 2),
  model: 'model-a',
  turn: turnIndex,
  usd,
  output: 100,
})

/** A session with one message of `usd[i]` dollars in turn i; `parent` makes it a fork. */
const session = (
  id: string,
  usd: number[],
  parent?: { id: string; atTurn: number; inherited: number[]; kind?: 'fork' | 'continuation' },
) =>
  ({
    summary: { key: { harness: 'claude', id }, title: `session ${id}` },
    cost: { overheadUSD: 0 },
    lineage: {
      parent: parent && {
        parent: { harness: 'claude', id: parent.id },
        child: { harness: 'claude', id },
        atTurn: parent.atTurn,
        kind: parent.kind ?? 'fork',
      },
      children: [],
      inheritedTurns: parent?.inherited ?? [],
    },
    digest: {
      turns: usd.map((_, i) => turn(i, 1000 * (i + 1))),
      messages: usd.map((v, i) => msg(`${id}-${i}`, i, v)),
      agents: [],
      compactions: [],
    },
  }) as unknown as SessionDetail

describe('buildTree', () => {
  // the trunk has four turns; A copied turns 0-1 and added two; B copied 0-2 and added one;
  // C continued from A after A's last turn, and its copies are not at the front of its transcript
  const trunk = session('t', [1, 2, 3, 4])
  const a = session('a', [1, 2, 10, 20], { id: 't', atTurn: 1, inherited: [0, 1] })
  const b = session('b', [1, 2, 3, 7], { id: 't', atTurn: 2, inherited: [0, 1, 2] })
  const c = session('c', [5, 10, 20, 6], { id: 'a', atTurn: 3, inherited: [1, 2], kind: 'continuation' })
  const tree = buildTree([c, a, trunk, b])

  test('a parent comes before its children, whatever the order given', () => {
    expect(tree.branches.map((x) => x.key.id)).toEqual(['t', 'a', 'c', 'b'])
    expect(tree.branches.map((x) => [x.parent, x.depth, x.kind])).toEqual([
      [undefined, 0, undefined],
      [0, 1, 'fork'],
      [1, 2, 'continuation'],
      [0, 1, 'fork'],
    ])
  })

  test('a branch has only its own turns', () => {
    expect(tree.branches.map((x) => x.own)).toEqual([[0, 1, 2, 3], [2, 3], [0, 3], [3]])
  })

  test("nothing is counted twice: the total is every branch's own spend", () => {
    expect(tree.branches.map((x) => x.model.total)).toEqual([10, 30, 11, 7])
    expect(tree.total).toBe(58)
    expect(tree.byKind.map((p) => [p.key, p.usd])).toEqual([['main', 58]])
  })

  test('decisions are ranked over the whole tree, and a fork starts one of its own', () => {
    const top = topTreeDecisions(tree, 3)
    expect(top.map((x) => [x.branch.key.id, x.decision.start, x.decision.usd])).toEqual([
      ['a', 3, 20],
      ['a', 2, 10],
      ['b', 3, 7],
    ])
  })

  test('a session whose parent did not load is a trunk of its own', () => {
    const alone = buildTree([a])
    expect(alone.branches.map((x) => [x.parent, x.depth, x.own])).toEqual([[undefined, 0, [2, 3]]])
  })
})

describe('shortTitle', () => {
  test('one line, cut with an ellipsis', () => {
    expect(shortTitle('fix the build\nand more')).toBe('fix the build')
    expect(shortTitle('a'.repeat(80), 10)).toBe(`${'a'.repeat(9)}…`)
  })
})

describe('overhead', () => {
  const base = session('o', [4, 6])
  const s = {
    ...base,
    cost: {
      overheadUSD: 2,
      windows: [
        { from: at(0), to: at(3), totalUSD: 12, coveredUSD: 10, overheadUSD: 2 },
        { from: at(4), to: at(5), totalUSD: 1, coveredUSD: 1, overheadUSD: 0.001 },
        { from: at(6), to: at(7), totalUSD: 1, coveredUSD: 2, overheadUSD: -1 },
      ],
    },
  } as unknown as SessionDetail
  const tree = buildTree([s])

  test('a window that reported more than its messages is a band of its own', () => {
    expect(tree.branches[0].overhead).toEqual([
      { t0: Date.parse(at(0)), t1: Date.parse(at(3)), usd: 2, reportedUSD: 12, coveredUSD: 10 },
    ])
  })

  test('with the messages it adds up to what the harness reported', () => {
    expect(tree.total).toBe(10)
    expect(tree.overheadUSD).toBe(2)
  })
})
