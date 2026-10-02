// One session in the list: two lines, the whole row a link.

import { Bot, MessageSquare } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useJustChanged } from '../../api/events'
import type { SessionSummary } from '../../api/types'
import { cn } from '../../lib/cn'
import { plural } from '../../lib/format'
import { sessionPath, shortId } from '../../lib/paths'
import { isRunning, promptCount, sessionTitle } from '../../lib/session'
import { Badge, EndStateBadge, Money, ProjectName, RelTime, StateDot } from '../../ui'
import type { Row } from './model'

/** "fork of ‹title›" / "continues ‹title›" for a session that starts from another one's history. */
function ParentHint({ s, parentTitle }: { s: SessionSummary; parentTitle: string | undefined }) {
  const p = s.lineage.parent
  if (!p) return null
  const what = s.lineage.parentKind === 'fork' ? 'fork of' : 'continues'
  const name = parentTitle || shortId(p.id)
  return (
    <span
      className="min-w-0 max-w-56 shrink truncate text-meta text-faint"
      title={`${what} ${parentTitle ? `“${parentTitle}” ` : ''}${p.id}${s.lineage.inheritedTurns ? `\n${plural(s.lineage.inheritedTurns, 'turn')} copied` : ''}`}
    >
      {what} {name}
    </span>
  )
}

export function SessionRow({
  row,
  selected,
  hideProject,
  parentTitle,
}: {
  row: Row
  selected: boolean
  hideProject: boolean
  parentTitle: string | undefined
}) {
  const s = row.session
  const flash = useJustChanged(s.key)
  const superseded = !s.lineage.leaf
  const prompts = promptCount(s)
  const preview = s.recap?.text || s.lastPrompt?.text
  const id = `${s.key.harness}/${s.key.id}`
  return (
    <Link
      to={sessionPath(s.key)}
      data-nav-id={id}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'row-fade @container block border-b border-line py-1.5 pr-3 pl-3 hover:bg-surface-2',
        row.level === 1 && 'pl-9',
        selected && 'bg-surface-2 shadow-[inset_2px_0_0_var(--accent)]',
        flash && 'flash',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StateDot state={s.state} />
        <span
          className={cn(
            'min-w-0 shrink truncate text-body [overflow-wrap:anywhere]',
            superseded ? 'text-muted' : 'font-medium text-fg',
          )}
          title={sessionTitle(s)}
        >
          {sessionTitle(s)}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {/* while it runs, the end state only says the last record is not an answer yet */}
          {!isRunning(s.state) && <EndStateBadge endState={s.endState} />}
          {s.kind === 'background' && (
            <Badge title="A background session: nobody typed into it interactively">background</Badge>
          )}
          {s.sourceMissing && (
            <Badge title="The transcript files are gone; the digest is what remains">no source</Badge>
          )}
        </span>
        <ParentHint s={s} parentTitle={parentTitle} />
        {superseded && (
          <span
            className="shrink-0 text-meta text-faint"
            title={`${plural(s.lineage.children, 'session')} continue${s.lineage.children === 1 ? 's' : ''} from this one; resume a leaf instead`}
          >
            continued in ›
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-3 pl-2 text-sec text-muted">
          {!hideProject && (
            <span className="hidden w-28 truncate @[560px]:block">
              <ProjectName path={s.project} />
            </span>
          )}
          <span className="hidden w-24 truncate font-mono text-meta @[760px]:block" title={s.branch}>
            {s.branch}
          </span>
          <RelTime time={s.lastActivityAt} className="w-24 text-right" />
          <span className="w-9 text-right" title={`${plural(prompts, 'prompt')} typed`}>
            {prompts > 0 && (
              <>
                <MessageSquare size={10} className="mr-0.5 inline align-baseline text-faint" />
                {prompts}
              </>
            )}
          </span>
          <span className="hidden w-9 text-right @[480px]:block" title={plural(s.agents, 'agent')}>
            {s.agents > 0 && (
              <>
                <Bot size={11} className="mr-0.5 inline align-baseline text-faint" />
                {s.agents}
              </>
            )}
          </span>
          <Money usd={s.cost.bestUSD} flag={s.cost.flag} className="w-20 text-right" />
        </span>
      </div>
      <div
        className={cn('flex min-w-0 items-baseline gap-1.5 pl-4 text-sec', superseded ? 'text-faint' : 'text-muted')}
      >
        {s.recap && (
          <span className="shrink-0 text-meta uppercase tracking-wide text-faint" title="The session's own recap">
            recap
          </span>
        )}
        <span className="min-w-0 truncate" title={preview}>
          {preview ?? (prompts > 0 ? <span className="text-faint">commands only</span> : ' ')}
        </span>
      </div>
    </Link>
  )
}
