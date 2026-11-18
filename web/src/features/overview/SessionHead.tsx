// The head of a session open in the Overview (docs/ui.md section 10b): the session's own line (`← the list it came from`,
// harness mark, title, description, folder; at the right the session's total spend, the paginator and the close button) and, under it, the slot the
// graph's locator is drawn into (SpendGraph portals it in). It borrows nothing of the list's row: no columns, no
// time axis of the list. The slot keeps its height while the session loads, so the head never jumps.

import { ArrowLeft, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { HarnessIcon, IconButton, Money } from '../../ui'
import type { Position } from './focus'
import { oneLine } from './model'
import { FolderCell } from './RowParts'

/** The locator's height: the strip is this tall (spend/Overview.tsx `H`); the slot holds it before it arrives. */
const LOCATOR_H = 54
/** The spend slot's width in characters: "$99,999" with room for a flag's prefix and suffix. */
const SPEND_CH = 9

export function SessionHead({
  harness,
  title,
  desc,
  folder,
  folderPath,
  command,
  context,
  usd,
  at,
  prev,
  next,
  onClose,
  locatorRef,
}: {
  harness: string
  title: string
  desc: string
  /** The session's directory as the list shows it, its full path (for the title), and the command a click copies. */
  folder: string
  folderPath: string
  command: string
  /** The list it came from (`7d · in ~/tools`): the back link's text. */
  context: string
  /** The session's total spend; absent while nothing is known of it. */
  usd?: number
  /** Where it is in the list; null when it is not in it. */
  at: Position | null
  prev: (() => void) | null
  next: (() => void) | null
  onClose: () => void
  /** Told the element the locator goes into. */
  locatorRef: (el: HTMLDivElement | null) => void
}) {
  const text = oneLine(desc)
  const arrow = (to: (() => void) | null, label: string, icon: React.ReactNode) => (
    <IconButton
      label={label}
      disabled={to === null}
      onClick={() => to?.()}
      className={cn('size-6', to === null && 'opacity-35 hover:bg-transparent hover:text-muted')}
    >
      {icon}
    </IconButton>
  )
  return (
    <div className="shrink-0 border-line border-b bg-surface">
      <div className="flex items-center gap-3 px-4 pt-2 text-sec">
        <button
          type="button"
          onClick={onClose}
          title="Back to the list"
          className="flex min-w-0 max-w-[40%] shrink items-center gap-1 self-center text-muted hover:text-fg"
        >
          <ArrowLeft size={13} className="shrink-0" aria-hidden />
          <span className="truncate">{context}</span>
        </button>
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="flex shrink-0 items-center self-center">
            <HarnessIcon harness={harness} size={13} />
          </span>
          <div className="min-w-0 flex-1 truncate" title={text ? `${title}: ${text}` : title}>
            <span className="font-semibold text-fg">{title}</span>
            {text && <span className="ml-2 text-muted">{text}</span>}
          </div>
        </div>
        <FolderCell text={folder} path={folderPath} command={command} />
        <div className="flex shrink-0 items-center gap-1">
          {/* a slot as wide as the widest figure ("$99,999" and a flag's marker), so paging never moves the arrows */}
          <span className="mx-1 shrink-0 text-right font-mono tabular-nums" style={{ width: `${SPEND_CH}ch` }}>
            {usd !== undefined && <Money usd={usd} />}
          </span>
          {at ? (
            <>
              {arrow(prev, 'Previous session ([)', <ChevronLeft size={15} />)}
              <span
                className="whitespace-nowrap text-center font-mono text-muted tabular-nums"
                style={{ width: `${2 * String(at.total).length + 4}ch` }}
              >
                {at.n} of {at.total}
              </span>
              {arrow(next, 'Next session (])', <ChevronRight size={15} />)}
            </>
          ) : (
            <span className="whitespace-nowrap text-muted">Not in this list</span>
          )}
          <IconButton label="Close (Esc)" onClick={onClose} className="size-6">
            <X size={15} />
          </IconButton>
        </div>
      </div>
      <div className="px-4 pt-1 pb-2">
        <div ref={locatorRef} data-testid="head-locator" style={{ minHeight: LOCATOR_H }} />
      </div>
    </div>
  )
}
