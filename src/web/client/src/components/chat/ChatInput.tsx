import { Send, StopCircle } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ChatInputProps {
  onSend: (text: string) => void
  onInterrupt: () => void
  streaming: boolean
  disabled?: boolean
}

export function ChatInput({ onSend, onInterrupt, streaming, disabled }: ChatInputProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = useCallback(() => {
    const text = value.trim()
    if (!text || streaming) return
    onSend(text)
    setValue('')
    inputRef.current?.focus()
  }, [value, streaming, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit],
  )

  return (
    <div className="flex items-center gap-2 border-t px-6 py-3">
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={streaming ? 'Clerk is responding...' : 'Message the clerk...'}
        disabled={streaming || disabled}
        className="flex-1"
        autoFocus
      />
      {streaming ? (
        <Button variant="destructive" size="icon" onClick={onInterrupt} title="Stop">
          <StopCircle className="h-4 w-4" />
        </Button>
      ) : (
        <Button size="icon" onClick={handleSubmit} disabled={!value.trim() || disabled} title="Send">
          <Send className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
