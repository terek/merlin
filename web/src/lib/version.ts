// Which daemon version a page loaded with, whether the daemon has since changed, and whether
// a newer release is waiting to be installed.

export type UpdateState = 'available' | 'downloading' | 'ready' | 'installing' | 'blocked'

/** A release the daemon found and did not install. */
export interface Available {
  version: string
  /** Where it stands; an update event without a state is `available`. */
  state: UpdateState
  /** Blocked: what to do (a sentence with the command); available: the last failure. */
  reason?: string
}

export interface VersionState {
  /** The version of the first hello this page saw; null before it. */
  loaded: string | null
  /** The newer version the daemon reports now, or null while it matches the loaded one. */
  updatedTo: string | null
  /** The release the daemon found and did not install (an update event); null for none. */
  available: Available | null
}

export const initialVersion: VersionState = { loaded: null, updatedTo: null, available: null }

/** Folds a hello event's version into the state: the first one is remembered, a different one is an update. */
export function seeVersion(s: VersionState, seen: string): VersionState {
  if (!seen) return s
  if (s.loaded === null) return { ...s, loaded: seen, updatedTo: null }
  const updatedTo = seen === s.loaded ? null : seen
  return updatedTo === s.updatedTo ? s : { ...s, updatedTo }
}

/** Folds an update event into the state; an empty version means nothing is waiting. */
export function seeAvailable(s: VersionState, seen: string, state?: UpdateState, reason?: string): VersionState {
  const cur = s.available
  if (!seen) return cur === null ? s : { ...s, available: null }
  const st = state ?? 'available'
  if (cur && cur.version === seen && cur.state === st && cur.reason === reason) return s
  return { ...s, available: reason ? { version: seen, state: st, reason } : { version: seen, state: st } }
}

/**
 * The release to offer as "available", or null. Not while the "updated, reload" notice is up (the daemon
 * has already moved on), and not when it is the version the daemon runs.
 */
export function availableToShow(s: VersionState): Available | null {
  const a = s.available
  if (!a || s.updatedTo || a.version === s.loaded) return null
  return a
}

/** The tab that clicked Install reloads once the daemon runs the version it installed. */
export function shouldReload(s: VersionState, installing: string | null): boolean {
  return installing !== null && s.updatedTo !== null && s.updatedTo === installing
}

/** The release page of a version (`0.4.2` and `v0.4.2` both give the tag `v0.4.2`). */
export function releaseUrl(version: string): string {
  return `https://github.com/terek/merlin/releases/tag/v${version.replace(/^v/, '')}`
}
