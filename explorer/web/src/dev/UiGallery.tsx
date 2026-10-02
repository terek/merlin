// /dev/ui: every shared primitive in each variant, on one page. It is what to screenshot when
// a primitive changes, in both themes (?theme=light, ?theme=dark).

import { type ReactNode, useState } from 'react'
import { ApiError } from '../api/client'
import type { AgentStatus, CostFlag, State, TurnOrigin } from '../api/types'
import { cn } from '../lib/cn'
import {
  AgentStatusMark,
  Badge,
  Bar,
  Button,
  Card,
  Clamp,
  CopyButton,
  DataTable,
  Duration,
  EmptyState,
  EndStateBadge,
  ErrorState,
  Highlight,
  Id,
  KeyHint,
  ModelName,
  Money,
  OriginBadge,
  PlainText,
  ProjectName,
  Prose,
  RelTime,
  SearchInput,
  Section,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonRows,
  Spinner,
  StateDot,
  Tabs,
  Tokens,
  Tooltip,
} from '../ui'

const LONG = 'The quick brown fox jumps over the lazy dog. '.repeat(14)
const MD = `## A heading

Some **bold**, some _italic_, \`inline code\` and a [link](https://example.com). A very long unbroken string:
\`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\`

- first item
- second item with \`code\`

1. one
2. two

> a quoted remark

| model | input | output |
|---|---:|---:|
| Fable 5.1 | 1,000 | 400 |
| Haiku 4.5 | 4,000 | 200 |

\`\`\`ts
export function veryLongFunctionName(argumentNumberOne: string, argumentNumberTwo: string): string { return argumentNumberOne + argumentNumberTwo }
\`\`\`

<script>alert('raw html is dropped')</script>

![an image](https://example.com/x.png)
`

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4 border-b border-line py-2 last:border-b-0">
      <div className="w-36 shrink-0 pt-0.5 text-sec text-muted">{label}</div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2">{children}</div>
    </div>
  )
}

const TOKENS = [
  ['bg', 'bg-bg'],
  ['surface', 'bg-surface'],
  ['surface-2', 'bg-surface-2'],
  ['line', 'bg-line'],
  ['fg', 'bg-fg'],
  ['muted', 'bg-muted'],
  ['faint', 'bg-faint'],
  ['accent', 'bg-accent'],
  ['ok', 'bg-ok'],
  ['warn', 'bg-warn'],
  ['bad', 'bg-bad'],
  ['reported', 'bg-reported'],
  ['attributed', 'bg-attributed'],
  ['overhead', 'bg-overhead'],
  ['human', 'bg-human'],
  ['machine', 'bg-machine'],
  ['series-1', 'bg-series-1'],
  ['series-2', 'bg-series-2'],
  ['series-3', 'bg-series-3'],
  ['series-4', 'bg-series-4'],
  ['series-5', 'bg-series-5'],
  ['series-other', 'bg-series-other'],
] as const

interface DemoRow {
  name: string
  sessions: number
  usd: number
}

const ROWS: DemoRow[] = [
  { name: 'acme/web', sessions: 41, usd: 41.2 },
  { name: 'acme/api', sessions: 30, usd: 12.02 },
  { name: 'merlin', sessions: 9, usd: 0.42 },
  { name: 'scratch', sessions: 2, usd: 0.004 },
]

export function UiGallery() {
  const [tab, setTab] = useState('a')
  const [seg, setSeg] = useState('30d')
  const [sel, setSel] = useState('b')
  const [q, setQ] = useState('chang.log')
  const now = Date.now()
  const ago = (ms: number) => new Date(now - ms).toISOString()

  return (
    <div className="mx-auto max-w-[1100px] space-y-8 p-6">
      <h1 className="text-page">UI gallery</h1>

      <Section title="Type and tokens">
        <Card>
          <Row label="sizes">
            <span className="text-meta">11 meta</span>
            <span className="text-sec">12 secondary</span>
            <span className="text-body">13 body</span>
            <span className="text-title">15 section</span>
            <span className="text-page">20 page</span>
            <span className="font-mono text-sec">mono 0123456789</span>
          </Row>
          <Row label="text colours">
            <span className="text-fg">fg</span>
            <span className="text-muted">muted</span>
            <span className="text-faint">faint</span>
            <span className="text-accent">accent</span>
            <span className="text-ok">ok</span>
            <span className="text-warn">warn</span>
            <span className="text-bad">bad</span>
          </Row>
          <Row label="swatches">
            {TOKENS.map(([name, cls]) => (
              <span key={name} className="flex items-center gap-1.5 text-sec text-muted">
                <span className={cn('size-4 rounded-badge border border-line', cls)} />
                {name}
              </span>
            ))}
          </Row>
        </Card>
      </Section>

      <Section title="Numbers and times">
        <Card>
          <Row label="Money">
            {[0, 0.004, 0.01, 0.0141, 1.5, 12.345, 99.99, 99.996, 100, 1234.56, 98765.4].map((n) => (
              <Money key={n} usd={n} />
            ))}
          </Row>
          <Row label="Money, flags">
            {(['exact', 'partial', 'estimated'] as CostFlag[]).map((f) => (
              <Money key={f} usd={12.34} flag={f} />
            ))}
            <Money usd={0.003} flag="estimated" />
            <Money usd={0} flag="exact" />
            <Money usd={5.5} dim />
            <span className="text-title">
              <Money usd={4.1} flag="partial" />
            </span>
            <span className="text-page">
              <Money usd={1234.5} flag="exact" />
            </span>
          </Row>
          <Row label="Tokens">
            {[0, 812, 1000, 12345, 123456, 999950, 1234567, 4_200_000_000].map((n) => (
              <Tokens key={n} n={n} />
            ))}
          </Row>
          <Row label="RelTime">
            <RelTime time={ago(10_000)} />
            <RelTime time={ago(3 * 60_000)} />
            <RelTime time={ago(3 * 3_600_000)} />
            <RelTime time={ago(26 * 3_600_000)} />
            <RelTime time={ago(9 * 86_400_000)} />
            <RelTime time={ago(400 * 86_400_000)} />
            <RelTime time={undefined} />
          </Row>
          <Row label="Duration">
            {[0, 850, 12_000, 245_000, 7_980_000].map((n) => (
              <Duration key={n} ms={n} />
            ))}
          </Row>
          <Row label="Names">
            <ProjectName path="/home/dev/acme/web" />
            <ModelName name="claude-fable-5-1" />
            <ModelName name="claude-haiku-4-5-20251001" />
            <ModelName name="(overhead)" />
            <Id value="16161616-0000-4000-8000-000000000001" />
          </Row>
        </Card>
      </Section>

      <Section title="States and badges">
        <Card>
          <Row label="StateDot">
            {(['busy', 'idle', 'recent', 'ended'] as State[]).map((s) => (
              <span key={s} className="flex items-center gap-1.5">
                <StateDot state={s} />
                {s}
              </span>
            ))}
          </Row>
          <Row label="Badge tones">
            {(['neutral', 'ok', 'warn', 'bad', 'accent'] as const).map((t) => (
              <Badge key={t} tone={t}>
                {t}
              </Badge>
            ))}
          </Row>
          <Row label="EndStateBadge">
            <EndStateBadge endState="interrupted" />
            <EndStateBadge endState="mid-turn" />
            <EndStateBadge endState="clean" />
            <span className="text-sec text-faint">(clean shows nothing)</span>
          </Row>
          <Row label="AgentStatusMark">
            {(['completed', 'open', 'killed'] as AgentStatus[]).map((s) => (
              <AgentStatusMark key={s} status={s} />
            ))}
          </Row>
          <Row label="OriginBadge">
            {(
              ['human', 'command', 'task-notification', 'peer', 'scheduled', 'continuation', 'sdk'] as TurnOrigin[]
            ).map((o) => (
              <span key={o} className="flex items-center gap-1.5">
                <OriginBadge origin={o} />
                {o === 'human' && <span className="text-sec text-faint">human: no badge</span>}
              </span>
            ))}
          </Row>
          <Row label="KeyHint">
            <KeyHint>/</KeyHint>
            <KeyHint>Esc</KeyHint>
            <KeyHint>g</KeyHint>
            <KeyHint>Enter</KeyHint>
          </Row>
        </Card>
      </Section>

      <Section title="Text">
        <div className="grid grid-cols-2 gap-4">
          <Card title="PlainText, clamped to 3 lines">
            <PlainText text={`${LONG}\nsecond paragraph`} lines={3} />
          </Card>
          <Card title="PlainText, short and a long unbroken string">
            <PlainText text={`short prompt\n${'x'.repeat(300)}`} />
          </Card>
          <Card title="Clamp, 4 lines of Prose">
            <Clamp lines={4}>
              <Prose>{MD}</Prose>
            </Clamp>
          </Card>
          <Card title="Prose, whole">
            <Prose>{MD}</Prose>
          </Card>
          <Card title="Highlight">
            <Highlight snippet="Write the changelog, then fix chang-log and chang.log (changXlog)" query={q} />
            <div className="mt-2">
              <SearchInput value={q} onChange={setQ} hint="/" label="Query for the highlight" />
            </div>
          </Card>
          <Card title="Copy">
            <div className="flex items-center gap-3">
              <code className="rounded-badge bg-surface-2 px-2 py-1 text-sec">
                cd /home/dev/acme && claude --resume 1616
              </code>
              <CopyButton text="cd /home/dev/acme && claude --resume 1616" />
              <CopyButton text="x">Copy command</CopyButton>
            </div>
          </Card>
        </div>
      </Section>

      <Section title="Bar, Card, DataTable">
        <div className="grid grid-cols-2 gap-4">
          <Card title="Bar">
            <div className="space-y-3">
              <Bar
                segments={[
                  { value: 6.2, tone: 'reported', title: 'Reported' },
                  { value: 1.1, tone: 'attributed', title: 'Attributed' },
                  { value: 0.3, tone: 'overhead', title: 'Overhead' },
                ]}
              />
              <Bar segments={[{ value: 3, tone: 'accent' }]} total={10} />
              <Bar segments={[{ value: 0.001, tone: 'accent' }]} total={100} />
              <Bar segments={[]} />
              <Bar
                height={10}
                segments={(['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-other'] as const).map(
                  (tone, i) => ({ value: 6 - i, tone }),
                )}
              />
            </div>
          </Card>
          <Card title="Card with actions" actions={<Button size="sm">Action</Button>}>
            <p className="text-muted">A bordered surface with a title row.</p>
          </Card>
          <Card title="DataTable (sortable, row link)" flush className="col-span-2">
            <DataTable
              columns={[
                { key: 'name', header: 'Project', cell: (r) => r.name, sortValue: (r) => r.name },
                {
                  key: 'sessions',
                  header: 'Sessions',
                  align: 'right',
                  cell: (r) => r.sessions,
                  sortValue: (r) => r.sessions,
                },
                {
                  key: 'usd',
                  header: 'Cost',
                  align: 'right',
                  cell: (r) => <Money usd={r.usd} />,
                  sortValue: (r) => r.usd,
                },
                {
                  key: 'share',
                  header: 'Share',
                  width: '30%',
                  cell: (r) => <Bar segments={[{ value: r.usd, tone: 'accent' }]} total={53.64} />,
                },
              ]}
              rows={ROWS}
              rowKey={(r) => r.name}
              rowHref={() => '/dev/ui'}
              defaultSort={{ key: 'usd', dir: 'desc' }}
              stickyTop={0}
            />
          </Card>
        </div>
      </Section>

      <Section title="Inputs">
        <Card>
          <Row label="Tabs">
            <Tabs
              label="demo"
              value={tab}
              onChange={setTab}
              items={[
                { id: 'a', label: 'Overview' },
                { id: 'b', label: 'Agents', count: 12 },
                { id: 'c', label: 'Diagnostics' },
              ]}
            />
          </Row>
          <Row label="SegmentedControl">
            <SegmentedControl
              label="range"
              value={seg}
              onChange={setSeg}
              options={[
                { value: '7d', label: '7d' },
                { value: '30d', label: '30d' },
                { value: '90d', label: '90d' },
                { value: 'all', label: 'All' },
              ]}
            />
          </Row>
          <Row label="Select">
            <Select
              label="project"
              value={sel}
              onChange={setSel}
              options={[
                { value: 'a', label: 'All projects' },
                { value: 'b', label: 'acme/web' },
              ]}
            />
          </Row>
          <Row label="SearchInput">
            <SearchInput
              value=""
              onChange={() => {}}
              hint="/"
              placeholder="search prompts, answers, titles"
              className="w-80"
            />
            <SearchInput value="changelog" onChange={() => {}} className="w-80" />
          </Row>
          <Row label="Button">
            <Button>Default</Button>
            <Button variant="primary">Primary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button disabled>Disabled</Button>
            <Button size="sm">Small</Button>
          </Row>
          <Row label="Tooltip">
            <Tooltip text="This is the title attribute">
              <span className="underline decoration-dotted">hover me</span>
            </Tooltip>
          </Row>
        </Card>
      </Section>

      <Section title="Loading, empty, error">
        <div className="grid grid-cols-2 gap-4">
          <Card title="Skeleton, Spinner">
            <div className="space-y-3">
              <Skeleton className="w-1/2" />
              <Skeleton />
              <Spinner />
              <SkeletonRows rows={3} height={32} />
            </div>
          </Card>
          <Card title="EmptyState">
            <EmptyState title="No sessions match">
              Clear the filters, or wait for Claude Code to write a session.
            </EmptyState>
          </Card>
          <Card title="ErrorState (API error)" className="col-span-2">
            <ErrorState
              error={new ApiError(400, 'invalid_parameter', 'limit="0": use a number from 1 to 500')}
              onRetry={() => {}}
            />
          </Card>
        </div>
      </Section>
    </div>
  )
}
