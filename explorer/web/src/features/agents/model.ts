// The logic behind the Agents card: subtree sums, grouping of long runs of siblings, which rows
// are visible. Pure, so it is tested; the components only draw what this returns.

import type { Agent } from '../../api/types'
import type { AgentNode } from '../../lib/tree'

/** More than this many consecutive siblings of one type are shown as one expandable line. */
export const GROUP_MIN = 8

/** Nodes at this level or deeper start collapsed (levels 0, 1 and 2 are visible at first). */
export const COLLAPSE_FROM_LEVEL = 2

export interface SubtreeStats {
  /** Own dollars plus all descendants (attributed). */
  usd: number
  /** The node and its descendants. */
  count: number
  /** Killed agents in the subtree, the node included. */
  killed: number
  /** Agents without a terminal marker in the subtree, the node included. */
  open: number
}

/** Sums per node, computed from the tree rather than trusted from `agent.subtreeUSD` (orphans, broken cycles). */
export function subtreeStats(forest: readonly AgentNode[]): Map<string, SubtreeStats> {
  const out = new Map<string, SubtreeStats>()
  const walk = (n: AgentNode): SubtreeStats => {
    const s: SubtreeStats = {
      usd: n.agent.cost.usd,
      count: 1,
      killed: n.agent.status === 'killed' ? 1 : 0,
      open: n.agent.status === 'open' ? 1 : 0,
    }
    for (const c of n.children) {
      const t = walk(c)
      s.usd += t.usd
      s.count += t.count
      s.killed += t.killed
      s.open += t.open
    }
    out.set(n.agent.id, s)
    return s
  }
  for (const n of forest) walk(n)
  return out
}

/** Number of levels of the deepest branch: 0 for an empty forest, 1 when there are only roots. */
export function treeDepth(forest: readonly AgentNode[]): number {
  let max = 0
  const walk = (n: AgentNode, depth: number) => {
    max = Math.max(max, depth)
    for (const c of n.children) walk(c, depth + 1)
  }
  for (const n of forest) walk(n, 1)
  return max
}

/** What makes two siblings "of one type": the kind and the agent type (or name for a teammate). */
export function typeKey(a: Agent): string {
  return `${a.kind}:${a.agentType ?? a.name ?? ''}`
}

export function agentLabel(a: Agent): string {
  return a.name ?? a.agentType ?? a.kind
}

export type Entry = { group: false; node: AgentNode } | { group: true; id: string; nodes: AgentNode[] }

/** Sibling list with each run of more than `min` consecutive same-type agents folded into one group. */
export function groupSiblings(nodes: readonly AgentNode[], min = GROUP_MIN): Entry[] {
  const out: Entry[] = []
  let i = 0
  while (i < nodes.length) {
    let j = i + 1
    while (j < nodes.length && typeKey(nodes[j].agent) === typeKey(nodes[i].agent)) j++
    if (j - i > min) out.push({ group: true, id: `g:${nodes[i].agent.id}`, nodes: nodes.slice(i, j) })
    else for (let k = i; k < j; k++) out.push({ group: false, node: nodes[k] })
    i = j
  }
  return out
}

export type Row =
  | { kind: 'node'; key: string; node: AgentNode; level: number; open: boolean; stats: SubtreeStats }
  | {
      kind: 'group'
      key: string
      level: number
      open: boolean
      nodes: AgentNode[]
      label: string
      stats: SubtreeStats
    }

export const isNodeOpen = (n: AgentNode, overrides: ReadonlyMap<string, boolean>): boolean =>
  overrides.get(n.agent.id) ?? n.level < COLLAPSE_FROM_LEVEL

/**
 * The visible rows, top to bottom. `overrides` maps a node id (or a group key `g:<first id>`) to
 * true / false against the default (nodes open above COLLAPSE_FROM_LEVEL, groups closed).
 * `level` is the indentation: a group's members sit one level deeper than the group line.
 */
export function visibleRows(
  forest: readonly AgentNode[],
  stats: ReadonlyMap<string, SubtreeStats>,
  overrides: ReadonlyMap<string, boolean>,
  min = GROUP_MIN,
): Row[] {
  const rows: Row[] = []
  const emit = (nodes: readonly AgentNode[], level: number, fold = true) => {
    const entries: Entry[] = fold ? groupSiblings(nodes, min) : nodes.map((node) => ({ group: false, node }))
    for (const e of entries) {
      if (!e.group) {
        const open = isNodeOpen(e.node, overrides)
        rows.push({
          kind: 'node',
          key: e.node.agent.id,
          node: e.node,
          level,
          open,
          stats: stats.get(e.node.agent.id) as SubtreeStats,
        })
        if (open) emit(e.node.children, level + 1)
        continue
      }
      const open = overrides.get(e.id) ?? false
      const sum: SubtreeStats = { usd: 0, count: 0, killed: 0, open: 0 }
      for (const n of e.nodes) {
        const s = stats.get(n.agent.id) as SubtreeStats
        sum.usd += s.usd
        sum.count += s.count
        sum.killed += s.killed
        sum.open += s.open
      }
      const first = e.nodes[0].agent
      rows.push({ kind: 'group', key: e.id, level, open, nodes: e.nodes, label: agentLabel(first), stats: sum })
      // the members of an open group are listed ungrouped: they are the folded run
      if (open) emit(e.nodes, level + 1, false)
    }
  }
  emit(forest, 0)
  return rows
}

/**
 * The keys to open so that agent `id` is visible: its ancestors, and the group line of every
 * sibling run that holds it or one of its ancestors. [] when the agent is not in the forest.
 */
export function revealKeys(forest: readonly AgentNode[], id: string, min = GROUP_MIN): string[] {
  const walk = (nodes: readonly AgentNode[]): string[] | null => {
    for (const e of groupSiblings(nodes, min)) {
      const members = e.group ? e.nodes : [e.node]
      for (const n of members) {
        if (n.agent.id === id) return e.group ? [e.id] : []
        const sub = walk(n.children)
        if (sub) return [...(e.group ? [e.id] : []), n.agent.id, ...sub]
      }
    }
    return null
  }
  return walk(forest) ?? []
}

/** Every key that can be opened (nodes with children, groups): for "expand all". */
export function allOpenKeys(forest: readonly AgentNode[], min = GROUP_MIN): string[] {
  const keys: string[] = []
  const walk = (nodes: readonly AgentNode[]) => {
    for (const e of groupSiblings(nodes, min)) {
      if (e.group) keys.push(e.id)
      for (const n of e.group ? e.nodes : [e.node]) {
        if (n.children.length) keys.push(n.agent.id)
        walk(n.children)
      }
    }
  }
  walk(forest)
  return keys
}
