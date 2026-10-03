import { Bot, ChevronDown, ChevronRight, GitFork, Minimize2, Users, Workflow } from 'lucide-react'
import type { AgentKind } from '../../api/types'
import { cn } from '../../lib/cn'
import { firstLine } from '../../lib/paths'
import { AgentStatusMark, Badge, Bar, ModelName, Money } from '../../ui'
import { agentLabel, type Row } from './model'

const KIND_ICON: Record<AgentKind, typeof Bot> = {
  subagent: Bot,
  teammate: Users,
  fork: GitFork,
  compact: Minimize2,
  workflow: Workflow,
}

export function KindIcon({ kind, size = 14 }: { kind: AgentKind; size?: number }) {
  const Icon = KIND_ICON[kind]
  return (
    <span title={kind} className="inline-flex shrink-0 text-muted">
      <Icon size={size} aria-label={kind} />
    </span>
  )
}

/** Width of one indentation step, in px; deeper levels stop indenting so that a deep tree still fits. */
const STEP = 14
const MAX_INDENT_LEVEL = 6

function Guides({ level }: { level: number }) {
  const n = Math.min(level, MAX_INDENT_LEVEL)
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: positional
          key={i}
          aria-hidden
          className="absolute inset-y-0 w-px bg-line"
          style={{ left: i * STEP + 7 }}
        />
      ))}
    </>
  )
}

/** A red dot for failures hidden inside a collapsed subtree. */
function HiddenFailures({ n }: { n: number }) {
  return (
    <span
      role="img"
      aria-label={`${n} killed inside`}
      title={`${n} killed agent${n === 1 ? '' : 's'} inside`}
      className="inline-block size-2 shrink-0 rounded-full bg-bad"
    />
  )
}

export function AgentRow({
  row,
  agentsTotal,
  selected,
  onToggle,
  onSelect,
}: {
  row: Row
  /** All agent dollars: the denominator of the bar, and a subtree with a big part of it gets a bold figure. */
  agentsTotal: number
  selected: boolean
  onToggle: (key: string, open: boolean) => void
  onSelect: (id: string) => void
}) {
  const heavy = agentsTotal > 0 && row.stats.usd / agentsTotal >= 0.25
  const indent = Math.min(row.level, MAX_INDENT_LEVEL) * STEP
  const hasKids = row.kind === 'group' || row.node.children.length > 0
  const hiddenKilled =
    !row.open && row.kind === 'node' ? row.stats.killed - (row.node.agent.status === 'killed' ? 1 : 0) : 0
  const bar = (
    <Bar
      height={3}
      total={agentsTotal}
      label="share of all agents' attributed cost"
      segments={[
        {
          value: row.stats.usd,
          tone: 'attributed',
          title: `${Math.round((row.stats.usd / (agentsTotal || 1)) * 100)}% of all agent cost`,
        },
      ]}
      className="mt-1"
    />
  )

  const chevron = hasKids ? (
    <button
      type="button"
      onClick={() => onToggle(row.key, !row.open)}
      aria-expanded={row.open}
      aria-label={row.open ? 'Collapse' : 'Expand'}
      className="flex w-5 shrink-0 items-start justify-center pt-2 text-muted hover:text-fg"
    >
      {row.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  ) : (
    <span aria-hidden className="w-5 shrink-0" />
  )

  if (row.kind === 'group') {
    const first = row.nodes[0].agent
    return (
      <div data-agent-row={row.key} className="relative flex border-b border-line" style={{ paddingLeft: indent }}>
        <Guides level={row.level} />
        {chevron}
        <button
          type="button"
          onClick={() => onToggle(row.key, !row.open)}
          className="min-w-0 flex-1 py-1.5 pr-3 text-left hover:bg-surface-2"
        >
          <span className="flex items-center gap-1.5">
            <KindIcon kind={first.kind} />
            <span className="min-w-0 flex-1 truncate font-medium">
              {row.run ? row.label : `${row.nodes.length} × ${row.label}`}
            </span>
            {row.run && row.run.status !== 'completed' && (
              <Badge tone={row.run.status === 'open' ? undefined : 'bad'}>{row.run.status}</Badge>
            )}
            {row.stats.killed > 0 && <Badge tone="bad">{row.stats.killed} killed</Badge>}
            <Money usd={row.stats.usd} className={heavy ? 'font-semibold' : undefined} />
          </span>
          <span className="block truncate text-sec text-muted">{row.subtitle}</span>
          {bar}
        </button>
      </div>
    )
  }

  const a = row.node.agent
  const hasOwnDiff = hasKids && Math.abs(row.stats.usd - a.cost.usd) >= 0.005
  const desc = a.description ? firstLine(a.description) : a.name && a.agentType ? a.agentType : ''
  return (
    <div
      data-agent-row={a.id}
      className={cn('relative flex border-b border-line', selected && 'bg-accent-soft')}
      style={{ paddingLeft: indent }}
    >
      <Guides level={row.level} />
      {chevron}
      <button
        type="button"
        onClick={() => onSelect(a.id)}
        aria-pressed={selected}
        className={cn('min-w-0 flex-1 py-1.5 pr-3 text-left', !selected && 'hover:bg-surface-2')}
      >
        <span className="flex items-center gap-1.5">
          <KindIcon kind={a.kind} />
          <span className="min-w-0 truncate font-medium">{agentLabel(a)}</span>
          {a.background && <Badge title="ran in the background">bg</Badge>}
          {row.node.orphan && (
            <Badge tone="warn" title="Its parent is not in this session's agent list; shown under the main agent">
              orphan
            </Badge>
          )}
          {a.status !== 'completed' && <AgentStatusMark status={a.status} />}
          {hiddenKilled > 0 && <HiddenFailures n={hiddenKilled} />}
          <span className="ml-auto pl-1">
            <Money
              usd={row.stats.usd}
              className={heavy ? 'font-semibold' : undefined}
              title={hasKids ? 'with all its descendants' : undefined}
            />
          </span>
        </span>
        <span className="flex items-baseline gap-1.5 text-sec text-muted">
          <span className="min-w-0 flex-1 truncate">{desc}</span>
          {a.model && <ModelName name={a.model} className="shrink-0 text-meta text-faint" />}
          {hasOwnDiff && (
            <span className="shrink-0 text-meta text-faint" title="the agent's own cost, descendants not included">
              own <Money usd={a.cost.usd} dim className="text-meta" />
            </span>
          )}
        </span>
        {bar}
      </button>
    </div>
  )
}
