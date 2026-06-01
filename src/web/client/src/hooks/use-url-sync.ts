import { useEffect, useRef } from 'react'
import { shortenPath } from '@/lib/utils'
import {
  type HostFilter,
  type NavigationFocus,
  type ProjectTab,
  type SessionTab,
  useMerlinStore,
} from '@/stores/merlin-store'

// URL hash format (readable paths, sub-page state as params after ?):
//   #/                                          → root
//   #/host                                      → host
//   #/host?filter=archived                      → host, archived tab
//   #/project/~/work/myapp                  → project
//   #/project/~/work/myapp?tab=timeline     → project, timeline tab
//   #/session/~/work/myapp/abc123           → session
//   #/session/~/work/myapp/abc123?tab=lean

// ── Path encoding ────────────────────────────────────────────────────────────
// cwd uses shortenPath for display (~/work/...) and we keep it as-is in the hash.
// To restore, we expand ~/work/ back to the matching prefix from known projects.

function encodeCwd(cwd: string): string {
  return shortenPath(cwd)
}

function decodeCwd(encoded: string): string {
  // If it starts with ~/work/, we need to expand it. Try known projects from the store.
  if (encoded.startsWith('~/work/')) {
    const model = useMerlinStore.getState().model
    if (model) {
      for (const cwd of Object.keys(model.projects)) {
        if (shortenPath(cwd) === encoded) return cwd
      }
    }
    // Fallback: can't expand without model, return as-is (will resolve once model loads)
    return encoded
  }
  return encoded
}

/**
 * Find the highest-level collapsed project that contains a session cwd.
 * Walks up the path from the full sessionCwd to root, returning the
 * shortest ancestor path that exists as a collapsed project.
 * Falls back to a direct match (sessionCwd is itself a project).
 */
function findProjectCwd(sessionCwd: string): string | null {
  const model = useMerlinStore.getState().model
  if (!model) return null
  // Walk up path segments from root, collecting all collapsed ancestors
  const parts = sessionCwd.split('/')
  let highestCollapsed: string | null = null
  for (let len = 1; len < parts.length; len++) {
    const candidate = parts.slice(0, len).join('/')
    const proj = model.projects[candidate]
    if (proj?.collapsed) {
      highestCollapsed = candidate
      break // shortest (highest-level) collapsed ancestor found
    }
  }
  if (highestCollapsed) return highestCollapsed
  // Direct match — sessionCwd is itself a known project
  if (model.projects[sessionCwd]) return sessionCwd
  return null
}

// ── Serialization ────────────────────────────────────────────────────────────

interface UrlState {
  focus: NavigationFocus
  hostFilter?: HostFilter
  projectTab?: ProjectTab
  sessionTab?: SessionTab
}

function stateToHash(s: UrlState): string {
  let path: string
  const params: string[] = []

  switch (s.focus.level) {
    case 'root':
      path = '/'
      break
    case 'host':
      path = '/host'
      if (s.hostFilter && s.hostFilter !== 'active') params.push(`filter=${s.hostFilter}`)
      break
    case 'project':
      path = `/project/${encodeCwd(s.focus.cwd)}`
      if (s.projectTab && s.projectTab !== 'sessions') params.push(`tab=${s.projectTab}`)
      break
    case 'session': {
      // URL uses sessionCwd (original folder path) if available, so it's stable across collapse/uncollapse
      const sessCwd = s.focus.sessionCwd ?? s.focus.cwd
      path = `/session/${encodeCwd(sessCwd)}/${s.focus.sessionId}`
      if (s.sessionTab && s.sessionTab !== 'raw') params.push(`tab=${s.sessionTab}`)
      break
    }
  }

  return `#${path}${params.length ? `?${params.join('&')}` : ''}`
}

function hashToState(hash: string): UrlState | null {
  const raw = hash.replace(/^#/, '')
  const [pathPart, paramsPart] = raw.split('?')
  const params = new URLSearchParams(paramsPart ?? '')

  const path = pathPart.replace(/^\//, '')
  if (!path) return { focus: { level: 'root' } }

  // Split carefully: first segment is the level, rest depends on level
  const firstSlash = path.indexOf('/')
  const level = firstSlash === -1 ? path : path.slice(0, firstSlash)
  const rest = firstSlash === -1 ? '' : path.slice(firstSlash + 1)

  switch (level) {
    case 'host':
      return {
        focus: { level: 'host' },
        hostFilter: (params.get('filter') as HostFilter) || undefined,
      }

    case 'project': {
      if (!rest) return null
      const cwd = decodeCwd(rest)
      return {
        focus: { level: 'project', cwd },
        projectTab: (params.get('tab') as ProjectTab) || undefined,
      }
    }

    case 'session': {
      // rest = <cwd>/<sessionId> — sessionId is always the last segment
      const lastSlash = rest.lastIndexOf('/')
      if (lastSlash === -1) return null
      const cwdPart = rest.slice(0, lastSlash)
      const sessionId = rest.slice(lastSlash + 1)
      if (!cwdPart || !sessionId) return null
      const sessionCwd = decodeCwd(cwdPart)
      // Find the project cwd — may be the sessionCwd itself or a collapsed parent
      const projectCwd = findProjectCwd(sessionCwd) ?? sessionCwd
      return {
        focus: {
          level: 'session',
          cwd: projectCwd,
          sessionId,
          sessionCwd: sessionCwd !== projectCwd ? sessionCwd : undefined,
        },
        sessionTab: (params.get('tab') as SessionTab) || undefined,
      }
    }

    default:
      return null
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/** Syncs store navigation focus + sub-page state ↔ URL hash. */
export function useUrlSync() {
  const focus = useMerlinStore((s) => s.focus)
  const hostFilter = useMerlinStore((s) => s.hostFilter)
  const projectTab = useMerlinStore((s) => s.projectTab)
  const sessionTab = useMerlinStore((s) => s.sessionTab)
  const navigate = useMerlinStore((s) => s.navigate)
  const skipPushRef = useRef(false)
  const initializedRef = useRef(false)

  // On mount: restore state from URL hash
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const initial = hashToState(location.hash)
    if (initial) {
      skipPushRef.current = true
      navigate(initial.focus)
      if (initial.hostFilter) useMerlinStore.setState({ hostFilter: initial.hostFilter })
      if (initial.projectTab) useMerlinStore.setState({ projectTab: initial.projectTab })
      if (initial.sessionTab) useMerlinStore.setState({ sessionTab: initial.sessionTab })
    } else {
      history.replaceState(null, '', stateToHash({ focus, hostFilter, projectTab, sessionTab }))
    }
  }, [hostFilter, sessionTab, projectTab, navigate, focus]) // eslint-disable-line react-hooks/exhaustive-deps

  // When any relevant state changes → push to history
  useEffect(() => {
    if (skipPushRef.current) {
      skipPushRef.current = false
      return
    }
    const newHash = stateToHash({ focus, hostFilter, projectTab, sessionTab })
    if (location.hash !== newHash) {
      history.pushState(null, '', newHash)
    }
  }, [focus, hostFilter, projectTab, sessionTab])

  // Listen for popstate (back/forward) → update store
  useEffect(() => {
    function onPopState() {
      const restored = hashToState(location.hash)
      if (restored) {
        skipPushRef.current = true
        navigate(restored.focus)
        if (restored.hostFilter) useMerlinStore.setState({ hostFilter: restored.hostFilter })
        else useMerlinStore.setState({ hostFilter: 'active' })
        if (restored.projectTab) useMerlinStore.setState({ projectTab: restored.projectTab })
        else useMerlinStore.setState({ projectTab: 'sessions' })
        if (restored.sessionTab) useMerlinStore.setState({ sessionTab: restored.sessionTab })
        else useMerlinStore.setState({ sessionTab: 'raw' })
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [navigate])

  // Re-resolve ~/work/ paths once model arrives (for initial page load before WS connects)
  const model = useMerlinStore((s) => s.model)
  useEffect(() => {
    if (!model) return
    const { focus } = useMerlinStore.getState()
    if ((focus.level === 'project' || focus.level === 'session') && focus.cwd.startsWith('~/work/')) {
      const resolved = decodeCwd(focus.cwd)
      if (resolved !== focus.cwd) {
        skipPushRef.current = true
        navigate({ ...focus, cwd: resolved } as NavigationFocus)
      }
    }
  }, [model, navigate])
}
