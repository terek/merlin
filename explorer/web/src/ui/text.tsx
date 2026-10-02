// Text from sessions. It is untrusted: rendered as text, or through react-markdown without raw HTML.

import { type ReactNode, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '../lib/cn'
import { highlightSnippet } from '../lib/highlight'
import { useOverflows } from '../lib/hooks'
import { modelLabel } from '../lib/models'
import { shortProject } from '../lib/paths'

function MoreButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-1 text-sec text-accent hover:underline">
      {open ? 'show less' : 'show more'}
    </button>
  )
}

const clampStyle = (lines: number) =>
  ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' }) as const

/**
 * Clamps its children to `lines` lines with a "show more" / "show less" toggle that appears only
 * when something is hidden. It never cuts the data, only the view.
 */
export function Clamp({
  lines,
  children,
  className,
  defaultOpen = false,
}: {
  lines: number
  children: ReactNode
  className?: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const ref = useRef<HTMLDivElement>(null)
  const over = useOverflows(ref, !open)
  return (
    <div className={className}>
      <div ref={ref} style={open ? undefined : clampStyle(lines)}>
        {children}
      </div>
      {(over || open) && <MoreButton open={open} onClick={() => setOpen(!open)} />}
    </div>
  )
}

/** Characters per clamped line past which a collapsed PlainText stops laying out the rest. */
const CHARS_PER_LINE = 240

/**
 * Prompt text: `white-space: pre-wrap`, long lines wrap, no markdown. With `lines` it is clamped,
 * and while collapsed only the first part of a very long text is laid out (a 100 kB prompt costs
 * nothing until "show more").
 */
export function PlainText({ text, lines, className }: { text: string; lines?: number; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const limit = lines ? lines * CHARS_PER_LINE : Number.POSITIVE_INFINITY
  const big = text.length > limit
  const collapsed = !!lines && !open
  const shown = collapsed && big ? `${text.slice(0, limit)}…` : text
  const over = useOverflows(ref, collapsed, shown)
  return (
    <div className={cn('max-w-col', className)}>
      <div
        ref={ref}
        className="whitespace-pre-wrap [overflow-wrap:anywhere]"
        style={collapsed && lines ? clampStyle(lines) : undefined}
      >
        {shown}
      </div>
      {!!lines && (big || over || open) && <MoreButton open={open} onClick={() => setOpen(!open)} />}
    </div>
  )
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  // No image is ever fetched (the page's CSP forbids it anyway): show what it was.
  img: ({ alt }) => <span className="text-faint">[image{alt ? `: ${alt}` : ''}]</span>,
}

/** Assistant text through react-markdown (GFM). No raw HTML, no syntax highlighter. */
export function Prose({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('prose-x max-w-col', className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {children}
      </Markdown>
    </div>
  )
}

/** A search snippet with the query's terms marked. */
export function Highlight({ snippet, query, className }: { snippet: string; query: string; className?: string }) {
  const segs = highlightSnippet(snippet, query)
  return (
    <span className={cn('[overflow-wrap:anywhere]', className)}>
      {segs.map((s, i) =>
        s.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity of their own
          <mark key={i} className="rounded-badge bg-flash px-px text-fg">
            {s.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  )
}

/** A project path as its last two segments; the full path is the tooltip. */
export function ProjectName({ path, className }: { path: string; className?: string }) {
  return (
    <span title={path} className={cn('whitespace-nowrap', className)}>
      {shortProject(path)}
    </span>
  )
}

/** A model as its label ("Fable 5.1"); the full name is the tooltip. */
export function ModelName({ name, className }: { name: string; className?: string }) {
  return (
    <span title={name} className={cn('whitespace-nowrap', className)}>
      {modelLabel(name)}
    </span>
  )
}

/** A mono id (session, agent), shortened to eight characters unless `full`; the full id is the tooltip. */
export function Id({ value, full, className }: { value: string; full?: boolean; className?: string }) {
  return (
    <span title={value} className={cn('font-mono text-sec', className)}>
      {full ? value : value.slice(0, 8)}
    </span>
  )
}

/** A hover title. A native title attribute is enough here; no popover library. */
export function Tooltip({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
  return (
    <span title={text} className={className}>
      {children}
    </span>
  )
}
