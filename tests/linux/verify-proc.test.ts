import { describe, expect, test } from 'bun:test'
import path from 'node:path'

const hasDocker = !!Bun.which('docker')
const LINUX_IMAGE = process.env.LINUX_TEST_IMAGE ?? 'alpine:3.20'

describe.skipIf(!hasDocker)('Linux /proc verification (containerized)', () => {
  test('proc cwd and cmdline work as expected', async () => {
    const scriptDir = path.dirname(new URL(import.meta.url).pathname)
    const scriptPath = path.join(scriptDir, 'verify-proc.sh')

    const proc = Bun.spawn(
      ['docker', 'run', '--rm', '-v', `${scriptPath}:/verify-proc.sh:ro`, LINUX_IMAGE, 'sh', '/verify-proc.sh'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    const stdout = await new Response(proc.stdout as ReadableStream).text()
    const stderr = await new Response(proc.stderr as ReadableStream).text()
    const exitCode = await proc.exited

    console.log(stdout)
    if (stderr) console.error(stderr)

    expect(exitCode).toBe(0)
    expect(stdout).toContain('PASS: /proc/pid/cwd is working directory')
    expect(stdout).toContain('PASS: cmdline contains --resume')
    expect(stdout).toContain('PASS: cmdline contains UUID')
    expect(stdout).toContain('3 passed, 0 failed')
  }, 60_000)
})
