import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { UiGallery } from './dev/UiGallery'
import { CostPage } from './features/cost/CostPage'
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

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<SessionsPage />} />
        <Route path="s/:harness/:id" element={<SessionPage />} />
        <Route path="cost" element={<CostPage />} />
        <Route path="dev/ui" element={<UiGallery />} />
        <Route path="dev/spend/:harness/:id" element={<SpendRedirect />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
