import type { ReactNode } from 'react'

interface PageHeaderProps {
  tabs?: ReactNode
  search?: ReactNode
  stats?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}

/**
 * Shared page header shell. Left: tabs + search. Middle: free-form children.
 * Right (pushed by ml-auto): stats, then actions.
 */
export function PageHeader({ tabs, search, stats, actions, children }: PageHeaderProps) {
  return (
    <div className="flex items-center gap-4 border-b px-6 py-3 shrink-0">
      {tabs}
      {search}
      {children}
      <div className="ml-auto flex items-center gap-4">
        {stats}
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
