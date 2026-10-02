// The project rail: "All" and each project, most recently active first.

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useProjects } from '../../api/queries'
import { cn } from '../../lib/cn'
import { formatCount } from '../../lib/format'
import { IconButton, Money, ProjectName, QueryBoundary, SkeletonRows } from '../../ui'

function Item({
  active,
  onClick,
  name,
  count,
  usd,
  title,
}: {
  active: boolean
  onClick: () => void
  name: React.ReactNode
  count: number
  usd: number
  title?: string
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'true' : undefined}
        title={title}
        className={cn(
          'flex w-full items-center gap-2 rounded-card px-2 py-1 text-left text-body hover:bg-surface-2',
          active && 'bg-accent-soft font-medium text-accent hover:bg-accent-soft',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="w-8 shrink-0 text-right text-sec text-muted">{formatCount(count)}</span>
        <Money usd={usd} dim className="w-14 shrink-0 text-right text-sec" />
      </button>
    </li>
  )
}

export function ProjectRail({
  selected,
  onSelect,
  collapsed,
  onToggle,
}: {
  selected: string
  onSelect: (project: string) => void
  collapsed: boolean
  onToggle: () => void
}) {
  const query = useProjects()
  if (collapsed) {
    return (
      <aside className="sticky top-11 h-[calc(100vh-44px)] w-10 shrink-0 border-r border-line bg-surface py-2 text-center">
        <IconButton label="Show projects" onClick={onToggle}>
          <PanelLeftOpen size={15} />
        </IconButton>
      </aside>
    )
  }
  return (
    <aside className="sticky top-11 flex h-[calc(100vh-44px)] w-rail shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-10 shrink-0 items-center justify-between pr-1 pl-3">
        <h2 className="text-meta uppercase tracking-wide text-muted">Projects</h2>
        <IconButton label="Hide projects" onClick={onToggle}>
          <PanelLeftClose size={15} />
        </IconButton>
      </div>
      <nav aria-label="Projects" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        <QueryBoundary
          query={query}
          skeleton={<SkeletonRows rows={8} height={28} />}
          isEmpty={(d) => d.projects.length === 0}
          empty={<p className="px-2 py-3 text-sec text-muted">No projects indexed yet.</p>}
        >
          {(d) => {
            const projects = [...d.projects].sort((a, b) =>
              (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''),
            )
            const count = projects.reduce((n, p) => n + p.sessions, 0)
            const usd = projects.reduce((n, p) => n + p.cost.totalUSD, 0)
            return (
              <ul className="space-y-px">
                <Item active={selected === ''} onClick={() => onSelect('')} name="All" count={count} usd={usd} />
                {projects.map((p) => (
                  <Item
                    key={`${p.harness}/${p.projectKey}`}
                    active={selected === p.project || selected === p.projectKey}
                    onClick={() => onSelect(p.project)}
                    name={<ProjectName path={p.project} />}
                    count={p.sessions}
                    usd={p.cost.totalUSD}
                    title={p.project}
                  />
                ))}
              </ul>
            )
          }}
        </QueryBoundary>
      </nav>
    </aside>
  )
}
