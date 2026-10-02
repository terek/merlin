import { SearchX } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { isApiError } from '../../api/client'
import { useSession } from '../../api/queries'
import type { Candidate, SessionDetail } from '../../api/types'
import { useDocumentTitle } from '../../lib/hooks'
import { sessionPath } from '../../lib/paths'
import { sessionTitle } from '../../lib/session'
import { EmptyState, ErrorState, Id, ProjectName, QueryBoundary, RelTime, Skeleton, SkeletonRows } from '../../ui'
import { AgentsCard } from '../agents/AgentsCard'
import { ContextChart } from '../context/ContextChart'
import { CostCard } from './CostCard'
import { Diagnostics } from './Diagnostics'
import { Banners, FamilyStrip, ResumeBox, SessionHeader } from './Header'
import { parseHash } from './model'
import { Timeline } from './Timeline'

function Candidates({ list }: { list: Candidate[] }) {
  return (
    <ul className="mx-auto mt-2 max-w-col divide-y divide-line rounded-card border border-line bg-surface">
      {list.map((c) => (
        <li key={c.key.id}>
          <Link
            to={sessionPath(c.key)}
            className="flex flex-col gap-0.5 px-3 py-2 hover:bg-surface-2 hover:no-underline"
          >
            <span className="[overflow-wrap:anywhere]">{c.title || c.key.id}</span>
            <span className="flex flex-wrap items-center gap-x-2 text-sec text-muted">
              <ProjectName path={c.project} />
              <RelTime time={c.lastActivityAt} />
              <Id value={c.key.id} full className="text-faint" />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function PageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <SkeletonRows rows={5} height={72} />
    </div>
  )
}

function Loaded({ detail }: { detail: SessionDetail }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [scrollNonce, setScrollNonce] = useState(0)
  const target = useMemo(() => parseHash(location.hash), [location.hash])
  const expandAll = import.meta.env.DEV && new URLSearchParams(location.search).get('expand') === '1'
  const agentsCardRef = useRef<HTMLDivElement>(null)

  const setHash = useCallback(
    (hash: string) =>
      navigate(
        { pathname: location.pathname, search: location.search, hash },
        { replace: true, preventScrollReset: true },
      ),
    [navigate, location.pathname, location.search],
  )

  const agentIds = useMemo(() => new Set((detail.digest.agents ?? []).map((a) => a.id)), [detail.digest.agents])
  const selectedAgentId = target?.kind === 'agent' && agentIds.has(target.id) ? target.id : null
  const onSelectAgent = useCallback((id: string | null) => setHash(id ? `a${id}` : ''), [setHash])
  const onSelectTurn = useCallback(
    (index: number) => {
      setHash(`t${index}`)
      setScrollNonce((n) => n + 1)
    },
    [setHash],
  )
  const onClearTarget = useCallback(() => setHash(''), [setHash])

  // A selected agent may sit below the fold of the side panel.
  useEffect(() => {
    if (selectedAgentId) agentsCardRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedAgentId])

  return (
    <div className="mx-auto flex max-w-[1500px] items-start gap-6 p-6">
      <div className="min-w-0 flex-1 space-y-4">
        <Banners detail={detail} />
        <SessionHeader detail={detail} />
        {!(detail.summary.sourceMissing || detail.digest.sourceMissing) && <ResumeBox detail={detail} />}
        <FamilyStrip detail={detail} />
        <Timeline
          detail={detail}
          target={target}
          scrollNonce={scrollNonce}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
          onClearTarget={onClearTarget}
          expandAll={expandAll}
        />
      </div>
      <aside className="sticky top-14 max-h-[calc(100vh-4.5rem)] w-side shrink-0 space-y-4 overflow-y-auto pb-1">
        <CostCard detail={detail} />
        <div ref={agentsCardRef} className="scroll-mt-2">
          <AgentsCard
            detail={detail}
            selectedAgentId={selectedAgentId}
            onSelectAgent={onSelectAgent}
            onSelectTurn={onSelectTurn}
          />
        </div>
        <ContextChart detail={detail} onSelectTurn={onSelectTurn} />
        <Diagnostics detail={detail} />
      </aside>
    </div>
  )
}

export function SessionPage() {
  const { harness = '', id = '' } = useParams()
  const query = useSession(harness, id)
  useDocumentTitle(query.data ? sessionTitle(query.data.summary) : undefined)

  const err = query.data ? undefined : query.error
  if (isApiError(err) && err.code === 'ambiguous_id') {
    return (
      <div className="p-6">
        <EmptyState title="Several sessions start with this id">Pick the one you meant.</EmptyState>
        <Candidates list={err.candidates} />
      </div>
    )
  }
  if (isApiError(err) && err.status === 404) {
    return (
      <div className="p-6">
        <EmptyState icon={<SearchX size={24} />} title="No such session" action={<Link to="/">Back to Sessions</Link>}>
          Merlin has no session with the id <span className="font-mono">{id}</span>. It may have been deleted before it
          was indexed, or the id is mistyped.
        </EmptyState>
      </div>
    )
  }
  if (err) return <ErrorState error={err} onRetry={() => void query.refetch()} />

  return (
    <QueryBoundary
      query={query}
      skeleton={
        <div className="p-6">
          <PageSkeleton />
        </div>
      }
    >
      {(detail) => <Loaded key={`${detail.summary.key.harness}/${detail.summary.key.id}`} detail={detail} />}
    </QueryBoundary>
  )
}
