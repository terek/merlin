import { Markdown } from '@/components/Markdown'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/stores/merlin-store'

interface MessageBubbleProps {
  message: ChatMessage
}

const roleStyles: Record<ChatMessage['role'], { label: string; color: string; align: string }> = {
  user: { label: 'you', color: 'text-cyan-400', align: 'ml-auto' },
  assistant: { label: 'clerk', color: 'text-emerald-400', align: '' },
  tool: { label: 'tool', color: 'text-amber-400', align: '' },
  error: { label: 'error', color: 'text-red-400', align: '' },
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const style = roleStyles[message.role]
  const isUser = message.role === 'user'
  const isMarkdown = message.role === 'user' || message.role === 'assistant'

  return (
    <div className={cn('max-w-[80%] space-y-1', style.align)}>
      <span className={cn('text-xs font-medium', style.color)}>{style.label}</span>
      <div
        className={cn(
          'rounded-lg px-4 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'bg-cyan-500/10 border border-cyan-500/20'
            : message.role === 'error'
              ? 'bg-red-500/10 border border-red-500/20'
              : message.role === 'tool'
                ? 'bg-amber-500/10 border border-amber-500/20 font-mono text-xs whitespace-pre-wrap'
                : 'bg-secondary',
        )}
      >
        {isMarkdown ? <Markdown>{message.text}</Markdown> : message.text}
        {!message.done && message.role === 'assistant' && (
          <span className="inline-block ml-1 animate-pulse text-muted-foreground">...</span>
        )}
      </div>
    </div>
  )
}
