// The session in the Overview's focus, as pure functions: what a URL hash points at in the spend tree.

import type { Job } from '../../api/types'
import type { Col } from './model'
import type { Pin, UnitRef } from './SpendGraph'
import type { Tree } from './tree'

// ---- hash addressing --------------------------------------------------------------------

export type Target =
  | { kind: 'turn'; index: number }
  | { kind: 'agent'; id: string }
  | { kind: 'compaction'; index: number }

/** `#t12` -> turn 12, `#a<id>` -> an agent, `#c0` -> the first compaction. Anything else: null. */
export function parseHash(hash: string): Target | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  const num = /^(\d+)$/
  if (h.startsWith('t') && num.test(h.slice(1))) return { kind: 'turn', index: Number(h.slice(1)) }
  if (h.startsWith('c') && num.test(h.slice(1))) return { kind: 'compaction', index: Number(h.slice(1)) }
  if (h.startsWith('a') && h.length > 1) return { kind: 'agent', id: decodeURIComponent(h.slice(1)) }
  return null
}

/**
 * What a hash target of the session `home` opens in the tree: the turn to pin, and the piece of
 * agent work to open with it. A turn the session copied is pinned on the ancestor that ran it; an
 * agent nested inside another opens the piece of work of the agent the session launched; a
 * compaction pins the turn it happened in. Null when the target is not in the tree.
 */
export function resolveTarget(
  tree: Tree,
  home: number,
  target: Target | null,
): { pin: Pin; unit: UnitRef | null } | null {
  const b = tree.branches[home]
  if (!b || !target) return null
  if (target.kind === 'agent') {
    // the session's own branch first, then the rest of the tree
    const order = [b, ...tree.branches.filter((x) => x !== b)]
    for (const x of order) {
      const u = x.model.units.find((v) => v.agent.id === target.id || v.nested.some((a) => a.id === target.id))
      if (u) return { pin: { branch: x.index, col: u.launch }, unit: { branch: x.index, id: u.id } }
    }
    return null
  }
  const index = target.kind === 'turn' ? target.index : b.detail.digest.compactions?.[target.index]?.turn
  if (index === undefined) return null
  for (let x: typeof b | undefined = b; x; x = x.parent !== undefined ? tree.branches[x.parent] : undefined) {
    const c = x.model.cols[index]
    if (c && !c.inherited) return { pin: { branch: x.index, col: index }, unit: null }
  }
  return null
}

/**
 * The turn that launched a background job: the digest's own `turn`, or when that is missing, not in the
 * session or copied from its parent, the session's own turn that started last at or before the job's start.
 * Undefined when there is none.
 */
export function jobLaunchTurn(
  cols: readonly Pick<Col, 'index' | 'inherited' | 'turn'>[],
  job: Pick<Job, 'turn' | 'startedAt'>,
): number | undefined {
  const named = job.turn === undefined ? undefined : cols[job.turn]
  if (named && !named.inherited) return named.index
  const at = Date.parse(job.startedAt)
  if (!Number.isFinite(at)) return undefined
  let best: { index: number; t: number } | undefined
  for (const c of cols) {
    const t = Date.parse(c.turn.startedAt ?? '')
    if (c.inherited || !Number.isFinite(t) || t > at) continue
    if (!best || t >= best.t) best = { index: c.index, t }
  }
  return best?.index
}
