// The box under the focus's graph (docs/ui.md section 9): what a selected turn, piece of agent work or background job says, read
// as a conversation. A main turn: the prompt (who it came from), what the turn did in a line, the reply. A piece
// of agent work: the exchange between the main agent and the agent, a request and its response at a time.
// No dollars, no tokens: the graph and its hover carry those.

import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { createContext, Fragment, type ReactNode, useContext, useState } from 'react'
import type { Agent, InboxMessage, Job, QueuedPrompt, Turn } from '../../api/types'
import { agentRole, ROLE_LABEL } from '../../lib/agent'
import { cn } from '../../lib/cn'
import { formatDuration, plural } from '../../lib/format'
import { inboxBody } from '../../lib/inbox'
import { fullTime, parseTime, timeOfDay } from '../../lib/time'
import { unwrapMachineText } from '../../lib/wrapper'
import { Badge, Clamp, FrameSection, IconButton, ModelName, PlainText, Prose } from '../../ui'
import { KindIcon } from '../agents/AgentRow'
import { agentLabel } from '../agents/model'
import { jobKind } from '../spend/jobs'
import { kindColor } from '../spend/marks'
import type { Col, SpendModel, Unit } from '../spend/model'
import type { Selection } from '../spend/SpendGraph'
import { jobLaunchTurn } from '../spend/session'
import type { Branch } from '../spend/tree'
import {
  agentThread,
  type Exchange,
  exchangeGist,
  filesLine,
  inboxKindName,
  noReply,
  openTurn,
  promptSource,
  reachedLine,
  toolsLine,
  turnMarks,
} from './thread'

const FOLD = 12

/** The names of the session's agents, by id: a message that says only which agent it is about is named by it. */
const AgentNames = createContext<ReadonlyMap<string, Agent>>(new Map())

function When({ at, className }: { at?: string; className?: string }) {
  const d = parseTime(at)
  if (!d) return null
  return (
    <time className={cn('text-muted', className)} title={fullTime(d)}>
      {timeOfDay(d)}
    </time>
  )
}

/** A link-looking button. */
function Go({ onClick, children, title }: { onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title} className="text-accent hover:underline">
      {children}
    </button>
  )
}

/** One speaker's turn to talk: who, when, then what they said. */
function Said({
  who,
  at,
  tone = 'line',
  children,
}: {
  who: ReactNode
  at?: string
  tone?: 'you' | 'line'
  children: ReactNode
}) {
  return (
    <div className={cn('space-y-1 border-l-2 pl-3', tone === 'you' ? 'border-accent' : 'border-line')}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-sec">
        <span className="font-medium text-fg">{who}</span>
        <When at={at} />
      </div>
      {children}
    </div>
  )
}

function Folded({ children }: { children: string }) {
  return (
    <Clamp lines={FOLD}>
      <Prose>{children}</Prose>
    </Clamp>
  )
}

const NONE = <p className="text-sec text-faint">No text.</p>

/** A message a machine delivered: sender (a link when it is one of the session's agents), kind, text. */
function InboxBlock({ m, onOpenAgent }: { m: InboxMessage; onOpenAgent: (agentId: string) => void }) {
  const body = m.encrypted && !m.text ? '' : unwrapMachineText(inboxBody(m)).body
  const named = useContext(AgentNames)
  const about = m.agentId ? named.get(m.agentId) : undefined
  const from = m.from || (about ? agentLabel(about) : m.kind === 'task' ? 'A background task' : 'A teammate')
  return (
    <Said
      who={
        <>
          {m.agentId ? <Go onClick={() => onOpenAgent(m.agentId as string)}>{from}</Go> : from}{' '}
          <span className="font-normal text-muted">{inboxKindName(m)}</span>
        </>
      }
      at={m.at}
    >
      {m.encrypted && !m.text ? (
        <p className="text-sec text-muted">The harness keeps this message encrypted.</p>
      ) : body ? (
        <Folded>{body}</Folded>
      ) : (
        NONE
      )}
    </Said>
  )
}

function Queued({ list, onOpenAgent }: { list: QueuedPrompt[]; onOpenAgent: (agentId: string) => void }) {
  return (
    <>
      {list.map((q) => {
        const typed = q.origin === 'human' || q.origin === 'command'
        return (
          <Fragment key={q.at}>
            {q.text && (
              <Said who={typed ? 'You, while it ran' : 'Arrived while it ran'} at={q.at} tone={typed ? 'you' : 'line'}>
                <PlainText text={q.text} lines={FOLD} />
              </Said>
            )}
            {(q.inbox ?? []).map((m) => (
              <InboxBlock key={`${m.at}${m.from ?? ''}${m.taskId ?? ''}`} m={m} onOpenAgent={onOpenAgent} />
            ))}
          </Fragment>
        )
      })}
    </>
  )
}

/** The one line of what the turn or the work did: its tools and files, and the agents it launched. */
function DidLine({
  calls,
  byName,
  files,
  launched,
  onSelectUnit,
}: {
  calls: number
  byName?: Record<string, number>
  files?: string[]
  launched?: Unit[]
  onSelectUnit?: (id: string) => void
}) {
  const tools = toolsLine(calls, byName)
  const nFiles = filesLine(files)
  const agents = launched ?? []
  if (!tools && !agents.length) return <p className="text-sec text-muted">Made no tool calls.</p>
  return (
    <p className="text-sec text-muted">
      {tools}
      {nFiles && (
        <>
          {tools && ' · '}
          <span title={(files ?? []).join('\n')}>{nFiles}</span>
        </>
      )}
      {agents.length > 0 && (
        <>
          {(tools || nFiles) && ' · '}
          launched{' '}
          {agents.map((u, i) => (
            <Fragment key={u.id}>
              {i > 0 && ', '}
              <Go onClick={() => onSelectUnit?.(u.id)} title={u.agent.description}>
                {agentLabel(u.agent)}
              </Go>
            </Fragment>
          ))}
        </>
      )}
    </p>
  )
}

function Marks({ list }: { list: string[] }) {
  return (
    <>
      {list.map((m) => (
        <Badge key={m}>{m}</Badge>
      ))}
    </>
  )
}

/** The prompt of a main turn: who it came from, and what it said. */
function TurnPrompt({ turn: t, onOpenAgent }: { turn: Turn; onOpenAgent: (agentId: string) => void }) {
  const inbox = t.inbox ?? []
  const source = promptSource(t.origin, inbox)
  const text = inbox.length === 0 ? unwrapMachineText(t.userText ?? '') : undefined
  const typed = (text?.body ?? t.userText ?? '').trim() || t.command || ''
  const who = text?.label && !source.typed ? `${source.label} (${text.label})` : source.label
  const images = t.images ? plural(t.images, 'image') : ''
  return (
    <div className="space-y-3">
      {(typed || images || inbox.length === 0) && (
        <Said who={who} at={t.startedAt} tone={source.typed ? 'you' : 'line'}>
          {typed ? (
            source.typed ? (
              <PlainText text={typed} lines={FOLD} />
            ) : (
              <Folded>{typed}</Folded>
            )
          ) : images ? null : (
            NONE
          )}
          {images && <p className="text-sec text-muted">{images}</p>}
        </Said>
      )}
      {inbox.map((m) => (
        <InboxBlock key={`${m.at}${m.from ?? ''}${m.taskId ?? ''}${m.kind ?? ''}`} m={m} onOpenAgent={onOpenAgent} />
      ))}
      {t.queued && t.queued.length > 0 && <Queued list={t.queued} onOpenAgent={onOpenAgent} />}
    </div>
  )
}

/** What the parts of the box take: the model and the handlers, as the box derives them from the selection. */
interface BoxParts {
  model: SpendModel
  col: Col
  /** The session's title, when the tree has more than one. */
  branchTitle?: string
  /** Select another turn of the session (null clears the selection). */
  onPin: (index: number | null) => void
  /** Select a piece of agent work of this turn, or (null) clear the selection. */
  onSelectUnit: (id: string | null) => void
  /** Close the background job (null clears the selection). */
  onSelectJob: (id: string | null) => void
  /** Select the work of an agent by its id (a sender of a message), wherever in the tree it is. */
  onOpenAgent: (agentId: string) => void
  /** Select a turn (a link from the agent's or the job's box to its turn). */
  onOpenTurn: (index: number) => void
}

export interface TurnBoxProps {
  /** The session the selection is in. */
  branch: Branch
  /** The session's title, when the tree has more than one. */
  branchTitle?: string
  selection: Selection
  onSelect: (selection: Selection | null) => void
  /** Select the work of an agent by its id, wherever in the tree it is. */
  onOpenAgent: (agentId: string) => void
}

/** What the main agent did in a turn, and the reply. */
function MainTurn({
  model,
  col,
  branchTitle,
  onPin,
  onSelectUnit,
  onOpenAgent,
}: Omit<BoxParts, 'onSelectJob' | 'onOpenTurn'>) {
  const t = col.turn
  const started = parseTime(t.startedAt)
  // previous and next among the session's own turns
  const own = model.cols.filter((c) => !c.inherited).map((c) => c.index)
  const at = own.indexOf(col.index)
  const prev = at > 0 ? own[at - 1] : undefined
  const next = at >= 0 && at < own.length - 1 ? own[at + 1] : undefined
  const marks = turnMarks(t)
  return (
    <FrameSection
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sec normal-case tracking-normal">
          {branchTitle && <span className="max-w-72 truncate font-normal text-muted">{branchTitle}</span>}
          <span className="text-faint text-meta uppercase tracking-wide">Turn {col.index}</span>
          {started && (
            <time className="font-normal text-muted" title={fullTime(started)}>
              {timeOfDay(started)}
            </time>
          )}
          {t.durationMs !== undefined && t.durationMs > 0 && (
            <span className="font-normal text-muted">{formatDuration(t.durationMs)}</span>
          )}
          <Marks list={marks} />
        </span>
      }
      actions={
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            label="Previous turn"
            disabled={prev === undefined}
            onClick={() => prev !== undefined && onPin(prev)}
          >
            <ChevronLeft size={14} />
          </IconButton>
          <IconButton label="Next turn" disabled={next === undefined} onClick={() => next !== undefined && onPin(next)}>
            <ChevronRight size={14} />
          </IconButton>
          <IconButton label="Close the turn" onClick={() => onPin(null)}>
            <X size={14} />
          </IconButton>
        </div>
      }
    >
      <div className="space-y-3">
        <TurnPrompt turn={t} onOpenAgent={onOpenAgent} />
        <DidLine
          calls={t.toolCalls}
          byName={t.toolsByName}
          files={t.filesTouched}
          launched={col.launched}
          onSelectUnit={onSelectUnit}
        />
        {t.finalText ? (
          <Said who="Reply" at={t.endedAt}>
            <Folded>{t.finalText}</Folded>
          </Said>
        ) : (
          <p className="text-sec text-muted">{noReply(t)}</p>
        )}
      </div>
    </FrameSection>
  )
}

/** The request of an exchange: the main agent's task, or the message that set the agent working again. */
function Request({ x, onOpenAgent }: { x: Exchange; onOpenAgent: (agentId: string) => void }) {
  const text = x.request.trim()
  return (
    <div className="space-y-3">
      {(text || x.encrypted || x.inbox.length === 0) && (
        <Said who={`Request from ${x.from}`} at={x.requestAt} tone="you">
          {text ? (
            <Folded>{unwrapMachineText(text).body}</Folded>
          ) : x.encrypted ? (
            <p className="text-sec text-muted">The harness keeps this prompt encrypted.</p>
          ) : (
            NONE
          )}
        </Said>
      )}
      {x.inbox.map((m) => (
        <InboxBlock key={`${m.at}${m.from ?? ''}${m.kind ?? ''}`} m={m} onOpenAgent={onOpenAgent} />
      ))}
      {x.queued.length > 0 && <Queued list={x.queued} onOpenAgent={onOpenAgent} />}
    </div>
  )
}

function Response({ x, who, status }: { x: Exchange; who: string; status: Agent['status'] }) {
  if (x.response.trim()) {
    return (
      <Said who={`Response from ${who}`} at={x.responseAt}>
        <Folded>{x.response}</Folded>
      </Said>
    )
  }
  const why = x.interrupted ? 'interrupted' : status === 'killed' ? 'killed before it answered' : 'still working'
  return <p className="text-sec text-muted">No response ({why}).</p>
}

/** A piece of agent work: the exchange between the main agent and the agent. */
function AgentWork({
  unit: u,
  branchTitle,
  onSelectUnit,
  onOpenAgent,
  onOpenTurn,
}: Omit<BoxParts, 'col' | 'onSelectJob' | 'onPin' | 'model'> & { unit: Unit }) {
  const a = u.agent
  const label = agentLabel(a)
  const open = openTurn(a, u.startMs, u.ordinal)
  const thread = agentThread(a, open)
  // turns the reader has opened or closed by hand; the selected one starts open
  const [toggled, setToggled] = useState<Set<number>>(new Set())
  const isOpen = (x: Exchange) => x.open !== toggled.has(x.index)
  const flip = (i: number) =>
    setToggled((s) => {
      const n = new Set(s)
      if (!n.delete(i)) n.add(i)
      return n
    })
  const started = parseTime(a.startedAt)
  const here = a.turns?.[open]
  const calls = here?.toolCalls ?? a.toolCalls
  const byName = here?.toolsByName ?? a.toolsByName
  const reached = reachedLine(u.reports)
  const role = ROLE_LABEL[agentRole(a)]
  return (
    <FrameSection
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sec normal-case tracking-normal">
          {branchTitle && <span className="max-w-72 truncate font-normal text-muted">{branchTitle}</span>}
          <KindIcon agent={a} color={kindColor(a)} />
          <span className="font-medium text-fg">{label}</span>
          {a.description && (
            <span className="max-w-[48ch] truncate font-normal text-muted" title={a.description}>
              {a.description}
            </span>
          )}
          <span className="font-normal text-muted">
            {role}
            {a.model && (
              <>
                {' · '}
                <ModelName name={a.model} />
              </>
            )}
          </span>
          {started && (
            <time className="font-normal text-muted" title={fullTime(started)}>
              {timeOfDay(started)}
            </time>
          )}
          <Badge>{a.status === 'open' ? 'working' : a.status}</Badge>
        </span>
      }
      actions={
        <IconButton label="Close the agent's work" onClick={() => onSelectUnit(null)} className="shrink-0">
          <X size={14} />
        </IconButton>
      }
    >
      <div className="space-y-3">
        <p className="text-sec text-muted">
          {u.ordinal === 1 ? 'Launched' : u.woken ? 'Woken by its own background work' : 'Sent a message'} in{' '}
          <Go onClick={() => onOpenTurn(u.launch)}>turn {u.launch}</Go>
          {reached && (
            <>
              {' · '}
              <span title={reached}>reached the main agent in turn{u.reports.length > 1 ? 's' : ''} </span>
              {u.reports.map((r, k) => (
                <Fragment key={r}>
                  {k > 0 && (k === u.reports.length - 1 ? ' and ' : ', ')}
                  <Go onClick={() => onOpenTurn(r)}>{r}</Go>
                </Fragment>
              ))}
            </>
          )}
          {!reached && !u.returned && ' · no report came back'}
        </p>
        {thread.map((x) =>
          isOpen(x) ? (
            <div key={x.index} className="space-y-3">
              {thread.length > 1 && (
                <button
                  type="button"
                  onClick={() => flip(x.index)}
                  className="text-meta uppercase tracking-wide text-faint hover:text-muted"
                >
                  Exchange {x.index + 1} of {thread.length}
                </button>
              )}
              <Request x={x} onOpenAgent={onOpenAgent} />
              <Response x={x} who={label} status={a.status} />
            </div>
          ) : (
            <button
              key={x.index}
              type="button"
              onClick={() => flip(x.index)}
              className="flex w-full max-w-col items-baseline gap-2 rounded-card border-l-2 border-line py-0.5 pl-3 text-left text-sec hover:bg-surface-2"
            >
              <span className="shrink-0 text-muted">{x.index + 1}.</span>
              <span className="shrink-0 font-medium">{x.from}</span>
              <span className="min-w-0 truncate text-muted">{exchangeGist(x) || '(no text)'}</span>
              <When at={x.requestAt} className="shrink-0 text-meta" />
            </button>
          ),
        )}
        <DidLine calls={calls} byName={byName} />
        {u.nested.length > 0 && (
          <p className="text-sec text-muted">
            Its own {plural(u.nested.length, 'sub-agent')}:{' '}
            {u.nested.map((n, i) => (
              <Fragment key={n.id}>
                {i > 0 && ', '}
                <Go onClick={() => onOpenAgent(n.id)}>{agentLabel(n)}</Go>
              </Fragment>
            ))}
          </p>
        )}
      </div>
    </FrameSection>
  )
}

/** A background job: what it was, the command as stored, and where its output went. */
function JobWork({
  job: j,
  branchTitle,
  onSelectJob,
  onOpenAgent,
  onOpenTurn,
  launch,
}: Pick<BoxParts, 'branchTitle' | 'onSelectJob' | 'onOpenAgent' | 'onOpenTurn'> & { job: Job; launch?: number }) {
  const agents = useContext(AgentNames)
  const [all, setAll] = useState(false)
  const nameOf = (id: string) => {
    const a = agents.get(id)
    return a ? agentLabel(a) : id
  }
  const started = parseTime(j.startedAt)
  const ended = parseTime(j.endedAt)
  const open = j.status === 'open'
  const command = (j.command ?? '').replace(/\r?\n$/, '')
  const returns = j.returns ?? []
  const shown = all ? returns : returns.slice(0, FOLD)
  const description = j.description || j.command || j.id
  const turn = launch
  return (
    <FrameSection
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sec normal-case tracking-normal">
          {branchTitle && <span className="max-w-72 truncate font-normal text-muted">{branchTitle}</span>}
          <span className="font-medium text-fg">{jobKind({ kind: j.kind })}</span>
          <span className="max-w-[48ch] truncate font-normal text-muted" title={description}>
            {description}
          </span>
          {started && (
            <time className="font-normal text-muted" title={fullTime(started)}>
              {timeOfDay(started)}
            </time>
          )}
          <Badge>{open ? 'running' : j.status}</Badge>
          {started && ended && !open && (
            <span className="font-normal text-muted">{formatDuration(ended.getTime() - started.getTime())}</span>
          )}
        </span>
      }
      actions={
        <IconButton label="Close the background job" onClick={() => onSelectJob(null)} className="shrink-0">
          <X size={14} />
        </IconButton>
      }
    >
      <div className="space-y-3">
        <p className="text-sec text-muted">
          Started
          {turn !== undefined && (
            <>
              {' in '}
              <Go onClick={() => onOpenTurn(turn)}>turn {turn}</Go>
            </>
          )}
          {j.agentId && (
            <>
              {' by '}
              <Go onClick={() => onOpenAgent(j.agentId ?? '')}>{nameOf(j.agentId)}</Go>
            </>
          )}
          {!open && ` · ended ${j.status}${j.exitCode !== undefined ? `, exit ${j.exitCode}` : ''}`}
        </p>
        {command && (
          <pre className="max-w-col overflow-x-auto whitespace-pre-wrap break-words rounded-card bg-surface-2 px-3 py-2 font-mono text-sec">
            {command}
          </pre>
        )}
        {returns.length === 0 ? (
          <p className="text-sec text-muted">Nothing came back.</p>
        ) : (
          <ul className="max-w-col space-y-1.5 text-sec">
            {shown.map((r) => (
              <li key={`${r.at}${r.how}${r.turn ?? ''}${r.agentId ?? ''}`}>
                <When at={r.at} className="mr-2" />
                {r.agentId ? (
                  <>
                    {r.how === 'woke' ? 'woke' : r.how === 'delivered' ? 'delivered to' : 'fetched by'}{' '}
                    <Go onClick={() => onOpenAgent(r.agentId ?? '')}>{nameOf(r.agentId)}</Go>
                  </>
                ) : (
                  <>
                    {r.how === 'woke' ? 'woke' : r.how === 'delivered' ? 'delivered in' : 'fetched in'}{' '}
                    {r.turn !== undefined ? (
                      <Go onClick={() => onOpenTurn(r.turn ?? 0)}>turn {r.turn}</Go>
                    ) : (
                      'the main agent'
                    )}
                  </>
                )}
                {r.final && <span className="text-muted"> (final)</span>}
                {r.summary && <p className="whitespace-pre-wrap break-words text-muted">{r.summary}</p>}
              </li>
            ))}
            {!all && returns.length > FOLD && (
              <li>
                <Go onClick={() => setAll(true)}>and {returns.length - FOLD} more</Go>
              </li>
            )}
          </ul>
        )}
      </div>
    </FrameSection>
  )
}

/** The box under the graph: what is selected, a turn, a piece of agent work or a background job. */
export function TurnBox({ branch, branchTitle, selection, onSelect, onOpenAgent }: TurnBoxProps) {
  const model = branch.model
  const at = branch.index
  const onOpenTurn = (col: number) => onSelect({ kind: 'turn', branch: at, col })
  const clear = () => onSelect(null)
  let body: ReactNode = null
  if (selection.kind === 'job') {
    const job = branch.detail.digest.jobs?.find((j) => j.id === selection.id)
    if (job) {
      body = (
        <JobWork
          key={job.id}
          job={job}
          launch={jobLaunchTurn(model.cols, job)}
          branchTitle={branchTitle}
          onSelectJob={clear}
          onOpenAgent={onOpenAgent}
          onOpenTurn={onOpenTurn}
        />
      )
    }
  } else if (selection.kind === 'unit') {
    const unit = model.units.find((u) => u.id === selection.id)
    if (unit) {
      body = (
        <AgentWork
          key={unit.id}
          unit={unit}
          branchTitle={branchTitle}
          onSelectUnit={(id) => (id === null ? clear() : onSelect({ kind: 'unit', branch: at, id }))}
          onOpenAgent={onOpenAgent}
          onOpenTurn={onOpenTurn}
        />
      )
    }
  } else {
    const col = model.cols[selection.col]
    if (col) {
      body = (
        <MainTurn
          key={col.index}
          model={model}
          col={col}
          branchTitle={branchTitle}
          onPin={(i) => (i === null ? clear() : onOpenTurn(i))}
          onSelectUnit={(id) => (id === null ? clear() : onSelect({ kind: 'unit', branch: at, id }))}
          onOpenAgent={onOpenAgent}
        />
      )
    }
  }
  return <AgentNames.Provider value={model.agentsById}>{body}</AgentNames.Provider>
}
