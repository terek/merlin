// A session and the sessions forked or continued from it are one tree: a trunk, and a branch
// wherever another session took a copy of the conversation and went its own way. Every branch is
// a session's own turns (the copied ones stay with the session that paid for them), with its
// steps and its agent work. Pure; SpendGraph.tsx draws it.

import type { LinkKind, SessionDetail, SessionKey } from '../../api/types'
import { sessionTitle } from '../../lib/session'
import { buildSpend, CLASS_SERIES, type Decision, KIND_SERIES, type Part, type Reread, type SpendModel } from './model'

/** One session of the tree. */
export interface Branch {
  /** Position in the tree order: a parent before its children. */
  index: number
  key: SessionKey
  detail: SessionDetail
  model: SpendModel
  title: string
  /** Index of the branch it left; undefined for the trunk. */
  parent?: number
  kind?: LinkKind
  depth: number
  /** Its own turns (indexes into `model.cols`), in order. */
  own: number[]
  /** Slot on the shared turn axis of each turn; undefined for a turn copied from the parent. */
  slot: (number | undefined)[]
  /** Turn index at each slot it occupies. */
  colAt: Map<number, number>
  /** First and last slot; `first > last` when it has no turn of its own. */
  first: number
  last: number
}

export interface Tree {
  branches: Branch[]
  /** Width of the shared turn axis. */
  slots: number
  /** Own spend of every branch: nothing is counted twice. */
  total: number
  byKind: Part[]
  byClass: Part[]
  rereads: Reread[]
  maxStep: number
  maxUnit: number
  fromMessages: boolean
}

/** A session without a title is named by its first prompt, which can be a page long: one line of it. */
export function shortTitle(title: string, max = 64): string {
  const line = title.split('\n')[0].trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

const same = (a: SessionKey, b: SessionKey) => a.harness === b.harness && a.id === b.id

/**
 * Lays the sessions of one family out as a tree. A branch starts in the slot after the last turn
 * it copied from its parent, so that two forks taken at the same point start under each other.
 * `details` may come in any order and may lack members (one that failed to load): a session whose
 * parent is missing becomes a trunk of its own. The result is depth first, so that a branch is
 * drawn right under the session it left.
 */
export function buildTree(details: readonly SessionDetail[]): Tree {
  // depth first: a session, then each session that left it, in the order given
  const order: SessionDetail[] = []
  const has = (k: SessionKey | undefined) => !!k && details.some((d) => same(d.summary.key, k))
  const visit = (d: SessionDetail) => {
    if (order.includes(d)) return
    order.push(d)
    for (const c of details) if (c.lineage.parent && same(c.lineage.parent.parent, d.summary.key)) visit(c)
  }
  for (const d of details) if (!has(d.lineage.parent?.parent)) visit(d)
  // whatever a cycle left out
  for (const d of details) visit(d)

  const branches: Branch[] = []
  for (const detail of order) {
    const model = buildSpend(detail)
    const link = detail.lineage.parent
    const parent = link ? branches.find((b) => same(b.key, link.parent)) : undefined
    const own = model.cols.filter((c) => !c.inherited).map((c) => c.index)
    // the slot of the parent's last copied turn; a copy of a turn the parent itself copied starts with the parent
    const after = parent && link ? (parent.slot[link.atTurn] ?? parent.first - 1) : -1
    const slot: (number | undefined)[] = model.cols.map(() => undefined)
    const colAt = new Map<number, number>()
    own.forEach((i, k) => {
      slot[i] = after + 1 + k
      colAt.set(after + 1 + k, i)
    })
    branches.push({
      index: branches.length,
      key: detail.summary.key,
      detail,
      model,
      title: shortTitle(sessionTitle(detail.summary)),
      parent: parent?.index,
      kind: parent ? link?.kind : undefined,
      depth: parent ? parent.depth + 1 : 0,
      own,
      slot,
      colAt,
      first: after + 1,
      last: after + own.length,
    })
  }

  const sum = (series: readonly { key: string }[], pick: (m: SpendModel) => Part[]) =>
    series
      .map((s) => {
        const parts = branches.flatMap((b) => pick(b.model).filter((p) => p.key === s.key))
        return parts.length ? { ...parts[0], usd: parts.reduce((a, p) => a + p.usd, 0) } : undefined
      })
      .filter((p): p is Part => !!p && p.usd > 0)

  return {
    branches,
    slots: Math.max(1, ...branches.map((b) => b.last + 1)),
    total: branches.reduce((a, b) => a + b.model.total, 0),
    byKind: sum(KIND_SERIES, (m) => m.byKind),
    byClass: sum(CLASS_SERIES, (m) => m.byClass),
    rereads: branches.flatMap((b) => b.model.rereads),
    maxStep: Math.max(0, ...branches.map((b) => b.model.maxStep)),
    maxUnit: Math.max(0, ...branches.map((b) => b.model.maxUnit)),
    fromMessages: branches.every((b) => b.model.fromMessages),
  }
}

/** The branches from the trunk down to `index`, in that order. */
export function pathTo(tree: Tree, index: number): Branch[] {
  const out: Branch[] = []
  let cur: Branch | undefined = tree.branches[index]
  while (cur) {
    out.unshift(cur)
    cur = cur.parent !== undefined ? tree.branches[cur.parent] : undefined
  }
  return out
}

/** A point of the context line along a path. */
export interface PathPoint {
  slot: number
  branch: number
  col: number
  tokens?: number
  rereadTokens: number
}

/**
 * The turns a session's context went through: each ancestor's own turns up to where the next
 * branch left it, then the branch's own.
 */
export function pathPoints(tree: Tree, index: number): PathPoint[] {
  const path = pathTo(tree, index)
  const out: PathPoint[] = []
  path.forEach((b, k) => {
    const next = path[k + 1]
    for (const i of b.own) {
      const slot = b.slot[i] as number
      if (next && slot >= next.first) break
      const c = b.model.cols[i]
      out.push({
        slot,
        branch: b.index,
        col: i,
        tokens: typeof c.turn.contextTokens === 'number' ? c.turn.contextTokens : undefined,
        rereadTokens: c.mainRereadTokens,
      })
    }
  })
  return out
}

/** A decision with the branch it was made on. */
export interface TreeDecision {
  branch: Branch
  decision: Decision
}

/** The `n` most expensive decisions of the whole tree, most expensive first. */
export function topTreeDecisions(tree: Tree, n: number): TreeDecision[] {
  return tree.branches
    .flatMap((branch) => branch.model.decisions.map((decision) => ({ branch, decision })))
    .filter((x) => x.decision.usd > 0)
    .sort((a, b) => b.decision.usd - a.decision.usd || a.branch.index - b.branch.index)
    .slice(0, n)
}
