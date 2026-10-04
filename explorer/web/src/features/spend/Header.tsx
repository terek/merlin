// The parts of the Session page around the spend tree: the header, the resume command, the
// banners, the family list and the parser's diagnostics.
import { GitBranch, TriangleAlert } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { useJustChanged } from '../../api/events'
import type { SessionDetail } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatCount, formatMoney, plural } from '../../lib/format'
import { sessionPath } from '../../lib/paths'
import { isRunning, promptCount, sameKey, sessionTitle } from '../../lib/session'
import { fullTime, parseTime, spanMs } from '../../lib/time'
import { Badge, Card, CopyButton, Duration, EndStateBadge, Id, Money, ProjectName, RelTime, StateDot } from '../../ui'
import { diagnosticsLines, familyRows, resumeInfo } from './session'

function Stat({ n, label, title }: { n: ReactNode; label: string; title?: string }) {
  return (
    <span title={title} className="whitespace-nowrap">
      <span className="font-mono text-fg">{n}</span> <span className="text-muted">{label}</span>
    </span>
  )
}

function Dot() {
  return (
    <span aria-hidden className="text-faint">
      {'·'}
    </span>
  )
}

/** What the tree adds up to, for the header. */
export interface TreeStats {
  sessions: number
  /** Claude Code's figure for every session of the tree. */
  bestUSD: number
  /** What the messages on the page add up to. */
  messagesUSD: number
}

export function SessionHeader({ detail, tree }: { detail: SessionDetail; tree: TreeStats }) {
  const { summary, digest, lineage, family } = detail
  const flashing = useJustChanged(summary.key)
  const started = parseTime(summary.startedAt)
  const last = parseTime(summary.lastActivityAt)
  const parentLink = lineage.parent
  const parent = parentLink ? family.members.find((m) => sameKey(m.key, parentLink.parent)) : undefined
  const stats = digest.stats
  const multi = tree.sessions > 1
  const best = multi ? tree.bestUSD : summary.cost.bestUSD
  return (
    <header className={cn('row-fade -mx-2 space-y-1.5 rounded-card px-2 py-1', flashing && 'flash')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StateDot state={summary.state} reserve={false} />
        <h1
          className="line-clamp-2 min-w-0 text-page font-semibold [overflow-wrap:anywhere]"
          title={sessionTitle(summary)}
        >
          {sessionTitle(summary)}
        </h1>
        {/* while it runs, the end state only says the last record is not an answer yet */}
        {!isRunning(summary.state) && <EndStateBadge endState={summary.endState} />}
        {summary.kind !== 'interactive' && <Badge>{summary.kind}</Badge>}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sec text-muted">
        <ProjectName path={summary.project} className="text-fg" />
        {summary.branch && (
          <span className="inline-flex items-center gap-1 font-mono" title="Git branch at the end">
            <GitBranch size={12} aria-hidden />
            {summary.branch}
          </span>
        )}
        <Dot />
        <span title={started ? fullTime(started) : undefined}>
          started <RelTime time={summary.startedAt} />
        </span>
        <Dot />
        <span title={last ? fullTime(last) : undefined}>
          last activity <RelTime time={summary.lastActivityAt} />
        </span>
        <Dot />
        <span title="From the first to the last record">
          wall time <Duration ms={spanMs(summary.startedAt, summary.lastActivityAt)} />
        </span>
        <Dot />
        <Id value={summary.key.id} full className="text-faint" />
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sec">
        <span className="whitespace-nowrap">
          <Money usd={best} flag={multi ? undefined : summary.cost.flag} className="font-semibold" />{' '}
          <span className="text-muted">
            {multi ? `for the ${tree.sessions} sessions of this tree` : 'total'}
            {multi && (
              <>
                {', '}
                <Money usd={detail.cost.ownUSD} dim /> of it in this one
              </>
            )}
          </span>
        </span>
        <Dot />
        <Stat n={formatCount(promptCount(summary))} label={promptCount(summary) === 1 ? 'prompt' : 'prompts'} />
        <Dot />
        <Stat n={formatCount(summary.turns)} label={summary.turns === 1 ? 'turn' : 'turns'} />
        <Dot />
        <Stat n={formatCount(summary.agents)} label={summary.agents === 1 ? 'agent' : 'agents'} />
        <Dot />
        <Stat n={formatCount(stats.toolCalls)} label={stats.toolCalls === 1 ? 'tool call' : 'tool calls'} />
        {!!(stats.linesAdded || stats.linesRemoved) && (
          <>
            <Dot />
            <span className="font-mono whitespace-nowrap" title="Lines added and removed, as the harness counted them">
              <span className="text-ok">+{formatCount(stats.linesAdded ?? 0)}</span>{' '}
              <span className="text-bad">
                {'−'}
                {formatCount(stats.linesRemoved ?? 0)}
              </span>
            </span>
          </>
        )}
      </div>

      {(parentLink || lineage.children.length > 0) && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sec text-muted">
          {parentLink && (
            <span>
              {parentLink.kind === 'fork' ? 'fork of' : 'continues'}{' '}
              <Link to={sessionPath(parentLink.parent)}>{parent?.title || parentLink.parent.id.slice(0, 8)}</Link>
              {lineage.inheritedTurns.length > 0 && (
                <span className="text-faint"> ({plural(lineage.inheritedTurns.length, 'turn')} copied)</span>
              )}
            </span>
          )}
          {lineage.children.map((c) => {
            const m = family.members.find((x) => sameKey(x.key, c.child))
            return (
              <span key={c.child.id}>
                {c.kind === 'fork' ? 'forked in' : 'continued in'}{' '}
                <Link to={sessionPath(c.child)}>{m?.title || c.child.id.slice(0, 8)}</Link>
                {' ›'}
              </span>
            )
          })}
        </div>
      )}

      {Math.abs(best - tree.messagesUSD) >= 0.005 && (
        <p className="text-sec text-muted">
          Claude Code reported {formatMoney(Math.abs(best - tree.messagesUSD))}{' '}
          {best > tree.messagesUSD ? 'more' : 'less'} than the messages on this page add up to (
          {formatMoney(tree.messagesUSD)}).
        </p>
      )}
    </header>
  )
}

export function ResumeBox({ detail }: { detail: SessionDetail }) {
  const r = resumeInfo(detail)
  return (
    <div className="rounded-card border border-line bg-surface">
      {!r.leaf && (
        <div className="border-b border-line bg-warn-soft px-3 py-2 text-sec">
          <p className="text-warn">
            This session was continued in another one. Resume the newest session of the family instead
            {r.leaves.length > 0 ? ':' : ' (see the family below).'}
          </p>
          {r.leaves.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {r.leaves.map((m) => (
                <li key={m.key.id} className="flex flex-wrap items-baseline gap-x-2">
                  <Link to={sessionPath(m.key)} className="[overflow-wrap:anywhere]">
                    {m.title || m.key.id.slice(0, 8)}
                  </Link>
                  <span className="text-muted">
                    <RelTime time={m.lastActivityAt} />
                  </span>
                  <Id value={m.key.id} className="text-faint" />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 text-meta uppercase tracking-wide text-faint">
            {r.leaf ? 'Resume' : 'Resume this session anyway'}
          </div>
          <code className={cn('block whitespace-pre-wrap text-sec [overflow-wrap:anywhere]', !r.leaf && 'text-muted')}>
            {r.command}
          </code>
        </div>
        <CopyButton text={r.command} label="Copy resume command" />
      </div>
    </div>
  )
}

export function Banners({ detail }: { detail: SessionDetail }) {
  const d = detail.digest
  return (
    <>
      {(detail.summary.sourceMissing || d.sourceMissing) && (
        <div
          role="status"
          className="flex gap-2 rounded-card border border-line bg-warn-soft px-3 py-2 text-sec text-warn"
        >
          <TriangleAlert size={16} className="mt-px shrink-0" />
          <span>
            The transcript files of this session are gone. What you see is the digest Merlin kept; it cannot be resumed
            from here.
          </span>
        </div>
      )}
      {d.error && (
        <div
          role="alert"
          className="flex gap-2 rounded-card border border-line bg-bad-soft px-3 py-2 text-sec text-bad"
        >
          <TriangleAlert size={16} className="mt-px shrink-0" />
          <span className="[overflow-wrap:anywhere]">The digest of this session could not be built: {d.error}</span>
        </div>
      )}
    </>
  )
}

/** Every session of the family, with links: where to go next, and which one to resume. */
export function FamilyStrip({ detail }: { detail: SessionDetail }) {
  const rows = familyRows(detail)
  if (rows.length < 2) return null
  return (
    <section aria-label="Family" className="rounded-card border border-line bg-surface">
      <h2 className="border-b border-line px-3 py-1.5 text-body font-semibold">
        Sessions in this tree <span className="font-normal text-muted">({rows.length})</span>
      </h2>
      <ul>
        {rows.map(({ member, depth, current, relation }) => (
          <li
            key={member.key.id}
            aria-current={current ? 'true' : undefined}
            className={cn(
              'flex min-h-8 items-center gap-2 border-b border-line px-3 py-1 text-sec last:border-b-0',
              current && 'bg-accent-soft',
            )}
          >
            <span style={{ paddingLeft: depth * 16 }} className="flex min-w-0 flex-1 items-baseline gap-1.5">
              {depth > 0 && (
                <span aria-hidden className="text-faint">
                  {'└'}
                </span>
              )}
              {current ? (
                <span className="min-w-0 truncate font-semibold" title={member.title}>
                  {member.title || member.key.id.slice(0, 8)}
                </span>
              ) : (
                <Link to={sessionPath(member.key)} className="min-w-0 truncate" title={member.title}>
                  {member.title || member.key.id.slice(0, 8)}
                </Link>
              )}
              {current && <Badge tone="accent">this session</Badge>}
            </span>
            {relation && <Badge>{relation}</Badge>}
            {member.leaf && (
              <Badge tone="ok" title="Nobody continues from this session">
                resume here
              </Badge>
            )}
            <span className="w-20 shrink-0 text-right text-muted">
              <RelTime time={member.lastActivityAt ?? member.startedAt} />
            </span>
            <span className="w-14 shrink-0 text-right">
              <Money usd={member.bestUSD} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Collapsed: where the digest came from and what the parser could not read. */
export function Diagnostics({ detail }: { detail: SessionDetail }) {
  const [open, setOpen] = useState(false)
  const d = detail.digest
  const lines = diagnosticsLines(d.diagnostics)
  return (
    <Card
      title={
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-body font-semibold">
          Diagnostics
          {lines.length > 0 && <span className="ml-2 text-meta font-normal text-warn">{lines.length} to look at</span>}
        </button>
      }
      actions={
        <button type="button" onClick={() => setOpen(!open)} className="text-sec text-accent hover:underline">
          {open ? 'hide' : 'show'}
        </button>
      }
      flush
      className={open ? undefined : '[&>header]:border-b-0'}
      bodyClassName={open ? 'space-y-3 p-3 text-sec' : undefined}
    >
      {open && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">Parser / schema</dt>
            <dd>
              {d.parserVersion} / {d.schemaVersion}
            </dd>
            {d.harnessVersions && d.harnessVersions.length > 0 && (
              <>
                <dt className="text-muted">Harness versions</dt>
                <dd className="font-mono">{d.harnessVersions.join(', ')}</dd>
              </>
            )}
            <dt className="text-muted">Messages billed</dt>
            <dd>{formatCount(detail.messageCount)}</dd>
            {lines.map((l) => (
              <div key={l.label} className="contents">
                <dt className="text-muted">{l.label}</dt>
                <dd className="text-warn [overflow-wrap:anywhere]">{l.value}</dd>
              </div>
            ))}
          </dl>
          {d.error && <p className="text-bad [overflow-wrap:anywhere]">Digest error: {d.error}</p>}
          <div>
            <div className="mb-1 text-muted">Source files ({d.source.length})</div>
            <ul className="space-y-1">
              {d.source.map((f) => (
                <li key={f.path} className="font-mono text-meta [overflow-wrap:anywhere]" title={f.path}>
                  {f.path} <span className="text-faint">{formatCount(f.size)} B</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </Card>
  )
}
