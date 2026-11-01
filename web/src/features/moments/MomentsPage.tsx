// The Moments page (docs/moments.md): what the sessions say about how someone works with agents,
// the three personas' reactions, what to try next, and the card to share.

import { ChevronRight, Download } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMoments } from '../../api/queries'
import type { MomentsReport, MomentView, PersonaView } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatCount } from '../../lib/format'
import { useDocumentTitle } from '../../lib/hooks'
import { sessionPath } from '../../lib/paths'
import { Badge, Button, Card, EmptyState, QueryBoundary, RelTime, Section, Skeleton } from '../../ui'
import { cardPng, MomentCard } from './MomentCard'
import { groupByStatus, PERSONA_NAMES, PERSONAS } from './model'
import { PersonaAvatar, PersonaFace } from './PersonaAvatar'

const HANDLE_KEY = 'merlin.moments.handle'

function loadHandle(): string {
  try {
    return localStorage.getItem(HANDLE_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveHandle(h: string) {
  try {
    localStorage.setItem(HANDLE_KEY, h)
  } catch {
    // private window: the handle is not remembered
  }
}

export function MomentsPage() {
  useDocumentTitle('Moments')
  const q = useMoments()
  return (
    <div className="mx-auto max-w-[1280px] space-y-6 px-4 py-4">
      <header>
        <h1 className="text-page font-semibold">Moments</h1>
        <p className="text-sec text-muted">
          What your sessions say about how you work with coding agents. Experimental; worked out on this machine from
          your history, every time you open the page.
        </p>
      </header>
      <QueryBoundary
        query={q}
        isEmpty={(r) => r.sessions - r.scripted === 0}
        empty={
          <EmptyState title="No sessions yet">
            Moments come from the sessions you work in. Once Merlin has indexed a few, they show up here.
          </EmptyState>
        }
        skeleton={<Skeleton className="h-96" />}
      >
        {(r) => <Report report={r} />}
      </QueryBoundary>
    </div>
  )
}

function Report({ report }: { report: MomentsReport }) {
  const g = useMemo(() => groupByStatus(report.moments), [report.moments])
  const byId = useMemo(() => new Map(report.moments.map((m) => [m.id, m])), [report.moments])
  return (
    <div className="space-y-8">
      <CardPanel report={report} />
      <div className="grid grid-cols-3 gap-3">
        {PERSONAS.map((id) => {
          const p = report.personas.find((x) => x.id === id)
          return p ? <PersonaPanel key={id} persona={p} /> : null
        })}
      </div>
      {report.suggestions.length > 0 && (
        <Section title="Worth trying" hint="Moments that are not yet a habit, picked from what your sessions show.">
          <div className="grid grid-cols-3 gap-3">
            {report.suggestions.map((s) => {
              const m = byId.get(s.moment)
              return m ? <Suggestion key={s.moment} moment={m} reason={s.reason} /> : null
            })}
          </div>
        </Section>
      )}
      <MomentList
        title="You do these well"
        hint="Habits: seen in at least three different weeks."
        moments={g.habits}
        empty="No habits yet: a moment becomes one after three different weeks."
      />
      <MomentList
        title="You've been exploring"
        hint="Seen, but in fewer than three weeks."
        moments={g.explored}
        empty="Nothing in between: everything you tried has stuck."
      />
      {g.unseen.length > 0 && <Unseen moments={g.unseen} />}
      <p className="text-sec text-faint">
        From {formatCount(report.sessions - report.scripted)} sessions
        {report.scripted > 0 && <> and {formatCount(report.scripted)} scripted runs</>}
        {report.since && (
          <>
            {' '}
            since <RelTime time={report.since} />
          </>
        )}
        . The personas are caricatures; their reactions are Merlin's, not theirs.
      </p>
    </div>
  )
}

function CardPanel({ report }: { report: MomentsReport }) {
  const [handle, setHandle] = useState(loadHandle)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const card = useRef<SVGSVGElement>(null)
  const download = async () => {
    if (!card.current) return
    setSaving(true)
    setFailed(false)
    try {
      const url = URL.createObjectURL(await cardPng(card.current))
      const a = document.createElement('a')
      a.href = url
      a.download = 'merlin-moments.png'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="mx-auto max-w-[680px] space-y-2">
      <MomentCard
        ref={card}
        report={report}
        handle={handle}
        className="h-auto w-full rounded-card border border-line"
      />
      <div className="flex flex-wrap items-center justify-center gap-3">
        <label className="flex items-center gap-2">
          <span className="text-sec text-muted">Your handle on the card</span>
          <input
            value={handle}
            onChange={(e) => {
              setHandle(e.target.value)
              saveHandle(e.target.value)
            }}
            placeholder="@you"
            maxLength={25}
            className="h-7 w-48 rounded-card border border-line bg-surface px-2 text-body outline-none focus:border-accent"
          />
        </label>
        <Button onClick={download} disabled={saving}>
          <Download size={14} />
          {saving ? 'Saving…' : 'Download PNG'}
        </Button>
        {failed && <span className="text-sec text-bad">Could not make the image.</span>}
      </div>
    </div>
  )
}

function PersonaPanel({ persona }: { persona: PersonaView }) {
  return (
    <Card bodyClassName="flex gap-5">
      <PersonaAvatar persona={persona} />
      <div className="min-w-0 space-y-1">
        <div>
          <div className="text-title font-semibold">{persona.name}</div>
          <div className="text-sec font-medium text-muted">{persona.focus}</div>
        </div>
        <p className="text-sec text-muted">{persona.reason}</p>
        <p className="text-meta text-faint">
          {persona.habits} habit{persona.habits === 1 ? '' : 's'} · {persona.explored} explored · {persona.unseen} not
          yet
        </p>
      </div>
    </Card>
  )
}

function Suggestion({ moment, reason }: { moment: MomentView; reason?: string }) {
  return (
    <Card bodyClassName="space-y-1.5">
      <div className="flex items-center gap-2">
        <PersonaFace persona={moment.persona} size={26} />
        <span className="text-body font-semibold">{moment.title}</span>
        {moment.status === 'explored' && <Badge>tried once</Badge>}
      </div>
      {reason && <p className="text-sec text-warn">{reason}</p>}
      <p className="text-sec text-muted">{moment.try}</p>
    </Card>
  )
}

function MomentList({
  title,
  hint,
  moments,
  empty,
}: {
  title: string
  hint: string
  moments: MomentView[]
  empty: string
}) {
  return (
    <Section title={title} hint={hint}>
      {moments.length === 0 ? (
        <p className="text-sec text-faint">{empty}</p>
      ) : (
        <Card flush>
          <ul className="divide-y divide-line">
            {moments.map((m) => (
              <MomentRow key={m.id} moment={m} />
            ))}
          </ul>
        </Card>
      )}
    </Section>
  )
}

function MomentRow({ moment }: { moment: MomentView }) {
  const [open, setOpen] = useState(false)
  const examples = moment.examples ?? []
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2"
      >
        <ChevronRight size={14} className={cn('shrink-0 text-faint', open && 'rotate-90')} />
        <PersonaFace persona={moment.persona} size={28} />
        <span className="flex w-56 shrink-0 items-center gap-2 text-body font-medium">
          {moment.title}
          {moment.new && <Badge tone="accent">new</Badge>}
        </span>
        <span className="min-w-0 flex-1 truncate text-sec text-muted">{moment.what}</span>
        <span className="shrink-0 text-sec text-muted tabular-nums">
          {formatCount(moment.hits)}× in {moment.weeks} week{moment.weeks === 1 ? '' : 's'}
        </span>
        <RelTime time={moment.last} className="w-28 shrink-0 text-right text-sec text-faint" />
      </button>
      {open && (
        <div className="space-y-1 border-t border-line bg-surface-2 px-3 py-2 pl-12">
          {examples.map((h) => (
            <div key={`${h.session.id}-${h.at}-${h.turn ?? ''}`} className="flex items-baseline gap-3 text-sec">
              <RelTime time={h.at} className="w-28 shrink-0 text-faint" />
              <Link to={sessionPath(h.session, h.turn !== undefined ? `t${h.turn}` : undefined)}>
                {h.note || 'open the session'}
              </Link>
            </div>
          ))}
          <p className="pt-1 text-meta text-faint">
            {formatCount(moment.sessions)} session{moment.sessions === 1 ? '' : 's'}. {moment.try}
          </p>
        </div>
      )}
    </li>
  )
}

function Unseen({ moments }: { moments: MomentView[] }) {
  return (
    <Section title="Not seen yet" hint="Nothing to worry about: these are ideas, not a checklist.">
      <div className="grid grid-cols-3 gap-3">
        {PERSONAS.map((p) => {
          const list = moments.filter((m) => m.persona === p)
          if (list.length === 0) return <div key={p} />
          return (
            <Card key={p} bodyClassName="space-y-2">
              <div className="flex items-center gap-2 text-sec text-muted">
                <PersonaFace persona={p} size={32} />
                {PERSONA_NAMES[p]}
              </div>
              {list.map((m) => (
                <div key={m.id}>
                  <div className="text-body font-medium">{m.title}</div>
                  <p className="text-sec text-muted">{m.try}</p>
                </div>
              ))}
            </Card>
          )
        })}
      </div>
    </Section>
  )
}
