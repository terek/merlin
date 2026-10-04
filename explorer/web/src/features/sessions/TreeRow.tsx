// One tree of linked sessions in the list: the newest session's title and preview, the tree's
// cost and liveness, the whole row a link to the session to resume. A tree of several sessions
// has a toggle that lists them underneath.

import { Bot, ChevronRight, MessageSquare } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useJustChanged } from '../../api/events'
import type { TreeSummary } from '../../api/types'
import { cn } from '../../lib/cn'
import { plural } from '../../lib/format'
import { sessionPath } from '../../lib/paths'
import { isRunning, keyString, promptCount, sessionTitle } from '../../lib/session'
import { Badge, EndStateBadge, Money, ProjectName, RelTime, StateDot } from '../../ui'
import { openMember, treeFlag, treeState } from './model'
import { SessionRow } from './SessionRow'

export function TreeRow({
  tree,
  selected,
  hideProject,
  expanded,
  onToggle,
}: {
  tree: TreeSummary
  selected: boolean
  hideProject: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const s = openMember(tree)
  const flash = useJustChanged(s.key)
  const prompts = promptCount(s)
  const preview = s.recap?.text || s.lastPrompt?.text
  const many = tree.sessions.length > 1
  const titles = new Map(tree.sessions.map((m) => [keyString(m.key), sessionTitle(m)]))
  return (
    <div className="border-b border-line">
      <div
        className={cn(
          'row-fade flex hover:bg-surface-2',
          selected && 'bg-surface-2 shadow-[inset_2px_0_0_var(--accent)]',
          flash && 'flash',
        )}
      >
        {many ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} the ${tree.sessions.length} sessions of this tree`}
            className="flex w-7 shrink-0 justify-center pt-2 text-faint hover:text-fg"
          >
            <ChevronRight size={14} className={cn('transition-transform', expanded && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-7 shrink-0" />
        )}
        <Link
          to={sessionPath(s.key)}
          data-nav-id={keyString(tree.open)}
          aria-current={selected ? 'true' : undefined}
          className="@container block min-w-0 flex-1 py-1.5 pr-3 hover:no-underline"
        >
          <div className="flex min-w-0 items-center gap-2">
            <StateDot state={treeState(tree)} />
            <span
              className="min-w-0 shrink truncate text-body font-medium text-fg [overflow-wrap:anywhere]"
              title={sessionTitle(s)}
            >
              {sessionTitle(s)}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {!isRunning(s.state) && <EndStateBadge endState={s.endState} />}
              {s.kind === 'background' && (
                <Badge title="A background session: nobody typed into it interactively">background</Badge>
              )}
              {s.sourceMissing && (
                <Badge title="The transcript files are gone; the digest is what remains">no source</Badge>
              )}
              {many && (
                <Badge
                  tone="accent"
                  title={`A tree of ${tree.sessions.length} sessions linked by forks and continuations; this row opens the newest`}
                >
                  {plural(tree.sessions.length, 'session')}
                </Badge>
              )}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-3 pl-2 text-sec text-muted">
              {!hideProject && (
                <span className="hidden w-28 truncate @[560px]:block">
                  <ProjectName path={s.project} />
                </span>
              )}
              <span className="hidden w-24 truncate font-mono text-meta @[760px]:block" title={s.branch}>
                {s.branch}
              </span>
              <RelTime time={tree.lastActivityAt} className="w-24 text-right" />
              <span
                className="w-9 text-right"
                title={`${plural(prompts, 'prompt')} typed${many ? ' in the newest session' : ''}`}
              >
                {prompts > 0 && (
                  <>
                    <MessageSquare size={10} className="mr-0.5 inline align-baseline text-faint" />
                    {prompts}
                  </>
                )}
              </span>
              <span
                className="hidden w-9 text-right @[480px]:block"
                title={`${plural(s.agents, 'agent')}${many ? ' in the newest session' : ''}`}
              >
                {s.agents > 0 && (
                  <>
                    <Bot size={11} className="mr-0.5 inline align-baseline text-faint" />
                    {s.agents}
                  </>
                )}
              </span>
              <span title={many ? `The ${tree.sessions.length} sessions of this tree together` : undefined}>
                <Money usd={tree.bestUSD} flag={treeFlag(tree)} className="inline-block w-20 text-right" />
              </span>
            </span>
          </div>
          <div className="flex min-w-0 items-baseline gap-1.5 pl-4 text-sec text-muted">
            {s.recap && (
              <span className="shrink-0 text-meta uppercase tracking-wide text-faint" title="The session's own recap">
                recap
              </span>
            )}
            <span className="min-w-0 truncate" title={preview}>
              {preview ?? (prompts > 0 ? <span className="text-faint">commands only</span> : ' ')}
            </span>
          </div>
        </Link>
      </div>
      {many && expanded && (
        <div className="border-t border-line bg-bg pl-4 [&>a:last-child]:border-b-0">
          {tree.sessions.map((m) => (
            <SessionRow
              key={keyString(m.key)}
              row={{ session: m, level: 1 }}
              selected={false}
              hideProject
              parentTitle={m.lineage.parent ? titles.get(keyString(m.lineage.parent)) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}
