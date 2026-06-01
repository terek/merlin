import * as React from 'react'
import { cn } from '@/lib/utils'

/** Simple scroll area — just an overflow container with styled scrollbar. */
const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'overflow-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  ),
)
ScrollArea.displayName = 'ScrollArea'

export { ScrollArea }
