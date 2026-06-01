#!/usr/bin/env bun
/**
 * Build shippable single-file binaries via `bun build --compile`.
 *
 * Always rebuilds the web client first (so the embedded asset map is fresh),
 * then cross-compiles the daemon for each target. Cross-compilation works from
 * any host — building macOS + Linux binaries from a Mac is fine.
 *
 * Usage:
 *   bun run build:bin                       # default target set
 *   bun run build:bin linux-arm64 darwin-arm64   # specific targets
 *   bun run build:bin all                    # every supported target
 */

import * as path from 'node:path'

const root = path.join(import.meta.dir, '..')
const entry = path.join(root, 'src', 'cli', 'start-daemon.ts')
const outDir = path.join(root, 'bin')

// Version baked into the binary (surfaced by `merlin --version`). CI sets
// $MERLIN_VERSION from the release tag; from a local build we fall back to the
// package.json version so a hand-built binary still self-identifies.
const pkg = (await Bun.file(path.join(root, 'package.json')).json()) as { version?: string }
const version = process.env.MERLIN_VERSION || pkg.version || 'dev'

// Bun --compile targets. `musl` = Alpine, `baseline` = pre-AVX2 CPUs.
const ALL = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-arm64-musl',
  'linux-x64',
  'linux-x64-musl',
  'windows-x64',
] as const

const DEFAULT = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']

const args = process.argv.slice(2)
const targets = args.length === 0 ? DEFAULT : args.includes('all') ? [...ALL] : args

async function run(cmd: string[], cwd = root): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}`)
}

// 1. Fresh web client + embedded asset map.
console.log('▶ building web client (bun run web:build)')
await run(['bun', 'run', 'web:build'])

// 2. Cross-compile each target.
for (const t of targets) {
  if (!(ALL as readonly string[]).includes(t)) {
    console.error(`✗ unknown target "${t}" — valid: ${ALL.join(', ')}`)
    process.exit(1)
  }
  const ext = t.startsWith('windows') ? '.exe' : ''
  const outfile = path.join(outDir, `merlin-${t}${ext}`)
  console.log(`▶ compiling ${t} (v${version}) → ${path.relative(root, outfile)}`)
  await run([
    'bun',
    'build',
    entry,
    '--compile',
    `--target=bun-${t}`,
    '--minify',
    '--sourcemap',
    `--define=process.env.MERLIN_VERSION=${JSON.stringify(version)}`,
    `--outfile=${outfile}`,
  ])
}

console.log(`\n✓ ${targets.length} binary(ies) in ${path.relative(root, outDir)}/`)
