// Screenshot a page with headless Chrome over the DevTools protocol (no dependency):
//   bun dev/shot.ts <url> <out.png> [width] [height] [--wait-for <css>] [--eval <js>]... [--delay <ms>] [--port <n>]
// Starts Chrome on a temporary profile with a remote-debugging port, navigates, waits until the
// network is idle (the event stream does not count), then for --wait-for (a CSS selector that must
// match), then --delay ms (default 500), runs each --eval (an expression or async function body;
// awaited, its value printed), waits 300 ms and captures the viewport as PNG. Chrome is always
// shut down, also on failure. Unlike `chrome --screenshot` it works for pages that have scrolled
// (deep links) and for pages holding an event stream open.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const chromePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function parseArgs(argv: string[]) {
  const pos: string[] = []
  const evals: string[] = []
  let waitFor = ''
  let delay = 500
  let port = Number(process.env.SHOT_PORT ?? 9333)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--wait-for') waitFor = argv[++i] ?? ''
    else if (a === '--eval') evals.push(argv[++i] ?? '')
    else if (a === '--delay') delay = Number(argv[++i])
    else if (a === '--port') port = Number(argv[++i])
    else pos.push(a)
  }
  const [url, out, w, h] = pos
  if (!url || !out) {
    console.error(
      'usage: shot.ts <url> <out.png> [width] [height] [--wait-for <css>] [--eval <js>]... [--delay <ms>] [--port <n>]',
    )
    process.exit(2)
  }
  return { url, out, width: Number(w ?? 1440), height: Number(h ?? 900), waitFor, evals, delay, port }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  private id = 0
  private pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  private listeners: ((method: string, params: Record<string, unknown>) => void)[] = []
  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) p?.fail(new Error(`${msg.error.message}`))
        else p?.ok(msg.result)
      } else for (const l of this.listeners) l(msg.method, msg.params ?? {})
    })
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => ok(new Cdp(ws)))
      ws.addEventListener('error', () => fail(new Error('cannot open the DevTools socket')))
    })
  }
  send<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(l: (method: string, params: Record<string, unknown>) => void) {
    this.listeners.push(l)
  }
  close() {
    this.ws.close()
  }
}

async function evaluate(cdp: Cdp, expression: string): Promise<unknown> {
  const r = await cdp.send<{
    result: { value?: unknown; description?: string }
    exceptionDetails?: { text: string; exception?: { description?: string } }
  }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

async function run(opts: ReturnType<typeof parseArgs>, chromeExited: Promise<never>) {
  const base = `http://127.0.0.1:${opts.port}`
  let target: { webSocketDebuggerUrl: string } | undefined
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = (await (await fetch(`${base}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
      target = list.find((t) => t.type === 'page')
    } catch {}
    if (!target) await Promise.race([sleep(100), chromeExited])
  }
  if (!target) throw new Error(`Chrome did not open a page on port ${opts.port} (is the port in use?)`)

  const cdp = await Cdp.open(target.webSocketDebuggerUrl)
  // In flight requests, except event streams (they never finish).
  const inflight = new Map<string, string>()
  let lastActivity = Date.now()
  cdp.on((method, p) => {
    if (method === 'Network.requestWillBeSent') {
      const url = String((p.request as { url?: string })?.url ?? '')
      if (p.type === 'EventSource' || url.includes('/api/events')) return
      inflight.set(String(p.requestId), url)
      lastActivity = Date.now()
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      inflight.delete(String(p.requestId))
      lastActivity = Date.now()
    }
  })
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: opts.width,
    height: opts.height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const loaded = new Promise<void>((ok) =>
    cdp.on((m) => {
      if (m === 'Page.loadEventFired') ok()
    }),
  )
  await cdp.send('Page.navigate', { url: opts.url })
  await Promise.race([loaded, sleep(15000)])

  // Network idle: nothing in flight for 500 ms (at most 15 s).
  const idleDeadline = Date.now() + 15000
  while (Date.now() < idleDeadline && (inflight.size > 0 || Date.now() - lastActivity < 500)) await sleep(50)

  if (opts.waitFor) {
    const sel = JSON.stringify(opts.waitFor)
    const deadline = Date.now() + 15000
    let found = false
    while (Date.now() < deadline && !found) {
      found = (await evaluate(cdp, `!!document.querySelector(${sel})`)) === true
      if (!found) await sleep(25)
    }
    if (!found) throw new Error(`--wait-for ${opts.waitFor}: no match after 15 s`)
  }
  await sleep(opts.delay)

  for (const js of opts.evals) {
    // An expression, or a statement list when it has a `return`.
    const expr = /\breturn\b|;/.test(js) ? `(async () => { ${js} })()` : js
    const v = await evaluate(cdp, expr)
    if (v !== undefined) console.log(`eval: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  if (opts.evals.length) await sleep(300)

  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
  writeFileSync(opts.out, Buffer.from(shot.data, 'base64'))
  cdp.close()
}

const opts = parseArgs(process.argv.slice(2))
const profile = mkdtempSync(join(tmpdir(), 'explorer-shot-'))
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${opts.port}`,
    `--window-size=${opts.width},${opts.height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)
const chromeExited = new Promise<never>((_, fail) => {
  chrome.on('exit', (code) => fail(new Error(`Chrome exited early (${code})`)))
  chrome.on('error', (e) => fail(e))
})
chromeExited.catch(() => {})

let status = 0
const hard = setTimeout(() => {
  console.error('shot: timed out after 60 s')
  cleanup()
  process.exit(1)
}, 60000)

function cleanup() {
  try {
    chrome.kill('SIGKILL')
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
}

try {
  rmSync(opts.out, { force: true })
  await run(opts, chromeExited)
  console.log(`wrote ${opts.out}`)
} catch (e) {
  console.error(`shot: ${e instanceof Error ? e.message : e}`)
  status = 1
} finally {
  clearTimeout(hard)
  cleanup()
}
process.exit(status)
