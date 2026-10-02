// The three non-data states of a region: loading, empty, error.

import { LoaderCircle, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { isApiError } from '../api/client'
import { cn } from '../lib/cn'
import { useDelayed } from '../lib/hooks'
import { Button } from './controls'

/** A static placeholder block (no shimmer: the UI has no motion). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('h-3 w-full rounded-badge bg-surface-2', className)} />
}

/** `rows` placeholder rows of `height` px, for a list that is loading. */
export function SkeletonRows({
  rows = 6,
  height = 36,
  className,
}: {
  rows?: number
  height?: number
  className?: string
}) {
  return (
    <div role="status" aria-label="Loading" className={cn('divide-y divide-line', className)}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="flex items-center gap-3 px-3" style={{ height }}>
          <Skeleton className="h-3 w-2/5" />
          <Skeleton className="ml-auto h-3 w-1/6" />
        </div>
      ))}
    </div>
  )
}

export function Spinner({
  size = 16,
  className,
  label = 'Loading',
}: {
  size?: number
  className?: string
  label?: string
}) {
  return <LoaderCircle role="status" aria-label={label} size={size} className={cn('spin text-muted', className)} />
}

/** What the region would show, and what would make it non-empty. */
export function EmptyState({
  title,
  children,
  icon,
  action,
  className,
}: {
  title: ReactNode
  children?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center gap-1.5 px-6 py-10 text-center', className)}>
      {icon && <div className="text-faint">{icon}</div>}
      <div className="text-body font-medium">{title}</div>
      {children && <div className="max-w-md text-sec text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/** The API's `error.message`, with a retry button. */
export function ErrorState({
  error,
  onRetry,
  title = 'Could not load this',
  className,
}: {
  error: unknown
  onRetry?: () => void
  title?: string
  className?: string
}) {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error')
  const code = isApiError(error) && error.status > 0 ? `${error.status} ${error.code}` : undefined
  return (
    <div role="alert" className={cn('flex flex-col items-center gap-1.5 px-6 py-10 text-center', className)}>
      <TriangleAlert size={20} className="text-bad" />
      <div className="text-body font-medium">{title}</div>
      <div className="max-w-md text-sec text-muted [overflow-wrap:anywhere]">{message}</div>
      {code && <div className="font-mono text-meta text-faint">{code}</div>}
      {onRetry && (
        <Button size="sm" onClick={onRetry} className="mt-2">
          Retry
        </Button>
      )}
    </div>
  )
}

interface QueryLike<T> {
  data: T | undefined
  isPending: boolean
  isError: boolean
  error: unknown
  refetch: () => unknown
}

/**
 * Gives a data region its three states from a query: a skeleton once loading has taken 200 ms
 * (nothing before), `empty` when `isEmpty(data)`, the API's error with a retry button, and
 * otherwise `children(data)`. When data is cached and a refetch fails, the data stays.
 */
export function QueryBoundary<T>({
  query,
  isEmpty,
  empty,
  skeleton = <SkeletonRows />,
  children,
}: {
  query: QueryLike<T>
  isEmpty?: (data: T) => boolean
  empty?: ReactNode
  skeleton?: ReactNode
  children: (data: T) => ReactNode
}): ReactNode {
  const showSkeleton = useDelayed(query.isPending, 200)
  if (query.data !== undefined) {
    if (isEmpty?.(query.data)) return empty ?? <EmptyState title="Nothing here" />
    return children(query.data)
  }
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  return showSkeleton ? skeleton : <div className="min-h-24" />
}
