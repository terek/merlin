import { ChevronDown, ChevronRight } from 'lucide-react'
import { type CSSProperties, memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, Compaction, InboxMessage, SessionDetail, Turn } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatMoneyFull, plural } from '../../lib/format'
import { useInView, useOverflows } from '../../lib/hooks'
import { inboxLabel } from '../../lib/inbox'
import { sameKey } from '../../lib/session'
import { fullTime, parseTime, shortDate, timeOfDay } from '../../lib/time'
import { unwrapMachineText } from '../../lib/wrapper'
import {
  AgentStatusMark,
  Badge,
  Clamp,
  CopyButton,
  Duration,
  Money,
  OriginBadge,
  PlainText,
  Prose,
  SegmentedControl,
  Tokens,
} from '../../ui'
import {
  buildTimeline,
  compactionDomId,
  compactionIsInherited,
  type Entry,
  hasAgentCost,
  type InheritedGroup,
  type Item,
  machineLine,
  spawnedAgents,
  type Target,
  targetDomId,
  textHead,
  topTools,
  turnDomId,
  turnNeeds,
} from './model'
import { scrollToIdSettled } from './scroll'

const FINAL_LINES = 12
const PROMPT_LINES = 6
const CHIPS_SHOWN = 8

const clampStyle = (lines: number): CSSProperties => ({
  display: '-webkit-box',
  WebkitLineClamp: lines,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
})

const TURN_COST_TIP = 'Attributed from token counts'

// ---- the answer -------------------------------------------------------------------------

/**
 * A turn's final text. Until the block is near the viewport it is a cheap plain preview; then it
 * becomes `Prose`. Collapsed, only the head of a long text is parsed.
 */
function FinalText({ text, defaultOpen }: { text: string; defaultOpen: boolean }) {
  const [ref, near] = useInView<HTMLDivElement>({ rootMargin: '1200px', once: true })
  const [open, setOpen] = useState(defaultOpen)
  const inner = useRef<HTMLDivElement>(null)
  const { head, cut } = useMemo(() => textHead(text, 3000), [text])
  const shown = open ? text : head
  const over = useOverflows(inner, !open && near, shown)
  return (
    <div ref={ref} className="max-w-col">
      <div ref={inner} style={open ? undefined : clampStyle(FINAL_LINES)}>
        {near ? (
          <Prose>{shown}</Prose>
        ) : (
          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text.slice(0, FINAL_LINES * 120)}</div>
        )}
      </div>
      {(over || cut || open) && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-sec text-accent hover:underline">
          {open ? 'show less' : 'show more'}
        </button>
      )}
    </div>
  )
}

// ---- agent chips ------------------------------------------------------------------------

function AgentChips({
  agents,
  selectedAgentId,
  onSelectAgent,
}: {
  agents: Agent[]
  selectedAgentId: string | null
  onSelectAgent: (id: string | null) => void
}) {
  const [all, setAll] = useState(false)
  const shown = all ? agents : agents.slice(0, CHIPS_SHOWN)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-meta text-faint">spawned</span>
      {shown.map((a) => {
        const on = a.id === selectedAgentId
        const label = a.name || a.agentType || a.kind
        return (
          <button
            key={a.id}
            type="button"
            aria-pressed={on}
            title={`${a.description ?? label}\nSubtree cost, attributed from token counts`}
            onClick={() => onSelectAgent(on ? null : a.id)}
            className={cn(
              'inline-flex max-w-64 items-center gap-1.5 rounded-badge border px-1.5 py-px text-sec',
              on ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2 hover:border-faint',
            )}
          >
            <span className="min-w-0 truncate">{label}</span>
            {a.background && <span className="text-meta text-faint">bg</span>}
            <AgentStatusMark status={a.status} />
            <Money usd={a.subtreeUSD} dim title={`${formatMoneyFull(a.subtreeUSD)}\n${TURN_COST_TIP}`} />
          </button>
        )
      })}
      {agents.length > CHIPS_SHOWN && (
        <button type="button" onClick={() => setAll(!all)} className="text-sec text-accent hover:underline">
          {all ? 'fewer' : `+${agents.length - CHIPS_SHOWN} more`}
        </button>
      )}
    </div>
  )
}

// ---- one turn ---------------------------------------------------------------------------

interface TurnProps {
  turn: Turn
  agentsById: Map<string, Agent>
  /** The selected agent, only when this turn spawned it. */
  selectedAgentId: string | null
  onSelectAgent: (id: string | null) => void
  highlighted: boolean
  /** The session ended in the middle of this turn. */
  midTurn: boolean
  startDay: string
  expandAll: boolean
  /** Shown on a machine turn that was opened: a way to fold it again. */
  onFold?: () => void
}

function turnTime(turn: Turn, startDay: string): { text: string; title?: string } {
  const d = parseTime(turn.startedAt)
  if (!d) return { text: '' }
  const day = d.toDateString()
  return { text: day === startDay ? timeOfDay(d) : `${shortDate(d)} ${timeOfDay(d)}`, title: fullTime(d) }
}

function FilesTouched({ files }: { files: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(!open)} className="text-accent hover:underline" aria-expanded={open}>
        {plural(files.length, 'file')}
      </button>
      {open && (
        <ul className="basis-full space-y-0.5 pt-1 font-mono text-meta text-muted">
          {files.map((f) => (
            <li key={f} className="[overflow-wrap:anywhere]">
              {f}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** The messages a machine delivered as a turn's prompt: who or what each came from, then what it says. */
function InboxList({
  inbox,
  agentsById,
  onSelectAgent,
  struck,
}: {
  inbox: InboxMessage[]
  agentsById: Map<string, Agent>
  onSelectAgent: (id: string | null) => void
  struck?: boolean
}) {
  const items = inbox.map((m, k) => ({ m, key: `m${k}` }))
  return (
    <ul className="space-y-1.5">
      {items.map(({ m, key }) => {
        const agentId = m.agentId && agentsById.has(m.agentId) ? m.agentId : undefined
        const label = inboxLabel(m)
        return (
          <li
            key={key}
            className={cn(
              'rounded-badge bg-surface-2 px-2.5 py-1.5 text-muted',
              struck && 'line-through decoration-faint',
            )}
          >
            <div className="mb-0.5 text-meta uppercase tracking-wide text-faint">
              {agentId ? (
                <button
                  type="button"
                  onClick={() => onSelectAgent(agentId)}
                  className="uppercase tracking-wide hover:text-accent hover:underline"
                  title="Show this agent"
                >
                  {label}
                </button>
              ) : (
                label
              )}
            </div>
            {m.summary && m.summary !== m.text && (
              <div className="max-w-col font-medium [overflow-wrap:anywhere]">{m.summary}</div>
            )}
            {m.error && <div className="max-w-col text-bad [overflow-wrap:anywhere]">{m.error}</div>}
            {m.text && <PlainText text={m.text} lines={PROMPT_LINES} className="max-w-col" />}
          </li>
        )
      })}
    </ul>
  )
}

const TurnBlock = memo(function TurnBlock({
  turn,
  agentsById,
  selectedAgentId,
  onSelectAgent,
  highlighted,
  midTurn,
  startDay,
  expandAll,
  onFold,
}: TurnProps) {
  const human = turn.origin === 'human'
  const when = turnTime(turn, startDay)
  const agents = spawnedAgents(turn, agentsById)
  const tools = topTools(turn.toolsByName)
  const files = turn.filesTouched ?? []
  // a message from a task or a peer shows without its wrapper; a typed prompt or command is as typed
  // (a digest written before the API parsed delivered prompts still has the wrapper in its text)
  const inbox = turn.inbox ?? []
  const unwrapped =
    inbox.length > 0 || turn.origin === 'human' || turn.origin === 'command' ? null : unwrapMachineText(turn.userText)
  const link = () => `${window.location.origin}${window.location.pathname}#${turnDomId(turn.index)}`
  return (
    <article
      id={turnDomId(turn.index)}
      aria-label={`Turn ${turn.index}`}
      className={cn(
        'group relative flex scroll-mt-16 rounded-card border border-line bg-surface',
        highlighted && 'outline outline-2 outline-accent',
        turn.abandoned && 'opacity-75',
      )}
    >
      <div aria-hidden className={cn('w-1 shrink-0 rounded-l-card', human ? 'bg-human' : 'bg-machine')} />
      <div className="min-w-0 flex-1 space-y-2 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sec text-muted">
          <a href={`#${turnDomId(turn.index)}`} className="font-mono text-muted hover:text-fg hover:no-underline">
            #{turn.index}
          </a>
          {when.text && <span title={when.title}>{when.text}</span>}
          {turn.durationMs !== undefined && <Duration ms={turn.durationMs} />}
          <OriginBadge origin={turn.origin} />
          {turn.command && !human && <span className="font-mono">/{turn.command.replace(/^\//, '')}</span>}
          {turn.interrupted && <Badge tone="bad">interrupted</Badge>}
          {midTurn && (
            <Badge tone="warn" title="The transcript stops in the middle of this turn">
              stopped mid-turn
            </Badge>
          )}
          {turn.abandoned && (
            <Badge title="The session was rewound past this turn. It is not on the path that continued, and its cost still counts.">
              rewound: not on the path that continued, cost still counts
            </Badge>
          )}
          <span className="ml-auto flex items-center gap-1">
            {onFold && (
              <button type="button" onClick={onFold} className="text-sec text-accent hover:underline">
                fold
              </button>
            )}
            <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <CopyButton text={link()} label="Copy link to this turn" />
            </span>
          </span>
        </div>

        {inbox.length > 0 && (
          <InboxList inbox={inbox} agentsById={agentsById} onSelectAgent={onSelectAgent} struck={turn.abandoned} />
        )}
        {turn.userText && (
          <div
            className={cn(
              'rounded-badge px-2.5 py-1.5',
              human ? 'bg-surface-2 font-medium' : 'bg-surface-2 text-muted',
              turn.abandoned && 'line-through decoration-faint',
            )}
          >
            {unwrapped?.label && (
              <div className="mb-0.5 text-meta uppercase tracking-wide text-faint">{unwrapped.label}</div>
            )}
            <PlainText text={unwrapped ? unwrapped.body : turn.userText} lines={PROMPT_LINES} className="max-w-col" />
          </div>
        )}
        {!!turn.images && <div className="text-sec text-muted">{plural(turn.images, 'image')} pasted</div>}

        {turn.finalText ? (
          <FinalText text={turn.finalText} defaultOpen={expandAll} />
        ) : (
          <p className="text-sec text-faint">
            {turn.interrupted ? 'No answer: interrupted.' : 'No final answer text.'}
          </p>
        )}

        {agents.length > 0 && (
          <AgentChips agents={agents} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} />
        )}

        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-line pt-1.5 text-sec text-muted">
          <span>{plural(turn.assistantMessages, 'message')}</span>
          <span aria-hidden className="text-faint">
            {'·'}
          </span>
          <span
            title={Object.entries(turn.toolsByName ?? {})
              .map(([k, n]) => `${k} ${n}`)
              .join('\n')}
          >
            {plural(turn.toolCalls, 'tool call')}
            {tools.top.length > 0 && (
              <span className="text-faint">
                {' '}
                ({tools.top.map((t) => `${t.name} ${t.count}`).join(', ')}
                {tools.rest > 0 ? `, +${tools.rest}` : ''})
              </span>
            )}
          </span>
          {files.length > 0 && (
            <>
              <span aria-hidden className="text-faint">
                {'·'}
              </span>
              <FilesTouched files={files} />
            </>
          )}
          {turn.contextTokens !== undefined && (
            <>
              <span aria-hidden className="text-faint">
                {'·'}
              </span>
              <span title="Context size at the end of the turn">
                context <Tokens n={turn.contextTokens} dim />
              </span>
            </>
          )}
          <span className="ml-auto flex items-baseline gap-2">
            <Money usd={turn.cost.usd} title={`${formatMoneyFull(turn.cost.usd)}\n${TURN_COST_TIP}`} />
            {hasAgentCost(turn) && (
              <span className="text-muted" title="This turn plus the agents it spawned">
                with agents{' '}
                <Money
                  usd={turn.costWithAgents}
                  dim
                  title={`${formatMoneyFull(turn.costWithAgents)}\nIncludes the agents spawned in this turn. ${TURN_COST_TIP}`}
                />
              </span>
            )}
          </span>
        </div>
      </div>
    </article>
  )
})

/** A turn nobody typed: one line, opened on click. */
const MachineTurn = memo(function MachineTurn(props: TurnProps) {
  const { turn, startDay, highlighted, expandAll } = props
  const [open, setOpen] = useState(expandAll)
  const forced = highlighted
  const when = turnTime(turn, startDay)
  if (open || forced) return <TurnBlock {...props} onFold={forced && !open ? undefined : () => setOpen(false)} />
  return (
    <div
      id={turnDomId(turn.index)}
      className="flex min-h-7 scroll-mt-16 items-center gap-2 border-l-2 border-machine pl-3 text-sec text-muted"
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open turn ${turn.index}`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-badge py-0.5 text-left hover:bg-surface-2"
      >
        <ChevronRight size={12} aria-hidden className="shrink-0 text-faint" />
        <span className="font-mono">#{turn.index}</span>
        <OriginBadge origin={turn.origin} />
        {turn.interrupted && <Badge tone="bad">interrupted</Badge>}
        {turn.abandoned && (
          <Badge title="Rewound: not on the path that continued; its cost still counts.">rewound</Badge>
        )}
        <span className={cn('min-w-0 flex-1 truncate', turn.abandoned && 'line-through decoration-faint')}>
          {machineLine(turn)}
        </span>
        {when.text && (
          <span className="shrink-0 text-faint" title={when.title}>
            {when.text}
          </span>
        )}
      </button>
      <Money usd={turn.cost.usd} dim title={`${formatMoneyFull(turn.cost.usd)}\n${TURN_COST_TIP}`} />
    </div>
  )
})

// ---- dividers ---------------------------------------------------------------------------

function CompactionDivider({
  compaction,
  index,
  highlighted,
  expandAll,
}: {
  compaction: Compaction
  index: number
  highlighted: boolean
  expandAll: boolean
}) {
  const [open, setOpen] = useState(expandAll)
  const show = open || highlighted
  const pre = compaction.preTokens
  const post = compaction.postTokens
  const at = parseTime(compaction.at)
  return (
    <div id={compactionDomId(index)} className="scroll-mt-16 py-1">
      <div className="flex items-center gap-3 text-sec text-muted">
        <span aria-hidden className="h-px flex-1 bg-line" />
        <span className={cn('flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5', highlighted && 'text-fg')}>
          <span className="font-medium text-fg">Compaction</span>
          {compaction.trigger && <Badge>{compaction.trigger}</Badge>}
          {pre !== undefined && (
            <span title="Context size before and after">
              <Tokens n={pre} dim /> {'→'} {post !== undefined ? <Tokens n={post} dim /> : '?'}
            </span>
          )}
          {compaction.durationMs !== undefined && <Duration ms={compaction.durationMs} />}
          {at && <span title={fullTime(at)}>{timeOfDay(at)}</span>}
          {compaction.summary && (
            <button
              type="button"
              onClick={() => setOpen(!show)}
              className="text-accent hover:underline"
              aria-expanded={show}
            >
              {show ? 'hide summary' : 'show summary'}
            </button>
          )}
        </span>
        <span aria-hidden className="h-px flex-1 bg-line" />
      </div>
      {show && compaction.summary && (
        <div className="mx-auto mt-2 max-w-col rounded-card border border-line bg-surface-2 px-3 py-2">
          <p className="mb-1 text-meta uppercase tracking-wide text-faint">
            Summary kept after the compaction (not a prompt)
          </p>
          <Clamp lines={16} defaultOpen={expandAll}>
            <Prose>{compaction.summary}</Prose>
          </Clamp>
        </div>
      )}
    </div>
  )
}

function InheritedDivider({
  group,
  parentTitle,
  open,
  onToggle,
}: {
  group: InheritedGroup
  parentTitle: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-3 text-sec text-muted hover:text-fg"
    >
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span className="flex items-center gap-1.5">
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        {plural(group.turns, 'turn')} copied from <span className="font-medium text-fg">{parentTitle}</span>
        <span className="text-faint">{open ? 'hide' : 'show'}</span>
      </span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </button>
  )
}

// ---- the timeline -----------------------------------------------------------------------

export interface TimelineProps {
  detail: SessionDetail
  target: Target | null
  /** Bumped by every "scroll to this turn" request, so asking for the same turn again scrolls again. */
  scrollNonce: number
  selectedAgentId: string | null
  onSelectAgent: (id: string | null) => void
  /** Drop the hash (the reader folded something the hash was holding open). */
  onClearTarget: () => void
  /** Dev: start with machine turns, summaries and answers expanded (?expand=1). */
  expandAll: boolean
}

export function Timeline({
  detail,
  target,
  scrollNonce,
  selectedAgentId,
  onSelectAgent,
  onClearTarget,
  expandAll,
}: TimelineProps) {
  const [promptsOnly, setPromptsOnly] = useState(false)
  const [inheritedOpen, setInheritedOpen] = useState(expandAll)

  // What the hash needs open: the copied turns, and machine turns while "prompts only" is on.
  const needs =
    target?.kind === 'turn'
      ? turnNeeds(detail, target.index)
      : target?.kind === 'compaction'
        ? { inherited: compactionIsInherited(detail, target.index), machine: false }
        : { inherited: false, machine: false }
  const showInherited = inheritedOpen || needs.inherited
  const onlyPrompts = promptsOnly && !needs.machine

  const timeline = useMemo(() => buildTimeline(detail, onlyPrompts), [detail, onlyPrompts])
  const agentsById = useMemo(() => new Map((detail.digest.agents ?? []).map((a) => [a.id, a])), [detail.digest.agents])
  const turns = detail.digest.turns ?? []
  const lastTurnIndex = turns.length ? turns[turns.length - 1].index : -1
  const midTurnIndex = detail.summary.endState === 'mid-turn' ? lastTurnIndex : -1
  const startDay = (parseTime(detail.summary.startedAt) ?? new Date(0)).toDateString()
  const parentLink = detail.lineage.parent
  const parentTitle =
    detail.family.members.find((m) => parentLink && sameKey(m.key, parentLink.parent))?.title ||
    parentLink?.parent.id.slice(0, 8) ||
    'the parent session'

  // Scroll: to the hash on load and when it changes, else to the first own turn once.
  const firstOwn = timeline.firstOwnTurn
  const hashId = targetDomId(target)
  const first = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls on a new target or request, not on every refetch
  useEffect(() => {
    // the divider that says what was copied sits right above the first own turn: land on it
    const group = timeline.items.findIndex((x) => x.type === 'inherited')
    const defaultId =
      group >= 0 && !showInherited ? `inherited-${group}` : firstOwn !== null && group >= 0 ? turnDomId(firstOwn) : null
    const id = hashId ?? (first.current ? defaultId : null)
    if (!id) {
      first.current = false
      return
    }
    return scrollToIdSettled(id, () => {
      first.current = false
    })
  }, [hashId, scrollNonce])

  const highlightedTurn = target?.kind === 'turn' ? target.index : -1
  const highlightedCompaction = target?.kind === 'compaction' ? target.index : -1

  const turnProps = (turn: Turn): TurnProps => ({
    turn,
    agentsById,
    selectedAgentId: selectedAgentId && turn.spawned?.includes(selectedAgentId) ? selectedAgentId : null,
    onSelectAgent,
    highlighted: turn.index === highlightedTurn,
    midTurn: turn.index === midTurnIndex,
    startDay,
    expandAll,
  })

  const renderEntry = (e: Entry) =>
    e.type === 'compaction' ? (
      <CompactionDivider
        key={`c${e.index}`}
        compaction={e.compaction}
        index={e.index}
        highlighted={e.index === highlightedCompaction}
        expandAll={expandAll}
      />
    ) : e.turn.origin === 'human' ? (
      <TurnBlock key={`t${e.turn.index}`} {...turnProps(e.turn)} />
    ) : (
      <MachineTurn key={`t${e.turn.index}`} {...turnProps(e.turn)} />
    )

  const renderItem = (it: Item, i: number) => {
    if (it.type === 'inherited') {
      return (
        <div key={`g${i}`} id={`inherited-${i}`} className="scroll-mt-16 space-y-2">
          <InheritedDivider
            group={it}
            parentTitle={parentTitle}
            open={showInherited}
            onToggle={() => {
              if (needs.inherited && showInherited) onClearTarget()
              setInheritedOpen(!showInherited)
            }}
          />
          {showInherited && (
            <div className="space-y-2 border-l border-dashed border-line pl-3 opacity-80">
              {it.entries.map(renderEntry)}
            </div>
          )}
        </div>
      )
    }
    if (it.type === 'hidden') {
      const cost = it.turns.reduce((s, t) => s + t.cost.usd, 0)
      return (
        <div key={`h${it.turns[0].index}`} className="flex items-center gap-2 pl-3 text-meta text-faint">
          <span>
            {plural(it.turns.length, 'turn')} nobody typed hidden (#{it.turns[0].index}
            {it.turns.length > 1 ? `–#${it.turns[it.turns.length - 1].index}` : ''})
          </span>
          <Money usd={cost} dim className="text-meta" title={`${formatMoneyFull(cost)}\n${TURN_COST_TIP}`} />
        </div>
      )
    }
    return renderEntry(it)
  }

  const humanCount = turns.filter((t) => t.origin === 'human').length
  return (
    <section aria-label="Timeline" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-title font-semibold">Timeline</h2>
          <p className="text-sec text-muted">
            {plural(turns.length, 'turn')}, {humanCount} typed. Turn and agent costs are attributed from token counts.
          </p>
        </div>
        {turns.length > humanCount && (
          <SegmentedControl
            label="Which turns to show"
            value={promptsOnly ? 'prompts' : 'all'}
            onChange={(v) => setPromptsOnly(v === 'prompts')}
            options={[
              { value: 'all', label: 'All turns' },
              {
                value: 'prompts',
                label: 'Prompts only',
                title: 'Hide turns nobody typed (commands, notifications, ...)',
              },
            ]}
          />
        )}
      </div>
      {turns.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-3 py-6 text-center text-sec text-muted">
          This session has no turns.
        </p>
      ) : (
        <div className="space-y-2">{timeline.items.map(renderItem)}</div>
      )}
    </section>
  )
}
