import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'
import { TopBar } from './TopBar'
import { useShortcut } from './useShortcut'

/** The top bar and the routed page. `g s` and `g c` switch pages. */
export function Layout() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  useShortcut('g s', () => navigate('/'))
  useShortcut('g c', () => navigate('/cost'))
  return (
    <>
      <TopBar />
      <main className="min-h-[calc(100vh-44px)]">
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </>
  )
}
