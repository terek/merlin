// Under the spend graph: the decision the pinned turn belongs to (its total and everything it paid
// for, ranked), the pinned turn (what was asked, what the main agent spent on it, the work it
// handed to agents and the reports that came in), the selected piece of agent work, and, always,
// the decisions that cost the most.
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Compaction, QueuedPrompt } from '../../api/types'
import { callLine, tallyLine, warmLine } from '../../lib/compaction'
import { formatDuration, formatMoney, formatTokens, plural } from '../../lib/format'
import { inboxSummary, turnPrompt } from '../../lib/inbox'
import { firstLine } from '../../lib/paths'
import { fullTime, parseTime, timeOfDay } from '../../lib/time'
import { unwrapMachineText } from '../../lib/wrapper'
import { Bar, Card, Clamp, IconButton, ModelName, Money, OriginBadge, PlainText, Prose, Tokens } from '../../ui'
import { AgentDetail } from '../agents/AgentDetail'
import { KindIcon } from '../agents/AgentRow'
import { agentLabel } from '../agents/model'
import {
  type Bucket,
  CLASS_SERIES,
  type Col,
  compactionTally,
  type Decision,
  decisionItems,
  KIND_SERIES,
  type Reread,
  type SpendModel,
  stepParts,
  type Unit,
  unitParts,
} from './model'
import type { Pin } from './SpendGraph'
import { type Tree, topTreeDecisions } from './tree'

function Label({ children }: { children: ReactNode }) {
  return <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-muted">{children}</h3>
}

function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: color }} />
}

/** The decisions that cost the most, over every branch: the list a reader starts from, and comes back to. */
export function TopDecisions({ tree, pinned, onPin }: { tree: Tree; pinned: Pin | null; onPin: (pin: Pin) => void }) {
  const top = topTreeDecisions(tree, 10)
  if (top.length === 0) return null
  const max = top[0].decision.usd
  const multi = tree.branches.length > 1
  return (
    <Card title="Your most expensive decisions" flush>
      <p className="border-b border-line px-3 py-1.5 text-sec text-muted">
        Everything that ran between a prompt you typed and your next one: the main agent's steps and the agent work
        launched in them, whichever prompt asked for it.
      </p>
      <ul className="divide-y divide-line">
        {top.map(({ branch, decision: x }) => {
          const on = pinned?.branch === branch.index && pinned.col >= x.start && pinned.col <= x.end
          return (
            <li key={`${branch.index}/${x.index}`}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onPin({ branch: branch.index, col: Math.max(x.start, branch.own[0] ?? x.start) })}
                className={`grid w-full grid-cols-[6.5rem_5rem_9rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-1.5 text-left ${on ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
              >
                <span className="font-mono text-sec text-muted">
                  {x.end > x.start ? `turns ${x.start}–${x.end}` : `turn ${x.start}`}
                </span>
                <Money usd={x.usd} className="text-right" />
                <Bar
                  height={6}
                  total={max}
                  label="who spent it"
                  segments={x.parts.map((p) => ({
                    value: p.usd,
                    tone: p.tone,
                    title: `${p.label} ${formatMoney(p.usd)}`,
                  }))}
                />
                <span className="min-w-0 truncate text-sec">
                  {x.prompt || <span className="text-faint">(no prompt text)</span>}
                </span>
                <span className="flex max-w-80 items-center gap-2 whitespace-nowrap text-sec text-muted">
                  {x.units > 0 && (
                    <span>
                      {plural(x.units, 'piece')} of agent work {formatMoney(x.unitsUSD)}
                    </span>
                  )}
                  {multi && <span className="min-w-0 truncate text-faint">{branch.title}</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/**
 * The decision the pinned turn belongs to: everything between a typed prompt and the next one,
 * with what it paid for, most expensive first. Nothing for a decision that is a single step.
 */
export function DecisionPanel({
  model,
  decision: dec,
  branchTitle,
  pinnedCol,
  selectedUnitId,
  onPin,
  onSelectUnit,
}: {
  model: SpendModel
  decision: Decision
  /** The session's title, when the tree has more than one. */
  branchTitle?: string
  pinnedCol: number
  selectedUnitId: string | null
  onPin: (index: number) => void
  onSelectUnit: (id: string) => void
}) {
  const items = decisionItems(model, dec)
  if (items.length < 2) return null
  const own = model.cols.slice(dec.start, dec.end + 1).filter((c) => !c.inherited)
  const first = own[0]
  const typed = first.human
  const more = dec.index < model.decisions.length - 1
  const from = parseTime(first.turn.startedAt)
  const to = parseTime(own[own.length - 1].turn.endedAt)
  const span = from && to ? to.getTime() - from.getTime() : 0
  const max = items[0].usd
  const row = (on: boolean) =>
    `grid w-full grid-cols-[5rem_minmax(0,1fr)_auto_6rem_4.5rem] items-center gap-3 px-3 py-1 text-left text-sec ${on ? 'bg-accent-soft' : 'hover:bg-surface-2'}`
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {branchTitle && <span className="max-w-72 truncate font-normal text-muted">{branchTitle}</span>}
          <span>{own.length > 1 ? `Turns ${first.index} to ${dec.end}` : `Turn ${first.index}`}</span>
          <Money usd={dec.usd} />
          <span className="text-sec font-normal text-muted">
            {typed
              ? more
                ? 'everything between this prompt and your next one'
                : 'everything since this prompt'
              : 'everything before your first prompt here'}
          </span>
        </span>
      }
      flush
    >
      <div className="space-y-1.5 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={() => onPin(first.index)}
          className="block max-w-full truncate text-left text-sec hover:underline"
        >
          <span className="font-mono text-muted">turn {first.index}</span>{' '}
          {first.prompt || <span className="text-faint">(no prompt text)</span>}
        </button>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sec">
          {dec.parts.map(
            (p) =>
              p.usd >= 0.005 && (
                <span key={p.key} className="inline-flex items-center gap-1.5">
                  <Swatch color={p.color} />
                  <span>{p.label}</span>
                  <Money usd={p.usd} />
                </span>
              ),
          )}
          <span className="text-muted">
            {plural(own.length, 'turn')}
            {dec.units > 0 && `, ${plural(dec.units, 'piece')} of agent work`}
            {span >= 60_000 && `, ${formatDuration(span)}`}
          </span>
        </div>
        <p className="text-meta text-muted">
          {own.length > 1
            ? `You typed turn ${first.index}; the other ${plural(own.length - 1, 'turn')} started without you (reports from agents, notifications). `
            : ''}
          Work that an earlier prompt asked for and that ran here is counted here.
        </p>
        {dec.compactions.length + dec.agentCompactions.length > 0 && (
          <CompactionTallyLine
            list={[...dec.compactions, ...dec.agentCompactions]}
            inAgents={dec.agentCompactions.length}
          />
        )}
      </div>
      <ul className="max-h-80 divide-y divide-line overflow-y-auto">
        {items.map((x) => {
          if (x.kind === 'step') {
            const c = x.col
            return (
              <li key={`s${c.index}`}>
                <button
                  type="button"
                  aria-pressed={pinnedCol === c.index && !selectedUnitId}
                  onClick={() => onPin(c.index)}
                  className={row(pinnedCol === c.index && !selectedUnitId)}
                >
                  <span className="flex items-center gap-1.5 font-mono text-muted">
                    <span className="flex w-3.5 justify-center">
                      <Swatch color={KIND_SERIES[0].color} />
                    </span>
                    turn {c.index}
                  </span>
                  <span className="min-w-0 truncate">
                    <span className="font-medium">Main agent</span>{' '}
                    <span className="text-muted">{c.prompt || '(no prompt text)'}</span>
                  </span>
                  <span className="text-meta text-faint">{c.human ? 'you typed it' : c.turn.origin}</span>
                  <Bar
                    height={4}
                    total={max}
                    label="share of the largest item"
                    segments={stepParts(c, 'kind').map((p) => ({ value: p.usd, tone: p.tone, title: p.label }))}
                  />
                  <Money usd={x.usd} className="text-right" />
                </button>
              </li>
            )
          }
          const u = x.unit
          return (
            <li key={`u${u.id}`}>
              <button
                type="button"
                aria-pressed={u.id === selectedUnitId}
                onClick={() => onSelectUnit(u.id)}
                className={row(u.id === selectedUnitId)}
              >
                <span className="flex items-center gap-1.5 font-mono text-muted">
                  <KindIcon kind={u.agent.kind} />
                  turn {u.launch}
                </span>
                <span className="min-w-0 truncate">
                  <span className="font-medium">{agentLabel(u.agent)}</span>{' '}
                  <span className="text-muted">
                    {firstLine(unwrapMachineText(u.asked).body) || u.agent.description}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-meta text-faint">
                  {u.returned ? (u.ret === u.launch ? 'back in the same turn' : `back in turn ${u.ret}`) : 'no report'}
                  {u.agent.model && <ModelName name={u.agent.model} />}
                </span>
                <Bar
                  height={4}
                  total={max}
                  label="share of the largest item"
                  segments={unitParts(u, 'kind').map((p) => ({ value: p.usd, tone: p.tone, title: p.label }))}
                />
                <Money usd={x.usd} className="text-right" />
              </button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** The compactions of a decision, added up: how many ran on a cold cache, and what that cost. */
function CompactionTallyLine({ list, inAgents }: { list: Compaction[]; inAgents: number }) {
  const t = compactionTally(list)
  return (
    <p className={`text-meta ${t.cold > 0 ? 'text-bad' : 'text-muted'}`}>
      Compactions in these turns: {t.calls > 0 ? tallyLine(t) : list.length}
      {inAgents > 0 && `, ${inAgents} of them inside agent work`}
      {t.cold > 0 && ` (${warmLine(t)})`}
      {t.unknown > 0 && t.calls > 0 && `, ${t.unknown} without an estimate`}
      {t.calls > 0 ? '. Estimated; not in this total.' : '.'}
    </p>
  )
}

/** A compaction that followed the turn: when, how much context, and what its call is estimated to have cost. */
function CompactionLine({
  compaction: cp,
  lead = 'Compacted after this turn',
}: {
  compaction: Compaction
  lead?: ReactNode
}) {
  const cold = cp.call?.cache === 'cold'
  return (
    <p className={`mt-1.5 text-sec ${cold ? 'text-bad' : 'text-muted'}`}>
      {lead}
      {cp.trigger && ` (${cp.trigger})`}
      {cp.preTokens !== undefined &&
        `, ${formatTokens(cp.preTokens)}${cp.postTokens !== undefined ? ` → ${formatTokens(cp.postTokens)}` : ''} tokens`}
      {cp.call ? `: ${callLine(cp.call)}. ` : '. '}
      <span className="text-muted">
        {cp.call ? 'An estimate, not in the figures above.' : 'No estimate of its call.'}
      </span>
    </p>
  )
}

/** Prompts that arrived while the turn ran: typed without waiting, or delivered by a machine. */
function Queued({ list }: { list: QueuedPrompt[] }) {
  return (
    <div className="space-y-1.5 border-l-2 border-line pl-2.5">
      {list.map((q) => {
        const d = parseTime(q.at)
        const typed = q.origin === 'human' || q.origin === 'command'
        const text = q.text || (q.inbox ?? []).map(inboxSummary).join('\n')
        return (
          <div key={q.at} className="space-y-0.5">
            <div className="text-meta uppercase tracking-wide text-faint" title={d ? fullTime(d) : undefined}>
              {typed ? 'typed while the turn ran' : 'arrived while the turn ran'}
              {d && <span className="normal-case tracking-normal"> · {timeOfDay(d)}</span>}
            </div>
            {text && <PlainText text={text} lines={4} className={typed ? 'font-medium' : 'text-muted'} />}
          </div>
        )
      })}
    </div>
  )
}

/** Dollars and tokens by token class. */
function ClassTable({ buckets }: { buckets: Bucket[] }) {
  const usd = (k: (typeof CLASS_SERIES)[number]['key']) => buckets.reduce((s, b) => s + b.byClass[k], 0)
  const tok = (k: (typeof CLASS_SERIES)[number]['key']) => buckets.reduce((s, b) => s + b.tokens[k], 0)
  const classes = CLASS_SERIES.filter((s) => usd(s.key) >= 0.005 || tok(s.key) > 0)
  if (classes.length === 0) return <p className="text-sec text-faint">Nothing was billed.</p>
  return (
    <>
      <Bar
        height={8}
        label="dollars by token class"
        segments={CLASS_SERIES.map((s) => ({ value: usd(s.key), tone: s.tone, title: s.label }))}
      />
      <table className="mt-2 w-full text-sec">
        <tbody>
          {classes.map((s) => (
            <tr key={s.key}>
              <td className="py-0.5">
                <span className="inline-flex items-center gap-1.5">
                  <Swatch color={s.color} />
                  {s.label}
                </span>
              </td>
              <td className="py-0.5 text-right">
                <Tokens n={tok(s.key)} dim />
              </td>
              <td className="w-20 py-0.5 text-right">
                <Money usd={usd(s.key)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/** Each cache miss in words. */
function Misses({ rereads, model }: { rereads: Reread[]; model: SpendModel }) {
  return (
    <>
      {rereads.map((r) => {
        const who = r.agentId ? model.agentsById.get(r.agentId) : undefined
        return (
          <p key={`${r.agentId ?? ''}${r.at}`} className="mt-1.5 text-sec text-muted">
            {who ? `${agentLabel(who)} wrote` : 'The main agent wrote'} {formatTokens(r.tokens)} tokens of context to
            the cache again
            {r.gapMs !== undefined && `, ${formatDuration(r.gapMs)} after its last message`}
            {r.expired ? ' (the cache had expired)' : ' (too soon for the cache to have expired)'}:{' '}
            <Money usd={r.usd} />, against <Money usd={r.cachedUSD} dim /> had it been read from the cache.
          </p>
        )
      })}
    </>
  )
}

function UnitList({
  units,
  total,
  selectedUnitId,
  onSelectUnit,
  where,
}: {
  units: Unit[]
  /** The denominator of the bars. */
  total: number
  selectedUnitId: string | null
  onSelectUnit: (id: string | null) => void
  /** What the right-hand note says about each unit. */
  where: (u: Unit) => string
}) {
  return (
    <ul className="rounded-card border border-line">
      {[...units]
        .sort((a, b) => b.bucket.usd - a.bucket.usd)
        .map((u) => {
          const on = u.id === selectedUnitId
          return (
            <li key={u.id} className="border-b border-line last:border-b-0">
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onSelectUnit(on ? null : u.id)}
                className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-sec ${on ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
              >
                <KindIcon kind={u.agent.kind} />
                <span className="shrink-0 font-medium">{agentLabel(u.agent)}</span>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {firstLine(unwrapMachineText(u.asked).body) || u.agent.description}
                </span>
                <span className="shrink-0 text-meta text-faint">{where(u)}</span>
                {u.agent.model && <ModelName name={u.agent.model} className="shrink-0 text-meta text-faint" />}
                <span className="w-10 shrink-0">
                  <Bar
                    height={4}
                    total={total}
                    label="share"
                    segments={[
                      { value: u.bucket.usd - u.bucket.reread, tone: toneOf(u) },
                      { value: u.bucket.reread, tone: 'series-5' },
                    ]}
                  />
                </span>
                <Money usd={u.bucket.usd} className="w-14 shrink-0 text-right" />
              </button>
            </li>
          )
        })}
    </ul>
  )
}

const toneOf = (u: Unit) =>
  u.agent.kind === 'teammate' ? 'series-3' : u.agent.kind === 'fork' ? 'series-4' : ('series-2' as const)

/** One piece of agent work: what it was asked, what it cost and why, then the agent. */
function UnitDetail({
  unit: u,
  model,
  onPin,
  onClose,
  onSelectAgentUnit,
}: {
  unit: Unit
  model: SpendModel
  onPin: (index: number) => void
  onClose: () => void
  /** Open the first unit of another agent (the parent or a child in the agent detail). */
  onSelectAgentUnit: (agentId: string) => void
}) {
  const asked = unwrapMachineText(u.asked)
  const a = u.agent
  return (
    <div className="-mx-3 -mb-3 mt-4 border-t border-line">
      <div className="grid gap-6 p-3 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <KindIcon kind={a.kind} />
            <span className="font-semibold">{agentLabel(a)}</span>
            {u.of > 1 && (
              <span className="text-sec text-muted">
                piece {u.ordinal} of {u.of}
              </span>
            )}
            <Money usd={u.bucket.usd} className="font-semibold" />
            {a.model && <ModelName name={a.model} className="text-sec text-muted" />}
          </div>
          <p className="text-sec text-muted">
            {u.ordinal === 1 ? 'Launched' : `Sent a message${u.from ? ` by ${u.from}` : ''}`} in{' '}
            <button type="button" onClick={() => onPin(u.launch)} className="text-accent hover:underline">
              turn {u.launch}
            </button>
            {u.returned ? (
              <>
                ; its report came in{' '}
                <button type="button" onClick={() => onPin(u.ret)} className="text-accent hover:underline">
                  turn {u.ret}
                </button>
              </>
            ) : (
              '; no report came back'
            )}
            {Number.isFinite(u.endMs - u.startMs) &&
              u.endMs > u.startMs &&
              `, ${formatDuration(u.endMs - u.startMs)} of work`}
            , {plural(u.bucket.messages, 'billed message')}.
          </p>
          <div>
            <Label>What it was asked{asked.label ? ` (${asked.label})` : ''}</Label>
            {asked.body ? <PlainText text={asked.body} lines={8} /> : <p className="text-faint">No text.</p>}
          </div>
        </div>
        <div className="min-w-0">
          <Label>What it paid for</Label>
          <ClassTable buckets={[u.bucket]} />
          <Misses rereads={u.bucket.rereads} model={model} />
          {u.nested.length > 0 && (
            <p className="mt-1.5 text-sec text-muted">
              Includes <Money usd={u.nestedUSD} /> of its own {plural(u.nested.length, 'sub-agent')}:{' '}
              {u.nested.map((x) => `${agentLabel(x)} ${formatMoney(x.cost.usd)}`).join(', ')}.
            </p>
          )}
          {u.compactions.map((x) => (
            <CompactionLine
              key={`${x.agent.id}${x.compaction.at}`}
              compaction={x.compaction}
              lead={
                <>
                  {x.agent === u.agent ? 'Its conversation' : `The conversation of ${agentLabel(x.agent)}`} was
                  compacted during{' '}
                  <button type="button" onClick={() => onPin(x.turn)} className="text-accent hover:underline">
                    turn {x.turn}
                  </button>
                </>
              }
            />
          ))}
        </div>
      </div>
      <AgentDetail
        agent={a}
        parent={a.parentAgentId ? model.agentsById.get(a.parentAgentId) : undefined}
        spawned={[...model.agentsById.values()].filter((x) => x.parentAgentId === a.id)}
        subtreeUSD={model.rows.find((r) => r.agent === a)?.usd ?? a.cost.usd}
        onClose={onClose}
        onSelectAgent={onSelectAgentUnit}
        onSelectTurn={onPin}
      />
    </div>
  )
}

export function TurnInspector({
  model,
  col,
  branchTitle,
  selectedUnitId,
  onPin,
  onSelectUnit,
}: {
  model: SpendModel
  col: Col
  /** The session's title, when the tree has more than one. */
  branchTitle?: string
  selectedUnitId: string | null
  onPin: (index: number | null) => void
  onSelectUnit: (id: string | null) => void
}) {
  const t = col.turn
  const prompt = turnPrompt(t)
  const started = parseTime(t.startedAt)
  const models = Object.keys(t.cost.byModel ?? {})
  const unit = model.units.find((u) => u.id === selectedUnitId)
  const launchedUSD = col.launched.reduce((s, u) => s + u.bucket.usd, 0)
  // previous and next among the session's own turns
  const own = model.cols.filter((c) => !c.inherited).map((c) => c.index)
  const step = (d: number) => own[Math.min(own.length - 1, Math.max(0, own.indexOf(col.index) + d))] ?? col.index

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {branchTitle && <span className="max-w-72 truncate font-normal text-muted">{branchTitle}</span>}
          <span>Turn {col.index}</span>
          <Money usd={col.usd} title="what the main agent spent in this turn" />
          <span className="text-sec font-normal text-muted">main agent, this turn only</span>
          <OriginBadge origin={t.origin} />
          {started && (
            <time className="text-sec font-normal text-muted" title={fullTime(started)}>
              {timeOfDay(started)}
            </time>
          )}
          {t.durationMs !== undefined && (
            <span className="text-sec font-normal text-muted">{formatDuration(t.durationMs)}</span>
          )}
          {col.idleMs !== undefined && col.idleMs >= 60_000 && (
            <span className="text-sec font-normal text-muted">after {formatDuration(col.idleMs)} idle</span>
          )}
        </span>
      }
      actions={
        <>
          <IconButton label="Previous turn" onClick={() => onPin(step(-1))}>
            <ChevronLeft size={14} />
          </IconButton>
          <IconButton label="Next turn" onClick={() => onPin(step(1))}>
            <ChevronRight size={14} />
          </IconButton>
          <IconButton label="Unpin the turn" onClick={() => onPin(null)}>
            <X size={14} />
          </IconButton>
        </>
      }
    >
      <div className="grid gap-6 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
        <div className="min-w-0 space-y-3">
          <div>
            <Label>Prompt{prompt.label ? ` (${prompt.label})` : ''}</Label>
            {prompt.body || t.command ? (
              <PlainText text={prompt.body || t.command || ''} lines={8} />
            ) : (
              <p className="text-faint">No prompt text.</p>
            )}
          </div>
          {t.queued && t.queued.length > 0 && <Queued list={t.queued} />}
          {t.finalText && (
            <div>
              <Label>Reply</Label>
              <Clamp lines={10}>
                <Prose>{t.finalText}</Prose>
              </Clamp>
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <Label>What the main agent paid for</Label>
            <ClassTable buckets={[col.step, col.compact]} />
            <Misses rereads={[...col.step.rereads, ...col.compact.rereads]} model={model} />
            <p className="mt-1.5 text-meta text-faint">
              {models.map((m, i) => (
                <span key={m}>
                  {i > 0 && ', '}
                  <ModelName name={m} />
                </span>
              ))}
              {col.compact.usd > 0 && (
                <>
                  {' · compaction '}
                  <Money usd={col.compact.usd} dim className="text-meta" />
                </>
              )}
              {typeof t.contextTokens === 'number' && ` · ${formatTokens(t.contextTokens)} context at the end`}
            </p>
            {col.compactions.map((cp) => (
              <CompactionLine key={cp.at} compaction={cp} />
            ))}
          </div>

          {col.launched.length > 0 && (
            <div>
              <Label>
                Launched in this turn: {plural(col.launched.length, 'piece')} of agent work, {formatMoney(launchedUSD)}
              </Label>
              <UnitList
                units={col.launched}
                total={Math.max(launchedUSD, col.usd)}
                selectedUnitId={selectedUnitId}
                onSelectUnit={onSelectUnit}
                where={(u) => (u.returned ? (u.ret === u.launch ? 'back in this turn' : `back in turn ${u.ret}`) : '')}
              />
            </div>
          )}
          {col.arrived.some((u) => u.launch !== col.index) && (
            <div>
              <Label>Reports that came in with this turn</Label>
              <UnitList
                units={col.arrived.filter((u) => u.launch !== col.index)}
                total={Math.max(...col.arrived.map((u) => u.bucket.usd), col.usd)}
                selectedUnitId={selectedUnitId}
                onSelectUnit={onSelectUnit}
                where={(u) => `from turn ${u.launch}`}
              />
            </div>
          )}
        </div>
      </div>

      {unit && (
        <UnitDetail
          unit={unit}
          model={model}
          onPin={onPin}
          onClose={() => onSelectUnit(null)}
          onSelectAgentUnit={(agentId) => {
            const first = model.units.find((u) => u.agent.id === agentId)
            if (first) onSelectUnit(first.id)
          }}
        />
      )}
    </Card>
  )
}
