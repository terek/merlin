import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const CloseContext = createContext<() => void>(() => {})

interface DropdownMenuProps {
  trigger: ReactNode
  children: ReactNode
  align?: 'left' | 'right'
}

export function DropdownMenu({ trigger, children, align = 'right' }: DropdownMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <div
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        {trigger}
      </div>
      {open && (
        <CloseContext.Provider value={() => setOpen(false)}>
          <div
            className={cn(
              'absolute z-50 mt-1 min-w-[180px] rounded-md border bg-popover py-1 shadow-lg',
              align === 'right' ? 'right-0' : 'left-0',
            )}
          >
            {children}
          </div>
        </CloseContext.Provider>
      )}
    </div>
  )
}

interface DropdownItemProps {
  onClick: () => void
  children: ReactNode
  variant?: 'default' | 'destructive'
  disabled?: boolean
}

export function DropdownItem({ onClick, children, variant = 'default', disabled }: DropdownItemProps) {
  const close = useContext(CloseContext)

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) {
          close()
          onClick()
        }
      }}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors',
        disabled
          ? 'text-muted-foreground/50 cursor-not-allowed'
          : variant === 'destructive'
            ? 'text-red-400 hover:bg-red-500/10'
            : 'text-popover-foreground hover:bg-secondary/60',
      )}
    >
      {children}
    </button>
  )
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-border" />
}
