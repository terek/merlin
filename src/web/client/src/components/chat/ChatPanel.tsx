import { Bug, MessageSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ChatInput } from '@/components/chat/ChatInput'
import { MessageBubble } from '@/components/chat/MessageBubble'
import { ToolResultView } from '@/components/chat/ToolResultView'
import { ScrollArea } from '@/components/ui/scroll-area'
import { type ChatMessage, useMerlinStore } from '@/stores/merlin-store'

/** Clerk study chat — project-scoped. The store handles loading the active session
 *  on navigation and routes streaming chunks to the matching cwd.
 *
 * Debug toggle (bug icon): inline boxes show what the LLM saw — the system prompt
 * at the top, plus the actual retrieved content behind every tool call rendered
 * with a typed view (task title + concepts, lean-turn summaries, etc.).
 */
export function ChatPanel() {
  const chatMessages = useMerlinStore((s) => s.chatMessages)
  const chatStreaming = useMerlinStore((s) => s.chatStreaming)
  const chatProjectCwd = useMerlinStore((s) => s.chatProjectCwd)
  const chatSystemPrompt = useMerlinStore((s) => s.chatSystemPrompt)
  const sendChatMessage = useMerlinStore((s) => s.sendChatMessage)
  const interruptChat = useMerlinStore((s) => s.interruptChat)
  const projectName = useMerlinStore((s) =>
    s.chatProjectCwd ? (s.model?.projects[s.chatProjectCwd]?.displayName ?? null) : null,
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const [debug, setDebug] = useState(false)

  // Re-scroll on each new message and as streaming chunks accumulate.
  // The deps don't appear in the body but they're what we want to trigger on.
  const lastMessage = chatMessages[chatMessages.length - 1]
  const lastLength = lastMessage?.text.length ?? 0
  const lastResultLength = lastMessage?.result?.length ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are scroll triggers, not body refs
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [chatMessages.length, lastLength, lastResultLength])

  return (
    <div className="flex h-full flex-col">
      {/* Panel header — anchors the chat to its project */}
      <div className="flex items-center gap-2 border-b px-6 py-3">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Clerk · Study</span>
        {projectName && <span className="text-xs text-muted-foreground truncate">{projectName}</span>}
        {chatStreaming && <span className="ml-2 text-xs text-emerald-400 animate-pulse">responding...</span>}
        <button
          type="button"
          onClick={() => setDebug(!debug)}
          title="Toggle debug view (system prompt + retrieved text inline)"
          aria-pressed={debug}
          className={`ml-auto rounded p-1 hover:bg-muted ${debug ? 'text-amber-400' : 'text-muted-foreground'}`}
        >
          <Bug className="h-4 w-4" />
        </button>
      </div>

      {/* Messages */}
      <ScrollArea ref={scrollRef} className="flex-1 px-6 py-4">
        {chatMessages.length === 0 && !debug ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground text-sm">Ask the clerk about this project.</p>
          </div>
        ) : (
          <div className="space-y-4 max-w-4xl">
            {debug && <SystemPromptBox systemPrompt={chatSystemPrompt} />}
            {chatMessages.map((msg, i) => {
              if (debug && msg.role === 'tool') {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only chat log, index is stable
                  <ToolDebugBox key={i} message={msg} />
                )
              }
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only chat log, index is stable
              return <MessageBubble key={i} message={msg} />
            })}
          </div>
        )}
      </ScrollArea>

      {/* Input */}
      <ChatInput
        onSend={sendChatMessage}
        onInterrupt={interruptChat}
        streaming={chatStreaming}
        disabled={!chatProjectCwd}
      />
    </div>
  )
}

// ── Debug-mode inline boxes ──────────────────────────────────────────────────

function SystemPromptBox({ systemPrompt }: { systemPrompt: string | null }) {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-amber-400">system prompt</span>
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2.5">
        {systemPrompt ? (
          <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed font-mono text-foreground/90">
            {systemPrompt}
          </pre>
        ) : (
          <p className="text-xs italic text-muted-foreground">(no snapshot yet)</p>
        )}
      </div>
    </div>
  )
}

function ToolDebugBox({ message }: { message: ChatMessage }) {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-amber-400">{message.text}</span>
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2.5">
        {message.result ? (
          <ToolResultView tool={message.tool} content={message.result} />
        ) : (
          <p className="text-xs italic text-muted-foreground">running…</p>
        )}
      </div>
    </div>
  )
}
