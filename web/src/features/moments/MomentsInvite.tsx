// The invite to the Moments page, for the top of the Sessions list: one short row with the three
// personas' reactions. It shows nothing while the report loads, fails or has no sessions.

import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useMoments } from '../../api/queries'
import { cardSummary, PERSONAS } from './model'
import { PersonaAvatar } from './PersonaAvatar'

export function MomentsInvite() {
  const { data } = useMoments()
  if (!data || data.sessions - data.scripted === 0) return null
  const sum = cardSummary(data)
  return (
    <Link
      to="/moments"
      title="Open Moments: what your sessions say about how you work with agents"
      className="flex items-stretch overflow-hidden rounded-card border border-line bg-surface text-fg hover:bg-surface-2 hover:no-underline"
    >
      <div className="grid min-w-0 flex-1 grid-cols-3 divide-x divide-line">
        {PERSONAS.map((id) => {
          const p = data.personas.find((x) => x.id === id)
          if (!p) return <div key={id} />
          return (
            <div key={id} className="flex min-w-0 items-center gap-5 px-3 py-2">
              <PersonaAvatar persona={p} small />
              <div className="min-w-0">
                <div className="text-body font-semibold">{p.name}</div>
                <div className="truncate text-sec text-muted" title={p.reason}>
                  {p.reason}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex shrink-0 items-center gap-1 border-l border-line px-3 text-sec text-accent">
        <span className="whitespace-nowrap">
          {sum.seen} of {sum.total} moments
        </span>
        <ChevronRight size={14} />
      </div>
    </Link>
  )
}
