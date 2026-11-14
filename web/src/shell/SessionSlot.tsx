import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { useSession } from '../api/queries'
import { sessionTitle } from '../lib/session'
import { HarnessIcon } from '../ui'
import { lastOverview } from './lastOverview'
import { ShellSlot } from './ShellSlot'

/** The Session page's tools in the bar: back to the Overview as it was left, and the session's title. */
export function SessionSlot() {
  const { harness = '', id = '' } = useParams()
  const { data } = useSession(harness, id)
  const title = data ? sessionTitle(data.summary) : ''
  return (
    <ShellSlot>
      <div className="flex min-w-0 items-center gap-3 text-sec">
        <Link
          to={lastOverview()}
          className="inline-flex shrink-0 items-center gap-1 text-muted hover:text-fg hover:no-underline"
        >
          <ArrowLeft size={13} aria-hidden />
          Overview
        </Link>
        {data && (
          <span className="flex min-w-0 items-center gap-1.5 text-muted" title={title}>
            <HarnessIcon harness={data.summary.key.harness} size={13} />
            <span className="truncate">{title}</span>
          </span>
        )}
      </div>
    </ShellSlot>
  )
}
