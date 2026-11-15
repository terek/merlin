import { PanelRight } from 'lucide-react'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { IconButton } from '../ui'
import { chooseTab, defaultPanelOpen, OVERLAY_BELOW, orderTabs, type PanelTabId } from './panel-model'

type Tab = { id: string; title: string }

type PanelState = {
  /** Filled tabs, in the order they were filled. */
  tabs: Tab[]
  fill: (tab: Tab) => void
  unfill: (id: string) => void
  els: Record<string, HTMLElement | null>
  setEl: (id: string, el: HTMLElement | null) => void
  open: boolean
  setOpen: (open: boolean) => void
  picked: string | null
  pick: (id: string) => void
}

const PanelContext = createContext<PanelState | null>(null)

const KEY = 'shell.legend'

function initialOpen(): boolean {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'open') return true
    if (v === 'closed') return false
  } catch {
    // no storage: the default
  }
  return defaultPanelOpen(window.innerWidth)
}

/** Holds the legend panel's state: what pages filled, which tab shows, whether it is open (kept per viewer). */
export function PanelProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [els, setEls] = useState<Record<string, HTMLElement | null>>({})
  const [open, setOpenState] = useState(initialOpen)
  const [picked, setPicked] = useState<string | null>(null)
  const fill = useCallback(
    (tab: Tab) =>
      setTabs((cur) => {
        const at = cur.findIndex((t) => t.id === tab.id)
        if (at < 0) return [...cur, tab]
        if (cur[at].title === tab.title) return cur
        return cur.map((t, i) => (i === at ? tab : t))
      }),
    [],
  )
  const unfill = useCallback((id: string) => setTabs((cur) => cur.filter((t) => t.id !== id)), [])
  const setEl = useCallback(
    (id: string, el: HTMLElement | null) => setEls((cur) => (cur[id] === el ? cur : { ...cur, [id]: el })),
    [],
  )
  const setOpen = useCallback((v: boolean) => {
    setOpenState(v)
    try {
      localStorage.setItem(KEY, v ? 'open' : 'closed')
    } catch {
      // no storage: the choice lives for this page only
    }
  }, [])
  const value = useMemo(
    () => ({ tabs, fill, unfill, els, setEl, open, setOpen, picked, pick: setPicked }),
    [tabs, fill, unfill, els, setEl, open, setOpen, picked],
  )
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>
}

export function usePanel(): PanelState {
  const p = useContext(PanelContext)
  if (!p) throw new Error('PanelProvider is missing')
  return p
}

/** What a page renders to fill a tab of the legend panel (pages never import the panel itself). */
export function PanelTab({ id, title, children }: { id: PanelTabId; title: string; children: ReactNode }) {
  const { fill, unfill, els } = usePanel()
  useEffect(() => {
    fill({ id, title })
  }, [id, title, fill])
  useEffect(() => () => unfill(id), [id, unfill])
  const el = els[id]
  return el ? createPortal(children, el) : null
}

/** The top bar's button: only when the page filled a tab. */
export function PanelButton() {
  const { tabs, open, setOpen } = usePanel()
  if (tabs.length === 0) return null
  return (
    <IconButton
      label={open ? 'Hide the legend (l)' : 'Show the legend (l)'}
      aria-pressed={open}
      onClick={() => setOpen(!open)}
      className={cn(open && 'bg-surface-2 text-fg')}
    >
      <PanelRight size={15} />
    </IconButton>
  )
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < OVERLAY_BELOW)
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < OVERLAY_BELOW)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return narrow
}

/** Where one tab's page content lands; the ref callback is stable so the element is registered once. */
function TabBody({ id, hidden }: { id: string; hidden: boolean }) {
  const { setEl } = usePanel()
  const ref = useCallback((el: HTMLDivElement | null) => setEl(id, el), [id, setEl])
  return <div ref={ref} hidden={hidden} />
}

/**
 * The right-hand column: a tab per filled page part. It pushes the page; under 1000 px it overlays it. The tab
 * bodies stay mounted (hidden) so a page's portal target is always there.
 */
export function PanelColumn() {
  const { tabs, open, picked, pick } = usePanel()
  const narrow = useNarrow()
  const filled = tabs.map((t) => t.id)
  const shown = chooseTab(filled, picked)
  const ordered = orderTabs(filled).map((id) => tabs.find((t) => t.id === id) as Tab)
  const visible = open && tabs.length > 0
  return (
    <aside
      aria-label="Legend"
      className={cn(
        'w-[300px] shrink-0 flex-col border-line border-l bg-surface',
        visible ? 'flex' : 'hidden',
        narrow && 'absolute top-0 right-0 bottom-0 z-20 shadow-pop',
      )}
    >
      {ordered.length === 1 ? (
        <h2 className="m-0 shrink-0 px-4 pt-3 pb-1 font-medium text-body text-fg">{ordered[0].title}</h2>
      ) : (
        <div role="tablist" className="flex shrink-0 gap-1 border-line border-b px-3 pt-2">
          {ordered.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === shown}
              onClick={() => pick(t.id)}
              className={cn(
                '-mb-px border-b-2 px-2 py-1 text-body',
                t.id === shown ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {t.title}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {ordered.map((t) => (
          <TabBody key={t.id} id={t.id} hidden={t.id !== shown} />
        ))}
      </div>
    </aside>
  )
}
