#!/usr/bin/env bun
// Generates explorer/testdata/claude/** and explorer/testdata/README.md.
//
//   bun explorer/testdata/generate.ts
//
// Everything here is invented; no real transcript content is used. The committed output is
// the specification: tests read the files, not this script. The script exists so that ids,
// timestamps, copied records and the hand-computed costs in the README stay consistent.
// It wipes and rewrites testdata/claude and testdata/README.md on every run.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HERE = import.meta.dir
const OUT = join(HERE, 'claude')

type J = Record<string, any>
const pad = (n: number, w: number) => String(n).padStart(w, '0')

// ---------------------------------------------------------------- pricing

// [input, output, cacheRead] in $ per million tokens (transcript-format.md section 8).
const PRICE: Record<string, [number, number, number]> = {
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-4-5-20251001': [1, 5, 0.1],
}
const SON = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-1'
const HAIKU = 'claude-haiku-4-5-20251001'

interface U {
  i: number
  o: number
  cr?: number
  c5?: number
  c1?: number
  fast?: boolean
  web?: number
}
const u = (i: number, o: number, cr = 0, c5 = 0, c1 = 0, x: Partial<U> = {}): U => ({ i, o, cr, c5, c1, ...x })

const usageJson = (x: U): J => ({
  input_tokens: x.i,
  output_tokens: x.o,
  cache_read_input_tokens: x.cr ?? 0,
  cache_creation_input_tokens: (x.c5 ?? 0) + (x.c1 ?? 0),
  cache_creation: { ephemeral_5m_input_tokens: x.c5 ?? 0, ephemeral_1h_input_tokens: x.c1 ?? 0 },
  ...(x.web ? { server_tool_use: { web_search_requests: x.web, web_fetch_requests: 0 } } : {}),
  service_tier: 'standard',
  speed: x.fast ? 'fast' : 'standard',
})

// Money in hundredths of a micro-dollar (integers, so no float noise): tokens * price(h).
const trimNum = (x: number) => String(Number(x.toFixed(8)))
function money(h: number): string {
  let s = (h / 1e8).toFixed(8).replace(/0+$/, '')
  const dec = s.split('.')[1] ?? ''
  if (dec.length < 3) s = s + '0'.repeat(3 - dec.length)
  return '$' + s
}

interface Cost {
  h: number
  terms: string[]
}
function costOf(model: string, x: U): Cost | null {
  const p = PRICE[model]
  if (!p) return null
  const [pi, po, pc] = p
  const mult = x.fast ? 2 : 1
  const rows: [number, string, number][] = [
    [x.i, 'in', pi],
    [x.o, 'out', po],
    [x.cr ?? 0, 'cache-read', pc],
    [x.c5 ?? 0, 'cache-write-5m', pi * 1.25],
    [x.c1 ?? 0, 'cache-write-1h', pi * 2],
  ]
  let h = 0
  const terms: string[] = []
  for (const [tok, label, price] of rows) {
    if (!tok) continue
    const th = tok * Math.round(price * 100)
    h += th
    terms.push(`${tok} ${label} x $${trimNum(price)}/M = ${money(th)}`)
  }
  if (mult === 2) {
    terms.push(`speed fast: x2 (assumed rule)`)
    h *= 2
  }
  return { h, terms }
}

// ---------------------------------------------------------------- ledger

interface Entry {
  id: string
  model: string
  u: U
  ts: string
}
const ledgers = new Map<string, Map<string, Entry>>()
const ledger = (k: string) => {
  if (!ledgers.has(k)) ledgers.set(k, new Map())
  return ledgers.get(k)!
}
const entryCost = (e: Entry) => costOf(e.model, e.u)
const totalH = (k: string) => [...ledger(k).values()].reduce((a, e) => a + (entryCost(e)?.h ?? 0), 0)
const total = (k: string) => money(totalH(k))
function breakdown(k: string): string {
  const out: string[] = []
  for (const e of ledger(k).values()) {
    const c = entryCost(e)
    if (!c) {
      out.push(`- \`${e.id}\` (${e.model}): UNPRICED model, ${e.u.i} in / ${e.u.o} out tokens, cost not computed`)
      continue
    }
    out.push(`- \`${e.id}\` (${e.model}): ${c.terms.join(' + ')} = **${money(c.h)}**`)
  }
  out.push(`- **total ${k}: ${total(k)}**`)
  return out.join('\n')
}

// ---------------------------------------------------------------- ids and time

const sid = (ss: number, v = 1) => `${pad(ss, 2).repeat(4)}-0000-4000-8000-${pad(v, 12)}`
const aid = (ss: number, n: number) => `a${pad(ss, 2)}e0c0de${pad(n, 7)}` // 16 hex chars
const keyOf = (name: string) => `-home-dev-acme-${name}`
const cwdOf = (name: string) => `/home/dev/acme/${name}`
const base = (ss: number) => Date.parse(`2026-09-${pad(ss, 2)}T10:00:00Z`)
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z')

const T = (text: string): J => ({ type: 'text', text })
const TH = (text: string): J => ({ type: 'thinking', thinking: text, signature: 'sig-fixture' })
const TU = (id: string, name: string, input: J): J => ({ type: 'tool_use', id, name, input })

// ---------------------------------------------------------------- file builder

interface PO {
  parent?: string | null
  uuid?: string
  noChain?: boolean
  dt?: number
  env?: J
}
interface FO {
  rel: string
  dir: string
  sid: string
  tag: string
  cwd: string
  branch: string
  ver: string
  entry: string
  agent?: string
  lkey: string
  t: number
}

const FILES: F[] = []
const RAW = new Map<string, string>()

class F {
  lines: string[] = []
  last: string | null = null
  n = 0
  ids = new Set<string>()
  tail = ''
  old = false // older Claude Code: no origin/promptSource on prompts
  t0: number
  rel: string
  dir: string
  sid: string
  tag: string
  cwd: string
  branch: string
  ver: string
  entry: string
  agent?: string
  lkey: string
  t: number

  constructor(o: FO) {
    Object.assign(this, o)
    this.rel = o.rel
    this.dir = o.dir
    this.sid = o.sid
    this.tag = o.tag
    this.cwd = o.cwd
    this.branch = o.branch
    this.ver = o.ver
    this.entry = o.entry
    this.agent = o.agent
    this.lkey = o.lkey
    this.t = o.t
    this.t0 = o.t
    FILES.push(this)
  }
  now() {
    return iso(this.t)
  }
  adv(s = 2) {
    this.t += s * 1000
  }
  at(isoStr: string) {
    this.t = Date.parse(isoStr)
  }
  uid() {
    return `${this.tag}-0000-4000-9000-${pad(++this.n, 12)}`
  }

  rec(r: J, o: PO = {}): string {
    const uuid = o.uuid ?? this.uid()
    const parent = o.parent === undefined ? this.last : o.parent
    const { type, ...rest } = r
    const out: J = {
      type,
      uuid,
      parentUuid: parent,
      isSidechain: !!this.agent,
      ...(this.agent ? { agentId: this.agent } : {}),
      timestamp: this.now(),
      sessionId: this.sid,
      cwd: this.cwd,
      gitBranch: this.branch,
      version: this.ver,
      entrypoint: this.entry,
      ...rest,
      ...(o.env ?? {}),
    }
    this.lines.push(JSON.stringify(out))
    if (!o.noChain) this.last = uuid
    this.adv(o.dt ?? 2)
    return uuid
  }
  /** metadata record: no uuid, no envelope, only sessionId */
  meta(r: J) {
    const { type, ...rest } = r
    this.lines.push(JSON.stringify({ type, ...rest, sessionId: this.sid }))
  }
  user(content: string | J[], o: PO & { origin?: string; src?: string; isMeta?: boolean; extra?: J } = {}): string {
    const extra: J = {}
    if (o.isMeta) extra.isMeta = true
    else if (!this.old) {
      extra.origin = { kind: o.origin ?? 'human' }
      extra.promptSource = o.src ?? 'typed'
    }
    return this.rec({ type: 'user', message: { role: 'user', content }, ...extra, ...(o.extra ?? {}) }, o)
  }
  result(toolUseId: string, content: string | J[], tur?: J, o: PO & { err?: boolean } = {}): string {
    const block: J = { type: 'tool_result', tool_use_id: toolUseId, content }
    if (o.err) block.is_error = true
    return this.rec(
      { type: 'user', message: { role: 'user', content: [block] }, ...(tur ? { toolUseResult: tur } : {}) },
      o,
    )
  }
  asst(
    id: string,
    blocks: J[],
    x: U,
    o: PO & { model?: string; stop?: string | null; noLedger?: boolean; extra?: J; msgExtra?: J } = {},
  ): string {
    const model = o.model ?? SON
    const stop = o.stop !== undefined ? o.stop : blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
    if (!o.noLedger && model !== '<synthetic>') {
      ledger(this.lkey).set(id, { id, model, u: x, ts: this.now() })
    }
    this.ids.add(id)
    return this.rec(
      {
        type: 'assistant',
        requestId: `req_${id}`,
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: blocks,
          stop_reason: stop,
          stop_sequence: null,
          usage: usageJson(x),
          ...(o.msgExtra ?? {}),
        },
        ...(o.extra ?? {}),
      },
      o,
    )
  }
  sys(subtype: string, fields: J, o: PO = {}): string {
    return this.rec({ type: 'system', subtype, ...fields }, o)
  }
  att(text = 'hook ok', o: PO = {}): string {
    return this.rec(
      { type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart', content: text } },
      o,
    )
  }
  turnEnd(durationMs: number, messageCount: number, o: PO = {}): string {
    return this.sys('turn_duration', { durationMs, messageCount }, o)
  }
  boundary(trigger: 'auto' | 'manual', md: J, logicalParentUuid: string | null, o: PO = {}): string {
    return this.sys(
      'compact_boundary',
      {
        content: 'Conversation compacted',
        level: 'info',
        logicalParentUuid,
        compactMetadata: { trigger, ...md },
      },
      { parent: null, ...o },
    )
  }
  summary(text: string, o: PO = {}): string {
    return this.rec(
      {
        type: 'user',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { role: 'user', content: text },
      },
      o,
    )
  }
  /** copy conversation records (those with a uuid) verbatim from another file, rewriting sessionId */
  copyFrom(src: F, from: number, to: number, mut: (r: J) => void = () => {}) {
    for (const line of src.lines.slice(from, to)) {
      const r = JSON.parse(line)
      if (!r.uuid) continue
      r.sessionId = this.sid
      if (this.agent) r.agentId = this.agent
      mut(r)
      this.lines.push(JSON.stringify(r))
      this.last = r.uuid
      if (r.type === 'assistant') this.ids.add(r.message.id)
      this.t = Math.max(this.t, Date.parse(r.timestamp) + 2000)
    }
  }
  tokens(): number {
    let s = 0
    for (const id of this.ids) {
      const e = ledger(this.lkey).get(id)
      if (e) s += e.u.i + e.u.o + (e.u.cr ?? 0) + (e.u.c5 ?? 0) + (e.u.c1 ?? 0)
    }
    return s
  }
  fileH(): number {
    let h = 0
    for (const id of this.ids) {
      const e = ledger(this.lkey).get(id)
      if (e) h += entryCost(e)?.h ?? 0
    }
    return h
  }
}

interface MO {
  v?: number
  ff?: number
  ver?: string
  entry?: string
  branch?: string
  lkey?: string
  off?: number
  projKey?: string
}
function mk(ss: number, name: string, o: MO = {}): F {
  const s = sid(ss, o.v ?? 1)
  const key = o.projKey ?? keyOf(name)
  return new F({
    rel: `projects/${key}/${s}.jsonl`,
    dir: `projects/${key}`,
    sid: s,
    tag: `${pad(ss, 2)}${pad(o.ff ?? 1, 2)}0000`,
    cwd: cwdOf(name),
    branch: o.branch ?? 'main',
    ver: o.ver ?? '2.1.200',
    entry: o.entry ?? 'cli',
    lkey: o.lkey ?? pad(ss, 2),
    t: base(ss) + (o.off ?? 0) * 1000,
  })
}
function sub(p: F, id: string, ff: number): F {
  return new F({
    rel: `${p.dir}/${p.sid}/subagents/agent-${id}.jsonl`,
    dir: p.dir,
    sid: p.sid,
    tag: `${p.tag.slice(0, 2)}${pad(ff, 2)}0000`,
    cwd: p.cwd,
    branch: p.branch,
    ver: p.ver,
    entry: p.entry,
    agent: id,
    lkey: p.lkey,
    t: p.t + 1000,
  })
}
const back = (p: F, c: F) => {
  p.t = Math.max(p.t, c.t + 1000)
}
function writeMeta(a: F, m: J) {
  RAW.set(a.rel.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(m, null, 2) + '\n')
}
function completed(a: F, agentType: string, text: string): J {
  return {
    status: 'completed',
    agentId: a.agent,
    agentType,
    content: [T(text)],
    totalTokens: a.tokens(),
    totalDurationMs: a.t - a.t0,
    totalToolUseCount: a.lines.filter((l) => l.includes('"tool_use"')).length,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}
const edit = (file: string): J => ({ file_path: `/home/dev/acme/${file}`, old_string: '', new_string: 'export {}' })

// ================================================================ 01 plain
{
  const f = mk(1, 'plain')
  f.user('add a login page')
  f.att()
  f.asst(
    'msg_plain_01',
    [TU('toolu_plain_01', 'Read', { file_path: '/home/dev/acme/plain/routes.ts' })],
    u(1000, 100, 0, 0, 2000),
  )
  f.result('toolu_plain_01', 'export const routes = []', {
    type: 'text',
    file: { filePath: '/home/dev/acme/plain/routes.ts', numLines: 1 },
  })
  f.asst('msg_plain_02', [TU('toolu_plain_02', 'Edit', edit('plain/login.tsx'))], u(100, 200, 2000, 0, 500))
  f.result('toolu_plain_02', 'File updated', { type: 'update', filePath: '/home/dev/acme/plain/login.tsx' })
  f.asst('msg_plain_03', [T('Done, 3 files changed')], u(100, 50, 2500))
  f.turnEnd(12000, 6)
  f.meta({ type: 'ai-title', aiTitle: 'Add login page' })
  f.user('now add a logout button')
  f.asst('msg_plain_04', [TU('toolu_plain_03', 'Edit', edit('plain/logout.tsx'))], u(100, 150, 3000, 0, 200))
  f.result('toolu_plain_03', 'File updated', { type: 'update', filePath: '/home/dev/acme/plain/logout.tsx' })
  f.asst('msg_plain_05', [T('Logout button added')], u(100, 50, 3200))
  f.turnEnd(8000, 4)
  f.meta({ type: 'last-prompt', lastPrompt: 'now add a logout button', leafUuid: f.last })
}

// ================================================================ 02 multi-line message
{
  const f = mk(2, 'multi-line')
  f.user('list the exported functions in utils.ts')
  f.asst('msg_multi_01', [TH('The user wants the exports of utils.ts.')], u(1000, 10, 0, 0, 2000), { stop: null })
  f.asst('msg_multi_01', [T('Let me look at the file.')], u(1000, 60, 0, 0, 2000), { stop: null })
  f.asst(
    'msg_multi_01',
    [TU('toolu_multi_01', 'Read', { file_path: '/home/dev/acme/multi-line/utils.ts' })],
    u(1000, 120, 0, 0, 2000),
  )
  f.result('toolu_multi_01', 'export const slugify = 1\nexport const clamp = 2', {
    type: 'text',
    file: { filePath: '/home/dev/acme/multi-line/utils.ts', numLines: 2 },
  })
  f.asst('msg_multi_02', [T('utils.ts exports two functions:')], u(100, 30, 3000, 0, 100), { stop: null })
  f.asst('msg_multi_02', [T('slugify and clamp.')], u(100, 45, 3000, 0, 100))
  f.turnEnd(7000, 6)
}

// ================================================================ 03 slash commands, titles
{
  const f = mk(3, 'slash', { ver: '2.1.150' })
  f.old = true
  f.user('<local-command-caveat>Caveat: local command output follows; do not respond to it.</local-command-caveat>', {
    isMeta: true,
  })
  f.user(
    '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>',
  )
  f.user('<local-command-stdout>Set model to sonnet</local-command-stdout>')
  f.user('add a logout button')
  f.asst('msg_slash_01', [T('Added the logout button.')], u(1000, 80, 0, 0, 2000))
  f.turnEnd(5000, 2)
  f.meta({ type: 'ai-title', aiTitle: 'Logout button task' })
  f.meta({ type: 'custom-title', customTitle: 'My logout work' })
  f.user(
    '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>the login page</command-args>',
  )
  f.asst('msg_slash_02', [T('Review: the login page looks fine.')], u(100, 60, 2000, 0, 300))
  f.turnEnd(4000, 2)
  f.user('<bash-input>ls src</bash-input>')
  f.user('<bash-stdout>login.tsx\nlogout.tsx</bash-stdout><bash-stderr></bash-stderr>')
  f.meta({ type: 'ai-title', aiTitle: 'Logout and review' }) // later ai-title; the custom title must still win
}

// ================================================================ 04 interruption
{
  const f = mk(4, 'interrupt')
  f.user('refactor the router')
  f.asst('msg_int_01', [T('Starting the refactor of router.ts.')], u(1000, 40, 0, 0, 2000), { stop: null })
  f.user('[Request interrupted by user]') // bare, string form: previous turn interrupted, not a turn
  f.user('actually, rename router.ts to routes.ts')
  f.asst('msg_int_02', [TU('toolu_int_01', 'Bash', { command: 'mv router.ts routes.ts' })], u(100, 80, 2000, 0, 300))
  f.result('toolu_int_01', '', { stdout: '', stderr: '' })
  f.asst('msg_int_03', [T('Renamed router.ts to routes.ts')], u(100, 30, 2400))
  f.turnEnd(6000, 4)
  f.user('add tests for routes.ts')
  f.asst('msg_int_04', [TU('toolu_int_02', 'Bash', { command: 'bun test' })], u(100, 60, 2500, 0, 100))
  f.result('toolu_int_02', 'The user does not want to proceed with this tool use.', undefined, { err: true })
  f.user([T('[Request interrupted by user for tool use]')]) // bare, array form
  f.user('use the built-in runner instead') // the prompt after the marker
  f.asst('msg_int_05', [T('Added routes.test.ts using the built-in runner')], u(100, 50, 2700))
  f.turnEnd(5000, 2)
  f.user('rename routes.ts to paths.ts')
  f.asst('msg_int_06', [T('Renaming now')], u(100, 20, 2800), { stop: null })
  f.user([T('[Request interrupted by user]'), T('stop, keep the old name')]) // marker + new text in one record
  f.asst('msg_int_07', [T('Okay, keeping routes.ts')], u(100, 20, 2900))
  f.turnEnd(3000, 2)
  f.user('add a changelog entry')
  f.asst('msg_int_08', [T('Drafting the entry')], u(100, 20, 3000), { stop: null })
  f.user('[Request interrupted by user]use tabs not spaces') // marker prefix + new text in one string
  f.asst('msg_int_09', [T('Switched to tabs')], u(100, 20, 3100))
  f.turnEnd(3000, 2)
}

// ================================================================ 05 compaction
const SUMMARY = (what: string) =>
  `This session is being continued from a previous conversation that ran out of context.\nSummary:\n${what}`
{
  // 05a: two boundary+summary pairs, turns before / between / after
  const f = mk(5, 's05-compaction', { v: 1, ff: 1, lkey: '05a' })
  f.user('set up the database layer')
  f.asst(
    'msg_cmpa_01',
    [TU('toolu_cmpa_01', 'Write', { file_path: '/home/dev/acme/s05-compaction/db.ts', content: 'export {}' })],
    u(1000, 100, 0, 0, 2000),
  )
  f.result('toolu_cmpa_01', 'File created', { type: 'create' })
  f.asst('msg_cmpa_02', [T('Database layer created')], u(100, 40, 2000, 0, 500))
  f.turnEnd(6000, 4)
  f.user('add migrations')
  const lastBefore1 = f.asst('msg_cmpa_03', [T('Migrations added')], u(100, 40, 2500, 0, 100))
  f.turnEnd(4000, 2)
  const head = f.last!
  f.boundary(
    'auto',
    {
      preTokens: 150000,
      postTokens: 12000,
      durationMs: 8000,
      cumulativeDroppedTokens: 138000,
      preservedSegment: { headUuid: lastBefore1, anchorUuid: lastBefore1, tailUuid: head },
    },
    head,
  ) // logicalParentUuid resolves
  f.summary(SUMMARY('The database layer and migrations exist.'))
  f.user('add seed data')
  f.asst('msg_cmpa_04', [T('Seed data added')], u(100, 30, 1500, 0, 100))
  const tail2 = f.turnEnd(3000, 2)
  void tail2
  f.boundary('manual', { preTokens: 90000, durationMs: 5000 }, '05010000-ffff-4000-9000-000000000999') // no postTokens; logicalParentUuid not in file
  f.att('compaction hook') // summary lands at +2
  f.summary(SUMMARY('Seed data was added after the first compaction.'))
  f.user('add an index on email')
  f.asst('msg_cmpa_05', [T('Index added')], u(100, 30, 1800, 0, 100))
  f.turnEnd(3000, 2)
}
{
  // 05b: file BEGINS with boundary + summary
  const f = mk(5, 's05-compaction', { v: 2, ff: 2, lkey: '05b' })
  f.boundary('manual', { preTokens: 70000, postTokens: 9000, durationMs: 4000 }, '05020000-ffff-4000-9000-000000000888')
  f.summary(SUMMARY('A repository layer was planned in an earlier session.'))
  f.user('continue with the repository layer')
  f.asst('msg_cmpb_01', [T('Repository layer continued')], u(500, 60, 0, 0, 1000))
  f.turnEnd(3000, 2)
}
{
  // 05c: a later record repeats an earlier uuid and must be skipped
  const f = mk(5, 's05-compaction', { v: 3, ff: 3, lkey: '05c' })
  const p1 = f.user('add a cache layer')
  const a1 = f.asst('msg_cmpc_01', [T('Cache layer added')], u(1000, 50, 0, 0, 2000))
  f.turnEnd(3000, 2)
  f.user('add cache expiry')
  f.asst('msg_cmpc_02', [T('Expiry added')], u(100, 40, 2000, 0, 100))
  f.turnEnd(3000, 2)
  f.user('DUPLICATE PROMPT (must be skipped)', { uuid: p1, noChain: true })
  f.asst('msg_cmpc_dup', [T('DUPLICATE ASSISTANT (must be skipped)')], u(90000, 9000), {
    uuid: a1,
    noChain: true,
    noLedger: true,
  })
}
{
  // 05d: a subagent file that compacts
  const f = mk(5, 's05-compaction', { v: 4, ff: 4, lkey: '05d' })
  f.user('audit every module')
  f.asst(
    'msg_cmpd_01',
    [
      TU('toolu_cmpd_01', 'Agent', {
        description: 'Audit modules',
        prompt: 'Audit every module and summarise.',
        subagent_type: 'general-purpose',
      }),
    ],
    u(1000, 80, 0, 0, 2000),
  )
  const a = sub(f, aid(5, 1), 5)
  a.user('Audit every module and summarise.')
  a.asst(
    'msg_cmpd_a1',
    [TU('toolu_cmpd_a1', 'Read', { file_path: '/home/dev/acme/s05-compaction/db.ts' })],
    u(1000, 60, 0, 1000),
  )
  a.result('toolu_cmpd_a1', 'export {}', { type: 'text' })
  const pre = a.asst('msg_cmpd_a2', [T('Read the first module')], u(100, 30, 1000, 500))
  a.boundary('manual', { preTokens: 80000, postTokens: 9000, durationMs: 4000 }, pre)
  a.summary(SUMMARY('The agent audited the first module.'))
  a.asst('msg_cmpd_a3', [T('All modules audited')], u(200, 40, 0, 900))
  writeMeta(a, {
    agentType: 'general-purpose',
    description: 'Audit modules',
    toolUseId: 'toolu_cmpd_01',
    spawnDepth: 1,
    model: 'sonnet',
  })
  back(f, a)
  f.result('toolu_cmpd_01', [T('All modules audited')], completed(a, 'general-purpose', 'All modules audited'))
  f.asst('msg_cmpd_02', [T('Audit complete')], u(100, 30, 2000, 0, 100))
  f.turnEnd(20000, 6)
}

// ================================================================ 06 sync subagent
{
  const f = mk(6, 'subsync', { ver: '2.1.200' })
  f.user('find where logins are validated')
  f.asst(
    'msg_sync_01',
    [
      TU('toolu_sync_01', 'Agent', {
        description: 'Find login validation',
        prompt: 'Search the repo for login validation and report the file.',
        subagent_type: 'Explore',
      }),
    ],
    u(1000, 80, 0, 0, 2000),
  )
  const a = sub(f, aid(6, 1), 2)
  a.user('Search the repo for login validation and report the file.')
  a.asst(
    'msg_sync_a1',
    [TU('toolu_sync_a1', 'Grep', { pattern: 'validate', path: '/home/dev/acme/subsync' })],
    u(2000, 60, 0, 1000),
  )
  a.result('toolu_sync_a1', 'src/auth.ts:12: validateLogin()', { mode: 'content', numFiles: 1 })
  a.asst('msg_sync_a2', [T('Login validation lives in src/auth.ts.')], u(300, 40, 3000, 200))
  writeMeta(a, {
    agentType: 'Explore',
    description: 'Find login validation',
    toolUseId: 'toolu_sync_01',
    spawnDepth: 1,
    model: 'sonnet',
  })
  back(f, a)
  f.result(
    'toolu_sync_01',
    [T('Login validation lives in src/auth.ts.')],
    completed(a, 'Explore', 'Login validation lives in src/auth.ts.'),
  )
  f.asst('msg_sync_02', [T('Login validation is in src/auth.ts.')], u(100, 30, 2100, 0, 100))
  f.turnEnd(15000, 4)
  // files that must be ignored
  RAW.set(`${f.dir}/${f.sid}/tool-results/toolu_sync_01.txt`, 'fixture spilled tool output\n')
  RAW.set(`${f.dir}/${f.sid}/custom-title.json`, JSON.stringify({ customTitle: 'ignored' }) + '\n')
}

// ================================================================ 07 background subagent
const BG = aid(7, 1)
{
  const f = mk(7, 'subbg')
  f.user('run the slow audit in the background')
  f.asst(
    'msg_bg_01',
    [
      TU('toolu_bg_01', 'Agent', {
        description: 'Run audit',
        prompt: 'Run the audit and report issues.',
        run_in_background: true,
      }),
    ],
    u(1000, 80, 0, 0, 2000),
  )
  f.result('toolu_bg_01', [T('Agent launched in the background')], {
    status: 'async_launched',
    agentId: BG,
    description: 'Run audit',
    resolvedModel: 'sonnet',
    outputFile: `/home/dev/.fixture/tasks/${BG}.output`,
  })
  f.asst('msg_bg_02', [T('The audit is running in the background.')], u(100, 30, 2100, 0, 100))
  f.turnEnd(5000, 4)
  const a = sub(f, BG, 2)
  a.t = base(7) + 20_000
  a.user('Run the audit and report issues.')
  a.asst('msg_bg_a1', [TU('toolu_bg_a1', 'Bash', { command: 'audit --quick' })], u(2000, 60, 0, 1000))
  a.result('toolu_bg_a1', '2 issues', { stdout: '2 issues', stderr: '' })
  a.asst('msg_bg_a2', [T('Audit complete: 2 issues.')], u(300, 40, 3000, 200))
  writeMeta(a, {
    agentType: 'general-purpose',
    description: 'Run audit',
    toolUseId: 'toolu_bg_01',
    spawnDepth: 1,
    model: 'sonnet',
  })
  f.at(iso(base(7) + 120_000))
  f.user(
    `<task-notification>\n<task-id>${BG}</task-id>\n<status>completed</status>\n<summary>Agent "Run audit" completed</summary>\n<result>Audit complete: 2 issues.</result>\n</task-notification>`,
    { origin: 'task-notification', src: 'system' },
  )
  f.asst('msg_bg_03', [T('The audit found 2 issues.')], u(100, 30, 2300, 0, 100))
  f.turnEnd(4000, 2)
  f.user('fix the first issue')
  f.asst('msg_bg_04', [T('Fixed the first issue')], u(100, 30, 2500, 0, 100))
  f.turnEnd(4000, 2)
}

// ================================================================ 08 nested subagent
{
  const f = mk(8, 'subnest')
  f.user('survey the repo with helpers')
  f.asst(
    'msg_nest_01',
    [TU('toolu_nest_01', 'Agent', { description: 'Survey', prompt: 'Survey the repo; delegate the test survey.' })],
    u(1000, 80, 0, 0, 2000),
  )
  const A = sub(f, aid(8, 1), 2)
  A.user('Survey the repo; delegate the test survey.')
  A.asst(
    'msg_nest_a1',
    [TU('toolu_nest_02', 'Agent', { description: 'Survey tests', prompt: 'Count the test files.' })],
    u(2000, 60, 0, 1000),
  )
  const B = sub(A, aid(8, 2), 3)
  B.user('Count the test files.')
  B.asst('msg_nest_b1', [TU('toolu_nest_b1', 'Glob', { pattern: '**/*.test.ts' })], u(1000, 40, 0, 500))
  B.result('toolu_nest_b1', '4 files', { numFiles: 4 })
  B.asst('msg_nest_b2', [T('There are 4 test files.')], u(200, 30, 1500, 100))
  writeMeta(B, {
    agentType: 'general-purpose',
    description: 'Survey tests',
    toolUseId: 'toolu_nest_02',
    parentAgentId: A.agent,
    spawnDepth: 2,
    model: 'sonnet',
  })
  back(A, B)
  A.result('toolu_nest_02', [T('There are 4 test files.')], completed(B, 'general-purpose', 'There are 4 test files.'))
  A.asst('msg_nest_a2', [T('Repo surveyed: 4 test files.')], u(300, 40, 3000, 200))
  writeMeta(A, {
    agentType: 'general-purpose',
    description: 'Survey',
    toolUseId: 'toolu_nest_01',
    spawnDepth: 1,
    model: 'sonnet',
  })
  back(f, A)
  f.result(
    'toolu_nest_01',
    [T('Repo surveyed: 4 test files.')],
    completed(A, 'general-purpose', 'Repo surveyed: 4 test files.'),
  )
  f.asst('msg_nest_02', [T('The repo has 4 test files.')], u(100, 30, 2100, 0, 100))
  f.turnEnd(30000, 4)
}

// ================================================================ 09 teammate
const TM = 'areviewer-09e0c0de00000001'
{
  const f = mk(9, 'team')
  f.user('ask the reviewer to check the diff')
  f.asst(
    'msg_team_01',
    [
      TU('toolu_team_01', 'Agent', {
        name: 'reviewer',
        team_name: 'acme-team',
        description: 'Review the diff',
        prompt: 'Review the diff in the login branch.',
        subagent_type: 'general-purpose',
      }),
    ],
    u(1000, 80, 0, 0, 2000),
  )
  f.result('toolu_team_01', [T('Spawned reviewer')], {
    status: 'teammate_spawned',
    name: 'reviewer',
    team_name: 'acme-team',
    agent_id: 'reviewer@acme-team',
    model: 'sonnet',
  })
  f.asst('msg_team_02', [T('The reviewer is on it.')], u(100, 30, 2100, 0, 100))
  f.turnEnd(4000, 4)
  const a = sub(f, TM, 2)
  a.t = base(9) + 12_000
  a.user('Review the diff in the login branch.')
  a.asst('msg_team_a1', [TU('toolu_team_a1', 'Bash', { command: 'git diff' })], u(2000, 60, 0, 1000))
  a.result('toolu_team_a1', '1 file changed', { stdout: '1 file changed', stderr: '' })
  a.asst('msg_team_a2', [T('Reviewed: one nit in login.tsx.')], u(300, 40, 3000, 200))
  f.at(iso(base(9) + 120_000))
  f.user('tell the reviewer to also check the tests')
  f.asst(
    'msg_team_03',
    [
      TU('toolu_team_02', 'SendMessage', {
        to: 'reviewer',
        message: 'Please also check the tests.',
        summary: 'also check tests',
      }),
    ],
    u(100, 60, 2300, 0, 100),
  )
  f.result('toolu_team_02', 'Message sent to reviewer', { success: true, message: 'Message sent to reviewer' })
  a.at(iso(base(9) + 125_000))
  a.user(
    '<teammate-message teammate_id="team-lead" summary="also check tests">Please also check the tests.</teammate-message>',
    { origin: 'peer', src: 'system' },
  )
  a.asst('msg_team_a3', [T('Tests look fine.')], u(300, 30, 3500, 100))
  f.at(iso(base(9) + 135_000))
  f.asst('msg_team_04', [T('The reviewer will also check the tests.')], u(100, 30, 2600, 0, 100))
  f.turnEnd(20000, 5)
  writeMeta(a, {
    agentType: 'reviewer',
    name: 'reviewer',
    teamName: 'acme-team',
    taskKind: 'in_process_teammate',
    color: 'blue',
    description: 'Review the diff',
    spawnDepth: 0,
    model: 'sonnet',
  })
}

// ================================================================ 10 fork agents
{
  const f = mk(10, 'fork')
  f.user('compare the storage options')
  const X = u(1000, 80, 0, 0, 2000)
  const l1 = f.asst(
    'msg_fork_01',
    [
      TU('toolu_fork_01', 'Agent', {
        description: 'Evaluate sqlite',
        prompt: 'Evaluate sqlite.',
        subagent_type: 'fork',
      }),
    ],
    X,
    { stop: null },
  )
  const l2 = f.asst(
    'msg_fork_01',
    [
      TU('toolu_fork_02', 'Agent', {
        description: 'Evaluate postgres',
        prompt: 'Evaluate postgres.',
        subagent_type: 'fork',
      }),
    ],
    X,
    { stop: null },
  )
  const l3 = f.asst(
    'msg_fork_01',
    [TU('toolu_fork_03', 'Agent', { description: 'Evaluate mysql', prompt: 'Evaluate mysql.', subagent_type: 'fork' })],
    X,
  )
  const parentLast = l3
  // shared context records written into two sibling files (old style)
  const ctx = new F({
    rel: 'unused',
    dir: '',
    sid: f.sid,
    tag: '109f0000',
    cwd: f.cwd,
    branch: f.branch,
    ver: f.ver,
    entry: f.entry,
    agent: 'ctx',
    lkey: f.lkey,
    t: f.t + 1000,
  })
  FILES.pop()
  ctx.user('Context: we are choosing between sqlite, postgres and mysql.')
  ctx.asst('msg_fork_ctx_01', [T('Noted the context.')], u(500, 20, 0, 1000))
  const ids = [aid(10, 1), aid(10, 2), aid(10, 3)]
  const mkFork = (n: number, ff: number, name: string, body: string, ref: boolean) => {
    const a = sub(f, ids[n], ff)
    a.t = ctx.t
    if (ref) {
      a.meta({
        type: 'fork-context-ref',
        agentId: a.agent,
        parentSessionId: f.sid,
        parentLastUuid: parentLast,
        contextLength: 4,
      })
    } else {
      a.copyFrom(ctx, 0, ctx.lines.length, () => {})
      a.t = ctx.t
    }
    a.user(`Evaluate ${name}.`)
    a.asst(`msg_fork_f${n + 1}_01`, [T(body)], u(300, 40, 1500, 100))
    writeMeta(a, {
      agentType: 'fork',
      isFork: true,
      description: `Evaluate ${name}`,
      toolUseId: `toolu_fork_0${n + 1}`,
      spawnDepth: 1,
      model: 'inherit',
    })
    return a
  }
  const a1 = mkFork(0, 2, 'sqlite', 'sqlite is simple and embedded.', false)
  const a2 = mkFork(1, 3, 'postgres', 'postgres scales and is heavier.', false)
  const a3 = mkFork(2, 4, 'mysql', 'mysql is a middle ground.', true)
  // the shared messages count for both sibling files in naive sums
  f.t = Math.max(a1.t, a2.t, a3.t) + 1000
  f.result(
    'toolu_fork_01',
    [T('sqlite is simple and embedded.')],
    completed(a1, 'fork', 'sqlite is simple and embedded.'),
    { parent: l1 },
  )
  f.result(
    'toolu_fork_02',
    [T('postgres scales and is heavier.')],
    completed(a2, 'fork', 'postgres scales and is heavier.'),
    { parent: l2 },
  )
  f.result('toolu_fork_03', [T('mysql is a middle ground.')], completed(a3, 'fork', 'mysql is a middle ground.'), {
    parent: l3,
  })
  f.last = f.lines.length ? JSON.parse(f.lines[f.lines.length - 1]).uuid : null
  f.asst('msg_fork_02', [T('sqlite fits best for now.')], u(100, 40, 2300, 0, 200))
  f.turnEnd(20000, 8)
}

// ================================================================ 11 linkage fallbacks
{
  const f = mk(11, 'linkage')
  f.user('check three things in parallel')
  const X = u(1000, 80, 0, 0, 2000)
  const l1 = f.asst(
    'msg_link_01',
    [TU('toolu_link_01', 'Agent', { description: 'Find entry point', prompt: 'Find the entry point.' })],
    X,
    { stop: null },
  )
  const l2 = f.asst(
    'msg_link_01',
    [TU('toolu_link_02', 'Agent', { description: 'List config files', prompt: 'List the config files.' })],
    X,
  )
  // L1: no toolUseId in meta; first prompt differs from input.prompt; linkable only through toolUseResult.agentId
  const A1 = sub(f, aid(11, 1), 2)
  A1.user('Context: the repo is small. Find the entry point.')
  A1.asst('msg_link_a1', [T('The entry point is main.ts.')], u(1000, 30, 0, 800))
  writeMeta(A1, { agentType: 'general-purpose', description: 'Find entry point', spawnDepth: 1, model: 'sonnet' })
  // L2: no toolUseId, tool_result carries no agentId; first prompt equals input.prompt exactly
  const A2 = sub(f, aid(11, 2), 3)
  A2.user('List the config files.')
  A2.asst('msg_link_a2', [T('Config files: tsconfig.json, package.json.')], u(1000, 40, 0, 800))
  writeMeta(A2, { agentType: 'general-purpose', description: 'List config files', spawnDepth: 1, model: 'sonnet' })
  // L3: nothing links it: no meta file at all, its prompt matches no tool_use, no tool_result names it
  const A3 = sub(f, aid(11, 3), 4)
  A3.user('Unrelated housekeeping task nobody asked for.')
  A3.asst('msg_link_a3', [T('Housekeeping finished.')], u(1000, 20, 0, 800))
  f.t = Math.max(A1.t, A2.t, A3.t) + 1000
  f.result(
    'toolu_link_01',
    [T('The entry point is main.ts.')],
    { status: 'completed', agentId: A1.agent, content: [T('The entry point is main.ts.')] },
    { parent: l1 },
  )
  f.result(
    'toolu_link_02',
    [T('Config files: tsconfig.json, package.json.')],
    { status: 'completed', content: [T('Config files: tsconfig.json, package.json.')] },
    { parent: l2 },
  )
  f.asst('msg_link_02', [T('Entry point is main.ts; two config files.')], u(100, 40, 2300, 0, 200))
  f.turnEnd(15000, 6)
}

// ================================================================ 12 orphan
{
  const s = sid(12)
  const key = keyOf('orphan')
  const mkO = (file: string, id: string, ff: number, n: number, withMeta: boolean) => {
    const a = new F({
      rel: `projects/${key}/${s}/subagents/${file}.jsonl`,
      dir: `projects/${key}`,
      sid: s,
      tag: `12${pad(ff, 2)}0000`,
      cwd: cwdOf('orphan'),
      branch: 'main',
      ver: '2.1.71',
      entry: 'cli',
      agent: id,
      lkey: '12',
      t: base(12) + n * 60_000,
    })
    a.old = true
    return a
  }
  const a1 = mkO(`agent-${aid(12, 1)}`, aid(12, 1), 1, 0, true)
  a1.user('Scan the repo for TODO comments.')
  a1.asst('msg_orph_a1', [T('Found 3 TODO comments.')], u(1000, 30, 0, 800))
  writeMeta(a1, {
    agentType: 'general-purpose',
    description: 'Scan TODOs',
    toolUseId: 'toolu_orph_missing',
    spawnDepth: 1,
    model: 'sonnet',
  })
  const a2 = mkO('agent-a1b2c3d', 'a1b2c3d', 2, 1, false)
  a2.user('Count the markdown files.')
  a2.asst('msg_orph_a2', [T('There are 5 markdown files.')], u(1000, 20, 0, 800))
  const a3 = mkO('agent-acompact-12e0c0de', 'acompact-12e0c0de', 3, 2, false)
  a3.user('Summarise the conversation so far.')
  a3.asst('msg_orph_a3', [T('Summary: scanning and counting were done.')], u(2000, 60, 0, 0), { model: SON })
}

// ================================================================ 13 copied history
const convo = (f: F, k: string) => {
  f.user('add a search box')
  f.asst(`msg_${k}_01`, [TU(`toolu_${k}_01`, 'Edit', edit('search.tsx'))], u(1000, 100, 0, 0, 2000))
  f.result(`toolu_${k}_01`, 'File updated', { type: 'update', filePath: '/home/dev/acme/search.tsx' })
  f.asst(`msg_${k}_02`, [T('Search box added')], u(100, 50, 2000, 0, 500))
  f.turnEnd(9000, 4)
  f.user('style the search box')
  f.asst(`msg_${k}_03`, [T('Styled')], u(100, 40, 2500, 0, 100))
  f.turnEnd(5000, 2)
}
const gap = (f: F, s: number) => f.adv(s)
{
  // 13a continuation, unmarked: A stops at the copy point
  const A = mk(13, 's13a-continuation', { v: 1, ff: 1, lkey: '13a' })
  convo(A, 'cpa')
  const B = mk(13, 's13a-continuation', { v: 2, ff: 2, lkey: '13a' })
  B.t = A.t + 60_000
  B.copyFrom(A, 0, A.lines.length)
  B.t = A.t + 120_000
  B.user('add a clear button')
  B.asst('msg_cpa_b1', [T('Clear button added')], u(100, 40, 2600, 0, 100))
  B.turnEnd(3000, 2)
}
const VAR: Record<string, [number, number]> = { a: [1, 2], b: [3, 4], c: [5, 6], d: [7, 8], e: [9, 10] }
const forkPair = (v: string, marked: boolean) => {
  const [va, vb] = VAR[v]
  const name = `s13${v}-${marked ? 'fork-marked' : 'fork-unmarked'}`
  const k = `cp${v}`
  const A = mk(13, name, { v: va, ff: va, lkey: `13${v}` })
  convo(A, k)
  const cp = A.lines.length
  const copyEnd = A.t
  A.t = copyEnd + 300_000
  A.user('add search history')
  A.asst(`msg_${k}_a1`, [T('Search history added')], u(100, 40, 2600, 0, 100))
  A.turnEnd(3000, 2)
  const B = mk(13, name, { v: vb, ff: vb, lkey: `13${v}` })
  B.t = copyEnd + 60_000
  B.copyFrom(
    A,
    0,
    cp,
    marked
      ? (r) => {
          r.forkedFrom = { sessionId: A.sid, messageUuid: r.uuid }
        }
      : () => {},
  )
  B.t = copyEnd + 600_000
  B.user('add search suggestions')
  B.asst(`msg_${k}_b1`, [T('Suggestions added')], u(100, 50, 2600, 0, 100))
  B.turnEnd(4000, 2)
  return { A, B }
}
const P13b = forkPair('b', false)
const P13c = forkPair('c', true)
let P13d: { A: F; B: F }
{
  // 13d partial copy marked by session_id != sessionId
  const A = mk(13, 's13d-partial-copy', { v: 7, ff: 7, lkey: '13d' })
  convo(A, 'cpd')
  const tailStart = A.lines.length
  const beforeTail = A.last!
  A.user('add a reset button')
  A.asst('msg_cpd_04', [T('Reset button added')], u(100, 40, 2700, 0, 100))
  A.turnEnd(3000, 2)
  const B = mk(13, 's13d-partial-copy', { v: 8, ff: 8, lkey: '13d' })
  B.t = Date.parse(JSON.parse(A.lines[tailStart]).timestamp) - 3000 // boundary and summary precede the copied tail
  B.boundary('auto', { preTokens: 120000, postTokens: 8000, durationMs: 6000 }, beforeTail)
  B.summary(SUMMARY('The search box was added and styled in session A.'))
  B.copyFrom(A, tailStart, A.lines.length, (r) => {
    r.session_id = A.sid
  })
  B.t = A.t + 300_000
  B.user('add a disabled state')
  B.asst('msg_cpd_b1', [T('Disabled state added')], u(100, 40, 2800, 0, 100))
  B.turnEnd(3000, 2)
  P13d = { A, B }
}
let P13e: { A: F; B: F }
{
  // 13e: cli session picked up by an SDK client
  const A = mk(13, 's13e-sdk-pickup', { v: 9, ff: 9, lkey: '13e' })
  convo(A, 'cpe')
  const B = mk(13, 's13e-sdk-pickup', { v: 10, ff: 10, lkey: '13e' })
  B.t = A.t + 60_000
  B.copyFrom(A, 0, A.lines.length)
  B.t = A.t + 120_000
  B.entry = 'sdk-cli'
  B.user('add a clear button', { src: 'sdk' })
  B.asst('msg_cpe_b1', [T('Clear button added')], u(100, 40, 2600, 0, 100))
  B.turnEnd(3000, 2)
  P13e = { A, B }
}
const P13a = FILES.filter((f) => f.rel.includes('s13a-continuation'))

// ================================================================ 14 rewind inside one file
{
  const f = mk(14, 'rewind')
  f.user('scaffold the app')
  f.att()
  f.asst('msg_rw_01', [T('Scaffolded')], u(1000, 60, 0, 0, 2000))
  const t0 = f.turnEnd(5000, 2)
  f.user('add a settings page') // abandoned: it is rewound, a sibling prompt takes its place
  f.att()
  f.asst('msg_rw_02', [T('Settings page added')], u(100, 40, 2000, 0, 200))
  f.turnEnd(4000, 2)
  f.user('add a profile page instead', { parent: t0 })
  f.att()
  f.asst('msg_rw_03', [T('Profile page added')], u(100, 40, 2200, 0, 200))
  const t1 = f.turnEnd(4000, 2)
  f.user('add dark mode') // abandoned: replaced before any response
  f.user('add light mode', { parent: t1 })
  f.att()
  f.asst('msg_rw_04', [T('Light mode added')], u(100, 40, 2500, 0, 200))
  f.turnEnd(4000, 2)
  f.user('rename both config files')
  f.att()
  const L = f.asst(
    'msg_rw_05',
    [
      TU('toolu_rw_a', 'Bash', { command: 'mv a.json a.yaml' }),
      TU('toolu_rw_b', 'Bash', { command: 'mv b.json b.yaml' }),
    ],
    u(100, 90, 2700, 0, 200),
  )
  f.result('toolu_rw_a', '', { stdout: '', stderr: '' }, { parent: L })
  f.result('toolu_rw_b', '', { stdout: '', stderr: '' }, { parent: L })
  f.att()
  f.asst('msg_rw_06', [T('Both config files renamed')], u(100, 40, 2900))
  f.turnEnd(6000, 5)
  f.meta({ type: 'last-prompt', lastPrompt: 'rename both config files', leafUuid: f.last })
}

// ================================================================ cost-state helper
function costState(k: string, f: F, hidden: boolean, suffix: Record<string, string> = {}, startTime = 0): J {
  const by = new Map<string, J>()
  const addm = (m: string, i: number, o: number, cr: number, cc: number, h: number) => {
    const e = by.get(m) ?? {
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      _h: 0,
    }
    e.inputTokens += i
    e.outputTokens += o
    e.cacheReadInputTokens += cr
    e.cacheCreationInputTokens += cc
    e._h += h
    by.set(m, e)
  }
  for (const e of ledger(k).values()) {
    if (e.ts > f.now()) continue
    addm(e.model, e.u.i, e.u.o, e.u.cr ?? 0, (e.u.c5 ?? 0) + (e.u.c1 ?? 0), entryCost(e)?.h ?? 0)
  }
  if (hidden) addm(HAIKU, 1000, 100, 0, 0, 1000 * 100 + 100 * 500) // calls that never reach a transcript
  let th = 0
  const modelUsage: J = {}
  for (const [m, e] of by) {
    th += e._h
    const { _h, ...rest } = e
    modelUsage[m + (suffix[m] ?? '')] = { ...rest, costUSD: Number((_h / 1e8).toFixed(8)) }
  }
  return {
    type: 'cost-state',
    totalCostUSD: Number((th / 1e8).toFixed(8)),
    startTime,
    totalAPIDuration: 12345,
    totalLinesAdded: 10,
    totalLinesRemoved: 2,
    modelUsage,
  }
}

// ================================================================ 15 sdk one-shot
{
  const f = mk(15, 'sdk', { ver: '2.1.280', entry: 'sdk-cli' })
  f.user('summarize README.md', { src: 'sdk' })
  f.asst(
    'msg_sdk_01',
    [TU('toolu_sdk_01', 'Read', { file_path: '/home/dev/acme/sdk/README.md' })],
    u(1000, 60, 0, 0, 2000),
  )
  f.result('toolu_sdk_01', '# Acme', { type: 'text', file: { filePath: '/home/dev/acme/sdk/README.md', numLines: 1 } })
  f.asst('msg_sdk_02', [T('README.md describes the Acme project.')], u(100, 40, 2000, 0, 200))
  f.turnEnd(5000, 4)
  f.meta(costState('15', f, true, {}, base(15)))
}

// ================================================================ 16 cost-state, several models
{
  const f = mk(16, 'coststate', { ver: '2.1.280' })
  const st = base(16)
  f.user('plan the billing module')
  f.asst(
    'msg_cs_01',
    [TU('toolu_cs_01', 'Read', { file_path: '/home/dev/acme/coststate/billing.ts' })],
    u(1000, 200, 0, 0, 4000),
    { model: OPUS },
  )
  f.result('toolu_cs_01', 'export {}', { type: 'text' })
  f.asst('msg_cs_02', [T('Plan: invoices, totals, tax.')], u(200, 300, 4000, 0, 500), { model: OPUS })
  f.turnEnd(9000, 4)
  f.meta(costState('16', f, true, { [OPUS]: '[1m]' }, st)) // process exit #1
  f.adv(3600)
  f.user('implement the invoice totals') // resumed
  f.asst(
    'msg_cs_03',
    [
      TU('toolu_cs_02', 'Agent', {
        description: 'Check tax rules',
        prompt: 'List the tax rules in billing.ts.',
        model: 'haiku',
      }),
    ],
    u(500, 100, 0, 0, 1000),
  )
  const a = sub(f, aid(16, 1), 2)
  a.user('List the tax rules in billing.ts.')
  a.asst('msg_cs_a1', [T('Tax rules: flat 10 percent.')], u(3000, 100, 0, 1000), { model: HAIKU })
  writeMeta(a, {
    agentType: 'general-purpose',
    description: 'Check tax rules',
    toolUseId: 'toolu_cs_02',
    spawnDepth: 1,
    model: 'haiku',
  })
  back(f, a)
  f.result(
    'toolu_cs_02',
    [T('Tax rules: flat 10 percent.')],
    completed(a, 'general-purpose', 'Tax rules: flat 10 percent.'),
  )
  f.asst('msg_cs_04', [T('Invoice totals implemented')], u(100, 80, 1500, 0, 200))
  f.turnEnd(12000, 4)
  f.user('review the invoice totals')
  f.asst('msg_cs_05', [T('Review: totals look correct.')], u(1000, 400, 5000, 0, 1000), { model: FABLE })
  f.turnEnd(7000, 2)
  f.meta(costState('16', f, true, { [OPUS]: '[1m]' }, st)) // process exit #2 (cumulative)
}

// ================================================================ 17 hostile input
{
  const f = mk(17, 'hostile')
  f.user('add input validation')
  f.asst(
    'msg_host_01',
    [TU('toolu_host_01', 'Read', { file_path: '/home/dev/acme/hostile/input.ts' })],
    u(1000, 100, 0, 0, 2000),
  )
  f.lines.push(
    '{"type":"assistant","uuid":"17010000-0000-4000-9000-000000000099","message":{"id":"msg_host_corrupt","content":[{"type":"text","text":"this line is cut and never closes"}}}]]',
  )
  f.rec({ type: 'hologram-state', payload: { x: 1 } }, { noChain: true })
  const huge = 'abcdefghij'.repeat(110000) // 1.1 MB
  f.result('toolu_host_01', huge, { type: 'text', file: { filePath: '/home/dev/acme/hostile/input.ts', numLines: 1 } })
  f.asst('msg_host_02', [T('Validation added')], u(100, 50, 2000, 0, 200), {
    extra: { futureField: { nested: [1, 2, 3] } },
    msgExtra: { futureMessageField: 'x' },
  })
  f.turnEnd(5000, 4)
  f.user('now handle empty strings')
  f.asst('<synthetic>-1', [T('Simulated API error for the fixture')], u(0, 0), {
    model: '<synthetic>',
    stop: 'stop_sequence',
    noLedger: true,
    extra: { isApiErrorMessage: true },
    msgExtra: { id: 'msg_host_synth' },
  })
  f.user('try again')
  f.asst('msg_host_03', [T('Empty strings handled')], u(100, 40, 2200))
  f.turnEnd(3000, 2)
  f.tail = '{"type":"assistant","uuid":"17010000-0000-4000-9000-000000000100","parentUuid":"'
}

// ================================================================ 18 cwd change
{
  const f = mk(18, 'cwdchange')
  f.user('start the feature')
  f.asst('msg_cwd_01', [T('Feature started')], u(1000, 50, 0, 0, 2000))
  f.turnEnd(3000, 2)
  f.meta({
    type: 'worktree-state',
    worktreeSession: {
      originalCwd: cwdOf('cwdchange'),
      worktreePath: cwdOf('cwdchange-wt'),
      worktreeName: 'login-wt',
      worktreeBranch: 'worktree-login',
    },
  })
  f.cwd = cwdOf('cwdchange-wt')
  f.branch = 'worktree-login'
  f.user('continue in the worktree')
  f.asst('msg_cwd_02', [T('Continuing in the worktree')], u(100, 40, 2000, 0, 200))
  f.turnEnd(3000, 2)
  f.meta({ type: 'relocated', relocatedCwd: cwdOf('cwdchange-moved') })
  f.cwd = cwdOf('cwdchange-moved')
  f.branch = 'main'
  f.user('wrap up')
  f.asst('msg_cwd_03', [T('Wrapped up')], u(100, 30, 2200, 0, 100))
  f.turnEnd(3000, 2)
}

// ================================================================ 19 day boundary
{
  const f = mk(19, 'daybound')
  f.at('2026-09-19T03:50:00Z')
  f.user('add a footer')
  f.at('2026-09-19T03:50:10Z')
  f.asst('msg_day_01', [T('Footer added')], u(1000, 100, 0, 0, 2000))
  f.at('2026-09-19T03:50:12Z')
  f.turnEnd(12000, 2)
  f.at('2026-09-19T03:59:30Z')
  f.user('add a header')
  f.at('2026-09-19T03:59:50Z')
  f.asst('msg_day_02', [TU('toolu_day_01', 'Edit', edit('header.tsx'))], u(100, 80, 2000, 0, 300))
  f.at('2026-09-19T04:00:10Z')
  f.result('toolu_day_01', 'File updated', { type: 'update' })
  f.at('2026-09-19T04:00:30Z')
  f.asst('msg_day_03', [T('Header added')], u(100, 40, 2400, 0, 100))
  f.at('2026-09-19T04:00:32Z')
  f.turnEnd(62000, 4)
  f.at('2026-09-19T04:05:00Z')
  f.user('add a sidebar')
  f.at('2026-09-19T04:05:20Z')
  f.asst('msg_day_04', [T('Sidebar added')], u(100, 50, 2500, 0, 100))
  f.at('2026-09-19T04:05:22Z')
  f.turnEnd(22000, 2)
}

// ================================================================ 20 pricing edges
{
  const f = mk(20, 'pricing')
  f.user('estimate the build cost')
  f.asst('msg_px_01', [T('Mixed cache writes')], u(1000, 100, 2000, 400, 600), { model: OPUS })
  f.asst('msg_px_02', [T('Fast mode reply')], u(1000, 100, 0, 0, 0, { fast: true }), { model: OPUS })
  f.asst('msg_px_03', [T('From a model with no price')], u(1000, 100), { model: 'claude-nova-9-9' })
  f.asst('msg_px_04', [T('Searched the web')], u(500, 50, 0, 0, 0, { web: 2 }))
  f.turnEnd(6000, 5)
}

// ================================================================ 21 misc non-transcripts, 22 nested project
{
  const f = mk(21, 'misc')
  f.user('write the changelog')
  f.asst('msg_misc_01', [T('Changelog written')], u(1000, 50, 0, 0, 2000))
  f.turnEnd(3000, 2)
  const p = f.dir
  RAW.set(
    `${p}/notes.jsonl`,
    [
      JSON.stringify({
        type: 'user',
        uuid: '21990000-0000-4000-9000-000000000001',
        parentUuid: null,
        timestamp: '2026-09-21T10:30:00Z',
        sessionId: 'not-a-session',
        message: { role: 'user', content: 'this file is not a transcript (basename is not a uuid)' },
      }),
      JSON.stringify({ note: 'scratch', n: 2 }),
    ].join('\n') + '\n',
  )
  RAW.set(
    `${p}/vercel-plugin/skill-injections.jsonl`,
    JSON.stringify({ skill: 'fake-skill', injectedAt: '2026-09-21T10:00:00Z' }) + '\n',
  )
  RAW.set(`${p}/sessions-index.json`, JSON.stringify({ version: 1, entries: [] }) + '\n')
  RAW.set(`${p}/memory/MEMORY.md`, '# Fixture memory\n\nNot a transcript.\n')
}
{
  const outer = mk(22, 'nest', { ff: 1 })
  outer.user('outer session in the nest project')
  outer.asst('msg_nest22_01', [T('Outer done')], u(1000, 50, 0, 0, 2000))
  outer.turnEnd(3000, 2)
  const inner = mk(22, 'nest/inner', {
    v: 2,
    ff: 2,
    projKey: '-home-dev-acme-nest/-home-dev-acme-nest-inner',
    lkey: '22',
  })
  inner.user('inner session in a nested project directory')
  inner.asst(
    'msg_nest22_02',
    [TU('toolu_nest22_01', 'Agent', { description: 'Inner helper', prompt: 'Say hello from the inner project.' })],
    u(1000, 60, 0, 0, 2000),
  )
  const a = sub(inner, aid(22, 1), 3)
  a.user('Say hello from the inner project.')
  a.asst('msg_nest22_a1', [T('Hello from the inner project.')], u(500, 20, 0, 400))
  writeMeta(a, {
    agentType: 'general-purpose',
    description: 'Inner helper',
    toolUseId: 'toolu_nest22_01',
    spawnDepth: 1,
    model: 'sonnet',
  })
  back(inner, a)
  inner.result(
    'toolu_nest22_01',
    [T('Hello from the inner project.')],
    completed(a, 'general-purpose', 'Hello from the inner project.'),
  )
  inner.asst('msg_nest22_03', [T('Inner done')], u(100, 30, 2000, 0, 100))
  inner.turnEnd(5000, 4)
}

// ================================================================ live-session registry
RAW.set(
  'sessions/4242.json',
  JSON.stringify(
    {
      pid: 4242,
      sessionId: sid(1),
      cwd: cwdOf('plain'),
      startedAt: base(1),
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'plain',
      status: 'busy',
      updatedAt: base(1) + 60_000,
    },
    null,
    2,
  ) + '\n',
)
RAW.set(
  'sessions/4343.json',
  JSON.stringify(
    {
      pid: 4343,
      sessionId: sid(3),
      cwd: cwdOf('slash'),
      startedAt: base(3),
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'slash',
      status: 'idle',
      updatedAt: base(3) + 60_000,
    },
    null,
    2,
  ) + '\n',
)

// ================================================================ README
const sec = (n: number | string) => (typeof n === 'number' ? pad(n, 2) : n)
const fileOf = (name: string, v = 1) =>
  FILES.find((f) => f.rel.includes(`/${name}/`) && f.sid.endsWith(pad(v, 12)) && !f.agent)!
void sec
void fileOf

function readme(): string {
  const d = (ss: number, v = 1) => sid(ss, v)
  const B = (k: string) => breakdown(k)
  const naive = (fs: F[]) => fs.map((f) => `${f.rel.split('/').pop()} = ${money(f.fileH())}`).join(', ')
  const L: string[] = []
  L.push(`# Explorer test fixtures

Synthetic Claude Code transcripts. Every prompt, reply and path is invented (\`/home/dev/acme/...\`).
The tree is usable directly as \`CLAUDE_CONFIG_DIR=explorer/testdata/claude\`; transcripts live under
\`claude/projects/<project-key>/\`. \`internal/fixtures\` locates the tree and validates it.

Regenerate with \`bun explorer/testdata/generate.ts\` (rewrites \`claude/\` and this file). The committed
files are authoritative; the generator only keeps ids, timestamps, copied records and costs consistent.

Conventions

- Session ids: \`SSSSSSSS-0000-4000-8000-00000000000V\` where SS is the scenario number repeated four times (scenario 05: \`05050505\`)
  and V the variant. Record uuids: \`SSFF0000-0000-4000-9000-<seq>\` (FF = file index inside the scenario).
  Agent ids: \`aSSe0c0de000000N\` (16 hex). Message ids \`msg_<name>_NN\`, tool ids \`toolu_<name>_NN\`.
- Timestamps: RFC 3339 UTC, base \`2026-09-SST10:00:00Z\` (SS = scenario number), non-decreasing inside every file,
  and consistent between a parent and its subagent files. Copied records keep their original timestamps.
- Default model \`claude-sonnet-5-5\` (input $2, output $10, cache read $0.20 per million). Cache write = input price x 1.25
  (5m) or x 2 (1h); main sessions write 1h, subagents write 5m. Prices for other models are in transcript-format.md section 8.
- A *turn* is a human prompt (including a slash command) and everything until the next one. "Abandoned" = on a branch
  the session later rewound away from. Token counts are small round numbers; arithmetic is shown per message below
  (each message id is billed once; for split messages the last line's usage counts).
- Most scenarios use \`cli\` / version 2.1.200 with \`origin\`+\`promptSource\` on prompts. Scenario 03 mimics an older
  version (2.1.150) with no \`origin\`; 15 and 16 use 2.1.280.
- turn_duration system records are written with the full envelope (uuid, parentUuid) and sit in the parentUuid chain.
- Files that must be ignored by a scan: see scenario 21.

## Scenario table
`)
  L.push('| # | scenario | project key | session id(s) | headline facts |\n|---|---|---|---|---|')
  const row = (n: string, name: string, key: string, ids: string, facts: string) =>
    L.push(`| ${n} | ${name} | \`${key}\` | ${ids} | ${facts} |`)
  const I = (...x: string[]) => x.map((s) => `\`${s}\``).join('<br>')
  row(
    '01',
    'plain',
    keyOf('plain'),
    I(d(1)),
    `2 turns, 5 assistant messages, ai-title "Add login page", cost ${total('01')}`,
  )
  row(
    '02',
    'multi-line message',
    keyOf('multi-line'),
    I(d(2)),
    `1 turn, 2 distinct messages (5 assistant lines), cost ${total('02')}`,
  )
  row(
    '03',
    'slash commands, titles',
    keyOf('slash'),
    I(d(3)),
    `title "My logout work" (custom beats ai-title), 2 model-answered turns, cost ${total('03')}`,
  )
  row('04', 'interruption', keyOf('interrupt'), I(d(4)), `8 turns; 4 interrupted; cost ${total('04')}`)
  row(
    '05a',
    'compaction, two pairs',
    keyOf('s05-compaction'),
    I(d(5, 1)),
    `4 turns, 2 compactions, cost ${total('05a')}`,
  )
  row(
    '05b',
    'file begins with boundary',
    keyOf('s05-compaction'),
    I(d(5, 2)),
    `1 turn, 1 compaction (leading), cost ${total('05b')}`,
  )
  row('05c', 'repeated uuid', keyOf('s05-compaction'), I(d(5, 3)), `2 turns, 2 messages, cost ${total('05c')}`)
  row(
    '05d',
    'subagent that compacts',
    keyOf('s05-compaction'),
    I(d(5, 4), aid(5, 1)),
    `1 turn, 1 agent with 1 compaction, cost ${total('05d')}`,
  )
  row('06', 'sync subagent', keyOf('subsync'), I(d(6), aid(6, 1)), `1 turn, 1 agent (meta link), cost ${total('06')}`)
  row(
    '07',
    'background subagent',
    keyOf('subbg'),
    I(d(7), BG),
    `2 human turns + 1 task-notification turn, 1 background agent, cost ${total('07')}`,
  )
  row(
    '08',
    'nested subagent',
    keyOf('subnest'),
    I(d(8), aid(8, 1), aid(8, 2)),
    `1 turn, agents A (depth 1) and B (depth 2, parent A), cost ${total('08')}`,
  )
  row(
    '09',
    'teammate',
    keyOf('team'),
    I(d(9), TM),
    `2 human turns, 1 teammate "reviewer" with 1 inbox message, cost ${total('09')}`,
  )
  row(
    '10',
    'fork agents',
    keyOf('fork'),
    I(d(10), aid(10, 1), aid(10, 2), aid(10, 3)),
    `1 turn, 3 fork agents, 1 message shared by two of them, cost ${total('10')}`,
  )
  row(
    '11',
    'linkage fallbacks',
    keyOf('linkage'),
    I(d(11), aid(11, 1), aid(11, 2), aid(11, 3)),
    `1 turn, 3 agents: tool-result, prompt, unresolved; cost ${total('11')}`,
  )
  row(
    '12',
    'orphan',
    keyOf('orphan'),
    I(d(12), aid(12, 1), 'a1b2c3d', 'acompact-12e0c0de'),
    `no main file, 3 agent files, cost ${total('12')}`,
  )
  row(
    '13a',
    'copy: continuation, unmarked',
    keyOf('s13a-continuation'),
    I(d(13, 1), d(13, 2)),
    `B copies all of A then adds 1 turn; unique cost ${total('13a')}`,
  )
  row(
    '13b',
    'copy: fork, unmarked',
    keyOf('s13b-fork-unmarked'),
    I(d(13, 3), d(13, 4)),
    `both continue after the copy point; unique cost ${total('13b')}`,
  )
  row(
    '13c',
    'copy: fork, forkedFrom',
    keyOf('s13c-fork-marked'),
    I(d(13, 5), d(13, 6)),
    `like 13b, copied records carry forkedFrom; unique cost ${total('13c')}`,
  )
  row(
    '13d',
    'copy: partial, session_id',
    keyOf('s13d-partial-copy'),
    I(d(13, 7), d(13, 8)),
    `B = boundary + summary + A's tail (session_id marked) + 1 turn; unique cost ${total('13d')}`,
  )
  row(
    '13e',
    'copy: SDK pickup',
    keyOf('s13e-sdk-pickup'),
    I(d(13, 9), d(13, 10)),
    `B mixes cli and sdk-cli records, not scripted; unique cost ${total('13e')}`,
  )
  row(
    '14',
    'rewind in one file',
    keyOf('rewind'),
    I(d(14)),
    `6 prompts, 4 active turns, 2 abandoned, 2 branch points, cost ${total('14')}`,
  )
  row(
    '15',
    'sdk one-shot',
    keyOf('sdk'),
    I(d(15)),
    `1 turn, all sdk-cli, cost-state at end, transcript cost ${total('15')}`,
  )
  row(
    '16',
    'cost-state, many models',
    keyOf('coststate'),
    I(d(16), aid(16, 1)),
    `3 turns, models opus/sonnet/fable + haiku agent, 2 cost-state records, transcript cost ${total('16')}`,
  )
  row(
    '17',
    'hostile input',
    keyOf('hostile'),
    I(d(17)),
    `3 turns, 1 corrupt line, 1 unknown type, 1 line over 1 MB, partial tail, 1 synthetic message, cost ${total('17')}`,
  )
  row('18', 'cwd change', keyOf('cwdchange'), I(d(18)), `3 turns, cwd and branch change twice, cost ${total('18')}`)
  row('19', 'day boundary', keyOf('daybound'), I(d(19)), `3 turns, tz America/New_York, cost ${total('19')}`)
  row(
    '20',
    'pricing edges',
    keyOf('pricing'),
    I(d(20)),
    `1 turn, 4 messages, unpriced model, fast speed, mixed cache writes`,
  )
  row(
    '21',
    'non-transcript files',
    keyOf('misc'),
    I(d(21)),
    `1 turn; notes.jsonl, vercel-plugin/, sessions-index.json, memory/ ignored; cost ${total('21')}`,
  )
  row(
    '22',
    'nested project dir',
    keyOf('nest'),
    I(d(22, 1), d(22, 2), aid(22, 1)),
    `outer session, plus inner project directory with a session and 1 agent; cost ${total('22')}`,
  )
  L.push(`
Also: \`claude/sessions/4242.json\` (pid 4242, session ${d(1)}, busy) and \`claude/sessions/4343.json\` (pid 4343, session ${d(3)}, idle).
Neither pid is expected to be alive. \`startedAt\`/\`updatedAt\` there are epoch milliseconds (assumed).

## Details and expected costs
`)

  L.push(`### 01 plain
Prompts: "add a login page" (turn 1, ends end_turn, turn_duration 12000 ms), "now add a logout button" (turn 2, 8000 ms). 5 assistant
messages, 3 tool_use. An attachment record follows the first prompt. ai-title "Add login page". Final text turn 1 "Done, 3 files changed".
Live registry file sessions/4242.json points here.

${B('01')}
`)
  L.push(`### 02 multi-line message
\`msg_multi_01\` is 3 lines (thinking, text, tool_use) with output tokens 10, 60, 120 (last wins; other usage fields equal); \`msg_multi_02\` is 2 lines
(output 30, 45). Count: 2 messages, 1 turn, 1 tool call. Naive per-line summing would give wrong cost.

${B('02')}
`)
  L.push(`### 03 slash commands and titles (older version, no origin fields)
Records in order: isMeta caveat (not a prompt); \`/model sonnet\` command + its \`<local-command-stdout>\` (a command turn with no model response; stdout record is not a prompt);
"add a logout button" (typed turn); \`/review the login page\` (command turn, command "review" with args, model response); \`!ls src\` bash-input + bash-stdout (local, no response).
Titles: ai-title "Logout button task", then custom-title "My logout work", then ai-title "Logout and review": expected title **"My logout work"**.
Model-answered turns: 2. Live registry file sessions/4343.json points here.

${B('03')}
`)
  L.push(`### 04 interruption
1. "refactor the router": assistant text with stop_reason null, then a bare string \`[Request interrupted by user]\` -> turn 1 **interrupted**; the marker is not a turn.
2. "actually, rename router.ts to routes.ts": complete.
3. "add tests for routes.ts": tool_use, error tool_result, bare array-form \`[Request interrupted by user for tool use]\` -> turn 3 **interrupted**.
4. "use the built-in runner instead": a normal prompt after the marker, complete.
5. "rename routes.ts to paths.ts": partial answer, then ONE record with content array [marker text, "stop, keep the old name"] -> turn 5 **interrupted**, and
   a new turn 6 with the marker stripped: "stop, keep the old name" (answered "Okay, keeping routes.ts").
6. "add a changelog entry": partial answer, then a string \`[Request interrupted by user]use tabs not spaces\` -> turn **interrupted**, new turn "use tabs not spaces".
Totals: turns = 8 (refactor, rename, tests, built-in runner, rename-again, stop-keep, changelog, use-tabs); interrupted = 4 (refactor, tests, rename-again, changelog).
(The marker-with-text forms in 5 and 6 are my reading of PLAN.md section 5 "With text after it, the marker is stripped and the rest is a turn".)

${B('04')}
`)
  L.push(`### 05 compaction (project ${keyOf('s05-compaction')}, 4 sessions)
- **05a** \`${d(5, 1)}\`: turns 1-2 before, boundary #1 (**auto**, preTokens 150000, postTokens 12000, durationMs 8000, logicalParentUuid resolves, summary at +1),
  turn 3 between, boundary #2 (**manual**, preTokens 90000, **no postTokens**, logicalParentUuid \`05010000-ffff-4000-9000-000000000999\` is **not in the file**,
  an attachment record sits between boundary and summary so the summary is at +2), turn 4 after. 4 turns, 2 compactions, 2 epoch changes.
- **05b** \`${d(5, 2)}\`: the file BEGINS with a manual boundary (logicalParentUuid not in file) + summary, then one turn. 1 compaction at epoch 0, no earlier turns.
- **05c** \`${d(5, 3)}\`: 2 turns. Two trailing records repeat the uuid of the first prompt and of the first assistant message (with different text and a huge usage,
  message id \`msg_cmpc_dup\`); both must be **skipped**, so turns = 2 and cost is unaffected.
- **05d** \`${d(5, 4)}\` + agent \`${aid(5, 1)}\`: the agent file contains a manual boundary (pre 80000, post 9000) + summary; 1 compaction on the agent.

05a
${B('05a')}

05b
${B('05b')}

05c
${B('05c')}

05d
${B('05d')}
`)
  L.push(`### 06 sync subagent
Main prompt, Agent tool_use \`toolu_sync_01\` (subagent_type Explore), agent \`${aid(6, 1)}\` (meta.toolUseId \`toolu_sync_01\`, spawnDepth 1), tool_result with
toolUseResult status completed (agentId, totalTokens, totalDurationMs). Linkage "meta". Agent cost uses 5m cache writes. Also present and to be ignored:
\`<session>/tool-results/toolu_sync_01.txt\`, \`<session>/custom-title.json\`.

${B('06')}
`)
  L.push(`### 07 background subagent
Agent \`${BG}\` launched by \`toolu_bg_01\` (run_in_background); tool_result status async_launched with agentId and outputFile. It runs 20s-60s after the start.
At +120 s a user record with origin task-notification (and the \`<task-notification>\` text prefix, \`<task-id>\` = agent id) starts a model response: that is
a turn of origin task-notification, not human. Turns: human "run the slow audit..." , task-notification, human "fix the first issue" = 3 turns, 2 human.

${B('07')}
`)
  L.push(`### 08 nested subagent
Main spawns A (\`${aid(8, 1)}\`, toolu_nest_01, depth 1); A's file contains the Agent tool_use \`toolu_nest_02\` that spawns B (\`${aid(8, 2)}\`, depth 2, meta.parentAgentId = A).
Both agent files sit flat in the same \`subagents/\` directory. Subtree cost of A = A + B.

${B('08')}
`)
  L.push(`### 09 teammate
Agent tool_use \`toolu_team_01\` has \`name: "reviewer"\`, team_name acme-team; result status teammate_spawned (\`agent_id: reviewer@acme-team\`). Agent file
\`agent-${TM}.jsonl\` (agentId \`${TM}\`), meta agentType/name reviewer, teamName acme-team, taskKind in_process_teammate, spawnDepth 0, **no toolUseId**
(so linkage must be by name). Turn 2 sends a SendMessage; the agent file then gets a user record origin peer with a \`<teammate-message ...>\` body: 1 inbox message
("Please also check the tests."). Agent has 3 assistant messages.

${B('09')}
`)
  L.push(`### 10 fork agents
Main has one message \`msg_fork_01\` in 3 lines, each an Agent tool_use (fork type). Agents: \`${aid(10, 1)}\` (sqlite) and \`${aid(10, 2)}\` (postgres) are old-style forks: each starts with the same
two context records (same uuid and timestamp: a user prompt and assistant \`msg_fork_ctx_01\`), then its own; \`${aid(10, 3)}\` (mysql) is new-style: a \`fork-context-ref\` record
(no uuid) instead of copied context. All three: meta isFork true, agentType fork. \`msg_fork_ctx_01\` is billed **once**.
Naive per-file sums: ${naive(FILES.filter((f) => f.agent && f.sid === sid(10)))} (sums of fork files exceed the true total).

${B('10')}
`)
  L.push(`### 11 linkage fallbacks
Main message \`msg_link_01\` spawns two agents (\`toolu_link_01\` "Find the entry point.", \`toolu_link_02\` "List the config files.").
- \`${aid(11, 1)}\`: meta without toolUseId; its first prompt ("Context: the repo is small. Find the entry point.") does not equal the input prompt; the \`toolu_link_01\` result has toolUseResult.agentId -> linkage **tool-result**.
- \`${aid(11, 2)}\`: meta without toolUseId; the \`toolu_link_02\` result has no agentId; first prompt equals input.prompt exactly -> linkage **prompt**.
- \`${aid(11, 3)}\`: no meta file, prompt matches nothing, no result names it -> **unresolved** (attached to the session root).

${B('11')}
`)
  L.push(`### 12 orphan
\`projects/${keyOf('orphan')}/${d(12)}/subagents/\` holds \`agent-${aid(12, 1)}.jsonl\` (+meta whose toolUseId matches nothing), \`agent-a1b2c3d.jsonl\` (old style, no meta) and
\`agent-acompact-12e0c0de.jsonl\` (compaction agent, no meta). There is **no** \`${d(12)}.jsonl\`. Records have sessionId ${d(12)}, version 2.1.71.

${B('12')}
`)
  L.push(`### 13 copied history
Copied records keep uuid, message.id, timestamp; sessionId is rewritten. Common conversation (A): "add a search box" (tool_use, result, answer, turn_duration) and "style the search box".
Naive per-file sums are shown to demonstrate the double counting; the unique cost is what counts.
- **13a** continuation, unmarked: \`${d(13, 1)}\` (A) has 2 turns and stops. \`${d(13, 2)}\` (B) = all of A's records + turn "add a clear button". A has no records after the copy point. Per file: ${naive(P13a)}.
- **13b** fork, unmarked: A \`${d(13, 3)}\` has 2 turns then its own "add search history" 5 minutes later; B \`${d(13, 4)}\` copies A's first 2 turns, then "add search suggestions". Both continue. Per file: ${naive([P13b.A, P13b.B])}.
- **13c** fork marked: same shape as 13b (A \`${d(13, 5)}\`, B \`${d(13, 6)}\`) but every copied record in B has \`forkedFrom: {sessionId: A, messageUuid: <its own uuid>}\`. Per file: ${naive([P13c.A, P13c.B])}.
- **13d** partial copy: A \`${d(13, 7)}\` has 3 turns (the third is "add a reset button"). B \`${d(13, 8)}\` begins with a compact boundary (auto) + summary, then **only A's third turn** copied with \`session_id\` = A and \`sessionId\` = B,
  then B's own "add a disabled state". The copied head's parentUuid points to a record that is not in B. Boundary and summary timestamps precede the copied tail so the file stays ordered. Per file: ${naive([P13d.A, P13d.B])}.
- **13e** SDK pickup: A \`${d(13, 9)}\` all \`cli\`; B \`${d(13, 10)}\`'s copied records are \`cli\`, its own turn "add a clear button" is \`sdk-cli\` (promptSource sdk). B must be classified **interactive**, not sdk. Per file: ${naive([P13e.A, P13e.B])}.

13a
${B('13a')}

13b
${B('13b')}

13c
${B('13c')}

13d
${B('13d')}

13e
${B('13e')}
`)
  L.push(`### 14 rewind inside one file
Chain: every record (including attachments and turn_duration) is linked by parentUuid.
- T0 "scaffold the app" (complete). Its turn_duration \`X\` has **two** child prompts:
  "add a settings page" (answered, **abandoned**) and "add a profile page instead" (active). Branch point 1.
- After the profile turn's turn_duration \`Y\`: "add dark mode" (no response at all, **abandoned**) and "add light mode" (active). Branch point 2.
- "rename both config files": one assistant record (\`msg_rw_05\`) with two tool_use blocks; its two tool_result children are siblings; the conversation continues from the second.
  **Not** a branch point.
Totals: 6 prompts, 4 active turns (scaffold, profile, light mode, rename), 2 abandoned (settings, dark mode), 2 branch points. Messages \`msg_rw_02\` belongs to the abandoned
branch but is still billed. \`last-prompt.leafUuid\` names the last record.

${B('14')}
`)
  L.push(`### 15 sdk one-shot
All records \`sdk-cli\`, one prompt (promptSource sdk). A \`cost-state\` record at the end: totalCostUSD = transcript cost + an unrecorded haiku line (1000 in x $1/M + 100 out x $5/M = $0.0015).
Transcript cost ${total('15')}; cost-state total = ${total('15')} + $0.0015. startTime is epoch milliseconds (assumed).

${B('15')}
`)
  L.push(`### 16 cost-state, many models
Turn 1 on \`claude-opus-5-5\`, then cost-state #1 (first process exit, covering opus only plus the hidden haiku line); an hour later the session resumes: turn 2 on sonnet-5-5 with a haiku
subagent (\`${aid(16, 1)}\`), turn 3 on \`claude-fable-5-1\`; cost-state #2 is cumulative (same startTime). modelUsage keys for opus carry a \`[1m]\` suffix
(\`claude-opus-5-5[1m]\`); the assistant messages' \`model\` has no suffix (assumed). Each cost-state also contains a haiku line that includes a hidden 1000 in / 100 out call
($0.0015) that appears in no transcript. Transcript cost = sum below; cost-state #2 total = transcript cost + $0.0015.

${B('16')}
`)
  L.push(`### 17 hostile input
Line order: prompt, assistant tool_use, **corrupt** line (terminated, not JSON), **unknown type** \`hologram-state\`, tool_result with a **1.1 MB** content string (valid JSON, > 1 MB line), assistant with an unknown
envelope field and an unknown message field, turn_duration, prompt, assistant \`<synthetic>\` (\`isApiErrorMessage\`, no cost), prompt, assistant, turn_duration, and finally a **partial line with no trailing newline**.
Expected: 3 turns, bad lines = 1 (the corrupt one; the unterminated tail is not consumed), unknown types = {hologram-state: 1}, synthetic message not priced, \`msg_host_synth\` absent from messages.

${B('17')}
`)
  L.push(`### 18 cwd change
Turn 1 cwd \`${cwdOf('cwdchange')}\` branch main. Then a \`worktree-state\` record (shape assumed: {worktreeSession:{originalCwd, worktreePath, worktreeName, worktreeBranch}}); turn 2 records carry
cwd \`${cwdOf('cwdchange-wt')}\`, gitBranch \`worktree-login\`. Then a \`relocated\` record (\`relocatedCwd\`); turn 3 cwd \`${cwdOf('cwdchange-moved')}\`, gitBranch main.
Expected: cwds [${cwdOf('cwdchange')}, ${cwdOf('cwdchange-wt')}, ${cwdOf('cwdchange-moved')}], gitBranches [main, worktree-login, main] (as a set: main, worktree-login). The project key is derived from the first cwd.

${B('18')}
`)
  L.push(`### 19 day boundary
**The test must use time zone \`America/New_York\`** (UTC-4 on this date); local midnight = 2026-09-19T04:00:00Z. In UTC everything is on 2026-09-19; in New York:
| message | UTC | local | local day |
|---|---|---|---|
| msg_day_01 | 03:50:10Z | 23:50:10 | 2026-09-18 |
| msg_day_02 | 03:59:50Z | 23:59:50 | 2026-09-18 |
| msg_day_03 | 04:00:30Z | 00:00:30 | 2026-09-19 |
| msg_day_04 | 04:05:20Z | 00:05:20 | 2026-09-19 |
Turn 2 ("add a header") starts 2026-09-18 23:59:30 local and ends 2026-09-19 00:00:32 local (62 s). Daily cost by local day: see below.

${(() => {
  const m = ledger('19')
  const day = (ids: string[]) => money(ids.reduce((a, i) => a + (entryCost(m.get(i)!)?.h ?? 0), 0))
  return `2026-09-18 (msg_day_01 + msg_day_02) = ${day(['msg_day_01', 'msg_day_02'])}; 2026-09-19 (msg_day_03 + msg_day_04) = ${day(['msg_day_03', 'msg_day_04'])}.`
})()}

${B('19')}
`)
  L.push(`### 20 pricing edges
\`msg_px_01\` opus-5-5 with 400 5m + 600 1h cache writes (usage.cache_creation_input_tokens = 1000). \`msg_px_02\` opus-5-5 with \`speed: "fast"\` (price doubled: **assumed rule**, transcript-format.md section 8).
\`msg_px_03\` model \`claude-nova-9-9\`, not in the table: must be reported **unpriced** (diagnostics.unpricedModels), contributes no cost. \`msg_px_04\` sonnet with
\`server_tool_use.web_search_requests: 2\` (not priced). Total below is priced messages only (px_03 excluded).

${B('20')}
`)
  L.push(`### 21 non-transcript files
Project \`${keyOf('misc')}\` holds one real session \`${d(21)}\` plus files a scan must ignore: \`notes.jsonl\` (basename not a uuid, though its first line looks like a user record), \`vercel-plugin/skill-injections.jsonl\`,
\`sessions-index.json\`, \`memory/MEMORY.md\`.

${B('21')}
`)
  L.push(`### 22 nested project directory
\`projects/${keyOf('nest')}/\` has its own session \`${d(22, 1)}\` and a directory \`${keyOf('nest')}/-home-dev-acme-nest-inner/\` that holds session \`${d(22, 2)}\` (cwd \`${cwdOf('nest/inner')}\`) with agent \`${aid(22, 1)}\` under
\`<session>/subagents/\`. A recursive walk finds both sessions; the inner one's project key is the nested directory name.

${B('22')}
`)
  return L.join('\n')
}

// ================================================================ write everything
rmSync(OUT, { recursive: true, force: true })
const put = (rel: string, content: string) => {
  const p = join(OUT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}
for (const f of FILES) {
  if (f.rel === 'unused') continue
  put(f.rel, f.lines.join('\n') + '\n' + f.tail)
}
for (const [rel, content] of RAW) put(rel, content)
writeFileSync(join(HERE, 'README.md'), readme())
console.log(`wrote ${FILES.length} transcript files, ${RAW.size} other files`)
