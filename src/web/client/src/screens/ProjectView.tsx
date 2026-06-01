import { FolderOpen } from 'lucide-react'
import { SessionsOverview } from '@/components/project/SessionsOverview'
import type { NavigationFocus } from '@/stores/merlin-store'
import { useMerlinStore } from '@/stores/merlin-store'

export function ProjectView({ focus }: { focus: Extract<NavigationFocus, { level: 'project' }> }) {
  const model = useMerlinStore((s) => s.model)
  const navigate = useMerlinStore((s) => s.navigate)

  const project = model?.projects[focus.cwd] ?? null

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <FolderOpen className="h-10 w-10" />
        <p>Project not found.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Sessions overview (sessions list / timeline, active/archived toggle) */}
      <SessionsOverview
        project={project}
        onSessionClick={(sessionId) => {
          const session = project.sessions.find((s) => s.sessionId === sessionId)
          const sessionCwd = session?.nestedPath ? `${focus.cwd}/${session.nestedPath}` : undefined
          navigate({ level: 'session', cwd: focus.cwd, sessionId, sessionCwd })
        }}
      />
    </div>
  )
}
