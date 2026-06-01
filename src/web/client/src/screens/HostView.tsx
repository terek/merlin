import { Loader2, Play } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { SearchInput } from '@/components/layout/SearchInput'
import { TabGroup } from '@/components/layout/TabGroup'
import { ProjectCard } from '@/components/projects/ProjectCard'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useMerlinStore } from '@/stores/merlin-store'
import type { Project } from '@/types/model'

function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => {
    const aActive = a.activeSessionId ? 1 : 0
    const bActive = b.activeSessionId ? 1 : 0
    if (aActive !== bActive) return bActive - aActive
    const aOrd = a.owner === 'available' ? 2 : 1
    const bOrd = b.owner === 'available' ? 2 : 1
    if (aOrd !== bOrd) return aOrd - bOrd
    return b.lastTimestamp - a.lastTimestamp
  })
}

function matchesSearch(project: Project, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return project.displayName.toLowerCase().includes(needle) || project.cwd.toLowerCase().includes(needle)
}

export function HostView() {
  const filter = useMerlinStore((s) => s.hostFilter)
  const setFilter = useMerlinStore((s) => s.setHostFilter)
  const search = useMerlinStore((s) => s.hostSearch)
  const setSearch = useMerlinStore((s) => s.setHostSearch)
  const model = useMerlinStore((s) => s.model)
  const sendCommand = useMerlinStore((s) => s.sendCommand)
  const navigate = useMerlinStore((s) => s.navigate)
  const processProject = useMerlinStore((s) => s.processProject)
  const processAll = useMerlinStore((s) => s.processAll)
  const deleteProcessing = useMerlinStore((s) => s.deleteProcessing)

  if (!model) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Waiting for data...</p>
      </div>
    )
  }

  const allProjects = Object.values(model.projects)
  const activeProjects = sortProjects(allProjects.filter((p) => !p.archived))
  const archivedProjects = sortProjects(allProjects.filter((p) => p.archived))
  const partition = filter === 'active' ? activeProjects : archivedProjects
  const projects = partition.filter((p) => matchesSearch(p, search))

  // Aggregate processing stats across active projects
  const ppAgg = activeProjects.reduce(
    (acc, p) => {
      if (!p.preprocessing) return acc
      acc.total += p.preprocessing.total
      acc.processed += p.preprocessing.processed
      acc.running += p.preprocessing.running
      acc.error += p.preprocessing.error
      acc.outdated += p.preprocessing.outdated
      acc.missing += p.preprocessing.missing
      return acc
    },
    { total: 0, processed: 0, running: 0, error: 0, outdated: 0, missing: 0 },
  )
  const isRunning = ppAgg.running > 0

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        tabs={
          <TabGroup
            value={filter}
            onChange={setFilter}
            items={[
              { key: 'active', label: 'Active', count: activeProjects.length },
              { key: 'archived', label: 'Archived', count: archivedProjects.length },
            ]}
          />
        }
        search={<SearchInput value={search} onChange={setSearch} placeholder="Search projects..." />}
        stats={
          ppAgg.total > 0 ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {isRunning && <Loader2 className="h-3 w-3 animate-spin text-blue-400" />}
              <span className={ppAgg.processed === ppAgg.total ? 'text-emerald-500' : ''}>
                {ppAgg.processed}/{ppAgg.total}
              </span>
              {ppAgg.error > 0 && <span className="text-red-400">{ppAgg.error} err</span>}
              {ppAgg.outdated > 0 && <span className="text-amber-400">{ppAgg.outdated} stale</span>}
            </div>
          ) : null
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs text-muted-foreground"
            onClick={() => processAll()}
            disabled={isRunning}
          >
            {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Process All
          </Button>
        }
      />

      {/* Projects grid */}
      <ScrollArea className="flex-1 p-6">
        {projects.length === 0 ? (
          <div className="flex h-64 items-center justify-center">
            <p className="text-muted-foreground">
              {search
                ? 'No projects match your search.'
                : filter === 'active'
                  ? 'No active projects.'
                  : 'No archived projects.'}
            </p>
          </div>
        ) : (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 640px), 1fr))' }}
          >
            {projects.map((project) => (
              <ProjectCard
                key={project.cwd}
                project={project}
                onArchive={() =>
                  sendCommand({
                    type: filter === 'active' ? 'archive' : 'unarchive',
                    scope: 'project',
                    id: project.cwd,
                  })
                }
                onCollapse={() =>
                  sendCommand({
                    type: project.collapsed ? 'uncollapse_project' : 'collapse_project',
                    cwd: project.cwd,
                  })
                }
                onChat={() => navigate({ level: 'project', cwd: project.cwd })}
                onProcess={() => processProject(project.cwd)}
                onDelete={() => deleteProcessing(project.cwd)}
                archiveMode={filter}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
