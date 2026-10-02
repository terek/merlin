// Dev-only page (/dev/agents/:harness/:id): both components at the width of the side panel.
// URL: #a<agentId> selects an agent; ?expand=all|id,id opens nodes; ?cursor=<turn> places the chart cursor.
import { useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useSession } from '../../api/queries'
import { ErrorState, QueryBoundary } from '../../ui'
import { ContextChart } from '../context/ContextChart'
import { AgentsCard } from './AgentsCard'

export function DevAgents() {
  const { harness = '', id = '' } = useParams()
  const loc = useLocation()
  const query = useSession(harness, id)
  const params = new URLSearchParams(loc.search)
  const expand = params.get('expand')
  const cursor = params.get('cursor')
  const [selected, setSelected] = useState<string | null>(() =>
    loc.hash.startsWith('#a') ? decodeURIComponent(loc.hash.slice(2)) : null,
  )
  const [turn, setTurn] = useState<number | null>(null)
  if (query.error && !query.data) return <ErrorState error={query.error} />
  return (
    <div className="flex gap-6 p-6">
      <div className="w-side shrink-0 space-y-4">
        <QueryBoundary query={query}>
          {(d) => (
            <>
              <AgentsCard
                detail={d}
                selectedAgentId={selected}
                onSelectAgent={setSelected}
                onSelectTurn={setTurn}
                initialExpand={expand === 'all' ? 'all' : expand ? expand.split(',') : undefined}
              />
              <ContextChart detail={d} onSelectTurn={setTurn} initialCursor={cursor ? Number(cursor) : undefined} />
            </>
          )}
        </QueryBoundary>
      </div>
      <p className="text-sec text-muted">selected turn: {turn ?? 'none'}</p>
    </div>
  )
}
