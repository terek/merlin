import { Monitor, Moon, Sun } from 'lucide-react'
import { Link, NavLink } from 'react-router-dom'
import { useConnection, useScanProgress } from '../api/events'
import { useSpend7d } from '../api/queries'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import { IconButton, Money } from '../ui'
import { nextTheme, useTheme } from './theme'

function ScanIndicator() {
  const p = useScanProgress()
  if (!p || p.pending <= 0) return null
  const seen = Math.max(p.seen, p.pending)
  const done = seen - p.pending
  return (
    <div
      className="flex items-center gap-2 text-sec text-muted"
      title={`${formatCount(p.processed)} indexed, ${formatCount(p.unchanged)} unchanged, ${formatCount(p.failed)} failed`}
    >
      <span className="whitespace-nowrap">
        indexing {formatCount(done)} / {formatCount(seen)}
      </span>
      <span className="block h-0.5 w-20 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full bg-accent" style={{ width: `${(done / seen) * 100}%` }} />
      </span>
    </div>
  )
}

function ConnectionIndicator() {
  const c = useConnection()
  const look = c === 'live' ? 'bg-ok' : c === 'offline' ? 'bg-bad' : 'bg-faint'
  const text = c === 'live' ? 'live' : c === 'offline' ? 'offline, retrying' : 'connecting'
  return (
    <div className="flex items-center gap-1.5 text-sec text-muted" title={`Event stream: ${text}`}>
      <span className={cn('size-2 rounded-full', look)} aria-hidden />
      {c === 'live' ? <span className="sr-only">live</span> : <span className="whitespace-nowrap">{text}</span>}
    </div>
  )
}

function SpendLink() {
  const { data } = useSpend7d()
  if (!data) return null
  return (
    <Link
      to="/cost?range=7d"
      title="Spend in the last 7 days. Open Cost."
      className="flex items-center gap-1.5 text-sec text-muted hover:text-fg hover:no-underline"
    >
      <Money usd={data.total.totalUSD} dim />
      <span>7 d</span>
    </Link>
  )
}

function ThemeControl() {
  const [theme, set] = useTheme()
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor
  return (
    <IconButton label={`Theme: ${theme}. Click for ${nextTheme(theme)}.`} onClick={() => set(nextTheme(theme))}>
      <Icon size={15} />
    </IconButton>
  )
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex h-11 items-center border-b-2 px-0.5 text-body hover:no-underline',
    isActive ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg',
  )

/** 44 px: the name, the two destinations, and on the right indexing, connection, 7-day spend, theme. */
export function TopBar() {
  return (
    <header className="sticky top-0 z-30 flex h-11 items-center gap-6 border-b border-line bg-surface px-4">
      <Link to="/" className="flex items-center gap-2 font-semibold text-fg hover:no-underline" aria-label="Merlin">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <title>Merlin</title>
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--accent)" strokeWidth="2" />
          <circle cx="8" cy="8" r="2" fill="var(--accent)" />
        </svg>
        Merlin
      </Link>
      <nav className="flex gap-5" aria-label="Main">
        <NavLink to="/" end className={navClass} title="Sessions (g s)">
          Sessions
        </NavLink>
        <NavLink to="/cost" className={navClass} title="Cost (g c)">
          Cost
        </NavLink>
      </nav>
      <div className="ml-auto flex items-center gap-4">
        <ScanIndicator />
        <ConnectionIndicator />
        <SpendLink />
        <ThemeControl />
      </div>
    </header>
  )
}
