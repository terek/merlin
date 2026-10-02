// The Cost card. Session-level figures (reported, attributed outside the windows, overhead) are
// labelled by source; everything below the rule is attributed from token counts, said once.

import type { ReactNode } from 'react'
import type { SessionDetail } from '../../api/types'
import { agentCostSplit, sessionCostSegments } from '../../lib/cost'
import { formatPercent } from '../../lib/format'
import { fullTime, parseTime } from '../../lib/time'
import { Bar, type BarTone, Card, ModelName, Money, Tokens } from '../../ui'
import { costSentence, modelRows } from './model'

const SWATCH: Record<string, string> = { reported: 'bg-reported', attributed: 'bg-attributed', overhead: 'bg-overhead' }

const SEGMENT_HINT: Record<string, string> = {
  reported: 'Part of what Claude Code reported: the spend that transcript messages explain',
  overhead: 'Part of what Claude Code reported: spend that no transcript message explains; session level only',
  attributed: 'Spend outside every reported window, recomputed from token counts',
}

function Row({
  swatch,
  label,
  hint,
  children,
}: {
  swatch?: string
  label: ReactNode
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-sec" title={hint}>
      {swatch ? (
        <span aria-hidden className={`size-2 shrink-0 rounded-badge ${swatch}`} />
      ) : (
        <span className="size-2 shrink-0" />
      )}
      <span className="min-w-0 flex-1 text-muted">{label}</span>
      {children}
    </div>
  )
}

export function CostCard({ detail }: { detail: SessionDetail }) {
  const { cost, digest } = detail
  const segments = sessionCostSegments(cost)
  const split = agentCostSplit(digest)
  const models = modelRows(digest.cost.byModel)
  const windows = cost.windows ?? []
  const attributedTotal = split.main + split.agents
  return (
    <Card title="Cost" bodyClassName="space-y-4">
      <div>
        <div className="flex items-baseline gap-2">
          <Money usd={cost.bestUSD} flag={cost.flag} className="text-page" />
        </div>
        <p className="mt-1 text-sec text-muted">{costSentence(cost)}</p>
      </div>

      <div>
        <Bar
          label="Where the best cost comes from"
          segments={segments.map((s) => ({
            value: s.usd,
            tone: s.key as BarTone,
            title: `${s.label}: ${SEGMENT_HINT[s.key]}`,
          }))}
        />
        <div className="mt-2">
          {segments.map((s) => (
            <Row key={s.key} swatch={SWATCH[s.key]} label={s.label} hint={SEGMENT_HINT[s.key]}>
              <Money usd={s.usd} />
            </Row>
          ))}
          {cost.inheritedUSD > 0 && (
            <Row label="Inherited" hint="History copied from another session, already paid for there">
              <Money usd={cost.inheritedUSD} dim />
            </Row>
          )}
        </div>
        {cost.inheritedUSD > 0 && (
          <p className="mt-1 pl-4 text-meta text-faint">Inherited: paid by the parent session, not counted here.</p>
        )}
      </div>

      <div className="space-y-4 border-t border-line pt-3">
        <p className="text-meta uppercase tracking-wide text-faint">Attributed from token counts</p>

        <div>
          <h3 className="mb-1 text-sec text-muted">Main agent and sub-agents</h3>
          <Bar
            label="Main agent versus sub-agents"
            segments={[
              { value: split.main, tone: 'series-1', title: 'Main agent' },
              { value: split.agents, tone: 'series-2', title: 'Sub-agents' },
            ]}
          />
          <div className="mt-2">
            <Row swatch="bg-series-1" label="Main agent">
              <Money usd={split.main} />
              <span className="w-10 text-right text-meta text-faint">{formatPercent(split.main, attributedTotal)}</span>
            </Row>
            <Row swatch="bg-series-2" label="Sub-agents">
              <Money usd={split.agents} />
              <span className="w-10 text-right text-meta text-faint">
                {formatPercent(split.agents, attributedTotal)}
              </span>
            </Row>
          </div>
        </div>

        {models.length > 0 && (
          <div>
            <h3 className="mb-1 text-sec text-muted">By model</h3>
            <table className="w-full border-collapse text-sec">
              <thead>
                <tr className="text-meta text-faint">
                  <th className="pb-1 text-left font-normal">Model</th>
                  <th className="pb-1 text-right font-normal">In</th>
                  <th className="pb-1 text-right font-normal">Out</th>
                  <th className="pb-1 text-right font-normal" title="Cache read">
                    Cache r
                  </th>
                  <th className="pb-1 text-right font-normal" title="Cache write, 5 minute and 1 hour">
                    Cache w
                  </th>
                  <th className="pb-1 pl-2 text-right font-normal">$</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.model} className="border-t border-line">
                    <td className="whitespace-nowrap py-0.5 pr-2" title={m.model}>
                      <ModelName name={m.model} />
                    </td>
                    <td className="text-right">
                      <Tokens n={m.input} />
                    </td>
                    <td className="text-right">
                      <Tokens n={m.output} />
                    </td>
                    <td className="text-right">
                      <Tokens n={m.cacheRead} />
                    </td>
                    <td className="text-right">
                      <Tokens n={m.cacheWrite} />
                    </td>
                    <td className="pl-2 text-right">
                      <Money usd={m.usd} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-meta text-faint">
          Per-turn and per-agent figures on this page are attributed the same way. They explain the session; they are
          not added to the reported figure.
        </p>
      </div>

      {windows.length > 0 && (
        <details className="border-t border-line pt-3">
          <summary className="cursor-pointer text-sec text-muted hover:text-fg">
            Reported windows ({windows.length})
          </summary>
          <ul className="mt-2 space-y-1 text-sec">
            {windows.map((w) => {
              const from = parseTime(w.from)
              const to = parseTime(w.to)
              return (
                <li key={`${w.from}-${w.to}`} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 text-muted">
                    {from ? fullTime(from).slice(4) : w.from} {'→'} {to ? fullTime(to).slice(4) : w.to}
                  </span>
                  <Money usd={w.totalUSD} />
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </Card>
  )
}
