import { readFile, readlink } from 'node:fs/promises'

export const IS_LINUX = process.platform === 'linux'

export interface ProcessHit {
  pid: number
  binaryName: string
  /** Session ID extracted from --resume flag, if present. */
  sessionId?: string
}

export interface ProcessScannerDeps {
  pgrep: (binaryName: string) => Promise<number[]>
  lsofCwd: (pid: number) => Promise<string | null>
  /** Get command-line args for a PID. Used to extract --resume <sessionId>. */
  psArgs?: (pid: number) => Promise<string | null>
}

async function defaultPgrep(binaryName: string): Promise<number[]> {
  const proc = Bun.spawn(['pgrep', '-x', binaryName], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const text = await new Response(proc.stdout as ReadableStream).text()
  await proc.exited
  return text
    .trim()
    .split('\n')
    .map((l) => parseInt(l.trim(), 10))
    .filter((n) => !Number.isNaN(n) && n > 0)
}

/** Resolve cwd via /proc/<pid>/cwd symlink (Linux). */
export async function procCwd(pid: number): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

/** Resolve cwd via lsof (macOS). */
export async function lsofCwd(pid: number): Promise<string | null> {
  const proc = Bun.spawn(['lsof', '-p', String(pid), '-Ftfn'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const text = await new Response(proc.stdout as ReadableStream).text()
  await proc.exited
  const lines = text.split('\n')
  const cwdIdx = lines.indexOf('fcwd')
  if (cwdIdx === -1) return null
  // After 'fcwd' there may be a type line (tDIR) before the name line (n/path)
  const nameLine = lines.slice(cwdIdx + 1, cwdIdx + 4).find((l) => l.startsWith('n'))
  return nameLine ? nameLine.slice(1).trim() : null
}

/** Read command-line args from /proc/<pid>/cmdline (Linux). Null-separated → space-separated. */
export async function procArgs(pid: number): Promise<string | null> {
  try {
    const buf = await readFile(`/proc/${pid}/cmdline`)
    // cmdline is null-byte separated; replace nulls with spaces
    const text = buf.toString('utf-8').replace(/\0/g, ' ').trim()
    return text || null
  } catch {
    return null
  }
}

/** Read command-line args via ps (macOS). */
export async function psArgs(pid: number): Promise<string | null> {
  const proc = Bun.spawn(['ps', '-p', String(pid), '-o', 'args='], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const text = await new Response(proc.stdout as ReadableStream).text()
  await proc.exited
  const trimmed = text.trim()
  return trimmed || null
}

/** Platform-aware defaults. */
function defaultDeps(): ProcessScannerDeps {
  return {
    pgrep: defaultPgrep,
    lsofCwd: IS_LINUX ? procCwd : lsofCwd,
    psArgs: IS_LINUX ? procArgs : psArgs,
  }
}

/** Extract --resume <sessionId> from a command-line string. */
export function parseResumeSessionId(args: string): string | undefined {
  const match = args.match(/--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)
  return match?.[1]
}

export class ProcessScanner {
  private cwdCache = new Map<number, string>()

  constructor(private readonly deps: ProcessScannerDeps = defaultDeps()) {}

  async scan(
    binaryNames: string[],
    managedPids: Set<number>,
    { force = false }: { force?: boolean } = {},
  ): Promise<Map<string, ProcessHit[]>> {
    if (binaryNames.length === 0) return new Map()

    const pidEntries = await Promise.all(
      binaryNames.map(async (binary) => {
        const base = binary.split('/').pop() ?? binary
        const pids = await this.deps.pgrep(base).catch(() => [] as number[])
        return pids.filter((pid) => !managedPids.has(pid)).map((pid) => ({ pid, binaryName: base }))
      }),
    )
    const found = pidEntries.flat()
    const foundPids = new Set(found.map((e) => e.pid))

    if (force) {
      this.cwdCache.clear()
    } else {
      for (const cachedPid of this.cwdCache.keys()) {
        if (!foundPids.has(cachedPid)) this.cwdCache.delete(cachedPid)
      }
    }

    const pidsToResolve = found.filter((e) => !this.cwdCache.has(e.pid))
    await Promise.all(
      pidsToResolve.map(async ({ pid }) => {
        const cwd = await this.deps.lsofCwd(pid).catch(() => null)
        if (cwd) this.cwdCache.set(pid, cwd)
      }),
    )

    // Resolve session IDs from command-line args (--resume <sessionId>)
    const resolveArgs = this.deps.psArgs ?? (IS_LINUX ? procArgs : psArgs)
    const sessionIdByPid = new Map<number, string>()
    await Promise.all(
      found.map(async ({ pid }) => {
        const args = await resolveArgs(pid).catch(() => null)
        if (args) {
          const sessionId = parseResumeSessionId(args)
          if (sessionId) sessionIdByPid.set(pid, sessionId)
        }
      }),
    )

    const result = new Map<string, ProcessHit[]>()
    for (const { pid, binaryName } of found) {
      const cwd = this.cwdCache.get(pid)
      if (!cwd) continue
      const hits = result.get(cwd) ?? []
      hits.push({ pid, binaryName, sessionId: sessionIdByPid.get(pid) })
      result.set(cwd, hits)
    }
    return result
  }

  clearCache(): void {
    this.cwdCache.clear()
  }
}
