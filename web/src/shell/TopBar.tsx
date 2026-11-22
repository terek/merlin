import { Monitor, Moon, Radio, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { isApiError } from '../api/client'
import { useConnection, useInstall, useScanProgress, useVersion } from '../api/events'
import { cn } from '../lib/cn'
import { formatCount } from '../lib/format'
import { type Available, availableToShow, releaseUrl } from '../lib/version'
import { Button, IconButton } from '../ui'
import { lensLinks } from './lastOverview'
import { useMomentsBadge } from './momentsBadge'
import { PanelButton } from './Panel'
import { nextTheme, useTheme } from './theme'
import { useShortcut } from './useShortcut'

/** Indexing, along the bar's bottom edge: done / seen of the width, the counts in the tooltip. Nothing when idle. */
function ScanBar() {
  const p = useScanProgress()
  if (!p || p.pending <= 0) return null
  const seen = p.queued !== undefined ? Math.max(p.queued, p.pending) : Math.max(p.seen, p.pending)
  const done = p.done !== undefined ? p.done : seen - p.pending
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

/** The theme: one button that cycles System, Light, Dark. */
function ThemeControl() {
  const [theme, set] = useTheme()
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor
  return (
    <IconButton label={`Theme: ${theme}. Click for ${nextTheme(theme)}.`} onClick={() => set(nextTheme(theme))}>
      <Icon size={15} />
    </IconButton>
  )
}

/** The popover's update block: the release, Install and what it is doing, or the command when blocked. */
function UpdateRow({ update }: { update: Available }) {
  const install = useInstall()
  const [phase, setPhase] = useState<'idle' | 'installing' | 'restarting'>('idle')
  const [error, setError] = useState('')
  const click = async () => {
    setPhase('installing')
    setError('')
    try {
      await install(update.version)
      setPhase('restarting')
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e))
      setPhase('idle')
    }
  }
  const busy = phase !== 'idle' || update.state === 'installing'
  const label = phase === 'restarting' ? 'Restarting…' : busy ? 'Installing…' : `Install ${update.version}`
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-fg">Update available</span>
        <a href={releaseUrl(update.version)} target="_blank" rel="noreferrer" title="Release notes">
          {update.version}
        </a>
      </div>
      {update.state === 'blocked' ? (
        <p className="m-0 select-text break-words text-muted">
          {update.reason ?? 'Merlin cannot install this update by itself.'}
        </p>
      ) : (
        <>
          <Button variant="primary" disabled={busy} onClick={click} className="w-full">
            {label}
          </Button>
          {update.state === 'downloading' && !busy && <span className="text-faint">downloading…</span>}
          {error && <p className="m-0 select-text break-words text-bad">{error}</p>}
          {!error && update.state === 'available' && update.reason && (
            <p className="m-0 select-text break-words text-faint">{update.reason}</p>
          )}
        </>
      )}
      <p className="m-0 text-faint">
        Turn on auto-upgrade: <code className="select-text">merlin autoupgrade</code>
      </p>
    </div>
  )
}

/** One button at the far right: its look is the connection; its panel holds the state, the version and the theme. */
function StatusButton() {
  const connection = useConnection()
  const version = useVersion()
  const available = availableToShow(version)
  const offered = available !== null && connection !== 'offline' ? available : null
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
        title={
          offered
            ? `Update available: ${offered.version}. Status: ${text}`
            : connection === 'offline'
              ? 'Status: offline, retrying'
              : `Status: ${text}`
        }
        onClick={() => setOpen(!open)}
        className={cn(
          'relative inline-flex size-7 items-center justify-center rounded-card hover:bg-surface-2',
          connection === 'live' && (offered ? 'text-accent' : 'text-muted hover:text-fg'),
          connection === 'connecting' && 'text-faint',
          connection === 'offline' && 'text-bad',
        )}
      >
        <Radio size={15} aria-hidden />
        {offered && (
          <span className="pointer-events-none absolute top-0.5 right-0.5 flex size-2" aria-hidden>
            <span className="absolute inline-flex size-full rounded-full bg-accent opacity-75 motion-safe:animate-ping" />
            <span className="relative inline-flex size-2 rounded-full bg-accent" />
          </span>
        )}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-40 mt-1 w-72 rounded-card border border-line bg-surface p-3 text-sec shadow-lg">
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
          </dl>
          {available && <UpdateRow update={available} />}
        </div>
      )}
    </div>
  )
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center rounded-full px-2.5 py-[3px] text-body hover:no-underline',
    isActive ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:text-fg',
  )

/** 44 px: the name and the tabs, the page's slot (the search), then the update notice and the buttons. It never changes with a session open. */
export function TopBar() {
  const { pathname, search } = useLocation()
  const links = lensLinks(pathname, search)
  const fresh = useMomentsBadge()
  return (
    <header className="relative z-30 flex h-11 shrink-0 items-center gap-4 border-b border-line bg-surface px-4">
      <Link to="/" className="flex items-center gap-2 font-semibold text-fg hover:no-underline" aria-label="Merlin">
        <img src="/logo-48.png" width={22} height={22} alt="" className="size-[22px]" />
        Merlin
      </Link>
      <nav className="flex gap-1" aria-label="Main">
        <NavLink to={links.overview} end className={navClass} title="Overview: where the agents' work went (g o)">
          Overview
        </NavLink>
        <NavLink to={links.cost} className={navClass} title="Cost: the same scope, read as money (g c)">
          Cost
        </NavLink>
        <NavLink to="/moments" className={navClass} title="Moments: what your sessions say about how you work (g m)">
          Moments
          {fresh > 0 && (
            <span
              className="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-meta font-medium text-surface tabular-nums leading-4"
              title={`${fresh} new since you last opened Moments`}
            >
              <span className="sr-only">{fresh} new, </span>
              {fresh}
            </span>
          )}
        </NavLink>
      </nav>
      <div className="flex-1" />
      <UpdateNotice />
      <div className="flex items-center gap-1">
        <PanelButton />
        <ThemeControl />
        <StatusButton />
      </div>
      <ScanBar />
    </header>
  )
}
