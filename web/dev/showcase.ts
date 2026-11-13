// The showcase session of the mock: one tree that exercises everything the spend graph draws. Three
// calendar days of work (a sparse day, a day with one dense push of forty turns, a day of three
// bursts), a main agent on a frontier model with a detour to another, one-shot sub-agents on cheaper
// models (two launch another), a swarm of 25 short Explore agents in one turn, a teammate sent five
// pieces of work over a day, a fork that starts with its parent's whole context, a warm and a cold
// compaction, cache misses from idle time and from model switches, a prompt typed while a turn ran,
// and a second session forked from the first. The billed messages are written down call by call
// (served by `messagesOf` through `recordedMessages`), and every cost in the digest is summed from them,
// so that tokens, prices and dollars agree. All text is invented; the random stream is its own.

import type { Agent, AgentTurn, Compaction, Cost, InboxMessage, Message, ModelCost, Turn } from '../src/api/types'
import { finishSession, makeRng, PRICE, recordedMessages, type Sess, type Spec } from './gen'

const SEC = 1000
const MIN = 60_000

const OPUS = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-1'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'
const ALIAS: Record<string, string> = { [OPUS]: 'opus', [FABLE]: 'fable', [SONNET]: 'sonnet', [HAIKU]: 'haiku' }

export const SHOWCASE_TITLE = 'showcase: orchestrator with workers, teammates and forks'
export const SHOWCASE_FORK_TITLE = 'showcase: fork that tries the batched writer'
const PROJECT = '/Users/dev/acme/api'

// ---- the script -----------------------------------------------------------------------

/** A piece of an agent's work: a number of calls, the prompt growing to `ctxEnd` tokens. */
interface Piece {
  calls: number
  ctxEnd: number
  /** First piece only: the prompt of the first call (system prompt, tools and the task). */
  ctx0?: number
  gapSec?: [number, number]
  prompt: string
  final: string
  /** A sub-agent this piece launches after one of its calls, and waits for. */
  child?: { call: number; plan: AgentPlan }
}

interface AgentPlan {
  model: string
  type?: string
  name?: string
  desc: string
  role?: 'fork' | 'addressable'
  background?: boolean
  tools?: string[]
  piece: Piece
}

const READ_TOOLS = ['Read', 'Grep', 'Glob']
const WORK_TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write']
/** What every call of an agent reads from the cache before its own task: the system prompt and the tools. */
const PREFIX = 11_000

const HANDLERS = [
  'ingest/fetch',
  'ingest/parse',
  'ingest/normalise',
  'ingest/dedupe',
  'ingest/enrich',
  'ingest/geocode',
  'billing/sync',
  'billing/invoice',
  'billing/refund',
  'billing/tax',
  'billing/export',
  'audit/log',
  'audit/purge',
  'audit/export',
  'notify/email',
  'notify/sms',
  'notify/push',
  'search/index',
  'search/reindex',
  'search/suggest',
  'reports/daily',
  'reports/weekly',
  'reports/export',
  'admin/users',
  'admin/roles',
]

const PLANS: Record<string, AgentPlan> = {
  cron: {
    model: HAIKU,
    type: 'Explore',
    desc: 'List every cron entry and script the ingest job touches',
    tools: READ_TOOLS,
    piece: {
      calls: 3,
      ctx0: 9_500,
      ctxEnd: 14_000,
      prompt: 'List every crontab entry, wrapper script and environment file that the nightly ingest job touches.',
      final:
        'Three entries: the fetcher at 01:10, the loader at 02:00 and a cleanup at 05:30. They share one lock file in /var/run and one env file.',
    },
  },
  flow: {
    model: SONNET,
    type: 'general-purpose',
    desc: 'Trace how a batch moves from the fetcher to the loader',
    tools: READ_TOOLS,
    piece: {
      calls: 7,
      ctx0: 12_000,
      ctxEnd: 38_000,
      gapSec: [10, 28],
      prompt:
        'Follow one batch from the moment the fetcher writes it to the moment the loader commits it. Name every file it passes through and every place it can be lost.',
      final:
        'A batch is a directory of parquet files plus a manifest. The loader reads the manifest, never the directory, so a half-written batch is skipped silently. Flush is called from four places.',
      child: {
        call: 3,
        plan: {
          model: HAIKU,
          type: 'Explore',
          desc: 'Count the call sites of Batch.flush',
          tools: READ_TOOLS,
          piece: {
            calls: 3,
            ctx0: 9_000,
            ctxEnd: 15_500,
            prompt: 'Find every call site of Batch.flush and say which of them run inside a transaction.',
            final: 'Four call sites; only the one in loader/commit.go runs inside a transaction.',
          },
        },
      },
    },
  },
  schema: {
    model: SONNET,
    type: 'Plan',
    desc: 'Draft the queue schema and the retry policy',
    tools: READ_TOOLS,
    piece: {
      calls: 8,
      ctx0: 13_000,
      ctxEnd: 55_000,
      gapSec: [12, 35],
      prompt:
        'Draft the tables for a job queue (jobs, leases, dead letters) and a retry policy with backoff. Keep it small enough to review in ten minutes.',
      final:
        'Three tables. Jobs carry an attempt counter and a visible-after timestamp; a lease is a row with an expiry; after three attempts a job moves to dead letters with its last error. Backoff doubles from 30 seconds.',
    },
  },
  heartbeat: {
    model: SONNET,
    type: 'general-purpose',
    desc: 'Add lease renewal on a heartbeat',
    background: true,
    tools: WORK_TOOLS,
    piece: {
      calls: 12,
      ctx0: 14_000,
      ctxEnd: 80_000,
      gapSec: [12, 40],
      prompt:
        'Implement lease renewal: a goroutine per job that extends the lease every third of its length, and stops when the handler returns.',
      final:
        'Done in queue/heartbeat.go. The renewal stops on context cancel, and a failed renewal cancels the handler. Two tests added; both pass.',
    },
  },
  tests: {
    model: HAIKU,
    type: 'general-purpose',
    desc: 'Run the handler tests and summarise failures',
    tools: ['Bash', 'Read', 'Grep'],
    piece: {
      calls: 5,
      ctx0: 10_000,
      ctxEnd: 25_000,
      prompt: 'Run the handler tests and report each failure in one line with the file and line.',
      final: 'Two failures, both in dates_test.go: the expected value is local time, the handler returns UTC.',
    },
  },
  fork: {
    model: OPUS,
    type: 'general-purpose',
    desc: 'Try batching the writes',
    role: 'fork',
    background: true,
    tools: WORK_TOOLS,
    piece: {
      calls: 7,
      ctxEnd: 0, // set from the parent's context when it starts
      gapSec: [22, 50],
      prompt: 'Try the batched writer in a scratch copy and measure it against one transaction per job.',
      final:
        'Batching 50 jobs per transaction is 3.1 times faster on the sample batch, but a poison job now fails the whole group. It needs a split-and-retry step.',
    },
  },
  load: {
    model: SONNET,
    type: 'general-purpose',
    desc: 'Run the load test and collect the numbers',
    background: true,
    tools: ['Bash', 'Read'],
    piece: {
      calls: 6,
      ctx0: 12_000,
      ctxEnd: 34_000,
      gapSec: [35, 80],
      prompt: 'Run the queue load test at 200 jobs per second for eight minutes and collect latency percentiles.',
      final: 'p50 41 ms, p99 380 ms, no lost jobs. Lease expiry fired 3 times, all recovered.',
    },
  },
  grep: {
    model: HAIKU,
    type: 'Explore',
    desc: 'Find leftover references to the cron wrapper',
    tools: READ_TOOLS,
    piece: {
      calls: 4,
      ctx0: 9_500,
      ctxEnd: 17_000,
      prompt: 'Find every remaining reference to run_ingest.sh in the repository, docs and deploy files included.',
      final: 'Seven references: two in docs, three in deploy/, one in the Makefile, one in a comment.',
    },
  },
  flaky: {
    model: SONNET,
    type: 'general-purpose',
    desc: 'Find why the lease sweep test is flaky',
    tools: WORK_TOOLS,
    piece: {
      calls: 7,
      ctx0: 13_000,
      ctxEnd: 41_000,
      gapSec: [10, 26],
      prompt: 'The lease sweep test fails one run in twenty in CI. Find out why.',
      final: 'The test sleeps for the lease length and races the sweeper tick. A fake clock removes the race.',
    },
  },
  dlq: {
    model: SONNET,
    type: 'code-reviewer',
    desc: 'Review the dead-letter handling',
    tools: READ_TOOLS,
    piece: {
      calls: 7,
      ctx0: 13_000,
      ctxEnd: 48_000,
      gapSec: [8, 20],
      prompt:
        'Review how a job reaches the dead-letter table and how it leaves it. Look for lost errors and double moves.',
      final:
        'Two problems: the last error is overwritten when the move is retried, and requeue from the dead letters resets the attempt counter without a limit.',
      child: {
        call: 3,
        plan: {
          model: HAIKU,
          type: 'Explore',
          desc: 'List every writer to the dead-letter table',
          tools: READ_TOOLS,
          piece: {
            calls: 3,
            ctx0: 9_500,
            ctxEnd: 16_000,
            prompt: 'List every function that inserts into or deletes from dead_letters.',
            final: 'Three: Move, Requeue and the nightly purge.',
          },
        },
      },
    },
  },
  proof: {
    model: HAIKU,
    type: 'general-purpose',
    desc: 'Proofread the runbook',
    tools: ['Read', 'Edit'],
    piece: {
      calls: 3,
      ctx0: 9_800,
      ctxEnd: 15_000,
      prompt: 'Proofread docs/runbook-queue.md for typos and commands that do not match the Makefile.',
      final: 'Four typos fixed; the drain command in step 3 used a flag the CLI does not have.',
    },
  },
  bench: {
    model: SONNET,
    type: 'general-purpose',
    desc: 'Benchmark the batched writer against the per-job writer',
    tools: ['Bash', 'Read', 'Edit'],
    piece: {
      calls: 6,
      ctx0: 12_500,
      ctxEnd: 36_000,
      gapSec: [12, 30],
      prompt: 'Benchmark the batched writer against the per-job writer on the sample batch, three runs each.',
      final: 'Batched: 1.9 s, 2.0 s, 1.9 s. Per job: 5.8 s, 6.1 s, 5.9 s. Memory is flat in both.',
    },
  },
  reviewer: {
    model: SONNET,
    type: 'code-reviewer',
    name: 'reviewer',
    desc: 'Reviews each piece as it lands',
    role: 'addressable',
    tools: READ_TOOLS,
    piece: {
      calls: 6,
      ctx0: 14_000,
      ctxEnd: 34_000,
      gapSec: [12, 28],
      prompt: 'You are the reviewer for the queue worker. First piece: src/queue/lease.go and its tests.',
      final:
        'Two issues in the lease module: a lease can be renewed after it expired, and the sweep never resets the attempt counter. The third note is only style.',
    },
  },
}

/** Later pieces of the teammate: what the main agent sent it, and what it answered. */
const PIECES: Record<string, Piece & { summary: string }> = {
  rev2: {
    summary: 'The worker loop',
    calls: 7,
    ctxEnd: 44_000,
    gapSec: [12, 28],
    prompt: 'Next piece: the worker loop in src/queue/worker.go. Look at the order of ack and lease release.',
    final: 'The ack happens after the lease is released, so a crash in between redelivers a finished job. Swap them.',
  },
  rev3: {
    summary: 'The writers',
    calls: 8,
    ctxEnd: 54_000,
    gapSec: [12, 28],
    prompt: 'The writers group is in. Check the transaction boundaries in src/handlers/writers.',
    final:
      'One writer commits before it acks, which is right, but the invoice writer opens a second transaction inside the first. Fix the nesting.',
  },
  rev4: {
    summary: 'The new tests',
    calls: 6,
    ctxEnd: 62_000,
    gapSec: [12, 28],
    prompt: 'The two missing tests are added. Read them and say if they would have caught the bugs.',
    final: 'Both would have caught them. One test name is misleading (TestLeaseOK checks expiry). Otherwise fine.',
  },
  rev5: {
    summary: 'Open items',
    calls: 5,
    ctxEnd: 68_000,
    gapSec: [12, 28],
    prompt: 'Last piece for today: here is the list of open items. Which of them should block the merge?',
    final: 'Only the rollout checklist blocks the merge. The metric names can follow in a second change.',
  },
}

interface SpawnAt {
  call: number
  /** A key of PLANS, 'swarm', or a key of PIECES (a message to the teammate). */
  key: string
}

interface TurnPlan {
  day: 1 | 2 | 3
  /** 'HH:MM', or 'after:<key>' for a turn that a report starts (peer, task-notification). */
  at: string
  origin?: 'peer' | 'task-notification'
  prompt: string
  final: string
  calls: number
  model?: string
  spawn?: SpawnAt[]
  compact?: { cold: boolean; post: number; summary: string }
  queued?: { afterSec: number; text: string }
  /** Context at the end of the turn, where it is pinned (the rest is interpolated). */
  ctx?: number
  key?: string
}

const h = (
  day: 1 | 2 | 3,
  at: string,
  calls: number,
  prompt: string,
  final: string,
  x: Partial<TurnPlan> = {},
): TurnPlan => ({ day, at, calls, prompt, final, ...x })

const MAIN_PLAN: TurnPlan[] = [
  // ---- day 1: a handful of turns, two short sittings
  h(
    1,
    '09:31',
    4,
    'We want the nightly ingest off cron and onto a queue worker. First work out what runs today and how a batch moves through it.',
    'Three cron entries feed one loader. A batch is a directory plus a manifest, and the loader only trusts the manifest. Say the word and the constraints go into a note.',
    {
      spawn: [
        { call: 0, key: 'cron' },
        { call: 0, key: 'flow' },
      ],
      ctx: 26_000,
    },
  ),
  h(
    1,
    '+',
    3,
    'Good. Write the constraints you found into docs/ingest-queue.md as a short design note.',
    'The note is in docs/ingest-queue.md: five constraints, two open questions (lock file, manifest format).',
  ),
  h(
    1,
    '+',
    3,
    'Have someone draft the queue schema and the retry policy so we can compare it with the note.',
    'The draft has three tables and doubling backoff from 30 seconds. It matches the note except for the lock file, which it drops.',
    { spawn: [{ call: 1, key: 'schema' }] },
  ),
  h(
    1,
    '11:46',
    3,
    'The schema looks right. What happens to a batch that fails three times in a row?',
    'It moves to the dead-letter table with its last error and the attempt count, and stays there until somebody requeues it.',
  ),
  h(
    1,
    '+',
    4,
    'Add a dead-letter table to the plan and say who clears it.',
    'Added. The on-call engineer clears it; the nightly purge only touches rows older than 30 days.',
  ),
  h(
    1,
    '+',
    2,
    'Enough for today. Give me five lines for the ticket.',
    'Ticket text ready: scope, schema, retry policy, dead letters, rollout in two steps.',
    { ctx: 50_000 },
  ),
  // ---- day 2, morning
  h(
    2,
    '09:06',
    4,
    'Picking up the queue worker. Start with the lease and visibility-timeout module.',
    'src/queue/lease.go written: acquire, renew, release and a sweep that returns expired leases to the queue.',
  ),
  h(
    2,
    '+',
    3,
    'Bring in a teammate called reviewer to look at each piece as I land it, and send it the lease module first.',
    'The reviewer is started and has the lease module. I will keep going on the enqueue side meanwhile.',
    { spawn: [{ call: 1, key: 'reviewer' }] },
  ),
  h(
    2,
    'after:reviewer',
    2,
    '',
    'The reviewer found two real issues: a lease can be renewed after it expired, and the sweep never resets the attempt counter. The third note is style.',
    { origin: 'peer' },
  ),
  h(2, '+', 4, 'Fix both, then run the unit tests.', 'Both fixed with tests; 14 pass.'),
  h(
    2,
    '+',
    4,
    'Now the enqueue side: wrap the fetcher output in a job envelope.',
    'Envelope added: source, batch number, checksum, payload path.',
  ),
  h(
    2,
    '+',
    4,
    'Add the idempotency key; derive it from the source file hash and the batch number.',
    'The key is sha256(source hash, batch number), stored with a unique index.',
  ),
  h(2, '+', 2, 'Show me the diff stat.', '9 files changed, 612 insertions, 41 deletions.'),
  h(2, '+', 1, "Fine. I'll be back after lunch.", 'Understood. Everything is saved; nothing is running.', {
    ctx: 96_000,
  }),
  // ---- day 2, the push: 41 turns between 13:05 and 17:00
  h(
    2,
    '13:05',
    5,
    'Back. Next the worker loop: pull a job, take a lease, run the handler, ack.',
    'Loop in src/queue/worker.go. Handlers are looked up by name from a registry.',
  ),
  h(
    2,
    '+',
    4,
    'Move the handler registry out of the loop into its own file, and have a worker add lease renewal on a heartbeat.',
    'Registry moved to registry.go. A worker is adding the heartbeat in the background.',
    { spawn: [{ call: 1, key: 'heartbeat' }] },
  ),
  h(2, '+', 3, 'Send the loop to the reviewer.', 'Sent worker.go and registry.go to the reviewer.', {
    spawn: [{ call: 1, key: 'rev2' }],
  }),
  h(
    2,
    'after:rev2',
    2,
    '',
    'The reviewer says the ack happens after the lease is released. A crash in between would redeliver a finished job.',
    { origin: 'peer' },
  ),
  h(
    2,
    '+',
    4,
    'Take the point about ack ordering and fix it.',
    'Ack now comes first, the release second; a test crashes between the two and sees no redelivery.',
  ),
  h(
    2,
    '+',
    3,
    'Add a metric for lease expiry and one for the dead-letter depth.',
    'Two gauges added and registered next to the existing ones.',
  ),
  h(
    2,
    '+',
    5,
    'How many handlers do we have to port? Survey all of them, one agent each.',
    'All 25 handlers surveyed. 11 only read, 9 write one table, 5 write several. 4 are not safe to run twice.',
    { spawn: [{ call: 1, key: 'swarm' }], key: 'swarm' },
  ),
  h(
    2,
    '+',
    3,
    'Group the results by how they touch the database.',
    'Three groups: readers (11), single-table writers (9), multi-table writers (5).',
  ),
  h(
    2,
    '+',
    4,
    'Start with the group that only reads.',
    'The 11 readers need no transaction at all; they only need the new envelope.',
  ),
  h(
    2,
    '14:04',
    4,
    'Port the first read-only handler as a template.',
    'ingest/fetch ported. The diff is 38 lines and mostly deletions.',
  ),
  h(2, '+', 5, 'Good. Apply the same shape to the next three.', 'Three more ported with the same shape.'),
  h(2, '+', 3, 'Run the handler tests.', 'Running them through an agent; the report follows.', {
    spawn: [{ call: 0, key: 'tests' }],
  }),
  h(
    2,
    '+',
    4,
    'Two of them fail on the date handling. Look at it.',
    'The handlers return UTC, the tests expect local time. I changed the tests, since UTC is the contract.',
  ),
  h(
    2,
    '+',
    4,
    'Now the writers. I am torn between one transaction per job and batching the writes. Try batching in a fork and keep going here with the per-job version.',
    'The fork is trying batching in a scratch copy. Here I am doing the per-job version.',
    { spawn: [{ call: 1, key: 'fork' }], key: 'fork-at', ctx: 146_000 },
  ),
  h(
    2,
    '+',
    3,
    'What did the fork find?',
    'Batching is 3.1 times faster on the sample batch, but a poison job fails the whole group. It would need a split-and-retry step.',
  ),
  h(
    2,
    '+',
    3,
    'Keep the per-job version for now. Note the batching numbers in the design note.',
    'Numbers added under Alternatives. Per-job stays the default.',
  ),
  h(2, '+', 5, 'Port the writers group.', 'Nine single-table writers ported, each in one transaction with the ack.', {
    queued: { afterSec: 35, text: 'Also keep the cron path as a fallback behind a flag.' },
  }),
  h(2, '+', 3, 'Send the writers to the reviewer.', 'Sent the writers directory to the reviewer.', {
    spawn: [{ call: 1, key: 'rev3' }],
  }),
  h(
    2,
    'after:rev3',
    2,
    '',
    'The invoice writer opens a second transaction inside the first. Everything else in the writers is fine.',
    { origin: 'peer' },
  ),
  h(2, '+', 4, 'Fix the transaction boundary it found.', 'The invoice writer now joins the outer transaction.'),
  h(2, '+', 3, 'Run the whole suite and report.', 'Suite green: 212 tests, 41 seconds.'),
  h(
    2,
    '+',
    4,
    'Start the load test in the background and keep porting.',
    'The load test runs in the background. Meanwhile the first multi-table writer is ported.',
    { spawn: [{ call: 0, key: 'load' }], ctx: 168_000 },
  ),
  h(2, '+', 4, 'Now the writers that touch two tables.', 'Two-table writers ported behind one transaction each.', {
    compact: {
      cold: false,
      post: 30_000,
      summary:
        'The work so far: the queue core (jobs, leases, dead letters) is in src/queue; the worker loop acks before it releases the lease; handlers are looked up from a registry; 11 readers and 9 single-table writers are ported with the job envelope; the idempotency key is sha256(source hash, batch number).\n\nDecisions: per-job transactions stay the default, batching is an alternative noted in the design note; dates are UTC.\n\nOpen: the multi-table writers, the cron fallback flag, the rollout checklist.',
    },
    ctx: 36_000,
    key: 'warm-compact',
  }),
  h(
    2,
    'after:load',
    2,
    '',
    'The load test finished: p50 41 ms, p99 380 ms, no lost jobs, three lease expiries, all recovered.',
    { origin: 'task-notification' },
  ),
  h(
    2,
    '15:40',
    2,
    'Is the p99 acceptable?',
    'Yes for the batch window: the job needs minutes, not milliseconds. The expiries are the interesting part.',
  ),
  h(2, '+', 3, 'Write up the numbers next to the design note.', 'A Results section is added to docs/ingest-queue.md.'),
  h(
    2,
    '+',
    5,
    'Port the last group, the ones that call the billing API.',
    'The five billing writers are ported; each calls the API after the commit, not inside it.',
  ),
  h(
    2,
    '+',
    5,
    'Think hard about failure modes: what breaks if two workers ever hold the same lease?',
    'Two holders would both run the handler; the idempotency key makes the second write a no-op, but the second ack would fail. The fence is the lease expiry stored with the job.',
    { model: FABLE, key: 'fable-in' },
  ),
  h(
    2,
    '+',
    4,
    'And if the clock on a worker jumps forward an hour?',
    'It would release its own leases early. Use the database clock for expiry, never the worker clock.',
    { model: FABLE },
  ),
  h(
    2,
    '+',
    4,
    'Write that up as the failure-mode section.',
    'Section added: duplicate holder, clock jump, partial batch, poison job.',
    { model: FABLE },
  ),
  h(
    2,
    '+',
    3,
    'Which of those do we cover with tests today?',
    'Duplicate holder and poison job yes; clock jump and partial batch no.',
    { model: FABLE },
  ),
  h(
    2,
    '+',
    5,
    'Good. Back to routine work: add tests for the two gaps, and find what still points at the cron wrapper.',
    'Two tests added (clock jump, partial batch). Seven leftover references to the wrapper found.',
    { spawn: [{ call: 1, key: 'grep' }], key: 'fable-out' },
  ),
  h(2, '+', 3, 'Send the new tests to the reviewer.', 'Sent.', { spawn: [{ call: 1, key: 'rev4' }] }),
  h(2, 'after:rev4', 2, '', 'Both tests would have caught the bugs. One test name is misleading.', { origin: 'peer' }),
  h(2, '+', 3, 'Apply the nit about naming.', 'Renamed TestLeaseOK to TestLeaseExpiryIsChecked.'),
  h(
    2,
    '+',
    3,
    'Delete the old cron wrapper script.',
    'run_ingest.sh and its crontab line are gone; the seven references are updated.',
  ),
  h(2, '+', 3, 'Run the suite one last time.', 'Green: 216 tests.'),
  h(2, '+', 3, 'Commit it in two pieces: queue core, then handlers.', 'Two commits made on the branch.'),
  h(2, '+', 2, 'Draft the PR description.', 'Description drafted: motivation, design, rollout, risks.'),
  h(
    2,
    '+',
    3,
    'Add a rollout checklist to it.',
    'Checklist added: shadow run, flip one handler group, watch the dead letters, remove the flag.',
  ),
  h(2, '+', 1, "Good. That's the end of the push.", 'Done for now.', { ctx: 118_000 }),
  // ---- day 2, evening
  h(
    2,
    '18:24',
    3,
    'One more thing before I go: what is still open?',
    'Open: the rollout checklist review, the metric names, and the cron fallback flag.',
  ),
  h(2, '+', 3, 'Send the open items list to the reviewer as the last piece for today.', 'Sent the list.', {
    spawn: [{ call: 1, key: 'rev5' }],
  }),
  h(
    2,
    'after:rev5',
    2,
    '',
    'Only the rollout checklist blocks the merge; the metric names can follow in a second change.',
    { origin: 'peer', ctx: 150_000 },
  ),
  // ---- day 3: three bursts
  h(
    3,
    '09:08',
    3,
    'Morning. Where did we land yesterday?',
    'The branch has the queue core, all 25 handlers ported and the failure-mode section. Open: the rollout checklist review.',
    {
      compact: {
        cold: true,
        post: 26_000,
        summary:
          'The branch moves the nightly ingest onto a queue worker. Done: queue core, leases with a database-clock expiry, ack-before-release, 25 handlers ported to the job envelope, a load test (p99 380 ms), failure-mode notes, the cron wrapper removed.\n\nDecisions: per-job transactions by default; batching kept as a documented alternative.\n\nOpen: rollout checklist review, metric names, a fallback flag for the cron path.',
      },
      ctx: 34_000,
      key: 'cold-compact',
    },
  ),
  h(
    3,
    '+',
    3,
    'Open a draft PR with the description we wrote.',
    'Draft PR opened with the description and the checklist.',
  ),
  h(
    3,
    '+',
    4,
    'The CI shows a flaky test in the lease sweep. Look at it.',
    'An agent is on it; the test sleeps for the lease length and races the sweeper tick.',
    { spawn: [{ call: 1, key: 'flaky' }] },
  ),
  h(3, '+', 4, 'Make the test deterministic with a fake clock.', 'The sweep test now uses a fake clock and no sleeps.'),
  h(3, '+', 2, 'Rerun CI.', 'CI green on the second run too.'),
  h(
    3,
    '+',
    2,
    "Reply to the reviewer's last comment on the PR.",
    'Replied: the metric names will follow in a second change.',
  ),
  h(
    3,
    '11:21',
    4,
    'Review the dead-letter handling once more with fresh eyes.',
    'Two problems found: the last error is overwritten on retry, and requeue resets the attempt counter without a limit.',
    { spawn: [{ call: 1, key: 'dlq' }] },
  ),
  h(3, '+', 4, 'Fix what it found.', 'The error is kept per attempt; requeue now has a limit of three.'),
  h(
    3,
    '+',
    3,
    'Add a test for a poison message.',
    'Test added: a message that always fails ends in the dead letters after three attempts.',
  ),
  h(3, '+', 2, 'Run the whole suite.', 'Green: 219 tests.'),
  h(3, '+', 3, 'Merge main into the branch.', 'Merged; one conflict in the config loader.'),
  h(3, '+', 4, 'Resolve the conflict in the config loader.', 'Resolved: both new keys kept, defaults unchanged.'),
  h(
    3,
    '16:41',
    4,
    'Last item: the runbook. Write the page on how to drain and restart the workers.',
    'docs/runbook-queue.md written: drain, restart, requeue, purge.',
  ),
  h(3, '+', 2, 'Add the dashboard links.', 'Links to the queue depth and lease expiry dashboards added.'),
  h(3, '+', 2, 'Shorten the intro.', 'Intro cut from nine lines to three.'),
  h(3, '+', 2, 'Proofread it.', 'An agent proofread it; four typos and one wrong flag fixed.', {
    spawn: [{ call: 0, key: 'proof' }],
  }),
  h(3, '+', 2, 'Link the runbook from the README.', 'Linked under Operations.'),
  h(3, '+', 1, 'Done. Thanks.', 'Done.', { ctx: 96_000 }),
]

/** The forked session: it leaves the main one after the turn keyed 'fork-at'. */
const FORK_PLAN: TurnPlan[] = [
  h(
    3,
    '13:51',
    6,
    'Take the batching idea from the experiment and implement it properly behind a flag.',
    'The batched writer is in src/handlers/batch.go behind INGEST_BATCH=1, with a split-and-retry step for poison jobs.',
    { ctx: 166_000 },
  ),
  h(3, '+', 4, 'Benchmark it against the per-job writer on the sample batch.', 'An agent ran three runs of each.', {
    spawn: [{ call: 1, key: 'bench' }],
  }),
  h(3, '+', 2, 'What is the speedup?', 'About 3 times: 1.9 s against 5.9 s for the sample batch.'),
  h(
    3,
    '+',
    3,
    'Does it change the ordering guarantees?',
    'Within a group, yes: jobs commit together. Across groups, no.',
  ),
  h(
    3,
    '+',
    3,
    'Write the trade-offs into the design note.',
    'Trade-offs written: speed against ordering and poison handling.',
  ),
  h(3, '+', 2, 'Make the flag default off.', 'Default is off; the README mentions the flag.'),
  h(
    3,
    '+',
    1,
    'Stop here; I will decide tomorrow which approach to keep.',
    'Stopped. Both approaches are on their branches.',
    {
      ctx: 184_000,
    },
  ),
]

// ---- the engine -----------------------------------------------------------------------

interface Chain {
  model: string
  /** The prompt of the last call; 0 before the first. */
  ctx: number
  lastAt: number
  /** The next call starts a new prefix (a compaction just rewrote the conversation). */
  fresh?: boolean
}

interface Handle {
  agent: Agent
  chain: Chain
  turns: AgentTurn[]
  end: number
}

const addCost = (c: Cost, model: string, mc: ModelCost) => {
  c.usd += mc.usd
  c.byModel ??= {}
  const cur = c.byModel[model] ?? { usd: 0 }
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const) {
    const v = (cur[k] ?? 0) + (mc[k] ?? 0)
    if (v) cur[k] = v
  }
  cur.usd += mc.usd
  c.byModel[model] = cur
}

const costOf = (messages: Message[]): Cost => {
  const c: Cost = { usd: 0 }
  for (const m of messages)
    addCost(c, m.model, {
      usd: m.usd,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite5m: m.cacheWrite5m,
    })
  return c
}

const iso = (ms: number) => new Date(ms).toISOString()
const byTime = (x: Message, y: Message) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)

/** The two sessions of the showcase; `now` is the mock's clock. */
export function buildShowcase(now: number): { main: Sess; fork: Sess; index: Record<string, number> } {
  const r = makeRng(5511)
  const dayStart = (back: number) => {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - back)
    return d.getTime()
  }
  const days = { 1: dayStart(4), 2: dayStart(3), 3: dayStart(2) }
  const at = (day: 1 | 2 | 3, hhmm: string) => {
    const [hh, mm] = hhmm.split(':').map(Number)
    const d = new Date(days[day])
    d.setHours(hh, mm, 0, 0)
    return d.getTime()
  }
  const mainId = r.uuid()
  const forkId = r.uuid()

  let msgs: Message[] = []
  let seq = 0
  const agents: Agent[] = []
  const handles = new Map<string, Handle>()
  /** Handles by the key of the plan that started them. */
  const byKey = new Map<string, Handle>()
  /** When a piece of a teammate or a background agent ended, by key. */
  const endOf = new Map<string, number>()

  /** One billed call: the prompt grows by `delta`; it reads the cache, or writes everything again after a miss. */
  const call = (
    ch: Chain,
    t: number,
    delta: number,
    out: number,
    o: { model?: string; turn?: number; agentId?: string; agentTurn?: number; prefix?: number },
  ) => {
    const model = o.model ?? ch.model
    const input = r.int(40, 260)
    const first = ch.ctx === 0
    const cold = !first && (t - ch.lastAt >= 5 * MIN || model !== ch.model)
    const total = ch.ctx + Math.max(delta, 600)
    let read = 0
    let write = 0
    if (first || ch.fresh) {
      read = Math.min(o.prefix ?? 0, total - input)
      write = total - input - read
    } else if (cold) {
      write = total - input
    } else {
      read = ch.ctx
      write = total - input - ch.ctx
    }
    const p = PRICE[model]
    const usd = (input * p.in + out * p.out + read * p.cr + write * p.cw) / 1e6
    msgs.push({
      id: `msg_${(seq++).toString(36).padStart(4, '0')}${r.hex(6)}`,
      at: iso(t),
      model,
      agentId: o.agentId,
      turn: o.turn,
      agentTurn: o.agentTurn,
      usd,
      input,
      output: out,
      cacheRead: read,
      cacheWrite5m: write,
    })
    ch.model = model
    ch.ctx = input + read + write
    ch.lastAt = t
    ch.fresh = false
  }

  /** Splits `total` growth over `n` calls, each at least 600. */
  const split = (total: number, n: number) => {
    const w = Array.from({ length: n }, () => 0.4 + r.next())
    const sum = w.reduce((a, b) => a + b, 0)
    return w.map((x) => Math.max(600, Math.round((total * x) / sum)))
  }
  const toolsFor = (names: string[], n: number) => {
    const out: Record<string, number> = {}
    for (let i = 0; i < n; i++) {
      const k = r.pick(names)
      out[k] = (out[k] ?? 0) + 1
    }
    return out
  }

  /** Runs one piece of an agent's work from `startAt`; returns when it stopped. */
  const runPiece = (
    hd: Handle,
    plan: AgentPlan,
    pc: Piece,
    startAt: number,
    rootTurn: number,
    delivered?: InboxMessage,
  ): number => {
    const a = hd.agent
    const k = hd.turns.length
    const [g0, g1] = pc.gapSec ?? [8, 26]
    const first = hd.chain.ctx === 0
    const ctx0 = pc.ctx0 ?? 8_000
    const rest = first ? pc.calls - 1 : pc.calls
    const deltas = split(Math.max(0, pc.ctxEnd - (first ? ctx0 : hd.chain.ctx)), Math.max(1, rest))
    const from = msgs.length
    let t = startAt + r.int(2, 5) * SEC
    let last = t
    for (let j = 0; j < pc.calls; j++) {
      const delta = first && j === 0 ? ctx0 : deltas[first ? j - 1 : j]
      call(hd.chain, t, delta, r.int(120, j === pc.calls - 1 ? 700 : 500), {
        turn: a.spawnTurn,
        agentId: a.id,
        agentTurn: k,
        prefix: PREFIX,
      })
      last = t
      t += r.int(g0, g1) * SEC
      if (pc.child && pc.child.call === j) {
        const child = startAgent(pc.child.plan, last + r.int(2, 4) * SEC, rootTurn, a)
        t = Math.max(t, child.end + r.int(3, 6) * SEC)
      }
    }
    const end = last + r.int(3, 7) * SEC
    const turn: AgentTurn = {
      index: k,
      startedAt: iso(startAt),
      endedAt: iso(end),
      origin: k === 0 ? 'spawn' : 'peer',
      prompt: k === 0 ? pc.prompt : undefined,
      inbox: delivered ? [delivered] : undefined,
      finalText: pc.final,
      rootTurn,
      assistantMessages: pc.calls,
      toolCalls: pc.calls - 1,
      toolsByName: pc.calls > 1 ? toolsFor(plan.tools ?? WORK_TOOLS, pc.calls - 1) : undefined,
      cost: costOf(msgs.slice(from).filter((m) => m.agentId === a.id)),
    }
    hd.turns.push(turn)
    hd.end = end
    a.endedAt = iso(end)
    a.finalText = pc.final
    return end
  }

  /** Creates an agent and runs its first piece. */
  const startAgent = (plan: AgentPlan, startAt: number, rootTurn: number, parent?: Agent, base?: Chain): Handle => {
    const pc = plan.piece
    const agent: Agent = {
      id: `a${r.hex(15)}`,
      kind: 'subagent',
      addressable: plan.role === 'addressable' || undefined,
      inheritsContext: plan.role === 'fork' || undefined,
      name: plan.name,
      agentType: plan.type,
      description: plan.desc,
      model: ALIAS[plan.model],
      parentAgentId: parent?.id ?? null,
      spawnToolUseId: `toolu_${r.hex(12)}`,
      spawnTurn: rootTurn,
      depth: (parent?.depth ?? 0) + 1,
      background: plan.background,
      linkage: 'meta',
      startedAt: iso(startAt),
      endedAt: iso(startAt),
      status: 'completed',
      prompt: pc.prompt,
      assistantMessages: 0,
      toolCalls: 0,
      cost: { usd: 0 },
      subtreeUSD: 0,
    }
    agents.push(agent)
    const hd: Handle = {
      agent,
      chain: base ? { ...base } : { model: plan.model, ctx: 0, lastAt: 0 },
      turns: [],
      end: startAt,
    }
    handles.set(agent.id, hd)
    runPiece(hd, plan, pc, startAt, rootTurn)
    return hd
  }

  /** The context at the end of each turn: pinned values and straight lines between them. */
  const endCtx = (plan: TurnPlan[], start = 14_000): number[] => {
    const pins = plan.flatMap((p, i) => (p.ctx ? [[i, p.ctx] as const] : []))
    const out: number[] = []
    let prev: readonly [number, number] = [-1, start]
    let next = 0
    for (let i = 0; i < plan.length; i++) {
      while (next < pins.length && pins[next][0] < i) next++
      const pin = pins[next]
      if (!pin) {
        out.push(prev[1] + (i - prev[0]) * 3_000)
        continue
      }
      out.push(Math.round(prev[1] + ((pin[1] - prev[1]) * (i - prev[0])) / (pin[0] - prev[0])))
      if (pin[0] === i) prev = pin
    }
    return out
  }

  const compactions: Compaction[] = []
  const compactAgents: Agent[] = []
  const idx: Record<string, number> = {}
  let epoch = 0

  /** Runs a list of turns on the main agent's chain `ch`, numbered from `first`. */
  const runTurns = (plan: TurnPlan[], ch: Chain, first: number, sink: Turn[]) => {
    const ctxs = endCtx(plan, ch.ctx || 14_000)
    plan.forEach((p, n) => {
      const i = first + n
      if (p.key) idx[p.key] = i
      const prev = sink[sink.length - 1]
      const prevEnd = prev ? Date.parse(prev.endedAt ?? '') : 0
      let start: number
      if (p.at.startsWith('after:')) {
        const ended = endOf.get(p.at.slice(6))
        if (ended === undefined) throw new Error(`showcase: turn ${i} waits for ${p.at}, which has not ended`)
        start = Math.max(ended + 8 * SEC, prevEnd + 10 * SEC)
      } else if (p.at === '+') {
        start = prevEnd + r.int(70, 230) * SEC
      } else {
        start = at(p.day, p.at)
        if (prev && start < prevEnd + 5 * SEC)
          throw new Error(`showcase: turn ${i} (${p.at}) starts before turn ${i - 1} ended (${prev.endedAt})`)
      }
      let cursor = start + r.int(4, 9) * SEC
      if (p.compact) {
        const pre = ch.ctx
        const cat = start + 4 * SEC
        const dur = r.int(25, 60) * SEC
        const idle = cat - ch.lastAt
        const cold = idle >= 5 * MIN
        if (cold !== p.compact.cold)
          throw new Error(`showcase: the compaction at turn ${i} is ${cold ? 'cold' : 'warm'}`)
        const out = r.int(2500, 4500)
        const pr = PRICE[OPUS]
        const read = cold ? 0 : pre - 120
        const inp = cold ? pre : 120
        const usd = (inp * pr.in + out * pr.out + read * pr.cr) / 1e6
        const agentId = `acompact${r.hex(9)}`
        msgs.push({
          id: `msg_c${(seq++).toString(36)}${r.hex(6)}`,
          at: iso(cat + dur / 2),
          model: OPUS,
          agentId,
          turn: i,
          usd,
          input: inp,
          output: out,
          cacheRead: read,
        })
        compactions.push({
          at: iso(cat),
          turn: i,
          trigger: 'auto',
          preTokens: pre,
          postTokens: p.compact.post,
          durationMs: dur,
          summary: p.compact.summary,
          call: {
            model: OPUS,
            idleMs: idle,
            cache: cold ? 'cold' : 'warm',
            billing: cold ? 'input' : 'cache-read',
            inputTokens: pre,
            outputTokens: out,
            usd,
            warmUSD: (pre * pr.cr + out * pr.out) / 1e6,
          },
        })
        compactAgents.push({
          id: agentId,
          kind: 'compact',
          model: 'opus',
          parentAgentId: null,
          depth: 1,
          linkage: 'meta',
          startedAt: iso(cat),
          endedAt: iso(cat + dur),
          status: 'completed',
          assistantMessages: 1,
          toolCalls: 0,
          cost: { usd: 0 },
          subtreeUSD: 0,
        })
        ch.ctx = p.compact.post
        ch.fresh = true
        ch.lastAt = cat + dur
        cursor = cat + dur + r.int(3, 6) * SEC
        epoch++
      }
      const deltas = split(Math.max(0, ctxs[n] - ch.ctx), p.calls)
      const spawned: string[] = []
      const toolNames: Record<string, number> = {}
      const bump = (name: string, k = 1) => {
        toolNames[name] = (toolNames[name] ?? 0) + k
      }
      const firstMsg = msgs.length
      let lastCall = cursor
      for (let j = 0; j < p.calls; j++) {
        call(ch, cursor, deltas[j], r.int(150, j === p.calls - 1 ? 1000 : 700), {
          model: p.model ?? OPUS,
          turn: i,
          prefix: 12_000,
        })
        lastCall = cursor
        let next = cursor + r.int(8, 45) * SEC
        for (const sp of (p.spawn ?? []).filter((x) => x.call === j)) {
          const t0 = cursor + r.int(2, 5) * SEC
          if (sp.key === 'swarm') {
            for (const [s, name] of HANDLERS.entries()) {
              const hd = startAgent(
                {
                  model: HAIKU,
                  type: 'Explore',
                  desc: `Survey the ${name} handler`,
                  tools: READ_TOOLS,
                  piece: {
                    calls: r.int(3, 5),
                    ctx0: 9_000 + r.int(600, 1800),
                    ctxEnd: 15_000 + r.int(0, 9_000),
                    gapSec: [5, 20],
                    prompt: `Read the ${name} handler and say which tables it writes and whether it is safe to run twice.`,
                    final: `${name}: writes ${r.pick(['no table', 'one table', 'one table', 'two tables', 'three tables'])}; ${r.pick(['safe', 'safe', 'not safe'])} to run twice.`,
                  },
                },
                t0 + Math.round((s * 13_000) / HANDLERS.length) + r.int(0, 900),
                i,
              )
              spawned.push(hd.agent.id)
              next = Math.max(next, hd.end + r.int(3, 7) * SEC)
            }
            bump('Task', HANDLERS.length)
          } else if (PIECES[sp.key]) {
            const pcs = PIECES[sp.key]
            const rev = byKey.get('reviewer') as Handle
            const msg: InboxMessage = {
              at: iso(t0),
              kind: 'message',
              from: 'team-lead',
              summary: pcs.summary,
              text: pcs.prompt,
            }
            endOf.set(sp.key, runPiece(rev, PLANS.reviewer, pcs, t0, i, msg))
            rev.agent.inbox = [...(rev.agent.inbox ?? []), msg]
            bump('SendMessage')
          } else {
            const plan1 = PLANS[sp.key]
            if (!plan1) throw new Error(`showcase: no plan ${sp.key}`)
            let base: Chain | undefined
            let p1 = plan1
            if (sp.key === 'fork') {
              // a fork starts with its parent's conversation, on the parent's model, and reads its cache
              base = { model: OPUS, ctx: ch.ctx, lastAt: cursor }
              p1 = { ...plan1, piece: { ...plan1.piece, ctxEnd: ch.ctx + 16_000 } }
            }
            const hd = startAgent(p1, t0, i, undefined, base)
            byKey.set(sp.key, hd)
            endOf.set(sp.key, hd.end)
            spawned.push(hd.agent.id)
            bump('Task')
            if (!plan1.background) next = Math.max(next, hd.end + r.int(3, 7) * SEC)
          }
        }
        cursor = next
      }
      const end = lastCall + r.int(5, 14) * SEC
      for (let q = 0; q < p.calls - 1; q++) bump(r.pick(WORK_TOOLS))
      const cost = costOf(msgs.slice(firstMsg).filter((m) => !m.agentId))
      const reviewer = byKey.get('reviewer')?.agent.id
      const inbox: InboxMessage[] | undefined =
        p.origin === 'peer'
          ? [
              {
                at: iso(start),
                kind: 'message',
                from: 'reviewer',
                agentId: reviewer,
                summary: 'Review notes',
                text: p.final,
              },
            ]
          : p.origin === 'task-notification'
            ? [
                {
                  at: iso(start),
                  kind: 'task',
                  taskId: `b${r.hex(6)}`,
                  agentId: byKey.get('load')?.agent.id,
                  status: 'completed',
                  summary: 'Background agent "Run the load test and collect the numbers" completed',
                  text: PLANS.load.piece.final,
                },
              ]
            : undefined
      const tools = Object.values(toolNames).reduce((a, b) => a + b, 0)
      sink.push({
        index: i,
        epoch,
        uuid: r.uuid(),
        startedAt: iso(start),
        endedAt: iso(end),
        durationMs: end - start,
        origin: p.origin ?? 'human',
        userText: p.origin ? '' : p.prompt,
        inbox,
        queued: p.queued
          ? [{ at: iso(start + p.queued.afterSec * SEC), origin: 'human', text: p.queued.text }]
          : undefined,
        finalText: p.final,
        assistantMessages: p.calls,
        toolCalls: tools,
        toolsByName: tools ? toolNames : undefined,
        contextTokens: ch.ctx,
        cost,
        costWithAgents: cost.usd,
        spawned: spawned.length ? spawned : undefined,
      })
    })
  }

  /** Costs, turns and subtree sums of agents, from the messages. */
  const settle = (list: Agent[], turns: Turn[]) => {
    for (const a of list) {
      const mine = msgs.filter((m) => m.agentId === a.id)
      a.cost = costOf(mine)
      a.assistantMessages = mine.length
      a.subtreeUSD = a.cost.usd
      const hd = handles.get(a.id)
      if (!hd) continue
      a.turns = hd.turns
      a.toolCalls = hd.turns.reduce((s, t) => s + t.toolCalls, 0)
      const names: Record<string, number> = {}
      for (const t of hd.turns) for (const [k, v] of Object.entries(t.toolsByName ?? {})) names[k] = (names[k] ?? 0) + v
      a.toolsByName = Object.keys(names).length ? names : undefined
    }
    const byId = new Map(list.map((a) => [a.id, a]))
    for (let k = list.length - 1; k >= 0; k--) {
      const p = list[k].parentAgentId ? byId.get(list[k].parentAgentId as string) : undefined
      if (p) p.subtreeUSD += list[k].subtreeUSD
    }
    for (const t of turns) {
      t.costWithAgents = t.cost.usd
      for (const id of t.spawned ?? []) t.costWithAgents += byId.get(id)?.subtreeUSD ?? 0
    }
  }
  const sumCost = (ts: Turn[], ags: Agent[]) => {
    const c: Cost = { usd: 0 }
    for (const x of [...ts.map((t) => t.cost), ...ags.map((a) => a.cost)])
      for (const [m, mc] of Object.entries(x.byModel ?? {})) addCost(c, m, mc)
    return c
  }

  // ---- the main session
  const turns: Turn[] = []
  const mainChain: Chain = { model: OPUS, ctx: 0, lastAt: 0 }
  runTurns(MAIN_PLAN, mainChain, 0, turns)
  settle([...agents, ...compactAgents], turns)
  const mainAgents = [...agents, ...compactAgents].sort((x, y) => ((x.startedAt ?? '') < (y.startedAt ?? '') ? -1 : 1))
  const main = finishSession(
    r,
    {
      id: mainId,
      project: PROJECT,
      kind: 'interactive',
      start: Date.parse(turns[0].startedAt ?? ''),
      turns: turns.length,
      flag: 'exact',
      endState: 'clean',
      title: SHOWCASE_TITLE,
    } satisfies Spec,
    {
      turns,
      agents: mainAgents,
      compactions,
      dcost: sumCost(turns, mainAgents),
      lastAt: Date.parse(turns[turns.length - 1].endedAt ?? ''),
      now,
    },
  )
  const mainMessages = [...msgs].sort(byTime)
  recordedMessages.set(mainId, mainMessages)

  // ---- the fork: the first turns are the main session's, then its own
  const atTurn = idx['fork-at']
  const k = atTurn + 1
  const copied = turns.slice(0, k).map((t) => structuredClone(t))
  const copiedMsgs = mainMessages.filter((m) => !m.agentId && (m.turn ?? 0) < k && !m.id.startsWith('msg_c'))
  const lastCopied = copiedMsgs[copiedMsgs.length - 1]
  const forkChain: Chain = {
    model: lastCopied.model,
    ctx: (lastCopied.input ?? 0) + (lastCopied.cacheRead ?? 0) + (lastCopied.cacheWrite5m ?? 0),
    lastAt: Date.parse(lastCopied.at),
  }
  msgs = copiedMsgs.map((m) => ({ ...m }))
  epoch = turns[atTurn].epoch
  const before = agents.length
  const own: Turn[] = []
  runTurns(FORK_PLAN, forkChain, k, own)
  const forkAgents = agents.slice(before)
  settle(forkAgents, own)
  const forkTurns = [...copied, ...own]
  const fork = finishSession(
    r,
    {
      id: forkId,
      project: PROJECT,
      kind: 'interactive',
      start: Date.parse(forkTurns[0].startedAt ?? ''),
      turns: forkTurns.length,
      flag: 'exact',
      endState: 'clean',
      title: SHOWCASE_FORK_TITLE,
    } satisfies Spec,
    {
      turns: forkTurns,
      agents: forkAgents,
      compactions: [],
      dcost: sumCost(forkTurns, forkAgents),
      lastAt: Date.parse(own[own.length - 1].endedAt ?? ''),
      now,
    },
    { turns: k, from: main.summary.key },
  )
  fork.parent = { key: main.summary.key, kind: 'fork', atTurn }
  recordedMessages.set(forkId, [...msgs].sort(byTime))
  return { main, fork, index: idx }
}
