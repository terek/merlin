/**
 * Codebase tools — read files, search code, list files.
 * Operates within a project directory.
 */

import path from 'node:path'

export class CodebaseTools {
  constructor(private projectPath: string) {}

  async readFile(filePath: string, startLine?: number, endLine?: number): Promise<string> {
    // Resolve relative paths against project root
    const resolved = filePath.startsWith('/') ? filePath : path.join(this.projectPath, filePath)

    // Security: ensure the file is within the project
    if (!resolved.startsWith(this.projectPath)) {
      return `Error: path ${filePath} is outside the project directory`
    }

    try {
      const content = await Bun.file(resolved).text()
      const lines = content.split('\n')

      if (startLine !== undefined || endLine !== undefined) {
        const start = (startLine ?? 1) - 1
        const end = endLine ?? lines.length
        return lines
          .slice(start, end)
          .map((l, i) => `${start + i + 1}\t${l}`)
          .join('\n')
      }

      return lines.map((l, i) => `${i + 1}\t${l}`).join('\n')
    } catch {
      return `Error: could not read ${filePath}`
    }
  }

  async searchCode(
    pattern: string,
    glob?: string,
    limit: number = 20,
  ): Promise<Array<{ file: string; line: number; text: string }>> {
    try {
      const args = ['rg', '--no-heading', '-n', '--max-count', String(limit)]
      if (glob) args.push('--glob', glob)
      args.push(pattern, this.projectPath)

      const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
      const output = await new Response(proc.stdout).text()
      await proc.exited

      const results: Array<{ file: string; line: number; text: string }> = []
      for (const line of output.split('\n').filter((l) => l.trim())) {
        // Format: /path/to/file:linenum:text
        const match = line.match(/^(.+?):(\d+):(.*)$/)
        if (match) {
          results.push({
            file: path.relative(this.projectPath, match[1]),
            line: parseInt(match[2], 10),
            text: match[3],
          })
        }
      }
      return results.slice(0, limit)
    } catch {
      return []
    }
  }

  async listFiles(pattern: string): Promise<string[]> {
    try {
      const { Glob } = await import('bun')
      const glob = new Glob(pattern)
      const results: string[] = []
      for await (const file of glob.scan({ cwd: this.projectPath, onlyFiles: true })) {
        results.push(file)
        if (results.length >= 100) break
      }
      return results.sort()
    } catch {
      return []
    }
  }
}
