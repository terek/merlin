// The hits of a search, grouped by session. The terms are highlighted as React text nodes, so any
// query text is safe.

import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { SearchResult, SessionList } from '../../api/types'
import { plural } from '../../lib/format'
import { sessionPath, shortId } from '../../lib/paths'
import { keyString } from '../../lib/session'
import { Badge, Highlight, ProjectName, RelTime } from '../../ui'
import { cachedTitles, fieldLabel, groupHits, hitHash, hitPlace } from './model'

export const hitNavId = (index: number) => `hit-${index}`

/** Id and target of every hit, in the order shown (what j / k / Enter walk through). */
export function hitNavItems(result: SearchResult): { id: string; href: string }[] {
  return groupHits(result.hits).flatMap((g) =>
    g.hits.map(({ hit, index }) => ({ id: hitNavId(index), href: sessionPath(hit.session, hitHash(hit)) })),
  )
}

export function SearchResults({
  result,
  query,
  selectedId,
}: {
  result: SearchResult
  query: string
  selectedId: string | null
}) {
  const groups = groupHits(result.hits)
  // "also in" names a session by its title when the session list has it in the cache
  const qc = useQueryClient()
  const titles = cachedTitles(
    qc.getQueriesData<{ pages: SessionList[] }>({ queryKey: ['sessions'] }).flatMap(([, d]) => d?.pages ?? []),
  )
  return (
    <div>
      {groups.map((g) => (
        <section key={`${g.session.harness}/${g.session.id}`} className="border-b border-line pb-1">
          <Link
            to={sessionPath(g.session)}
            className="flex min-w-0 items-baseline gap-3 px-3 pt-2 pb-0.5 hover:underline"
          >
            <span className="min-w-0 flex-1 truncate text-body font-medium text-fg" title={g.title}>
              {g.title || shortId(g.session.id)}
            </span>
            <span className="shrink-0 text-sec text-muted">
              <ProjectName path={g.project} />
            </span>
            <RelTime time={g.at} className="w-24 shrink-0 text-right text-sec text-muted" />
          </Link>
          <ul>
            {g.hits.map(({ hit, index }) => {
              const id = hitNavId(index)
              const hash = hitHash(hit)
              return (
                <li key={id}>
                  <Link
                    to={sessionPath(hit.session, hash)}
                    data-nav-id={id}
                    aria-current={selectedId === id ? 'true' : undefined}
                    className={`flex items-baseline gap-2 py-0.5 pr-3 pl-6 hover:bg-surface-2 ${
                      selectedId === id ? 'bg-surface-2 shadow-[inset_2px_0_0_var(--accent)]' : ''
                    }`}
                  >
                    <Badge className="w-16 shrink-0 justify-center">{fieldLabel(hit.field)}</Badge>
                    <span className="min-w-0 flex-1 text-sec text-fg">
                      <Highlight snippet={hit.snippet} query={query} />
                    </span>
                    {hit.abandoned && (
                      <Badge tone="warn" title="Rewound: not on the path that continued">
                        rewound
                      </Badge>
                    )}
                    {hash && <span className="shrink-0 font-mono text-meta text-faint">{hitPlace(hit)}</span>}
                  </Link>
                  {hit.continuedIn && hit.continuedIn.length > 0 && (
                    <div className="flex flex-wrap gap-x-2 pr-3 pl-[7.5rem] text-meta text-faint">
                      <span>also in ›</span>
                      {hit.continuedIn.slice(0, 4).map((k) => (
                        <Link
                          key={k.id}
                          to={sessionPath(k, hash)}
                          className="max-w-64 truncate text-muted hover:text-accent hover:underline"
                          title={k.id}
                        >
                          {titles.get(keyString(k)) ?? shortId(k.id)}
                        </Link>
                      ))}
                      {hit.continuedIn.length > 4 && <span>and {hit.continuedIn.length - 4} more</span>}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      {result.truncated && (
        <p className="px-3 py-3 text-sec text-muted">
          More than {plural(result.hits.length, 'hit')} match; add a word or pick a project to narrow them down.
        </p>
      )}
    </div>
  )
}
