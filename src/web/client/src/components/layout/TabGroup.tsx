import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TabItem<K extends string = string> {
  key: K
  label: string
  icon?: LucideIcon
  loading?: boolean
  count?: number
}

interface TabGroupProps<K extends string> {
  value: K
  onChange: (key: K) => void
  items: TabItem<K>[]
}

export function TabGroup<K extends string>({ value, onChange, items }: TabGroupProps<K>) {
  return (
    <div className="flex items-center gap-1 rounded-md bg-secondary/50 p-0.5">
      {items.map((item) => {
        const active = value === item.key
        const Icon = item.icon
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            className={cn(
              'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
              active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className={cn('h-3.5 w-3.5', item.loading && 'animate-spin')} />}
            <span>{item.label}</span>
            {item.count != null && <span className="text-muted-foreground/60">({item.count})</span>}
          </button>
        )
      })}
    </div>
  )
}
