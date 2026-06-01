import { Group, Panel, Separator } from 'react-resizable-panels'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { Breadcrumb } from '@/components/layout/Breadcrumb'
import { useBridge } from '@/hooks/use-bridge'
import { useUrlSync } from '@/hooks/use-url-sync'
import { HostView } from '@/screens/HostView'
import { ProjectView } from '@/screens/ProjectView'
import { RootView } from '@/screens/RootView'
import { SessionView } from '@/screens/SessionView'
import { useMerlinStore } from '@/stores/merlin-store'

export default function App() {
  useBridge()
  useUrlSync()
  const focus = useMerlinStore((s) => s.focus)
  // Chat is project-scoped; only show it when the user is inside a project or session.
  const showChat = focus.level === 'project' || focus.level === 'session'

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <Breadcrumb />
      <Group direction="horizontal" className="flex-1">
        <Panel defaultSize={showChat ? 60 : 100} minSize={30} id="main-content">
          <main className="h-full overflow-hidden">
            {focus.level === 'root' && <RootView />}
            {focus.level === 'host' && <HostView />}
            {focus.level === 'project' && <ProjectView focus={focus} />}
            {focus.level === 'session' && <SessionView focus={focus} />}
          </main>
        </Panel>

        {showChat && (
          <>
            <Separator className="group relative flex w-2 items-center justify-center">
              <div className="h-full w-px bg-border group-hover:bg-foreground/20 transition-colors" />
              <div className="absolute flex flex-col gap-0.5">
                <div className="w-1 h-6 rounded-full bg-border group-hover:bg-foreground/30 transition-colors" />
              </div>
            </Separator>

            <Panel defaultSize={40} minSize={20} id="chat-panel">
              <ChatPanel />
            </Panel>
          </>
        )}
      </Group>
    </div>
  )
}
