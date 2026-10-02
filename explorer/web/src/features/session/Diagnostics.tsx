import { useState } from 'react'
import type { SessionDetail } from '../../api/types'
import { formatCount } from '../../lib/format'
import { Card } from '../../ui'
import { diagnosticsLines } from './model'

/** The foot of the side panel, collapsed: where the digest came from and what the parser could not read. */
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
