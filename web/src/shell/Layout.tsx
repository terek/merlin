import { useEffect } from 'react'
import { Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'
import { rememberOverview } from './lastOverview'
import { SessionSlot } from './SessionSlot'
import { SlotProvider } from './ShellSlot'
import { TopBar } from './TopBar'
import { useShortcut } from './useShortcut'

/** The top bar and the routed page. `g o`, `g s`, `g c` and `g m` switch pages. */
export function Layout() {
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const onSession = useMatch('/s/:harness/:id') !== null
  useShortcut('g o', () => navigate('/'))
  useShortcut('g s', () => navigate('/sessions'))
  useShortcut('g c', () => navigate('/cost'))
  useShortcut('g m', () => navigate('/moments'))
  useEffect(() => rememberOverview(pathname, search), [pathname, search])
  return (
    <SlotProvider>
      <TopBar />
      {onSession && <SessionSlot />}
      <main className="min-h-[calc(100vh-44px)]">
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </SlotProvider>
  )
}
