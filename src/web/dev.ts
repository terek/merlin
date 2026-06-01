#!/usr/bin/env bun
/**
 * Dev helper: runs the bridge server and Vite dev server together.
 * Kills both on exit. Assumes the daemon is already running.
 */

import { spawn } from 'bun'

const bridgeArgs = process.argv.slice(2)

const bridge = spawn(['bun', 'src/web/start-bridge.ts', ...bridgeArgs], {
  stdio: ['inherit', 'inherit', 'inherit'],
  cwd: `${import.meta.dir}/../..`,
})

const viteArgs = ['bun', 'run', 'dev']
if (process.env.PORT) {
  viteArgs.push('--port', process.env.PORT)
}
if (process.env.HOST) {
  // portless injects HOST=127.0.0.1 but registers the route's upstream as
  // `localhost`, which resolves IPv6-first on macOS. Binding Vite to the
  // injected IPv4 host would leave [::1] dead and the proxy 404s. Use a
  // dual-stack bind under portless so it's reachable via ::1 and 127.0.0.1.
  const host = process.env.PORTLESS_URL ? '::' : process.env.HOST
  viteArgs.push('--host', host)
}

const vite = spawn(viteArgs, {
  stdio: ['inherit', 'inherit', 'inherit'],
  cwd: `${import.meta.dir}/client`,
})

function cleanup() {
  bridge.kill()
  vite.kill()
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

// Exit when either process dies
await Promise.race([bridge.exited, vite.exited])
cleanup()
