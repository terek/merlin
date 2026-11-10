// Which daemon version a page loaded with, whether the daemon has since changed, and whether
// a newer release is waiting to be installed.

export interface VersionState {
  /** The version of the first hello this page saw; null before it. */
  loaded: string | null
  /** The newer version the daemon reports now, or null while it matches the loaded one. */
  updatedTo: string | null
  /** The release the daemon found and did not install (an update event); null for none. */
  available: string | null
}

export const initialVersion: VersionState = { loaded: null, updatedTo: null, available: null }

/** Folds a hello event's version into the state: the first one is remembered, a different one is an update. */
export function seeVersion(s: VersionState, seen: string): VersionState {
  if (!seen) return s
  if (s.loaded === null) return { ...s, loaded: seen, updatedTo: null }
  const updatedTo = seen === s.loaded ? null : seen
  return updatedTo === s.updatedTo ? s : { ...s, updatedTo }
}

/** Folds an update event's version into the state; an empty one means nothing is waiting. */
export function seeAvailable(s: VersionState, seen: string): VersionState {
  const available = seen || null
  return available === s.available ? s : { ...s, available }
}

/**
 * The release to offer as "available", or null. Not while the "updated, reload" notice is up (the daemon
 * has already moved on), and not when it is the version the daemon runs.
 */
export function availableToShow(s: VersionState): string | null {
  if (!s.available || s.updatedTo || s.available === s.loaded) return null
  return s.available
}

/** The release page of a version (`0.4.2` and `v0.4.2` both give the tag `v0.4.2`). */
export function releaseUrl(version: string): string {
  return `https://github.com/terek/merlin/releases/tag/v${version.replace(/^v/, '')}`
}
