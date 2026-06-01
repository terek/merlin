import { Battery, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PreprocessingStatus } from '@/types/model'

interface PpStatusIconProps {
  status?: PreprocessingStatus
  error?: string
  turnsCovered?: number
  totalTurns?: number
  className?: string
}

// Battery metaphor: how "charged" is the processing for this session?
// Empty=missing, Low=outdated, animating=running, Full=processed, Warning=error
export function PpStatusIcon({ status, error, turnsCovered, totalTurns, className }: PpStatusIconProps) {
  if (!status) return null

  const base = cn('h-3.5 w-3.5 shrink-0', className)

  const title =
    status === 'processed'
      ? turnsCovered != null && totalTurns != null && turnsCovered < totalTurns
        ? `Processed (${turnsCovered}/${totalTurns} turns)`
        : 'Processed'
      : status === 'running'
        ? 'Processing...'
        : status === 'error'
          ? `Error${error ? `: ${error}` : ''}`
          : status === 'outdated'
            ? 'Outdated (source changed)'
            : 'Not processed'

  switch (status) {
    case 'processed':
      return <BatteryFull className={cn(base, 'text-muted-foreground')} title={title} />
    case 'running':
      return <BatteryMedium className={cn(base, 'text-muted-foreground animate-pulse')} title={title} />
    case 'error':
      return <BatteryWarning className={cn(base, 'text-muted-foreground')} title={title} />
    case 'outdated':
      return <BatteryLow className={cn(base, 'text-muted-foreground')} title={title} />
    case 'missing':
      return <Battery className={cn(base, 'text-muted-foreground/40')} title={title} />
  }
}
