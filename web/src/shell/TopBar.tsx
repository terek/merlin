import { Monitor, Moon, Radio, Sun } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { useConnection, useScanProgress, useVersion } from '../api/events'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import { availableToShow, releaseUrl } from '../lib/version'
import { SlotTarget } from './ShellSlot'
import { type ThemeChoice, useTheme } from './theme'
import { useShortcut } from './useShortcut'

/** Indexing, along the bar's bottom edge: done / seen of the width, the counts in the tooltip. Nothing when idle. */
function ScanBar() {
  const p = useScanProgress()
  if (!p || p.pending <= 0) return null
  const seen = Math.max(p.seen, p.pending)
  const done = seen - p.pending
  return (
    <span
      className="absolute bottom-[-1px] left-0 h-0.5 bg-accent transition-[width] duration-300"
      style={{ width: `${(done / seen) * 100}%` }}
      title={`indexing ${formatCount(done)} / ${formatCount(seen)} · ${formatCount(p.unchanged)} unchanged · ${formatCount(p.failed)} failed`}
    />
  )
}

function UpdateNotice() {
  const { updatedTo } = useVersion()
  if (!updatedTo) return null
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap text-sec text-muted">
      <a href={releaseUrl(updatedTo)} target="_blank" rel="noreferrer" title="Release notes">
        Merlin updated to {updatedTo}
      </a>
      <span aria-hidden>·</span>
      <button type="button" className="text-accent hover:underline" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  )
}

const THEMES: { id: ThemeChoice; label: string; icon: ReactNode }[] = [
  { id: 'system', label: 'System', icon: <Monitor size={13} aria-hidden /> },
  { id: 'light', label: 'Light', icon: <Sun size={13} aria-hidden /> },
  { id: 'dark', label: 'Dark', icon: <Moon size={13} aria-hidden /> },
]

/** One button at the far right: its look is the connection; its panel holds the state, the version and the theme. */
function StatusButton() {
  const connection = useConnection()
  const version = useVersion()
  const available = availableToShow(version)
  const [theme, setTheme] = useTheme()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useShortcut('Escape', () => setOpen(false), { enabled: open })
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])
  const text = connection === 'live' ? 'live' : connection === 'offline' ? 'offline, retrying' : 'connecting'
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label="Status"
        aria-expanded={open}
        title={connection === 'offline' ? 'Status: offline, retrying' : `Status: ${text}`}
        onClick={() => setOpen(!open)}
        className={cn(
          'relative inline-flex size-7 items-center justify-center rounded-card hover:bg-surface-2',
          connection === 'live' && 'text-muted hover:text-fg',
          connection === 'connecting' && 'text-faint',
          connection === 'offline' && 'text-bad',
        )}
      >
        <Radio size={15} aria-hidden />
      </button>
      {open && (
        <div className="absolute top-full right-0 z-40 mt-1 w-64 rounded-card border border-line bg-surface p-3 text-sec shadow-lg">
          <dl className="m-0 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
            <dt className="text-muted">Connection</dt>
            <dd className="m-0 flex items-center justify-end gap-1.5 text-fg">
              <span
                className={cn(
                  'size-2 rounded-full',
                  connection === 'live' ? 'bg-ok' : connection === 'offline' ? 'bg-bad' : 'bg-faint',
                )}
                aria-hidden
              />
              {text}
            </dd>
            <dt className="text-muted">Version</dt>
            <dd className="m-0 text-right text-fg">{version.loaded ?? 'unknown'}</dd>
            {available && (
              <>
                <dt className="text-muted">Update</dt>
                <dd className="m-0 text-right">
                  <a
                    href={releaseUrl(available)}
                    target="_blank"
                    rel="noreferrer"
                    title="merlin upgrade installs it; merlin autoupgrade keeps Merlin up to date"
                  >
                    {available} available
                  </a>
                </dd>
              </>
            )}
            <dt className="text-muted">Theme</dt>
            <dd className="m-0 flex justify-end">
              <fieldset
                aria-label="Theme"
                className="m-0 inline-flex rounded-card border border-line bg-surface-2 p-0.5"
              >
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={theme === t.id}
                    title={t.label}
                    aria-label={t.label}
                    onClick={() => setTheme(t.id)}
                    className={cn(
                      'inline-flex h-6 w-7 items-center justify-center rounded-badge',
                      theme === t.id ? 'bg-surface text-fg outline outline-1 outline-line' : 'text-muted hover:text-fg',
                    )}
                  >
                    {t.icon}
                  </button>
                ))}
              </fieldset>
            </dd>
          </dl>
        </div>
      )}
    </div>
  )
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex h-11 items-center border-b-2 px-0.5 text-body hover:no-underline',
    isActive ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg',
  )

/** 44 px: the name, the page's slot in the middle, the tabs and the status button at the right. */
export function TopBar() {
  return (
    <header className="sticky top-0 z-30 flex h-11 items-center gap-4 border-b border-line bg-surface px-4">
      <Link to="/" className="flex items-center gap-2 font-semibold text-fg hover:no-underline" aria-label="Merlin">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <title>Merlin</title>
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--accent)" strokeWidth="2" />
          <circle cx="8" cy="8" r="2" fill="var(--accent)" />
        </svg>
        Merlin
      </Link>
      <SlotTarget />
      <UpdateNotice />
      <nav className="flex gap-5" aria-label="Main">
        <NavLink to="/" end className={navClass} title="Overview: where the agents' work went (g o)">
          Overview
        </NavLink>
        <NavLink to="/cost" className={navClass} title="Cost (g c)">
          Cost
        </NavLink>
        <NavLink to="/moments" className={navClass} title="Moments: what your sessions say about how you work (g m)">
          Moments
        </NavLink>
      </nav>
      <StatusButton />
      <ScanBar />
    </header>
  )
}
