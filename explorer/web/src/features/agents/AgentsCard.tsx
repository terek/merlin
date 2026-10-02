// The Agents card: who spawned whom, and which subtree cost the money. The tree and its cost
// logic are in model.ts and lib/tree.ts; this file draws them.
import { ChevronDown, ChevronRight, Minimize2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, SessionDetail } from '../../api/types'
import { agentCostSplit } from '../../lib/cost'
import { formatPercent, plural } from '../../lib/format'
import { parseTime, timeOfDay } from '../../lib/time'
import { buildAgentTree } from '../../lib/tree'
import { Bar, Button, Card, EmptyState, Money } from '../../ui'
import { AgentDetail } from './AgentDetail'
import { AgentRow } from './AgentRow'
import { allOpenKeys, revealKeys, subtreeStats, treeDepth, visibleRows } from './model'

export interface AgentsCardProps {
  detail: SessionDetail
  /** The agent whose detail is open, or null. */
  selectedAgentId: string | null
  onSelectAgent: (id: string | null) => void
  /** Scroll the timeline to a turn (an agent's spawn turn). */
  onSelectTurn: (index: number) => void
  /** Dev and screenshots: start with every node and group open, or with these keys open. */
  initialExpand?: 'all' | readonly string[]
}

export function AgentsCard({ detail, selectedAgentId, onSelectAgent, onSelectTurn, initialExpand }: AgentsCardProps) {
  const digest = detail.digest
  const cutShort = (digest?.agents ?? []).reduce((n, a) => n + (a.cost?.truncatedMessages ?? 0), 0)
  const agents = digest.agents
  const tree = useMemo(() => buildAgentTree(agents ?? []), [agents])
  const stats = useMemo(() => subtreeStats([...tree.roots, ...tree.unresolved]), [tree])
  const byId = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents])
  const kids = useMemo(() => {
    const m = new Map<string, Agent[]>()
    for (const a of agents ?? []) {
      if (a.parentAgentId && a.kind !== 'compact') m.set(a.parentAgentId, [...(m.get(a.parentAgentId) ?? []), a])
    }
    return m
  }, [agents])

  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => {
    const keys = initialExpand === 'all' ? allOpenKeys([...tree.roots, ...tree.unresolved]) : (initialExpand ?? [])
    return new Map(keys.map((k) => [k, true] as const))
  })
  const [compactOpen, setCompactOpen] = useState(false)

  const rows = useMemo(() => visibleRows(tree.roots, stats, overrides), [tree, stats, overrides])
  const unresolvedRows = useMemo(() => visibleRows(tree.unresolved, stats, overrides), [tree, stats, overrides])

  const toggle = (key: string, value: boolean) => setOverrides((prev) => new Map(prev).set(key, value))

  // A selection from outside opens whatever hides it, once per selection.
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedAgentId || revealed.current === selectedAgentId) return
    revealed.current = selectedAgentId
    const keys = [...revealKeys(tree.roots, selectedAgentId), ...revealKeys(tree.unresolved, selectedAgentId)]
    if (keys.length)
      setOverrides((prev) => {
        const next = new Map(prev)
        for (const k of keys) next.set(k, true)
        return next
      })
    if (tree.compactions.some((c) => c.id === selectedAgentId)) setCompactOpen(true)
  }, [selectedAgentId, tree])

  const listRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows and compactOpen change what is in the DOM
  useEffect(() => {
    if (!selectedAgentId) {
      scrolled.current = null
      return
    }
    if (scrolled.current === selectedAgentId) return
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-agent-row]') ?? [])].find(
      (e) => e.dataset.agentRow === selectedAgentId,
    )
    if (!el) return
    scrolled.current = selectedAgentId
    el.scrollIntoView({ block: 'nearest' })
  }, [selectedAgentId, rows, unresolvedRows, compactOpen])

  const topology = stats.size
  const split = agentCostSplit(digest)
  const total = digest.cost.usd
  const depth = Math.max(treeDepth(tree.roots), treeDepth(tree.unresolved))
  const compactUSD = tree.compactions.reduce((s, c) => s + c.cost.usd, 0)
  const selected = selectedAgentId ? byId.get(selectedAgentId) : undefined
  const hasOpenable = allOpenKeys([...tree.roots, ...tree.unresolved]).length > 0

  if (topology === 0 && tree.compactions.length === 0) {
    return (
      <Card title="Agents">
        <EmptyState title="No agents in this session">Sub-agents, teammates and forks appear here.</EmptyState>
      </Card>
    )
  }

  const rowProps = (id?: string) => ({
    agentsTotal: split.agents,
    selected: id !== undefined && id === selectedAgentId,
    onToggle: toggle,
    onSelect: (agentId: string) => onSelectAgent(agentId === selectedAgentId ? null : agentId),
  })

  return (
    <Card
      title={
        <>
          Agents <span className="font-normal text-muted">{topology}</span>
        </>
      }
      actions={
        hasOpenable && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setOverrides(new Map(allOpenKeys([...tree.roots, ...tree.unresolved]).map((k) => [k, true] as const)))
              }
            >
              expand
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setOverrides(new Map(allOpenKeys([...tree.roots, ...tree.unresolved]).map((k) => [k, false] as const)))
              }
            >
              collapse
            </Button>
          </>
        )
      }
      flush
    >
      <div className="space-y-1.5 border-b border-line px-3 py-2">
        <div className="flex items-baseline justify-between gap-2 text-sec">
          <span>
            {plural(topology, 'agent')}
            {depth > 0 && <span className="text-muted">, {plural(depth, 'level')} deep</span>}
          </span>
          <span className="whitespace-nowrap text-muted">
            <Money usd={split.agents} /> agents · <Money usd={split.main} dim /> main
          </span>
        </div>
        <Bar
          height={6}
          label="agents against the main agent"
          segments={[
            {
              value: split.agents,
              tone: 'attributed',
              title: `agents ${formatPercent(split.agents, total)} of ${total.toFixed(2)}`,
            },
            { value: split.main, tone: 'muted', title: 'main agent' },
          ]}
        />
        <p className="text-meta text-faint">
          {formatPercent(split.agents, total)} of the session's attributed cost went to agents.
        </p>
      </div>

      <div ref={listRef} className="max-h-[28rem] overflow-y-auto">
        {rows.map((r) => (
          <AgentRow key={r.key} {...rowProps(r.kind === 'node' ? r.node.agent.id : undefined)} row={r} />
        ))}

        {unresolvedRows.length > 0 && (
          <>
            <div className="border-b border-line bg-surface-2 px-3 py-1 text-meta font-semibold uppercase tracking-wide text-muted">
              Not tied to a spawn
            </div>
            {unresolvedRows.map((r) => (
              <AgentRow key={r.key} {...rowProps(r.kind === 'node' ? r.node.agent.id : undefined)} row={r} />
            ))}
          </>
        )}

        {tree.compactions.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={compactOpen}
              onClick={() => setCompactOpen(!compactOpen)}
              className="flex w-full items-center gap-1.5 border-b border-line px-3 py-1.5 text-left text-sec text-muted hover:bg-surface-2"
            >
              {compactOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Minimize2 size={13} aria-hidden />
              <span className="flex-1">{plural(tree.compactions.length, 'compaction call')}, not topology</span>
              <Money usd={compactUSD} dim />
            </button>
            {compactOpen &&
              tree.compactions.map((c) => (
                <div
                  key={c.id}
                  data-agent-row={c.id}
                  className={`flex border-b border-line ${c.id === selectedAgentId ? 'bg-accent-soft' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectAgent(c.id === selectedAgentId ? null : c.id)}
                    className="flex min-w-0 flex-1 items-baseline gap-2 py-1 pr-3 pl-8 text-left text-sec text-muted hover:bg-surface-2"
                  >
                    <span className="flex-1 truncate">
                      compaction at {parseTime(c.startedAt) ? timeOfDay(parseTime(c.startedAt) as Date) : '?'}
                    </span>
                    <Money usd={c.cost.usd} dim />
                  </button>
                </div>
              ))}
          </>
        )}
      </div>

      <p className="border-t border-line px-3 py-1.5 text-meta text-faint">
        Agent cost is recomputed from token counts.
        {cutShort > 0 &&
          ` ${plural(cutShort, 'agent message was', 'agent messages were')} written down before finishing, so it is a lower bound.`}
      </p>

      {selected && (
        <AgentDetail
          agent={selected}
          parent={selected.parentAgentId ? byId.get(selected.parentAgentId) : undefined}
          spawned={kids.get(selected.id) ?? []}
          subtreeUSD={stats.get(selected.id)?.usd ?? selected.cost.usd}
          onClose={() => onSelectAgent(null)}
          onSelectAgent={onSelectAgent}
          onSelectTurn={onSelectTurn}
        />
      )}
    </Card>
  )
}
