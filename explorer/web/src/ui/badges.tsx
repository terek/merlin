import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AgentStatus, EndState, State, TurnOrigin } from '../api/types'
import { cn } from '../lib/cn'

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  accent: 'bg-accent-soft text-accent',
}

/** A small label. Tones: neutral, ok, warn, bad, accent. */
export function Badge({
  tone = 'neutral',
  children,
  title,
  className,
}: {
  tone?: Tone
  children: ReactNode
  title?: string
  className?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-badge px-1.5 text-meta leading-[18px]',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

const STATE_TITLE: Record<State, string> = {
  busy: 'Running, working',
  idle: 'Running, waiting for input',
  recent: 'Not running; active in the last 10 minutes',
  ended: 'Ended',
}

/**
 * Session liveness: busy is a filled green dot that pulses, idle a hollow green dot, recent a grey
 * dot, ended nothing (an empty slot of the same width keeps titles aligned; `reserve={false}` drops it).
 */
export function StateDot({
  state,
  reserve = true,
  className,
}: {
  state: State
  reserve?: boolean
  className?: string
}) {
  const slot = 'inline-block size-2 shrink-0 rounded-full align-middle'
  if (state === 'ended') return reserve ? <span aria-hidden className={cn(slot, className)} /> : null
  const look =
    state === 'busy' ? 'bg-ok pulse-dot' : state === 'idle' ? 'border-[1.5px] border-ok box-border' : 'bg-faint'
  return <span role="img" aria-label={state} title={STATE_TITLE[state]} className={cn(slot, look, className)} />
}

/** `interrupted` is a red badge, `mid-turn` an amber "stopped mid-turn"; clean and unknown show nothing. */
export function EndStateBadge({ endState }: { endState: EndState | undefined }) {
  if (endState === 'interrupted') return <Badge tone="bad">interrupted</Badge>
  if (endState === 'mid-turn')
    return (
      <Badge tone="warn" title="The transcript stops in the middle of work">
        stopped mid-turn
      </Badge>
    )
  return null
}

/** completed is a check, open an amber "open" (no terminal marker in the files), killed a red "killed". */
export function AgentStatusMark({ status }: { status: AgentStatus }) {
  if (status === 'completed')
    return (
      <span title="completed" className="inline-flex text-ok">
        <Check size={13} aria-label="completed" />
      </span>
    )
  if (status === 'killed') return <Badge tone="bad">killed</Badge>
  return (
    <Badge tone="warn" title="No terminal marker in the files">
      open
    </Badge>
  )
}

/** A turn nobody typed carries a small grey badge with the origin's name; a human turn shows nothing. */
export function OriginBadge({ origin }: { origin: TurnOrigin }) {
  return origin === 'human' ? null : <Badge>{origin}</Badge>
}
