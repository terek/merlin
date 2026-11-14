// The sidebar both lenses of the scope show: the places as a file tree, and the scope's selection (docs/ui.md
// section 10b). It folds to a strip.

import { ChevronRight, type Folder, FolderX, HardDrive, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import { IconButton, Money, Select } from '../../ui'
import {
  ancestorIds,
  type Beads,
  BYS,
  type By,
  beadLabel,
  markedNode,
  NONE_SEL,
  nodeForPath,
  type PlaceTree,
  type Totals,
  visibleRows,
} from './model'
import { BY_LABEL, folderIcon, NONE_TITLE } from './placeUi'

export const SIDEBAR_W = 260
export const STRIP_W = 37

// ---- the sidebar: the places as a file tree, and the scope -------------------------------

const TREE_INDENT = 12
const TREE_GUTTER = 8

/** The ids of the folders the user closed under this key: kept per key, and fine without storage. */
function useClosed(by: By): [ReadonlySet<string>, (id: string) => void, (ids: string[]) => void] {
  const storeKey = `overview.tree.${by}`
  const read = (): Set<string> => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(storeKey) ?? '[]')
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
  }
  const [state, setState] = useState(() => ({ storeKey, closed: read() }))
  // the key changed: its own closed folders
  const closed = state.storeKey === storeKey ? state.closed : read()
  if (state.storeKey !== storeKey) setState({ storeKey, closed })
  const write = (next: Set<string>) => {
    setState({ storeKey, closed: next })
    try {
      localStorage.setItem(storeKey, JSON.stringify([...next]))
    } catch {
      // no storage: the state lives for this page only
    }
  }
  const toggle = (id: string) => {
    const next = new Set(closed)
    if (!next.delete(id)) next.add(id)
    write(next)
  }
  const open = (ids: string[]) => {
    const next = new Set(closed)
    for (const id of ids) next.delete(id)
    write(next)
  }
  return [closed, toggle, open]
}

/** Whether the sidebar is open: the user's choice, kept in the browser (open without it). */
export function useSidebarOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('overview.sidebar') !== 'closed'
    } catch {
      return true
    }
  })
  return [
    open,
    (v) => {
      setOpen(v)
      try {
        localStorage.setItem('overview.sidebar', v ? 'open' : 'closed')
      } catch {
        // no storage: the choice lives for this page only
      }
    },
  ]
}

const ITEM = 'flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left text-body'
// The selection reads through colour, not weight (a bolder label would shift the text): a stronger accent tint,
// the label, icon and figures in the accent. The hover tint (`bg-surface-2`) stays a grey.
const SELECTED = 'bg-accent/15 text-accent'

/**
 * The faint vertical guides of the levels above an item `indent` steps in: one through the chevron of each
 * ancestor that has its own indent step.
 */
function Guides({ indent }: { indent: number }) {
  return Array.from({ length: indent }, (_, j) => j).map((i) => (
    <span
      key={i}
      aria-hidden
      className="absolute inset-y-0 w-px bg-[color-mix(in_srgb,var(--text)_13%,transparent)]"
      style={{ left: TREE_GUTTER + i * TREE_INDENT + 7 }}
    />
  ))
}

/** The figures at the end of an item: sessions shown and spend. */
function Figures({ count, usd, selected }: { count: number; usd: number; selected: boolean }) {
  return (
    <>
      <span className={cn('w-6 shrink-0 text-right text-sec tabular-nums', !selected && 'text-muted')}>{count}</span>
      <Money
        usd={usd}
        dim={!selected}
        className={cn('w-12 shrink-0 text-right text-sec', selected && 'text-accent!')}
      />
    </>
  )
}

/**
 * One line of the tree. `level` 0 is a section heading (semibold); its children start flush under it, and each
 * level below them is one indent step further. The chevron only opens or closes; the label selects.
 */
function TreeLine({
  level,
  open,
  onToggle,
  icon: Icon,
  label,
  sub,
  title,
  count,
  usd,
  selected,
  hot,
  muted,
  onPick,
  node,
}: {
  /** 0: a heading, always open: no chevron. */
  level: number
  /** Whether its folder is open; undefined for a line with nothing under it (no chevron). */
  open?: boolean
  onToggle?: () => void
  icon: typeof Folder
  label: string
  /** Smaller and muted after the label (a bead's id). */
  sub?: string
  title: string
  count: number
  usd: number
  selected: boolean
  hot: boolean
  muted?: boolean
  onPick: () => void
  /** Its node id, for scrolling the selection into view. */
  node?: string
}) {
  const indent = Math.max(0, level - 1)
  return (
    <li
      data-node={node}
      className={cn('relative flex items-center rounded-card', selected ? SELECTED : hot && 'bg-surface-2')}
      style={{ paddingLeft: TREE_GUTTER + indent * TREE_INDENT }}
    >
      <Guides indent={indent} />
      {level === 0 ? null : open === undefined ? (
        <span className="size-4 shrink-0" aria-hidden />
      ) : (
        <button
          type="button"
          data-nav
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? 'Close' : 'Open'} ${label}`}
          className="flex size-4 shrink-0 items-center justify-center text-muted hover:text-fg"
        >
          <ChevronRight size={12} aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
        </button>
      )}
      <button
        type="button"
        data-nav
        onClick={onPick}
        aria-current={selected ? 'true' : undefined}
        title={title}
        className={cn(
          ITEM,
          level === 0 ? 'pl-1' : 'pl-0.5',
          level === 0 && 'font-semibold',
          muted && !selected && 'text-muted',
        )}
      >
        <Icon size={14} aria-hidden className={cn('shrink-0', !selected && 'text-muted')} />
        {/* the id wraps out of sight (the line is clipped) when it does not fit whole beside the title */}
        <span className="flex h-5 min-w-0 flex-1 flex-wrap items-baseline overflow-hidden">
          <span className="max-w-full truncate">{label}</span>
          {sub && (
            <span className={cn('ml-1.5 whitespace-nowrap text-meta', selected ? 'text-accent' : 'text-faint')}>
              {sub}
            </span>
          )}
        </span>
        <Figures count={count} usd={usd} selected={selected} />
      </button>
    </li>
  )
}

/**
 * The sidebar: a file explorer of the places under the key it is organised by, and the table's scope. The places
 * sit where they are in the filesystem (a repository at its working directory, a remote as host / owner / name),
 * compact folders, the home as `~`. A click on a line selects it (the table shows what is at or under it), a
 * click on the selected line or on All clears; the chevron only opens or closes. `hover` is the place of the row
 * under the pointer (when a closed folder hides it, the folder is marked). It folds to a strip.
 */
export function Sidebar({
  extra,
  open,
  onOpen,
  by,
  onBy,
  tree,
  beads,
  all,
  sel,
  hover,
  onSelect,
}: {
  open: boolean
  onOpen: (open: boolean) => void
  by: By
  onBy: (by: By) => void
  tree: PlaceTree
  /** The beads of the response, for the labels of the Bead key. */
  beads?: Beads
  /** The figures of everything the search leaves. */
  all: Totals
  sel: string | null
  hover: string | null
  onSelect: (path: string | null) => void
  /** Lines under the tree that are no places (Cost: what the places leave out of its total). */
  extra?: { id: string; label: string; title: string; count?: number; usd: number }[]
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const [stored, toggle, openFolders] = useClosed(by)
  // the top level (All, else the top places) is always open: what was stored for it does not count
  const none = tree.none
  const rooted = !!none
  const closed = useMemo(
    () => (rooted ? stored : new Set([...stored].filter((id) => !tree.nodes.some((n) => n.id === id)))),
    [stored, rooted, tree.nodes],
  )
  const rows = useMemo(() => visibleRows(tree.nodes, closed), [tree.nodes, closed])
  const selNode = sel === null || sel === NONE_SEL ? null : nodeForPath(tree.nodes, sel)
  const hot = hover === null ? null : markedNode(tree.nodes, hover, closed)
  // with sessions of no value the places hang under an All heading, so that (none) is their sibling; without
  // them the places are the top level and nothing else is added
  // the selection's ancestors are open, once for each selection
  const opened = useRef('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: once for each selection, not at every change of the folders
  useEffect(() => {
    if (!selNode || sel === null || opened.current === `${by}|${sel}`) return
    opened.current = `${by}|${sel}`
    const shut = ancestorIds(tree.nodes, sel).filter((id) => closed.has(id))
    if (shut.length > 0) openFolders(shut)
  }, [sel, by, selNode, tree.nodes])
  useEffect(() => {
    if (!open || !selNode) return
    const li = [...(listRef.current?.children ?? [])].find((c) => (c as HTMLElement).dataset.node === selNode.id)
    li?.scrollIntoView({ block: 'nearest' })
  }, [selNode, open])
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const all = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }
  const pick = (path: string) => onSelect(sel === path ? null : path)
  const lift = rooted ? 1 : 0
  return (
    <aside
      aria-label={`${BY_LABEL[by]} tree`}
      className="relative shrink-0 overflow-hidden border-line border-r transition-[width] duration-150 motion-reduce:transition-none"
      style={{ width: open ? SIDEBAR_W : STRIP_W }}
    >
      {!open && (
        <div className="absolute inset-x-0 top-0 flex justify-center border-line border-b py-1">
          <IconButton label="Show the sidebar" onClick={() => onOpen(true)}>
            <PanelLeftOpen size={15} />
          </IconButton>
        </div>
      )}
      <div
        aria-hidden={!open}
        inert={!open}
        className={cn('flex h-full flex-col', !open && 'invisible')}
        style={{ width: SIDEBAR_W - 1 }}
      >
        <div className="flex shrink-0 items-center gap-2 border-line border-b py-1 pr-1.5 pl-3">
          <span className="shrink-0 text-faint text-meta uppercase tracking-wide">Organise by</span>
          <Select<By>
            label="Organise by"
            value={by}
            onChange={onBy}
            options={BYS.map((v) => ({ value: v, label: BY_LABEL[v] }))}
            className="min-w-0 flex-1"
          />
          <IconButton label="Hide the sidebar" onClick={() => onOpen(false)}>
            <PanelLeftClose size={15} />
          </IconButton>
        </div>
        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5" onKeyDown={onKeyDown}>
          {rooted && (
            <TreeLine
              level={0}
              icon={HardDrive}
              label="All"
              title="Every place"
              count={all.sessions}
              usd={all.usd}
              selected={sel === null}
              hot={false}
              onPick={() => onSelect(null)}
            />
          )}
          {rows.map(({ node: n, depth }) => {
            const folder = n.children.length > 0
            const isOpen = folder && !closed.has(n.id)
            const shown = by === 'bead' ? beadLabel(n.label, beads) : { text: n.label, closed: false }
            return (
              <TreeLine
                key={n.id}
                node={n.id}
                level={depth + lift}
                open={folder ? isOpen : undefined}
                onToggle={() => toggle(n.id)}
                icon={folderIcon(n, by, isOpen, beads)}
                label={shown.text}
                sub={shown.id}
                muted={shown.closed}
                title={shown.title ? `${shown.title}\n${n.label}` : n.id}
                count={n.count}
                usd={n.usd}
                selected={selNode?.id === n.id}
                hot={hot === n.id}
                onPick={() => pick(n.path)}
              />
            )
          })}
          {none && (
            <TreeLine
              level={1}
              icon={FolderX}
              label="(none)"
              title={NONE_TITLE[by]}
              count={none.count}
              usd={none.usd}
              selected={sel === NONE_SEL}
              hot={hover === ''}
              muted
              onPick={() => pick(NONE_SEL)}
            />
          )}
          {extra?.map((e) => (
            <li
              key={e.id}
              title={e.title}
              className="mt-1 flex items-center text-muted"
              style={{ paddingLeft: TREE_GUTTER }}
            >
              <span className="size-4 shrink-0" aria-hidden />
              <span className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-body">
                <span className="min-w-0 flex-1 truncate pl-5">
                  {e.label}
                  {e.count !== undefined && (
                    <span className="ml-1.5 text-faint text-meta">{e.count.toLocaleString('en-US')}</span>
                  )}
                </span>
                <Money usd={e.usd} dim className="w-12 shrink-0 text-right text-sec" />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
