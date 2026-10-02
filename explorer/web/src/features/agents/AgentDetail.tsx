import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Agent } from '../../api/types'
import { formatCount } from '../../lib/format'
import { fullTime, parseTime, spanMs, timeOfDay } from '../../lib/time'
import { unwrapMachineText } from '../../lib/wrapper'
import {
  AgentStatusMark,
  Badge,
  Clamp,
  Duration,
  IconButton,
  Id,
  ModelName,
  Money,
  PlainText,
  Prose,
  Tokens,
} from '../../ui'
import { KindIcon } from './AgentRow'
import { agentLabel } from './model'

function Label({ children }: { children: ReactNode }) {
  return <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-muted">{children}</h3>
}

function Time({ at }: { at: string | undefined }) {
  const d = parseTime(at)
  return d ? <time title={fullTime(d)}>{timeOfDay(d)}</time> : <span className="text-faint">{'–'}</span>
}

const linkLabel = (a: Agent) =>
  a.linkage === 'meta' ? '' : a.linkage === 'unresolved' ? 'not tied to a spawn' : `tied by ${a.linkage}`

/** The detail of one agent, under the tree. */
export function AgentDetail({
  agent: a,
  parent,
  spawned,
  subtreeUSD,
  onClose,
  onSelectAgent,
  onSelectTurn,
}: {
  agent: Agent
  /** The spawning agent, when it is in the list. */
  parent: Agent | undefined
  /** Direct children, for a line of "spawned N agents". */
  spawned: Agent[]
  /** Own cost plus descendants, computed from the tree. */
  subtreeUSD: number
  onClose: () => void
  onSelectAgent: (id: string) => void
  onSelectTurn: (index: number) => void
}) {
  const tools = Object.entries(a.toolsByName ?? {}).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
  const models = Object.entries(a.cost.byModel ?? {}).sort((x, y) => y[1].usd - x[1].usd)
  const link = linkLabel(a)
  const prompt = unwrapMachineText(a.prompt ?? '')
  return (
    <div data-testid="agent-detail" className="space-y-3 border-t border-line bg-surface p-3">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <KindIcon kind={a.kind} />
            <span className="font-semibold [overflow-wrap:anywhere]">{agentLabel(a)}</span>
            <Badge>{a.kind}</Badge>
            {a.name && a.agentType && <span className="text-sec text-muted">{a.agentType}</span>}
            {a.background && <Badge title="ran in the background">bg</Badge>}
            <AgentStatusMark status={a.status} />
            {link && (
              <Badge tone={a.linkage === 'unresolved' ? 'warn' : 'neutral'} title="how the agent was tied to its spawn">
                {link}
              </Badge>
            )}
          </div>
          {a.description && <p className="text-sec text-muted [overflow-wrap:anywhere]">{a.description}</p>}
        </div>
        <IconButton label="Close agent detail" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sec">
        <dt className="text-muted">id</dt>
        <dd>
          <Id value={a.id} full className="[overflow-wrap:anywhere]" />
        </dd>
        {a.model && (
          <>
            <dt className="text-muted">model</dt>
            <dd>
              <ModelName name={a.model} />
            </dd>
          </>
        )}
        <dt className="text-muted">ran</dt>
        <dd>
          <Time at={a.startedAt} /> to <Time at={a.endedAt} /> · <Duration ms={spanMs(a.startedAt, a.endedAt)} />
        </dd>
        <dt className="text-muted">spawned</dt>
        <dd className="space-x-2">
          {a.spawnTurn !== undefined ? (
            <button
              type="button"
              onClick={() => onSelectTurn(a.spawnTurn as number)}
              className="text-accent hover:underline"
            >
              in turn {a.spawnTurn}
            </button>
          ) : (
            <span className="text-faint">turn unknown</span>
          )}
          {parent ? (
            <span>
              by{' '}
              <button type="button" onClick={() => onSelectAgent(parent.id)} className="text-accent hover:underline">
                {agentLabel(parent)}
              </button>
            </span>
          ) : (
            <span className="text-muted">{a.parentAgentId === null ? 'by the main agent' : 'parent not listed'}</span>
          )}
        </dd>
        <dt className="text-muted">work</dt>
        <dd>
          {formatCount(a.assistantMessages)} message{a.assistantMessages === 1 ? '' : 's'}, {formatCount(a.toolCalls)}{' '}
          tool call{a.toolCalls === 1 ? '' : 's'}
          {spawned.length > 0 && `, spawned ${spawned.length} agent${spawned.length === 1 ? '' : 's'}`}
        </dd>
      </dl>

      {a.prompt && (
        <div>
          <Label>Prompt{prompt.label ? ` (${prompt.label})` : ''}</Label>
          <PlainText text={prompt.body} lines={6} className="text-sec" />
        </div>
      )}
      {a.finalText ? (
        <div>
          <Label>Final text</Label>
          <Clamp lines={10}>
            <Prose>{a.finalText}</Prose>
          </Clamp>
        </div>
      ) : (
        a.status !== 'completed' && (
          <p className="text-sec text-muted">
            No final text: the agent {a.status === 'killed' ? 'was killed' : 'did not finish'}.
          </p>
        )
      )}

      {a.inbox && a.inbox.length > 0 && (
        <div>
          <Label>Inbox ({a.inbox.length})</Label>
          <ul className="space-y-1.5">
            {a.inbox.map((m) => (
              <li key={`${m.at}${m.text.slice(0, 20)}`} className="rounded-badge bg-surface-2 px-2 py-1 text-sec">
                <div className="text-meta text-muted">
                  <Time at={m.at} />
                  {m.from && <> from {m.from}</>}
                </div>
                <Clamp lines={4}>
                  <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</span>
                </Clamp>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tools.length > 0 && (
        <div>
          <Label>Tools</Label>
          <ul className="flex flex-wrap gap-1">
            {tools.map(([name, n]) => (
              <li key={name}>
                <Badge className="font-mono">
                  {name} <span className="text-fg">{formatCount(n)}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {a.compactions && a.compactions.length > 0 && (
        <div>
          <Label>Compactions ({a.compactions.length})</Label>
          <ul className="space-y-0.5 text-sec">
            {a.compactions.map((c) => (
              <li key={c.at} className="flex items-baseline gap-2">
                <Time at={c.at} />
                <span className="text-muted">{c.trigger ?? 'compaction'}</span>
                <span className="ml-auto font-mono">
                  {c.preTokens !== undefined ? <Tokens n={c.preTokens} /> : '?'}
                  {' → '}
                  {c.postTokens !== undefined ? <Tokens n={c.postTokens} /> : '?'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <Label>Cost by model</Label>
        {models.length === 0 ? (
          <p className="text-sec text-faint">no billed messages</p>
        ) : (
          <table className="w-full text-sec">
            <thead className="text-meta text-muted">
              <tr>
                <th className="text-left font-normal">model</th>
                <th className="text-right font-normal">in</th>
                <th className="text-right font-normal">out</th>
                <th className="text-right font-normal" title="cache read">
                  cache
                </th>
                <th className="text-right font-normal" />
              </tr>
            </thead>
            <tbody>
              {models.map(([m, c]) => (
                <tr key={m}>
                  <td className="truncate pr-2">
                    <ModelName name={m} />
                  </td>
                  <td className="text-right">
                    <Tokens n={c.input ?? 0} dim />
                  </td>
                  <td className="text-right">
                    <Tokens n={c.output ?? 0} dim />
                  </td>
                  <td className="text-right">
                    <Tokens n={c.cacheRead ?? 0} dim />
                  </td>
                  <td className="pl-2 text-right">
                    <Money usd={c.usd} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-1 text-meta text-faint">
          own <Money usd={a.cost.usd} dim className="text-meta" />
          {subtreeUSD - a.cost.usd >= 0.005 && (
            <>
              , with descendants <Money usd={subtreeUSD} dim className="text-meta" />
            </>
          )}
        </p>
      </div>
    </div>
  )
}
