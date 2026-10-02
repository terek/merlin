// The agent tree of a session.

import type { Agent } from '../api/types'

export interface AgentNode {
  agent: Agent
  children: AgentNode[]
  /** 0 for a root of the tree, 1 for its children, ... (computed here; `agent.depth` is the harness's). */
  level: number
  /** Its parent is not in the list, or it was picked to break a cycle: it is shown as a root. */
  orphan: boolean
}

export interface AgentTree {
  /** Agents spawned by the main agent (and orphans), oldest first. */
  roots: AgentNode[]
  /** Agents with `linkage: unresolved`, each with its own subtree: "not tied to a spawn". */
  unresolved: AgentNode[]
  /** Compaction calls (`kind: compact`): cost, not topology. */
  compactions: Agent[]
}

const byTime = (a: Agent, b: Agent) => {
  const ta = a.startedAt ?? ''
  const tb = b.startedAt ?? ''
  return ta < tb ? -1 : ta > tb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Builds the tree from the flat list by `parentAgentId`. Total on any input: an agent whose
 * parent is missing becomes a root with `orphan: true`; a cycle is broken at its oldest member
 * (which becomes an orphan root); nothing is dropped and nothing appears twice. Siblings are
 * ordered by start time, then id.
 */
export function buildAgentTree(agents: readonly Agent[]): AgentTree {
  const compactions = agents.filter((a) => a.kind === 'compact').sort(byTime)
  const topology = agents.filter((a) => a.kind !== 'compact')
  const byId = new Map<string, Agent>()
  for (const a of topology) byId.set(a.id, a)

  const kids = new Map<string, Agent[]>()
  const rootAgents: Agent[] = []
  const unresolvedAgents: Agent[] = []
  const orphans = new Set<string>()
  for (const a of topology) {
    const p = a.parentAgentId
    if (a.linkage === 'unresolved' && (p === null || !byId.has(p))) {
      unresolvedAgents.push(a)
    } else if (p === null) {
      rootAgents.push(a)
    } else if (byId.has(p) && p !== a.id) {
      const list = kids.get(p) ?? []
      list.push(a)
      kids.set(p, list)
    } else {
      orphans.add(a.id)
      rootAgents.push(a)
    }
  }

  const placed = new Set<string>()
  const build = (a: Agent, level: number): AgentNode => {
    placed.add(a.id)
    const children = (kids.get(a.id) ?? [])
      .filter((c) => !placed.has(c.id))
      .sort(byTime)
      .map((c) => build(c, level + 1))
    return { agent: a, children, level, orphan: orphans.has(a.id) }
  }

  const roots = rootAgents.sort(byTime).map((a) => build(a, 0))
  const unresolved = unresolvedAgents.sort(byTime).map((a) => build(a, 0))

  // What is left is in a cycle (or hangs off one): break it at the oldest member.
  const rest = topology.filter((a) => !placed.has(a.id)).sort(byTime)
  for (const a of rest) {
    if (placed.has(a.id)) continue
    orphans.add(a.id)
    roots.push(build(a, 0))
  }
  return { roots, unresolved, compactions }
}

/** Depth-first list of a forest, parents before children. */
export function flattenAgentTree(nodes: readonly AgentNode[]): AgentNode[] {
  const out: AgentNode[] = []
  const walk = (n: AgentNode) => {
    out.push(n)
    for (const c of n.children) walk(c)
  }
  for (const n of nodes) walk(n)
  return out
}

/** The ids on the path from a root to the agent `id` (inclusive); [] when it is not in the forest. */
export function agentPath(nodes: readonly AgentNode[], id: string): string[] {
  for (const n of nodes) {
    if (n.agent.id === id) return [id]
    const sub = agentPath(n.children, id)
    if (sub.length) return [n.agent.id, ...sub]
  }
  return []
}
