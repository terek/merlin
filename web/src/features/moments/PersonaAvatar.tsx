// A persona's drawing with its reaction as a small comment bubble, for the page (the card draws
// its own in SVG), and the persona's head alone (avatars/*-head.webp), small, to mark a moment's
// persona in a list.

import type { MomentPersona, PersonaView } from '../../api/types'
import { cn } from '../../lib/cn'
import borisHead from './avatars/boris-head.webp'
import karpathyHead from './avatars/karpathy-head.webp'
import yeggeHead from './avatars/yegge-head.webp'
import { AVATARS } from './MomentCard'
import { PERSONA_NAMES } from './model'

export function PersonaAvatar({ persona, small }: { persona: PersonaView; small?: boolean }) {
  return (
    <div className={cn('relative shrink-0', small ? 'w-10' : 'w-16')} aria-hidden>
      <img src={AVATARS[persona.id].url} alt="" className={cn('w-auto', small ? 'h-12' : 'h-20')} />
      <span
        className={cn(
          'absolute flex items-center justify-center border border-line bg-surface leading-none',
          small
            ? '-top-1 -right-4 h-6 w-7 rounded-[8px] text-[14px]'
            : '-top-1 -right-3 h-8 w-9 rounded-[10px] text-[20px]',
        )}
      >
        {persona.reaction}
      </span>
    </div>
  )
}

const HEADS: Record<MomentPersona, string> = { karpathy: karpathyHead, boris: borisHead, yegge: yeggeHead }

/** The persona's whole head, no neck and no backdrop, fitted in a `size` pixel square. */
export function PersonaFace({ persona, size = 22 }: { persona: MomentPersona; size?: number }) {
  return (
    <img
      src={HEADS[persona]}
      alt={PERSONA_NAMES[persona]}
      title={PERSONA_NAMES[persona]}
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
    />
  )
}
