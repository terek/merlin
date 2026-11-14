import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { UiGallery } from './dev/UiGallery'
import { BeadPage } from './features/beads/BeadPage'
import { CostPage } from './features/cost/CostPage'
import { MomentsPage } from './features/moments/MomentsPage'
import { OverviewPage } from './features/overview/OverviewPage'
import { SessionsPage } from './features/sessions/SessionsPage'
import { SessionPage } from './features/spend/SessionPage'
import { Layout } from './shell/Layout'
import { NotFound } from './shell/NotFound'

/** The prototype's old address, kept for links made while it was one. */
function SpendRedirect() {
  const { harness = '', id = '' } = useParams()
  const { search, hash } = useLocation()
  return <Navigate replace to={`/s/${encodeURIComponent(harness)}/${encodeURIComponent(id)}${search}${hash}`} />
}

/** The Overview's old address: `/`, the query string kept. */
function OverviewRedirect() {
  const { search, hash } = useLocation()
  return <Navigate replace to={`/${search}${hash}`} />
}

/** Params only the Sessions list reads: a `/` link carrying one was made for Sessions (it lived at `/`). */
const SESSIONS_ONLY = [
  'bead',
  'branch',
  'checkout',
  'group',
  'kind',
  'project',
  'remote',
  'repo',
  'since',
  'state',
  'touched',
  'worktree',
]

/** `/`: the Overview, or Sessions when the link carries a Sessions-only param. */
function Home() {
  const { search, hash } = useLocation()
  const params = new URLSearchParams(search)
  if (SESSIONS_ONLY.some((k) => params.has(k))) return <Navigate replace to={`/sessions${search}${hash}`} />
  return <OverviewPage />
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="s/:harness/:id" element={<SessionPage />} />
        <Route path="bead/:id" element={<BeadPage />} />
        <Route path="cost" element={<CostPage />} />
        <Route path="overview" element={<OverviewRedirect />} />
        <Route path="moments" element={<MomentsPage />} />
        <Route path="dev/ui" element={<UiGallery />} />
        <Route path="dev/spend/:harness/:id" element={<SpendRedirect />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
