// What the two lenses of the scope share about a place: the names of the keys and the icon of a node.

import { Circle, CircleCheck, Folder, FolderGit2, FolderOpen, Globe } from 'lucide-react'
import type { Beads, By, PlaceNode } from './model'

export const BY_LABEL: Record<By, string> = {
  dir: 'Folder',
  checkout: 'Worktree',
  repo: 'Repo',
  remote: 'Remote',
  bead: 'Bead',
}

/** The title of the sidebar's (none): the sessions with no value for the key. */
export const NONE_TITLE: Record<By, string> = {
  dir: 'Sessions with no folder',
  checkout: 'Sessions in no worktree',
  repo: 'Sessions in no repository',
  remote: 'Sessions with no remote',
  bead: 'Sessions on no bead',
}

export const folderIcon = (n: PlaceNode, by: By, open: boolean, beads?: Beads) => {
  // a bead: a circle, ticked when it is closed; a prefix is a folder
  if (by === 'bead' && beads?.[n.label]) return beads[n.label].status === 'closed' ? CircleCheck : Circle
  if (n.host) return Globe
  if (n.place && (by === 'repo' || by === 'checkout' || by === 'remote')) return FolderGit2
  return open ? FolderOpen : Folder
}
