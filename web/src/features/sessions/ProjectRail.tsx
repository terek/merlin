// The rail: what the list is narrowed to, grouped by project (the directory a session started
// in), by repository (with its worktrees and branches) or by bead prefix (merlin for
// merlin-t8s.48: in practice a project's bead database). Each grouping is a facet: a session keeps
// its identity, the rail only filters the list.

import { CircleDot, FolderGit2, GitBranch, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Fragment } from 'react'
import { useBeads, useProjects, useRepos } from '../../api/queries'
import type { BeadBrief, RepoGroup } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatCount, formatMoney, plural } from '../../lib/format'
import { BeadStatus, IconButton, Money, ProjectName, QueryBoundary, SegmentedControl, SkeletonRows } from '../../ui'
import { type GroupBy, type PageFilters, PLACE_FILTERS } from './model'

function Item({
  active,
  onClick,
  name,
  count,
  usd,
  title,
  level = 0,
  countTitle,
}: {
  active: boolean
  onClick: () => void
  name: React.ReactNode
  count?: number
  usd: number
  title?: string
  level?: 0 | 1
  countTitle?: string
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
          level === 1 && 'py-0.5 pl-5 text-sec',
          active && 'bg-accent-soft font-medium text-accent hover:bg-accent-soft',
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{name}</span>
        <span className="w-8 shrink-0 text-right text-sec text-muted" title={countTitle}>
          {count === undefined ? '' : formatCount(count)}
        </span>
        <Money usd={usd} dim className="w-14 shrink-0 text-right text-sec" />
      </button>
    </li>
  )
}

const GROUPS: { value: GroupBy; label: string; title: string }[] = [
  { value: '', label: 'Projects', title: 'The directory each session started in' },
  {
    value: 'repo',
    label: 'Repos',
    title: 'The git repository each session worked in, with its worktrees and branches',
  },
  { value: 'bead', label: 'Beads', title: 'The beads (bd issues) sessions worked on, by prefix' },
]

export function ProjectRail({
  filters,
  onChange,
  collapsed,
  onToggle,
}: {
  filters: PageFilters
  onChange: (patch: Partial<PageFilters>) => void
  collapsed: boolean
  onToggle: () => void
}) {
  if (collapsed) {
    return (
      <aside className="sticky top-11 h-[calc(100vh-44px)] w-10 shrink-0 border-r border-line bg-surface py-2 text-center">
        <IconButton label="Show the rail" onClick={onToggle}>
          <PanelLeftOpen size={15} />
        </IconButton>
      </aside>
    )
  }
  return (
    <aside className="sticky top-11 flex h-[calc(100vh-44px)] w-rail shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-10 shrink-0 items-center justify-between gap-1 pr-1 pl-2">
        <SegmentedControl
          label="Group sessions by"
          value={filters.group}
          onChange={(group) => onChange({ ...PLACE_FILTERS, group })}
          options={GROUPS}
        />
        <IconButton label="Hide the rail" onClick={onToggle}>
          <PanelLeftClose size={15} />
        </IconButton>
      </div>
      <nav
        aria-label={GROUPS.find((g) => g.value === filters.group)?.label}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3"
      >
        {filters.group === 'repo' ? (
          <RepoList filters={filters} onChange={onChange} />
        ) : filters.group === 'bead' ? (
          <BeadList filters={filters} onChange={onChange} />
        ) : (
          <ProjectList selected={filters.project} onSelect={(project) => onChange({ project })} />
        )}
      </nav>
    </aside>
  )
}

function ProjectList({ selected, onSelect }: { selected: string; onSelect: (project: string) => void }) {
  const query = useProjects()
  return (
    <QueryBoundary
      query={query}
      skeleton={<SkeletonRows rows={8} height={28} />}
      isEmpty={(d) => d.projects.length === 0}
      empty={<p className="px-2 py-3 text-sec text-muted">No projects indexed yet.</p>}
    >
      {(d) => {
        const projects = [...d.projects].sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
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
                title={(p.harnesses ?? [p.harness]).length > 1 ? `${p.project} (Claude Code and Codex)` : p.project}
              />
            ))}
          </ul>
        )
      }}
    </QueryBoundary>
  )
}

/** The `repo=` value of a group: its directory, `-` for the sessions in no repository. */
const repoParam = (r: RepoGroup) => r.repo || '-'

function RepoList({ filters, onChange }: { filters: PageFilters; onChange: (patch: Partial<PageFilters>) => void }) {
  const query = useRepos()
  return (
    <QueryBoundary
      query={query}
      skeleton={<SkeletonRows rows={8} height={28} />}
      isEmpty={(d) => d.repos.length === 0}
      empty={<p className="px-2 py-3 text-sec text-muted">No repositories known yet.</p>}
    >
      {(d) => {
        const count = d.repos.reduce((n, r) => n + r.sessions, 0)
        const usd = d.repos.reduce((n, r) => n + r.cost.totalUSD, 0)
        return (
          <ul className="space-y-px">
            <Item active={!filters.repo} onClick={() => onChange(PLACE_FILTERS)} name="All" count={count} usd={usd} />
            {d.repos.map((r) => {
              const open = filters.repo === repoParam(r)
              return <RepoItem key={r.repo || '-'} repo={r} open={open} filters={filters} onChange={onChange} />
            })}
          </ul>
        )
      }}
    </QueryBoundary>
  )
}

function RepoItem({
  repo,
  open,
  filters,
  onChange,
}: {
  repo: RepoGroup
  open: boolean
  filters: PageFilters
  onChange: (patch: Partial<PageFilters>) => void
}) {
  const select = { ...PLACE_FILTERS, repo: repoParam(repo) }
  const branches = repo.branches ?? []
  return (
    <>
      <Item
        active={open && !filters.worktree && !filters.branch}
        onClick={() => onChange(select)}
        name={
          <>
            <FolderGit2 size={12} className="shrink-0 text-faint" />
            <span className={cn('truncate', !repo.repo && 'italic text-muted', repo.gone && 'line-through')}>
              {repo.name}
            </span>
          </>
        }
        count={repo.sessions}
        usd={repo.cost.totalUSD}
        title={
          repo.repo
            ? `${repo.repo}${repo.remote ? `\n${repo.remote}` : ''}${repo.gone ? '\n(no longer on disk)' : ''}`
            : 'Sessions in no git repository Merlin knows'
        }
      />
      {open &&
        (repo.worktrees ?? []).map((w) => (
          <Item
            key={w.top}
            level={1}
            active={filters.worktree === w.top}
            onClick={() => onChange({ ...select, worktree: w.top })}
            name={<span className={cn('truncate', w.gone && 'line-through')}>⌥ {w.name}</span>}
            count={w.sessions}
            usd={w.bestUSD}
            title={`Worktree ${w.top}${w.gone ? ' (removed)' : ''}: the sessions that worked in it and their whole cost`}
          />
        ))}
      {open &&
        branches.map((b) => (
          <Item
            key={b.name}
            level={1}
            active={filters.branch === b.name}
            onClick={() => onChange({ ...select, branch: b.name })}
            name={
              <>
                <GitBranch size={11} className="shrink-0 text-faint" />
                <span className="truncate font-mono text-meta">{b.name}</span>
              </>
            }
            count={b.sessions}
            usd={b.usd}
            title={`Branch ${b.name}: ${plural(b.sessions, 'session')} with a turn on it; the cost is their spend while on it`}
          />
        ))}
    </>
  )
}

/** A bead id's prefix: what precedes the last dash of its root (merlin for merlin-t8s.48). */
function prefixOf(id: string): string {
  const root = id.split('.')[0]
  const i = root.lastIndexOf('-')
  return i > 0 ? root.slice(0, i) : ''
}

function BeadList({ filters, onChange }: { filters: PageFilters; onChange: (patch: Partial<PageFilters>) => void }) {
  const query = useBeads()
  return (
    <QueryBoundary
      query={query}
      skeleton={<SkeletonRows rows={8} height={28} />}
      isEmpty={(d) => (d.prefixes ?? []).length === 0}
      empty={
        <p className="px-2 py-3 text-sec text-muted">
          {query.data?.databases
            ? 'No session has worked on a bead yet.'
            : 'No bead databases known yet. Merlin finds them in the repositories sessions work in.'}
        </p>
      }
    >
      {(d) => {
        const prefixes = d.prefixes ?? []
        // a single bead picked elsewhere (a session's bead tags, a link) shows under its prefix
        const one = prefixes.some((p) => p.prefix === filters.bead) ? '' : filters.bead
        // a family's beads include its root
        const found = one ? d.families.flatMap((f) => f.beads).find((b) => b.id === one) : undefined
        const oneRef: BeadBrief | undefined = one ? (found ?? { id: one, root: one }) : undefined
        return (
          <ul className="space-y-px">
            <Item
              active={!filters.bead}
              onClick={() => onChange(PLACE_FILTERS)}
              name="All"
              usd={prefixes.reduce((n, p) => n + p.usd, 0)}
              title="Every session; the cost is the part spent on beads"
            />
            {prefixes.map((p) => (
              <Fragment key={p.prefix}>
                <Item
                  active={filters.bead === p.prefix}
                  onClick={() => onChange({ ...PLACE_FILTERS, bead: p.prefix })}
                  name={
                    <>
                      <CircleDot size={12} className="shrink-0 text-faint" />
                      <span className="truncate">{p.prefix}</span>
                    </>
                  }
                  count={p.sessions}
                  countTitle={`${plural(p.sessions, 'session')} worked on its beads`}
                  usd={p.usd}
                  title={`Beads ${p.prefix}-…: ${p.closed} of ${plural(p.issues, 'bead')} closed; sessions worked on ${plural(p.families, 'family', 'families')} of them.\nThe cost is what these sessions spent on these beads, of ${formatMoney(p.bestUSD)} in all.`}
                />
                {oneRef && prefixOf(one) === p.prefix && (
                  <BeadItem
                    level={1}
                    bead={oneRef}
                    label={oneRef.id}
                    active
                    onClick={() => onChange({ ...PLACE_FILTERS, bead: p.prefix })}
                    sessions={found?.sessions ?? 0}
                    usd={found?.usd ?? 0}
                    title={beadTitle(
                      oneRef,
                      '\nThe sessions that worked on it or a bead below it; click for all of the prefix',
                    )}
                  />
                )}
              </Fragment>
            ))}
          </ul>
        )
      }}
    </QueryBoundary>
  )
}

function beadTitle(b: BeadBrief, extra: string): string {
  return `${b.id}${b.title ? ` — ${b.title}` : ''}\n${b.status ?? 'unknown status'}${extra}`
}

/** A bead in the rail: its title over a line with its id, sessions and cost. */
function BeadItem({
  bead,
  label,
  active,
  onClick,
  sessions,
  usd,
  title,
  level = 0,
}: {
  bead: BeadBrief
  label: string
  active: boolean
  onClick: () => void
  sessions: number
  usd: number
  title: string
  level?: 0 | 1
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'true' : undefined}
        title={title}
        className={cn(
          'flex w-full items-baseline gap-1.5 rounded-card px-2 py-1 text-left hover:bg-surface-2',
          level === 1 ? 'pl-5 text-sec' : 'text-body',
          active && 'bg-accent-soft text-accent hover:bg-accent-soft',
        )}
      >
        <BeadStatus status={bead.status} />
        <span className="min-w-0 flex-1">
          <span className={cn('line-clamp-2 [overflow-wrap:anywhere]', active && 'font-medium')}>
            {bead.title || bead.id}
          </span>
          <span className="flex items-baseline gap-2 text-meta text-muted">
            <span className="min-w-0 truncate font-mono">{label}</span>
            <span className="ml-auto shrink-0">{plural(sessions, 'session')}</span>
            <Money usd={usd} dim className="w-14 shrink-0 text-right" />
          </span>
        </span>
      </button>
    </li>
  )
}
