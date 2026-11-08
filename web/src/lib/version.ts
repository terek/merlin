// Which daemon version a page loaded with, and whether the daemon has since changed.

export interface VersionState {
  /** The version of the first hello this page saw; null before it. */
  loaded: string | null
  /** The newer version the daemon reports now, or null while it matches the loaded one. */
  updatedTo: string | null
}

export const initialVersion: VersionState = { loaded: null, updatedTo: null }

/** Folds a hello event's version into the state: the first one is remembered, a different one is an update. */
export function seeVersion(s: VersionState, seen: string): VersionState {
  if (!seen) return s
  if (s.loaded === null) return { loaded: seen, updatedTo: null }
  const updatedTo = seen === s.loaded ? null : seen
  return updatedTo === s.updatedTo ? s : { ...s, updatedTo }
}

/** The release page of a version (`0.4.2` and `v0.4.2` both give the tag `v0.4.2`). */
export function releaseUrl(version: string): string {
  return `https://github.com/terek/merlin/releases/tag/v${version.replace(/^v/, '')}`
}
