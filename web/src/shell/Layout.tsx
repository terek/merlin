import { useEffect, useRef } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'
import { lensLinks, rememberOverview, rememberScope } from './lastOverview'
import { PanelColumn, PanelProvider, usePanel } from './Panel'
import { SlotProvider } from './ShellSlot'
import { TopBar } from './TopBar'
import { useShortcut } from './useShortcut'

/** The top bar and the routed page. `g o`, `g s`, `g c` and `g m` switch pages. */
export function Layout() {
  return (
    <PanelProvider>
      <Shell />
    </PanelProvider>
  )
}

function Shell() {
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const main = useRef<HTMLElement>(null)
  const links = lensLinks(pathname, search)
  useShortcut('g o', () => navigate(links.overview))
  useShortcut('g s', () => navigate('/sessions'))
  useShortcut('g c', () => navigate(links.cost))
  useShortcut('g m', () => navigate('/moments'))
  const panel = usePanel()
  useShortcut('l', () => panel.setOpen(!panel.open), { enabled: panel.tabs.length > 0 })
  useEffect(() => {
    rememberOverview(pathname, search)
    rememberScope(pathname, search)
  }, [pathname, search])
  // a new page starts at the top of main (not on a filter change); the keyboard pages main unless a field has focus
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new page resets the scroll
  useEffect(() => {
    const el = main.current
    if (!el) return
    el.scrollTop = 0
    const a = document.activeElement
    if (!a || a === document.body) el.focus({ preventScroll: true })
  }, [pathname])
  return (
    <SlotProvider>
      <div className="flex h-dvh flex-col overflow-hidden">
        <TopBar />
        <div className="relative flex min-h-0 flex-1">
          <main ref={main} tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-auto outline-none">
            <ErrorBoundary resetKey={pathname}>
              <Outlet />
            </ErrorBoundary>
          </main>
          <PanelColumn />
        </div>
      </div>
    </SlotProvider>
  )
}
