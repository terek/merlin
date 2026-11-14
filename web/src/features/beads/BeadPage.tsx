// The bead page (docs/ui.md section 11): one bead, its family, what was done to it session by
// session, and what the sessions cost.

import { ChevronRight } from 'lucide-react'
import { Fragment } from 'react'
import { Link, useParams } from 'react-router-dom'
import { isApiError } from '../../api/client'
import { useBead, useBeads } from '../../api/queries'
import type { BeadDetail, BeadRef, BeadSession, BeadStep } from '../../api/types'
import { cn } from '../../lib/cn'
import { plural } from '../../lib/format'
import { useDocumentTitle } from '../../lib/hooks'
import { beadPath, sessionPath, shortProject } from '../../lib/paths'
import { fullTime, parseTime, shortDate, timeOfDay } from '../../lib/time'
import { Badge, BeadStatus, Card, EmptyState, Id, Money, QueryBoundary, Section, Skeleton, type Tone } from '../../ui'
import { actor, chain, groupSteps, opVerb, type StepGroup } from './model'

export function BeadPage() {
  const { id = '' } = useParams()
  const q = useBead(id)
  useDocumentTitle(q.data ? `${q.data.id}${q.data.title ? ` ${q.data.title}` : ''}` : id)
  if (q.isError && isApiError(q.error) && q.error.status === 404) {
    return (
      <EmptyState title="No such bead" className="py-24">
        <span className="font-mono">{id}</span> is not in any bead database Merlin knows and no session ran a bd call on
        it. <Link to="/">Go to Overview</Link> or <Link to="/cost">Cost</Link>.
      </EmptyState>
    )
  }
  return (
    <div className="mx-auto max-w-[1100px] space-y-6 px-4 py-4">
      <QueryBoundary query={q} skeleton={<Skeleton className="h-64" />}>
        {(d) => <Bead bead={d} />}
      </QueryBoundary>
    </div>
  )
}

function Bead({ bead: d }: { bead: BeadDetail }) {
  const groups = groupSteps(d.timeline, d.sessions)
  const sessions = d.sessions ?? []
  return (
    <>
      <Header bead={d} />
      <Section
        title="Timeline"
        hint="Every bd call that named this bead, by the session that ran it. Viewing is dimmed; a failed call is marked."
      >
        {groups.length === 0 ? (
          <Card>
            <EmptyState title="No bd call named this bead">
              It is known from a bead database, or as the parent of another bead.
            </EmptyState>
          </Card>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <Group key={`${g.harness}/${g.sessionId}`} group={g} />
            ))}
          </div>
        )}
      </Section>
      {sessions.length > 0 && <Sessions sessions={sessions} />}
    </>
  )
}

function SourceLabel({ source }: { source: BeadRef['source'] }) {
  if (!source || source === 'export') return null
  const title =
    source === 'implied'
      ? 'Named only as the parent of another bead: no database or session says more'
      : 'Known from sessions’ bd calls; no bead database export has it'
  return (
    <span title={title} className="text-meta text-faint">
      {source}
    </span>
  )
}

const STATUS_TONE: Record<string, Tone> = { closed: 'ok', in_progress: 'accent', blocked: 'bad' }

function Header({ bead: d }: { bead: BeadDetail }) {
  // an untitled bead is named by its family: the hint of the family it belongs to
  const families = useBeads(!d.title)
  const hint = d.title ? undefined : families.data?.families.find((f) => f.root.id === d.root)?.hint
  const up = chain(d)
  const children = d.children ?? []
  return (
    <header className="space-y-2">
      {up.length > 0 && (
        <nav aria-label="Parents" className="flex flex-wrap items-center gap-1 text-sec text-muted">
          {up.map((a) => (
            <Fragment key={a.id}>
              <Link to={beadPath(a.id)} title={a.title} className="inline-flex items-center gap-1.5">
                <BeadStatus status={a.status} />
                <span className="font-mono">{a.id}</span>
                {a.title && <span className="max-w-60 truncate text-fg">{a.title}</span>}
              </Link>
              <ChevronRight size={12} className="text-faint" />
            </Fragment>
          ))}
        </nav>
      )}
      <div>
        <h1 className="text-page font-semibold [overflow-wrap:anywhere]">
          {d.title ?? <span className="font-mono">{d.id}</span>}
        </h1>
        {d.title ? (
          <div className="font-mono text-sec text-muted">{d.id}</div>
        ) : (
          hint && (
            <div
              className="text-sec text-muted italic"
              title="No title was recorded for this bead; this is its family's"
            >
              in the family “{hint}”
            </div>
          )
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sec">
        <span className="inline-flex items-center gap-1.5">
          {d.status ? (
            <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{d.status.replace('_', ' ')}</Badge>
          ) : (
            <span className="text-faint">status unknown</span>
          )}
        </span>
        {d.type && <Badge>{d.type}</Badge>}
        {d.priority !== undefined && (
          <span className="text-muted" title="0 is the most urgent">
            P{d.priority}
          </span>
        )}
        <SourceLabel source={d.source} />
        {d.closedAt && (
          <span className="text-muted" title={fullTime(new Date(d.closedAt))}>
            closed {shortDate(new Date(d.closedAt))}
            {d.closeReason ? `: ${d.closeReason}` : ''}
          </span>
        )}
      </div>
      {children.length > 0 && (
        <div className="space-y-0.5 pt-1">
          <div className="text-meta text-muted">{plural(children.length, 'child', 'children')}</div>
          <ul className="space-y-0.5">
            {children.map((c) => (
              <li key={c.id}>
                <Link to={beadPath(c.id)} className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                  <BeadStatus status={c.status} />
                  <span className="shrink-0 font-mono text-meta">{c.id}</span>
                  <span className="min-w-0 truncate text-fg">{c.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </header>
  )
}

function Group({ group: g }: { group: StepGroup }) {
  const first = parseTime(g.steps[0]?.at)
  const title = g.session?.title
  return (
    <Card
      flush
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <Badge className="shrink-0">{g.harness}</Badge>
          <Link to={sessionPath({ harness: g.harness, id: g.sessionId })} className="min-w-0 truncate">
            {title || <Id value={g.sessionId} />}
          </Link>
        </span>
      }
      actions={
        <span className="text-sec font-normal text-muted" title={first ? fullTime(first) : undefined}>
          {first ? shortDate(first) : ''} · {plural(g.steps.length, 'step')}
        </span>
      }
    >
      <ol className="divide-y divide-line">
        {g.steps.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps have no id; the list is static
          <Step key={`${s.at}-${i}`} step={s} />
        ))}
      </ol>
    </Card>
  )
}

function Step({ step: s }: { step: BeadStep }) {
  const at = parseTime(s.at)
  const failed = s.outcome === 'failed'
  const text = s.reason || s.title
  return (
    <li className={cn('flex items-baseline gap-3 px-3 py-1.5', s.op === 'show' && 'text-muted opacity-70')}>
      <time
        dateTime={s.at}
        title={at ? fullTime(at) : undefined}
        className="w-16 shrink-0 font-mono text-meta text-muted"
      >
        {at ? timeOfDay(at) : ''}
      </time>
      <span className="w-32 shrink-0 text-sec text-muted" title={s.agentId ? `Agent ${s.agentId}` : 'The main agent'}>
        {actor(s)}
        {s.agentId && <span className="ml-1.5 font-mono text-meta text-faint">{s.agentId.slice(0, 6)}</span>}
      </span>
      <span className={cn('w-24 shrink-0 font-medium', failed && 'text-bad line-through')}>{opVerb(s.op)}</span>
      <span className="w-24 shrink-0">
        {failed ? (
          <Badge tone="bad" title="The bd call failed; it is history all the same">
            failed
          </Badge>
        ) : (
          s.status && <span className="text-sec text-muted">{s.status.replace('_', ' ')}</span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate" title={text}>
        {s.reason && s.title && <span className="text-muted">{s.title}: </span>}
        {s.reason || s.title}
      </span>
    </li>
  )
}

function Sessions({ sessions }: { sessions: BeadSession[] }) {
  const total = sessions.reduce((n, s) => n + s.usd, 0)
  return (
    <Section title="Sessions" hint="Each one's share of its cost is what it spent on this bead, most expensive first.">
      <Card flush>
        <ul className="divide-y divide-line">
          {sessions.map((s) => (
            <li key={`${s.harness}/${s.id}`} className="flex items-baseline gap-3 px-3 py-1.5">
              <Badge className="shrink-0">{s.harness}</Badge>
              <Link to={sessionPath({ harness: s.harness, id: s.id })} className="min-w-0 flex-1 truncate">
                {s.title || <Id value={s.id} />}
              </Link>
              {s.project && (
                <span className="hidden shrink-0 text-sec text-muted sm:inline" title={s.project}>
                  {shortProject(s.project)}
                </span>
              )}
              <span className="shrink-0 text-sec text-muted">{s.ops.join(', ')}</span>
              <Money usd={s.usd} className="w-16 shrink-0 text-right" />
            </li>
          ))}
        </ul>
        {sessions.length > 1 && (
          <div className="flex justify-end gap-3 border-t border-line px-3 py-1.5 text-sec text-muted">
            <span>Total</span>
            <Money usd={total} className="w-16 text-right" />
          </div>
        )}
      </Card>
    </Section>
  )
}
