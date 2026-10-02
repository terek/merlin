import { Check, ChevronDown, Copy, Search, X } from 'lucide-react'
import {
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
  useState,
} from 'react'
import { cn } from '../lib/cn'

/** A keyboard key: `/`, `Esc`, `g`. */
export function KeyHint({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex min-w-[18px] items-center justify-center rounded-badge border border-line bg-surface-2 px-1 text-meta leading-[16px] text-muted',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost'
  size?: 'sm' | 'md'
}

const BUTTON_VARIANTS = {
  default: 'border border-line bg-surface text-fg hover:bg-surface-2',
  primary: 'border border-accent bg-accent text-surface hover:opacity-90',
  ghost: 'border border-transparent text-muted hover:bg-surface-2 hover:text-fg',
}

export function Button({ variant = 'default', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-card text-body disabled:cursor-default disabled:opacity-50',
        size === 'sm' ? 'h-6 px-2 text-sec' : 'h-7 px-3',
        BUTTON_VARIANTS[variant],
        className,
      )}
    />
  )
}

/** A square icon-only button; `label` is its accessible name and tooltip. */
export function IconButton({
  label,
  children,
  className,
  ...rest
}: Omit<ButtonProps, 'variant' | 'size'> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-card border border-transparent text-muted hover:bg-surface-2 hover:text-fg',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Copies a string to the clipboard and shows a check for a second. With children, it is a text button. */
export function CopyButton({
  text,
  label = 'Copy',
  children,
  className,
}: {
  text: string
  label?: string
  children?: ReactNode
  className?: string
}) {
  const [done, setDone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // clipboard denied: fall back to a hidden textarea
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        // nothing more to try
      }
      ta.remove()
    }
    setDone(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setDone(false), 1000)
  }
  const icon = done ? <Check size={14} className="text-ok" /> : <Copy size={14} />
  if (children) {
    return (
      <Button size="sm" variant="ghost" onClick={copy} className={className} aria-label={label}>
        {icon}
        {children}
      </Button>
    )
  }
  return (
    <IconButton label={done ? 'Copied' : label} onClick={copy} className={cn('size-6', className)}>
      {icon}
    </IconButton>
  )
}

export interface TabItem<V extends string = string> {
  id: V
  label: ReactNode
  count?: number
}

function arrowTarget(e: KeyboardEvent, i: number, n: number): number | undefined {
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return (i + 1) % n
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') return (i + n - 1) % n
  if (e.key === 'Home') return 0
  if (e.key === 'End') return n - 1
  return undefined
}

/** Underlined tabs. Arrow keys move between them. */
export function Tabs<V extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: TabItem<V>[]
  value: V
  onChange: (id: V) => void
  label?: string
  className?: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  return (
    <div role="tablist" aria-label={label} className={cn('flex gap-4 border-b border-line', className)}>
      {items.map((it, i) => {
        const on = it.id === value
        return (
          <button
            key={it.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(it.id)}
            onKeyDown={(e) => {
              const t = arrowTarget(e, i, items.length)
              if (t !== undefined) {
                e.preventDefault()
                onChange(items[t].id)
                refs.current[t]?.focus()
              }
            }}
            className={cn(
              '-mb-px border-b-2 px-0.5 pb-1.5 text-body',
              on ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {it.label}
            {it.count !== undefined && <span className="ml-1.5 text-sec text-faint">{it.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

export interface Option<V extends string = string> {
  value: V
  label: ReactNode
  title?: string
}

/** A row of mutually exclusive options (range, split, state), as toggle buttons. */
export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: Option<V>[]
  value: V
  onChange: (v: V) => void
  label?: string
  className?: string
}) {
  return (
    <fieldset
      aria-label={label}
      className={cn(
        'm-0 inline-flex h-7 min-w-0 shrink-0 rounded-card border border-line bg-surface-2 p-0.5',
        className,
      )}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'whitespace-nowrap rounded-badge px-2.5 text-sec',
              on ? 'bg-surface text-fg outline outline-1 outline-line' : 'text-muted hover:text-fg',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </fieldset>
  )
}

/** A native select, styled. */
export function Select<V extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: V
  onChange: (v: V) => void
  options: { value: V; label: string }[]
  label: string
  className?: string
}) {
  return (
    <span className={cn('relative inline-flex', className)}>
      <select
        aria-label={label}
        title={label}
        value={value}
        onChange={(e) => onChange(e.target.value as V)}
        className="h-7 w-full appearance-none rounded-card border border-line bg-surface pr-7 pl-2.5 text-body text-fg hover:bg-surface-2"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-muted" />
    </span>
  )
}

/**
 * A search box. Typing calls `onChange` at once (debounce in the view with `useDebounced`); Esc
 * clears it, and blurs it when it is already empty. `hint` is a key shown while it is empty.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  hint,
  inputRef,
  className,
  label = 'Search',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  inputRef?: Ref<HTMLInputElement>
  className?: string
  label?: string
}) {
  return (
    <div className={cn('relative flex items-center', className)}>
      <Search size={14} className="pointer-events-none absolute left-2.5 text-faint" />
      <input
        ref={inputRef}
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (value) onChange('')
            else e.currentTarget.blur()
          }
        }}
        className="h-7 w-full rounded-card border border-line bg-surface pr-14 pl-8 text-body text-fg placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
      />
      <span className="absolute right-1.5 flex items-center">
        {value ? (
          <IconButton label="Clear" onClick={() => onChange('')} className="size-5">
            <X size={13} />
          </IconButton>
        ) : (
          hint && <KeyHint>{hint}</KeyHint>
        )}
      </span>
    </div>
  )
}
