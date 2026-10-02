// Paths and ids as the UI shows them.

/** The last two segments of a path: "/home/dev/acme/web" -> "acme/web". The full path goes in a tooltip. */
export function shortProject(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return path || '(unknown)'
  return parts.slice(-2).join('/')
}

/** The last segment: "/home/dev/acme/web" -> "web". */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** The first eight characters of a session or agent id. */
export function shortId(id: string): string {
  return id.slice(0, 8)
}

/** The first non-empty line of a text, trimmed. */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/** Quotes a string for a POSIX shell when it needs it. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The command that resumes a session: `cd <cwd> && claude --resume <id>`. */
export function resumeCommand(cwd: string | undefined, id: string): string {
  const resume = `claude --resume ${shellQuote(id)}`
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume
}

/** The app path of a session, with an optional hash ("t12", "a<agentId>", "c0"). */
export function sessionPath(key: { harness: string; id: string }, hash?: string): string {
  const base = `/s/${encodeURIComponent(key.harness)}/${encodeURIComponent(key.id)}`
  return hash ? `${base}#${hash}` : base
}
