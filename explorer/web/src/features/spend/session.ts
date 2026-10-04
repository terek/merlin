// The Session page around the spend tree, as pure functions: what a URL hash points at, the resume
// command, the family list and the parser's diagnostics.

import type { Diagnostics, FamilyMember, SessionDetail, SessionKey } from '../../api/types'
import { resumeCommand } from '../../lib/paths'
import { sameKey } from '../../lib/session'
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

// ---- resume -----------------------------------------------------------------------------

export interface ResumeInfo {
  command: string
  /** Nobody continues from this session. */
  leaf: boolean
  /** The newest sessions of the family, when this one is not a leaf. */
  leaves: FamilyMember[]
}

export function resumeInfo(d: SessionDetail): ResumeInfo {
  const cwd = d.summary.cwd ?? d.digest.cwd
  const leaves = d.family.leaves
    .filter((k) => !sameKey(k, d.summary.key))
    .map((k) => d.family.members.find((m) => sameKey(m.key, k)))
    .filter((m): m is FamilyMember => !!m)
  return { command: resumeCommand(cwd, d.summary.key.id), leaf: d.lineage.leaf, leaves }
}

// ---- family -----------------------------------------------------------------------------

export interface FamilyRow {
  member: FamilyMember
  depth: number
  current: boolean
  /** How this member relates to its parent, when the detail says so (only links of the current session are given). */
  relation?: 'fork' | 'continuation'
}

export function familyRows(d: SessionDetail): FamilyRow[] {
  const depthOf = new Map<string, number>()
  const id = (k: SessionKey) => `${k.harness}/${k.id}`
  const relations = new Map<string, 'fork' | 'continuation'>()
  if (d.lineage.parent) relations.set(id(d.lineage.parent.child), d.lineage.parent.kind)
  for (const c of d.lineage.children) relations.set(id(c.child), c.kind)
  return d.family.members.map((member) => {
    const depth = member.parent ? (depthOf.get(id(member.parent)) ?? 0) + 1 : 0
    depthOf.set(id(member.key), depth)
    return {
      member,
      depth,
      current: sameKey(member.key, d.summary.key),
      relation: relations.get(id(member.key)),
    }
  })
}

// ---- diagnostics ------------------------------------------------------------------------

export function diagnosticsLines(dg: Diagnostics): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  const unknown = Object.entries(dg.unknownTypes ?? {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  if (unknown.length)
    out.push({ label: 'Unknown record types', value: unknown.map(([k, n]) => `${k} ×${n}`).join(', ') })
  if (dg.badLines) out.push({ label: 'Lines that could not be parsed', value: String(dg.badLines) })
  if (dg.unpricedModels?.length) out.push({ label: 'Models without a price', value: dg.unpricedModels.join(', ') })
  if (dg.unresolvedAgents) out.push({ label: 'Agents not tied to a spawn', value: String(dg.unresolvedAgents) })
  return out
}
