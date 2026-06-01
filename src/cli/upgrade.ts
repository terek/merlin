/**
 * `merlin upgrade` — self-update the running binary in place.
 *
 * Mirrors install.sh, but for an already-installed binary: detect this host's
 * target, ask GitHub for the latest release, and — if it's newer than the baked-in
 * version — download + checksum-verify the matching binary and atomically swap it
 * over the currently-running executable.
 *
 *   merlin upgrade            download + install the latest release (if newer)
 *   merlin upgrade --check    report whether an update is available, install nothing
 *
 * The swap is a rename() onto process.execPath. On Unix you can't truncate a
 * running executable, but you *can* replace its directory entry — the live process
 * keeps the old inode, and the next launch picks up the new binary.
 */

import { createHash } from 'node:crypto'
import { chmod, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

const REPO = 'terek/merlin'
const CURRENT_VERSION = process.env.MERLIN_VERSION ?? 'dev'

/** Map this host to a release asset name, e.g. `merlin-linux-x64-musl`. */
async function detectAsset(): Promise<string> {
  let os: string
  switch (process.platform) {
    case 'darwin':
      os = 'darwin'
      break
    case 'linux':
      os = 'linux'
      break
    default:
      throw new Error(
        `self-upgrade isn't supported on ${process.platform} — download the latest binary from https://github.com/${REPO}/releases/latest`,
      )
  }

  let arch: string
  switch (process.arch) {
    case 'arm64':
      arch = 'arm64'
      break
    case 'x64':
      arch = 'x64'
      break
    default:
      throw new Error(`unsupported architecture: ${process.arch}`)
  }

  // musl (Alpine etc.) needs the -musl build. Detect by the musl loader / Alpine marker.
  let libc = ''
  if (
    os === 'linux' &&
    ((await pathExists('/etc/alpine-release')) ||
      (await pathExists('/lib/ld-musl-x86_64.so.1')) ||
      (await pathExists('/lib/ld-musl-aarch64.so.1')))
  ) {
    libc = '-musl'
  }

  return `merlin-${os}-${arch}${libc}`
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** Resolve the latest release tag (e.g. "v0.2.0") via the /releases/latest redirect. */
async function latestTag(): Promise<string> {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: 'follow' })
  if (!res.ok) throw new Error(`could not reach GitHub to find the latest release (HTTP ${res.status})`)
  const tag = res.url.split('/').pop() ?? ''
  if (!tag || tag === 'latest') throw new Error('could not determine the latest release version')
  return tag
}

/** Compare dotted numeric versions. Returns 1 if a>b, -1 if a<b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  const pb = b
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await Bun.file(filePath).bytes())
  return hash.digest('hex')
}

// Downloads go through curl, not fetch: Bun's fetch+Bun.write pathologically
// spins (100% CPU, ignores AbortSignal) on large release assets, while curl
// streams a 60–120MB binary in a couple of seconds. curl is already a hard
// dependency of install.sh, so any installed user has it.
async function curlToFile(url: string, dest: string): Promise<void> {
  const proc = Bun.spawn(['curl', '-fsSL', url, '-o', dest], { stdout: 'ignore', stderr: 'pipe' })
  if ((await proc.exited) !== 0) {
    throw new Error(`download failed: ${url}\n${(await new Response(proc.stderr).text()).trim()}`)
  }
}

async function curlToText(url: string): Promise<string> {
  const proc = Bun.spawn(['curl', '-fsSL', url], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) {
    throw new Error(`fetch failed: ${url}\n${(await new Response(proc.stderr).text()).trim()}`)
  }
  return out
}

export async function runUpgrade(
  opts: { checkOnly?: boolean } = {},
  log: (m: string) => void = (m) => console.log(m),
): Promise<void> {
  if (CURRENT_VERSION === 'dev') {
    throw new Error('running from source (version "dev") — nothing to upgrade. Use `git pull` instead.')
  }

  const asset = await detectAsset()
  const tag = await latestTag()
  const latest = tag.replace(/^v/, '')

  log(`Current: v${CURRENT_VERSION}   Latest: ${tag}`)

  if (compareVersions(latest, CURRENT_VERSION) <= 0) {
    log('✓ Already up to date.')
    return
  }
  if (opts.checkOnly) {
    log(`↑ Update available: v${CURRENT_VERSION} → ${tag}. Run \`merlin upgrade\` to install.`)
    return
  }

  if (!Bun.which('curl')) {
    throw new Error('`curl` is required for self-upgrade but was not found on PATH.')
  }

  const dest = process.execPath
  const base = `https://github.com/${REPO}/releases/download/${tag}`

  // Stage the download next to the live binary so the final rename() is an atomic,
  // same-filesystem move. A failed write here never touches the running binary.
  const tmp = path.join(path.dirname(dest), `.merlin-upgrade-${crypto.randomUUID()}`)

  try {
    log(`Downloading ${asset} (${tag})…`)
    await curlToFile(`${base}/${asset}`, tmp)

    log('Verifying checksum…')
    const sums = await curlToText(`${base}/SHA256SUMS`)
    const line = sums.split('\n').find((l) => l.trimEnd().endsWith(` ${asset}`))
    const expected = line?.trim().split(/\s+/)[0]
    if (!expected) throw new Error(`no checksum for ${asset} in SHA256SUMS`)
    const actual = await sha256(tmp)
    if (expected !== actual) throw new Error(`checksum mismatch for ${asset} — refusing to install`)

    await chmod(tmp, 0o755)
    await rename(tmp, dest)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    if ((err as NodeJS.ErrnoException).code === 'EACCES' || (err as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(
        `cannot replace ${dest}: permission denied. Re-run with write access (e.g. \`sudo merlin upgrade\`).`,
      )
    }
    throw err
  }

  log(`✓ Upgraded v${CURRENT_VERSION} → ${tag} at ${dest}`)
  log('  Restart the daemon to run the new version.')
}
