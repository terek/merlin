// A session and the sessions forked or continued from it are one tree: a trunk, and a branch
// wherever another session took a copy of the conversation and went its own way. Every branch is
// a session's own turns (the copied ones stay with the session that paid for them), with its
// steps and its agent work. Pure; timeline.ts lays it out in time.

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
  /** The stretches the harness reported a cost for that its messages do not add up to. */
  overhead: Overhead[]
}

/**
 * A reported window's overhead: what the harness reported for it that no message explains (calls it
 * makes without writing them down). It belongs to the window as a whole, never to a turn or an agent.
 */
export interface Overhead {
  t0: number
  t1: number
  usd: number
  reportedUSD: number
  coveredUSD: number
}

export interface Tree {
  branches: Branch[]
  /** Own spend of every branch: nothing is counted twice. */
  total: number
  /** Reported spend of every branch that no message explains: with `total`, the harness's figure. */
  overheadUSD: number
  byKind: Part[]
  byClass: Part[]
  rereads: Reread[]
  fromMessages: boolean
}

/** A session without a title is named by its first prompt, which can be a page long: one line of it. */
export function shortTitle(title: string, max = 64): string {
  const line = title.split('\n')[0].trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

const same = (a: SessionKey, b: SessionKey) => a.harness === b.harness && a.id === b.id

/**
 * Puts the sessions of one family in tree order.
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
      overhead: overheadOf(detail),
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
    total: branches.reduce((a, b) => a + b.model.total, 0),
    overheadUSD: branches.reduce((a, b) => a + b.detail.cost.overheadUSD, 0),
    byKind: sum(KIND_SERIES, (m) => m.byKind),
    byClass: sum(CLASS_SERIES, (m) => m.byClass),
    rereads: branches.flatMap((b) => b.model.rereads),
    fromMessages: branches.every((b) => b.model.fromMessages),
  }
}

/** The windows of a session with overhead worth a cent; none from a daemon that does not split it by window. */
function overheadOf(d: SessionDetail): Overhead[] {
  return (d.cost.windows ?? []).flatMap((w) => {
    const t0 = Date.parse(w.from)
    const t1 = Date.parse(w.to)
    if (w.overheadUSD === undefined || w.overheadUSD < 0.005 || !Number.isFinite(t0)) return []
    return [
      {
        t0,
        t1: Number.isFinite(t1) ? Math.max(t0, t1) : t0,
        usd: w.overheadUSD,
        reportedUSD: w.totalUSD,
        coveredUSD: w.coveredUSD ?? 0,
      },
    ]
  })
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
