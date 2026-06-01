import { describe, expect, test } from 'bun:test'
import {
  lsofCwd,
  ProcessScanner,
  type ProcessScannerDeps,
  parseResumeSessionId,
  procArgs,
  procCwd,
  psArgs,
} from '../../src/process-scanner.ts'

function makeDeps(pids: Record<string, number[]>, cwds: Record<number, string>): ProcessScannerDeps {
  return {
    pgrep: async (name) => pids[name] ?? [],
    lsofCwd: async (pid) => cwds[pid] ?? null,
  }
}

describe('ProcessScanner', () => {
  test('returns empty map for no binaries', async () => {
    const scanner = new ProcessScanner(makeDeps({}, {}))
    const result = await scanner.scan([], new Set())
    expect(result.size).toBe(0)
  })

  test('finds processes by binary name', async () => {
    const scanner = new ProcessScanner(
      makeDeps({ claude: [100, 200] }, { 100: '/home/user/project-a', 200: '/home/user/project-b' }),
    )
    const result = await scanner.scan(['claude'], new Set())
    expect(result.size).toBe(2)
    expect(result.get('/home/user/project-a')![0].pid).toBe(100)
    expect(result.get('/home/user/project-b')![0].pid).toBe(200)
  })

  test('excludes managed PIDs', async () => {
    const scanner = new ProcessScanner(
      makeDeps({ claude: [100, 200] }, { 100: '/home/user/project-a', 200: '/home/user/project-b' }),
    )
    const result = await scanner.scan(['claude'], new Set([100]))
    expect(result.size).toBe(1)
    expect(result.has('/home/user/project-a')).toBe(false)
    expect(result.has('/home/user/project-b')).toBe(true)
  })

  test('caches pid→cwd, lsof only called for new pids', async () => {
    let lsofCalls = 0
    const deps: ProcessScannerDeps = {
      pgrep: async () => [100],
      lsofCwd: async (_pid) => {
        lsofCalls++
        return '/tmp'
      },
    }
    const scanner = new ProcessScanner(deps)

    await scanner.scan(['claude'], new Set())
    expect(lsofCalls).toBe(1)

    await scanner.scan(['claude'], new Set())
    expect(lsofCalls).toBe(1) // cached, no new call
  })

  test('evicts stale pids not in latest pgrep', async () => {
    let pids = [100, 200]
    let lsofCalls = 0
    const deps: ProcessScannerDeps = {
      pgrep: async () => pids,
      lsofCwd: async (pid) => {
        lsofCalls++
        return `/dir/${pid}`
      },
    }
    const scanner = new ProcessScanner(deps)

    await scanner.scan(['claude'], new Set())
    expect(lsofCalls).toBe(2)

    // pid 200 disappears
    pids = [100]
    lsofCalls = 0
    const result = await scanner.scan(['claude'], new Set())
    expect(lsofCalls).toBe(0) // 100 is cached, 200 evicted
    expect(result.size).toBe(1)
    expect(result.has('/dir/100')).toBe(true)
  })

  test('force clears cache and re-resolves all pids', async () => {
    let lsofCalls = 0
    const deps: ProcessScannerDeps = {
      pgrep: async () => [100],
      lsofCwd: async () => {
        lsofCalls++
        return '/tmp'
      },
    }
    const scanner = new ProcessScanner(deps)

    await scanner.scan(['claude'], new Set())
    expect(lsofCalls).toBe(1)

    lsofCalls = 0
    await scanner.scan(['claude'], new Set(), { force: true })
    expect(lsofCalls).toBe(1) // re-resolved despite being cached
  })

  test('groups multiple pids in same cwd', async () => {
    const scanner = new ProcessScanner(
      makeDeps({ claude: [100, 200] }, { 100: '/home/user/project', 200: '/home/user/project' }),
    )
    const result = await scanner.scan(['claude'], new Set())
    expect(result.size).toBe(1)
    expect(result.get('/home/user/project')!).toHaveLength(2)
  })

  test('handles lsof failure gracefully', async () => {
    const deps: ProcessScannerDeps = {
      pgrep: async () => [100],
      lsofCwd: async () => {
        throw new Error('lsof failed')
      },
    }
    const scanner = new ProcessScanner(deps)
    const result = await scanner.scan(['claude'], new Set())
    expect(result.size).toBe(0)
  })

  test('scans multiple binary names in parallel', async () => {
    const scanner = new ProcessScanner(makeDeps({ claude: [100], codex: [200] }, { 100: '/tmp/a', 200: '/tmp/b' }))
    const result = await scanner.scan(['claude', 'codex'], new Set())
    expect(result.size).toBe(2)
    expect(result.get('/tmp/a')![0].binaryName).toBe('claude')
    expect(result.get('/tmp/b')![0].binaryName).toBe('codex')
  })

  test('extracts sessionId from --resume flag in process args', async () => {
    const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const deps: ProcessScannerDeps = {
      pgrep: async () => [100],
      lsofCwd: async () => '/home/user/project',
      psArgs: async () => `claude --resume ${sessionId} --verbose`,
    }
    const scanner = new ProcessScanner(deps)
    const result = await scanner.scan(['claude'], new Set())
    expect(result.get('/home/user/project')![0].sessionId).toBe(sessionId)
  })

  test('no sessionId when --resume flag absent', async () => {
    const deps: ProcessScannerDeps = {
      pgrep: async () => [100],
      lsofCwd: async () => '/home/user/project',
      psArgs: async () => 'claude --verbose',
    }
    const scanner = new ProcessScanner(deps)
    const result = await scanner.scan(['claude'], new Set())
    expect(result.get('/home/user/project')![0].sessionId).toBeUndefined()
  })

  test('psArgs failure does not break scan', async () => {
    const deps: ProcessScannerDeps = {
      pgrep: async () => [100],
      lsofCwd: async () => '/home/user/project',
      psArgs: async () => {
        throw new Error('ps failed')
      },
    }
    const scanner = new ProcessScanner(deps)
    const result = await scanner.scan(['claude'], new Set())
    expect(result.size).toBe(1)
    expect(result.get('/home/user/project')![0].sessionId).toBeUndefined()
  })
})

describe('parseResumeSessionId', () => {
  test('extracts UUID after --resume', () => {
    const id = parseResumeSessionId('claude --resume a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
  })

  test('returns undefined when no --resume flag', () => {
    expect(parseResumeSessionId('claude --verbose')).toBeUndefined()
  })

  test('returns undefined for --resume with non-UUID value', () => {
    expect(parseResumeSessionId('claude --resume not-a-uuid')).toBeUndefined()
  })

  test('extracts UUID when --resume is not the last flag', () => {
    const id = parseResumeSessionId('/usr/bin/claude --resume a1b2c3d4-e5f6-7890-abcd-ef1234567890 --json')
    expect(id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
  })

  test('handles multiple spaces between --resume and UUID', () => {
    const id = parseResumeSessionId('claude --resume   a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
  })
})

describe('platform-specific implementations', () => {
  const isLinux = process.platform === 'linux'
  const isMac = process.platform === 'darwin'
  const myPid = process.pid

  describe('lsofCwd (macOS)', () => {
    test.skipIf(!isMac)('resolves own process cwd', async () => {
      const cwd = await lsofCwd(myPid)
      expect(cwd).toBe(process.cwd())
    })

    test.skipIf(!isMac)('returns null for nonexistent PID', async () => {
      const cwd = await lsofCwd(999999)
      expect(cwd).toBeNull()
    })
  })

  describe('procCwd (Linux)', () => {
    test.skipIf(!isLinux)('resolves own process cwd via /proc', async () => {
      const cwd = await procCwd(myPid)
      expect(cwd).toBe(process.cwd())
    })

    test.skipIf(!isLinux)('returns null for nonexistent PID', async () => {
      const cwd = await procCwd(999999)
      expect(cwd).toBeNull()
    })
  })

  describe('psArgs (macOS)', () => {
    test.skipIf(!isMac)('resolves own process args', async () => {
      const args = await psArgs(myPid)
      expect(args).toBeTruthy()
      expect(args).toContain('bun')
    })

    test.skipIf(!isMac)('returns null for nonexistent PID', async () => {
      const args = await psArgs(999999)
      expect(args).toBeNull()
    })
  })

  describe('procArgs (Linux)', () => {
    test.skipIf(!isLinux)('resolves own process args via /proc', async () => {
      const args = await procArgs(myPid)
      expect(args).toBeTruthy()
      expect(args).toContain('bun')
    })

    test.skipIf(!isLinux)('returns null for nonexistent PID', async () => {
      const args = await procArgs(999999)
      expect(args).toBeNull()
    })
  })

  describe('ProcessScanner with simulated /proc deps', () => {
    test('works with /proc-style cwd resolver', async () => {
      // Simulate what procCwd does: direct path return, no lsof parsing
      const deps: ProcessScannerDeps = {
        pgrep: async () => [100, 200],
        lsofCwd: async (pid) => {
          // Simulate readlink /proc/<pid>/cwd
          const cwds: Record<number, string> = { 100: '/home/user/proj-a', 200: '/home/user/proj-b' }
          return cwds[pid] ?? null
        },
        psArgs: async (pid) => {
          // Simulate reading /proc/<pid>/cmdline (null-separated → space-separated)
          if (pid === 100) return 'claude --resume a1b2c3d4-e5f6-7890-abcd-ef1234567890'
          return 'claude'
        },
      }
      const scanner = new ProcessScanner(deps)
      const result = await scanner.scan(['claude'], new Set())
      expect(result.size).toBe(2)
      expect(result.get('/home/user/proj-a')![0].sessionId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
      expect(result.get('/home/user/proj-b')![0].sessionId).toBeUndefined()
    })
  })
})
