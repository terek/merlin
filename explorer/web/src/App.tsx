import { Route, Routes } from 'react-router-dom'
import { UiGallery } from './dev/UiGallery'
import { DevAgents } from './features/agents/DevAgents'
import { CostPage } from './features/cost/CostPage'
import { SessionPage } from './features/session/SessionPage'
import { SessionsPage } from './features/sessions/SessionsPage'
import { Layout } from './shell/Layout'
import { NotFound } from './shell/NotFound'

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<SessionsPage />} />
        <Route path="s/:harness/:id" element={<SessionPage />} />
        <Route path="cost" element={<CostPage />} />
        <Route path="dev/ui" element={<UiGallery />} />
        <Route path="dev/agents/:harness/:id" element={<DevAgents />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
