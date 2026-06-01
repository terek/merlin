#!/usr/bin/env bun
/**
 * TUI client: pair with daemon, multi-screen interface.
 *
 * Usage:
 *   bun src/cli/tui.ts                            # connect with existing pairing
 *   bun src/cli/tui.ts --pair                     # pair first
 *   bun src/cli/tui.ts --relay http://...          # custom relay URL
 *   bun src/cli/tui.ts --name client1             # client name (for stored keypair)
 */

import type { ActiveSession, ClientMessage, DaemonMessage, MerlinModel } from '@merlin/protocol'
import {
  decryptEnvelope,
  encryptPayload,
  joinPairing,
  loadPairing,
  loadSharedKey,
  type RelayEnvelope,
} from '@merlin/relay'
import { applyOps } from '@merlin/sync'
import { renderScreen } from '../tui/render.ts'
import { handleArchivedKey } from '../tui/screens/archived.ts'
import { handleChatKey } from '../tui/screens/chat.ts'
import { handleProjectsKey } from '../tui/screens/projects.ts'
import type { KeyResult, RenderContext, TuiScreen } from '../tui/state.ts'
import { initialState } from '../tui/state.ts'

const args = process.argv.slice(2)
const doPair = args.includes('--pair')
const nameIdx = args.indexOf('--name')
const name = nameIdx >= 0 ? args[nameIdx + 1] : 'client'
const relayIdx = args.indexOf('--relay')
const customRelay = relayIdx >= 0 ? args[relayIdx + 1] : undefined

// ── State ───────────────────────────────────────────────────────────────────

let model: MerlinModel | null = null
const sessions = new Map<string, ActiveSession>()
let sharedKey: CryptoKey
let token: string
let relayUrl: string
let daemonName: string | undefined
let connected = false
let ws: WebSocket | null = null
let screen: TuiScreen = initialState()

// ── Prompt for input (blocking) ─────────────────────────────────────────────

function prompt(message: string): Promise<string> {
  process.stdout.write(message)
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.removeListener('data', onData)
      resolve(chunk.toString().trim())
    }
    process.stdin.once('data', onData)
  })
}

// ── Pairing flow ────────────────────────────────────────────────────────────

async function pair(): Promise<void> {
  const relay = customRelay ?? 'http://localhost:4857'
  console.log()
  console.log('  Pairing with daemon')
  console.log(`  Relay: ${relay}`)
  console.log()

  process.stdin.setRawMode?.(false)
  process.stdin.resume()

  const code = await prompt('  Enter 6-character code: ')

  if (!code || code.length !== 6) {
    console.error('  Invalid code. Must be 6 characters.')
    process.exit(1)
  }

  try {
    const result = await joinPairing(relay, code.toUpperCase(), name)
    sharedKey = result.sharedKey
    token = result.sessionToken
    relayUrl = result.relayUrl
    daemonName = result.daemonName
    console.log(`  Paired with ${daemonName ?? 'daemon'} successfully!`)
    console.log()
  } catch (err) {
    console.error(`  Pairing failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

// ── Render context ──────────────────────────────────────────────────────────

function getRenderContext(): RenderContext {
  return {
    daemonName,
    connected,
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  }
}

// ── Message handling ────────────────────────────────────────────────────────

function handleMessage(msg: DaemonMessage): void {
  switch (msg.type) {
    case 'snapshot':
      if (msg.scope === 'metadata') {
        model = msg.data
      } else if (msg.scope === 'session') {
        sessions.set(msg.sessionId, msg.data)
      }
      break

    case 'patch':
      if (msg.scope === 'metadata' && model) {
        model = applyOps(model, msg.ops)
      } else if (msg.scope === 'session') {
        const existing = sessions.get(msg.sessionId)
        if (existing) {
          sessions.set(msg.sessionId, applyOps(existing, msg.ops))
        }
      }
      break

    // Clerk messages → update chat screen
    case 'clerk_chunk':
      if (screen.screen === 'chat') {
        appendClerkText(msg.conversationId, msg.text)
        if (!screen.conversationId) {
          screen = { ...screen, conversationId: msg.conversationId }
        }
      }
      break

    case 'clerk_tool_activity':
      if (screen.screen === 'chat') {
        const toolMsg = `[${msg.tool}] ${msg.description}`
        screen = {
          ...screen,
          messages: [...screen.messages, { role: 'tool', text: toolMsg, done: true }],
        }
      }
      break

    case 'clerk_done':
      if (screen.screen === 'chat') {
        finishClerkResponse()
      }
      break

    case 'clerk_error':
      if (screen.screen === 'chat') {
        screen = {
          ...screen,
          streaming: false,
          messages: [...screen.messages, { role: 'error', text: msg.error, done: true }],
        }
      }
      break

    case 'error':
      break
  }

  redraw()
}

/** Append streamed text to the last assistant message, or create one. */
function appendClerkText(conversationId: string, text: string): void {
  if (screen.screen !== 'chat') return
  const msgs = [...screen.messages]
  const last = msgs[msgs.length - 1]
  if (last && last.role === 'assistant' && !last.done) {
    msgs[msgs.length - 1] = { ...last, text: last.text + text }
  } else {
    msgs.push({ role: 'assistant', text, done: false })
  }
  screen = { ...screen, messages: msgs, conversationId }
}

/** Mark the last assistant message as done. */
function finishClerkResponse(): void {
  if (screen.screen !== 'chat') return
  const msgs = [...screen.messages]
  const last = msgs[msgs.length - 1]
  if (last && last.role === 'assistant' && !last.done) {
    msgs[msgs.length - 1] = { ...last, done: true }
  }
  screen = { ...screen, messages: msgs, streaming: false }
}

function redraw(): void {
  process.stdout.write(renderScreen(model, screen, getRenderContext()))
}

// ── WebSocket connection ────────────────────────────────────────────────────

function connect(): void {
  const wsUrl = relayUrl.replace(/^http/, 'ws')
  ws = new WebSocket(`${wsUrl}/ws?side=client&token=${encodeURIComponent(token)}`)

  ws.onopen = async () => {
    connected = true
    redraw()

    const envelope = await encryptPayload({ type: 'subscribe', scope: 'metadata' } satisfies ClientMessage, sharedKey)
    ws!.send(JSON.stringify(envelope))
  }

  ws.onmessage = async (event) => {
    try {
      const raw = JSON.parse(event.data as string)
      const decrypted = await decryptEnvelope(raw as RelayEnvelope, sharedKey)
      handleMessage(decrypted as DaemonMessage)
    } catch {
      /* ignore undecodable messages */
    }
  }

  ws.onclose = () => {
    connected = false
    redraw()
    setTimeout(connect, 2000)
  }

  ws.onerror = () => {}
}

async function sendCommand(msg: ClientMessage): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN) {
    const envelope = await encryptPayload(msg, sharedKey)
    ws.send(JSON.stringify(envelope))
  }
}

// ── Keyboard handling ───────────────────────────────────────────────────────

function setupKeyboard(): void {
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf-8')

  process.stdin.on('data', async (key: string) => {
    let result: KeyResult

    switch (screen.screen) {
      case 'projects':
        result = handleProjectsKey(key, screen, model)
        break
      case 'archived':
        result = handleArchivedKey(key, screen, model)
        break
      case 'chat':
        result = handleChatKey(key, screen)
        break
    }

    screen = result.state

    if (result.command) {
      await sendCommand(result.command)
    }

    if (result.quit) {
      process.stdout.write('\x1b[2J\x1b[H')
      ws?.close()
      process.exit(0)
    }

    redraw()
  })
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (doPair || !(await loadPairing(name))) {
    await pair()
  } else {
    const pairing = (await loadPairing(name))!
    sharedKey = await loadSharedKey(pairing)
    token = pairing.sessionToken
    relayUrl = pairing.relayUrl
    daemonName = pairing.daemonName
  }

  setupKeyboard()
  redraw()
  connect()
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
