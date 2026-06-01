#!/usr/bin/env bun

/**
 * Daemon CLI entry point.
 *
 * Usage:
 *   bun src/cli/start-daemon.ts                      # start with existing pairings
 *   bun src/cli/start-daemon.ts --pair               # pair first, then start
 *   bun src/cli/start-daemon.ts --add-client         # add another client while running
 *   bun src/cli/start-daemon.ts --relay http://...    # custom relay URL
 *   bun src/cli/start-daemon.ts --name myhost        # instance name
 *   bun src/cli/start-daemon.ts -w                   # also serve the web client
 *   bun src/cli/start-daemon.ts -w --web-port 4860   # web client on a custom port
 *
 * With -w the daemon and web client share an ephemeral encryption key
 * in-process over the local relay — no pairing, QR, or on-disk key needed.
 *
 * Web port resolves as: --web-port flag > $PORT env (portless/PaaS) > 4860.
 * Under portless, $HOST/$PORTLESS_URL also drive the bind host (dual-stack).
 */

import os from 'node:os'
import path from 'node:path'
import { createRelay, initiatePairing, loadPairings, loadSharedKey } from '@merlin/relay'
import type { Server } from 'bun'
import dotenv from 'dotenv'
import qrcode from 'qrcode-terminal'
import { Daemon, type RelayPairing } from '../daemon.ts'
import { DaemonTUI } from '../tui/daemon-tui.ts'
import { createBridge } from '../web/bridge.ts'
import { runSetup } from './setup.ts'
import { runUpgrade } from './upgrade.ts'

// Version is injected at compile time via `--define` (see scripts/build-bin.ts).
// Running from source it's undefined → "dev".
const MERLIN_VERSION = process.env.MERLIN_VERSION ?? 'dev'

// Subcommand routing. The default (no recognized verb) starts the daemon, so the
// bare `merlin` invocation keeps working exactly as before.
{
  const verb = process.argv[2]
  if (verb === '--version' || verb === '-v' || verb === 'version') {
    console.log(MERLIN_VERSION)
    process.exit(0)
  }
  if (verb === 'setup') {
    await runSetup()
    process.exit(0)
  }
  if (verb === 'upgrade' || verb === 'update') {
    try {
      await runUpgrade({ checkOnly: process.argv.includes('--check') })
      process.exit(0)
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`)
      process.exit(1)
    }
  }
}

// Load ~/.merlin/.env before anything reads process.env (the Daemon ctor reads
// model + API-key vars). This is the stable config home for the compiled binary,
// which otherwise only sees whatever cwd it was launched from. We parse into a
// throwaway object and apply fill-gaps ourselves so existing vars always win —
// shell env and Bun's cwd .env override the file — and we can log what was set.
const merlinEnvPath = path.join(process.env.HOME || os.homedir(), '.merlin', '.env')
const merlinEnv = dotenv.config({ path: merlinEnvPath, processEnv: {} }).parsed ?? {}
const appliedEnv = Object.keys(merlinEnv).filter((k) => process.env[k] === undefined)
for (const k of appliedEnv) process.env[k] = merlinEnv[k]

const args = process.argv.slice(2)
const doPair = args.includes('--pair')
const doAddClient = args.includes('--add-client')
const nameIdx = args.indexOf('--name')
const name = nameIdx >= 0 ? args[nameIdx + 1] : 'main'
const relayIdx = args.indexOf('--relay')
const customRelay = relayIdx >= 0 ? args[relayIdx + 1] : undefined
const doWeb = args.includes('-w') || args.includes('--web')
const webPortIdx = args.indexOf('--web-port')
// Web port priority: --web-port flag > $PORT (portless/PaaS) > default 4860.
const webPort =
  webPortIdx >= 0 ? parseInt(args[webPortIdx + 1], 10) : process.env.PORT ? parseInt(process.env.PORT, 10) : 4860
// Bind host: under portless, HOST is injected. PORTLESS_URL registers `localhost`
// (IPv6-first on macOS), so dual-stack bind to `::` keeps both ::1 and 127.0.0.1
// reachable. Mirrors the Vite handling in src/web/dev.ts.
const webHost = process.env.HOST ? (process.env.PORTLESS_URL ? '::' : process.env.HOST) : undefined

let localRelay: Server | null = null
let bridgeServer: Server | null = null

function showPairingCode(code: string, pairingUrl: string, expiresIn: number): void {
  const spaced = code.split('').join('  ')
  console.log()
  console.log('  ┌─────────────────────────────────┐')
  console.log('  │         Pairing Code             │')
  console.log('  │                                   │')
  console.log(`  │       ${spaced}       │`)
  console.log('  │                                   │')
  console.log(`  │   Expires in ${Math.floor(expiresIn / 60)} minutes            │`)
  console.log('  └─────────────────────────────────┘')
  console.log()
  qrcode.generate(pairingUrl, { small: true }, (qr: string) => {
    console.log(qr)
    console.log('  Scan the QR code with your iPhone camera,')
    console.log('  or enter the code in the app or TUI client.')
    console.log('  Waiting for client...')
    console.log()
  })
}

async function getRelayUrl(): Promise<string> {
  if (customRelay) return customRelay
  if (!localRelay) {
    localRelay = createRelay(4857)
    console.log(`  Local relay started on port ${localRelay.port}`)
  }
  return `http://localhost:${localRelay.port}`
}

async function main() {
  const existingPairings = await loadPairings(name)

  if (doPair || (existingPairings.length === 0 && !doWeb)) {
    // Initial pairing — pair the first client
    const relayUrl = await getRelayUrl()
    await initiatePairing({ relayHttpUrl: relayUrl, name, onCodeReady: showPairingCode })
    // Reload pairings after initial pairing
    const pairings = await loadPairings(name)
    await startDaemon(pairings)
  } else if (doAddClient) {
    // Start daemon with existing pairings, then add a new one
    const pairings = existingPairings
    const daemon = await startDaemon(pairings)

    // Now pair another client
    const relayUrl = pairings[0]?.relayUrl ?? (await getRelayUrl())
    console.log()
    console.log('  Adding new client...')
    await initiatePairing({ relayHttpUrl: relayUrl, name, onCodeReady: showPairingCode })

    // Connect the new pairing to the running daemon
    const newPairings = await loadPairings(name)
    const newPairing = newPairings[newPairings.length - 1]
    const sharedKey = await loadSharedKey(newPairing)
    daemon.addConnector({
      relayUrl: newPairing.relayUrl.replace(/^http/, 'ws'),
      token: newPairing.sessionToken,
      sharedKey,
    })
    console.log(`  New client connected (total: ${newPairings.length})`)
  } else {
    // Start with existing pairings
    await startDaemon(existingPairings)
  }
}

async function startDaemon(storedPairings: Awaited<ReturnType<typeof loadPairings>>): Promise<Daemon> {
  // Build relay pairings
  const pairings: RelayPairing[] = []
  for (const sp of storedPairings) {
    const sharedKey = await loadSharedKey(sp)
    const wsUrl = sp.relayUrl.replace(/^http/, 'ws')

    // Start local relay if pairing used localhost
    if (sp.relayUrl.includes('localhost') && !customRelay && !localRelay) {
      const port = parseInt(new URL(sp.relayUrl).port, 10)
      localRelay = createRelay(port)
      console.log(`  Local relay started on port ${localRelay.port}`)
    }

    pairings.push({ relayUrl: wsUrl, token: sp.sessionToken, sharedKey })
  }

  const tui = new DaemonTUI()

  if (appliedEnv.length > 0) {
    tui.log(`env: loaded ${appliedEnv.length} var(s) from ${merlinEnvPath}`)
  }

  const daemon = new Daemon({
    instanceName: name,
    pairings,
    log: tui.log,
  })

  const shutdown = async () => {
    tui.cleanup()
    console.log('  Shutting down...')
    bridgeServer?.stop(true)
    await daemon.stop()
    localRelay?.stop(true)
    process.exit(0)
  }

  await daemon.start()
  tui.attach(daemon, {
    instanceName: name,
    getRelayUrl,
    onQuit: () => void shutdown(),
  })

  if (doWeb) {
    await startWebClient(daemon, tui.log)
  }

  // Surface the live ports in the dashboard (startup logs scroll away).
  tui.setEndpoints({ relayPort: localRelay?.port, webPort: bridgeServer?.port })

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  return daemon
}

/**
 * Bootstrap the embedded web client.
 *
 * Generates an ephemeral session token + AES-256-GCM key, joins the daemon to
 * that relay room as a connector, and starts the bridge as the matching client.
 * The key is shared in-process only — never persisted or sent over the wire.
 */
async function startWebClient(daemon: Daemon, log: (msg: string) => void): Promise<void> {
  // Ensure a relay is reachable (starts the local relay if none yet).
  const relayHttpUrl = await getRelayUrl()

  // The web UI is served from the embedded/built asset map. We never build it
  // here — from source run `bun run web:build`; the compiled binary embeds it.
  // If it's missing the bridge serves a clear 503 telling you what to run.

  // Ephemeral, in-process credentials shared by daemon and bridge.
  const token = crypto.randomUUID()
  const sharedKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])

  daemon.addConnector({
    relayUrl: relayHttpUrl.replace(/^http/, 'ws'),
    token,
    sharedKey,
  })

  bridgeServer = await createBridge({
    port: webPort,
    hostname: webHost,
    log,
    credentials: { token, sharedKey, relayUrl: relayHttpUrl },
  })

  log(`  Web client: http://localhost:${bridgeServer.port}`)
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
