/**
 * .merlinignore parser and matcher.
 *
 * Sessions are identified by paths like "projects/web/b1af3".
 * Patterns are matched against session paths relative to the .merlinignore file.
 *
 * Matching model:
 * - No-slash patterns (e.g. "legacy", "web*"): match if ANY segment in the full
 *   session path matches the glob. Anchored: only match first segment.
 * - Slash patterns (e.g. "legacy/x", "a/**​/b"): match as a PREFIX of the
 *   session path. Anchored: must start at position 0.
 * - Trailing slash (e.g. "legacy/"): pattern segments must match as a suffix of the
 *   parent folder path (all segments except the session ID).
 */

export interface MerlinIgnoreRule {
  pattern: string
  negated: boolean
  anchored: boolean
  trailingSlash: boolean
  hasSlash: boolean // pattern contains "/" (multi-segment)
  segments: string[]
}

export function parseRules(content: string): MerlinIgnoreRule[] {
  const rules: MerlinIgnoreRule[] = []

  for (let line of content.split('\n')) {
    line = line.trim()
    if (line === '' || line.startsWith('#')) continue

    // Handle escaped # and ! — unescape and skip negation check
    let escaped = false
    if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1)
      escaped = true
    }

    let negated = false
    if (!escaped && line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    }

    let anchored = false
    if (line.startsWith('/')) {
      anchored = true
      line = line.slice(1)
    }

    let trailingSlash = false
    if (line.endsWith('/')) {
      trailingSlash = true
      line = line.slice(0, -1)
    }

    const hasSlash = line.includes('/')
    const segments = line.split('/')

    rules.push({ pattern: line, negated, anchored, trailingSlash, hasSlash, segments })
  }

  return rules
}

/**
 * Match a single segment against a glob pattern (supports * and ?).
 * `*` matches any characters within a segment (no `/`).
 */
function matchSegment(pattern: string, segment: string): boolean {
  let pi = 0
  let si = 0
  let starPi = -1
  let starSi = -1

  while (si < segment.length) {
    if (pi < pattern.length && (pattern[pi] === '?' || pattern[pi] === segment[si])) {
      pi++
      si++
    } else if (pi < pattern.length && pattern[pi] === '*') {
      starPi = pi
      starSi = si
      pi++
    } else if (starPi !== -1) {
      pi = starPi + 1
      starSi++
      si = starSi
    } else {
      return false
    }
  }

  while (pi < pattern.length && pattern[pi] === '*') pi++
  return pi === pattern.length
}

/**
 * Check if rule segments match path segments from [ri..] against [pi..],
 * consuming all rule segments exactly. Returns true if all rule segments
 * are matched AND pi has reached `mustEndAt`.
 * Handles `**` (matches zero or more segments).
 */
function matchSegmentsToEnd(
  ruleSegs: string[],
  pathSegs: string[],
  ri: number,
  pi: number,
  mustEndAt: number,
): boolean {
  while (ri < ruleSegs.length && pi < mustEndAt) {
    if (ruleSegs[ri] === '**') {
      ri++
      if (ri === ruleSegs.length) return true // ** consumes rest
      for (let k = pi; k <= mustEndAt; k++) {
        if (matchSegmentsToEnd(ruleSegs, pathSegs, ri, k, mustEndAt)) return true
      }
      return false
    }
    if (!matchSegment(ruleSegs[ri], pathSegs[pi])) return false
    ri++
    pi++
  }

  // Remaining rule segments must all be **
  while (ri < ruleSegs.length && ruleSegs[ri] === '**') ri++
  return ri === ruleSegs.length && pi === mustEndAt
}

/**
 * Check if rule segments match path segments starting at [pi..] as a prefix.
 * Unlike matchSegmentsToEnd, this does NOT require consuming all path segments —
 * only that all rule segments are matched.
 * Handles `**` (matches zero or more segments).
 */
function matchSegmentsPrefix(ruleSegs: string[], pathSegs: string[], ri: number, pi: number): boolean {
  while (ri < ruleSegs.length && pi < pathSegs.length) {
    if (ruleSegs[ri] === '**') {
      ri++
      if (ri === ruleSegs.length) return true // ** at end consumes rest — prefix trivially matches
      // Try matching remaining rule segments starting at each path position
      for (let k = pi; k < pathSegs.length; k++) {
        if (matchSegmentsPrefix(ruleSegs, pathSegs, ri, k)) return true
      }
      return false
    }
    if (!matchSegment(ruleSegs[ri], pathSegs[pi])) return false
    ri++
    pi++
  }

  // Remaining rule segments must all be **
  while (ri < ruleSegs.length && ruleSegs[ri] === '**') ri++
  return ri === ruleSegs.length
}

/**
 * Test whether a rule matches a session path.
 */
function ruleMatches(rule: MerlinIgnoreRule, sessionPath: string): boolean {
  const pathSegs = sessionPath.split('/')

  if (rule.trailingSlash) {
    // Trailing slash: session must be a direct child of the matched folder.
    // Pattern segments must match as a suffix of the parent folder segments.
    const parentSegs = pathSegs.slice(0, -1)
    if (parentSegs.length === 0) return false

    if (rule.anchored) {
      // Must match from root and end at last parent segment
      return matchSegmentsToEnd(rule.segments, parentSegs, 0, 0, parentSegs.length)
    }

    // Unanchored: try at every start position, must end at last parent segment
    for (let start = 0; start <= parentSegs.length; start++) {
      if (matchSegmentsToEnd(rule.segments, parentSegs, 0, start, parentSegs.length)) {
        return true
      }
    }
    return false
  }

  if (!rule.hasSlash) {
    // No-slash pattern: match if any segment in the full path matches the glob.
    if (rule.anchored) {
      // Anchored: only match first segment
      return pathSegs.length > 0 && matchSegment(rule.segments[0], pathSegs[0])
    }
    for (const seg of pathSegs) {
      if (matchSegment(rule.segments[0], seg)) return true
    }
    return false
  }

  // Slash pattern without trailing slash: prefix match.
  // Pattern segments must match contiguously, but the path can have extra segments after.
  if (rule.anchored) {
    return matchSegmentsPrefix(rule.segments, pathSegs, 0, 0)
  }

  // ** can match zero segments, so we can't use rule.segments.length as the bound.
  // Compute minimum required non-** segments for the upper bound.
  const minSegs = rule.segments.filter((s) => s !== '**').length
  for (let start = 0; start <= pathSegs.length - minSegs; start++) {
    if (matchSegmentsPrefix(rule.segments, pathSegs, 0, start)) {
      return true
    }
  }
  return false
}

/**
 * Determine if a session path is ignored by a set of rules.
 * Last matching rule wins. Default is included (not ignored).
 */
export function isIgnored(rules: MerlinIgnoreRule[], sessionPath: string): boolean {
  let ignored = false

  for (const rule of rules) {
    if (ruleMatches(rule, sessionPath)) {
      ignored = !rule.negated
    }
  }

  return ignored
}

/**
 * Parse a .merlinignore file and return a matcher function.
 */
export function createMatcher(content: string): (sessionPath: string) => boolean {
  const rules = parseRules(content)
  return (sessionPath: string) => isIgnored(rules, sessionPath)
}

/**
 * Collected rules from a single .merlinignore file, tagged with
 * the directory depth so we can relativize session paths.
 */
interface ScopedRuleSet {
  /** Number of path segments from root to this .merlinignore's directory (0 = root) */
  depth: number
  rules: MerlinIgnoreRule[]
}

/**
 * Read and collect .merlinignore files from root down to the session's parent folder.
 *
 * Given root "/data" and session path "projects/web/b1af3":
 *   - checks /data/.merlinignore           (depth 0, sees "projects/web/b1af3")
 *   - checks /data/projects/.merlinignore  (depth 1, sees "web/b1af3")
 *   - checks /data/projects/web/.merlinignore (depth 2, sees "b1af3")
 *
 * Rules from shallower files are evaluated first; deeper files override (last match wins).
 */
export async function isSessionIgnored(
  rootDir: string,
  sessionPath: string,
  readFile: (path: string) => Promise<string | null> = defaultReadFile,
): Promise<boolean> {
  const segments = sessionPath.split('/')
  // Parent folder segments (everything except the session ID)
  const folderSegments = segments.slice(0, -1)

  const scopedRuleSets: ScopedRuleSet[] = []

  // Walk from root down to the session's parent directory
  for (let depth = 0; depth <= folderSegments.length; depth++) {
    const dir = depth === 0 ? rootDir : `${rootDir}/${folderSegments.slice(0, depth).join('/')}`
    const filePath = `${dir}/.merlinignore`
    const content = await readFile(filePath)
    if (content !== null) {
      const rules = parseRules(content)
      if (rules.length > 0) {
        scopedRuleSets.push({ depth, rules })
      }
    }
  }

  // Evaluate all rule sets root→leaf, last match wins across all files
  let ignored = false
  for (const { depth, rules } of scopedRuleSets) {
    const relativePath = segments.slice(depth).join('/')
    for (const rule of rules) {
      if (ruleMatches(rule, relativePath)) {
        ignored = !rule.negated
      }
    }
  }

  return ignored
}

async function defaultReadFile(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text()
  } catch {
    return null
  }
}
