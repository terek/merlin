#!/usr/bin/env bun
/**
 * Start the bridge server (web client backend).
 *
 * Usage:
 *   bun src/web/start-bridge.ts                    # default settings
 *   bun src/web/start-bridge.ts --port 4860        # custom port
 *   bun src/web/start-bridge.ts --name client      # pairing name
 *   bun src/web/start-bridge.ts --relay http://...  # custom relay URL
 */

import { createBridge } from './bridge.ts'

const args = process.argv.slice(2)

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx >= 0 ? args[idx + 1] : undefined
}

const port = parseInt(getArg('--port') ?? '4860', 10)
const name = getArg('--name') ?? 'client'
const relay = getArg('--relay')

createBridge({ port, name, relay }).catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
