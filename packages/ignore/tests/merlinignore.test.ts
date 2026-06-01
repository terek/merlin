import { describe, expect, test } from 'bun:test'
import { createMatcher, isSessionIgnored, parseRules } from '../src/merlinignore'

/** Helper: build a readFile stub from a map of path → content. */
function fakeFS(files: Record<string, string>) {
  return async (path: string) => files[path] ?? null
}

describe('parseRules', () => {
  test('skips empty lines and comments', () => {
    const rules = parseRules('# comment\n\n  # indented comment\nlegacy')
    expect(rules).toHaveLength(1)
    expect(rules[0].pattern).toBe('legacy')
  })

  test('detects negation', () => {
    const rules = parseRules('!legacy/keep')
    expect(rules[0].negated).toBe(true)
    expect(rules[0].pattern).toBe('legacy/keep')
  })

  test('detects root anchoring', () => {
    const rules = parseRules('/experiments')
    expect(rules[0].anchored).toBe(true)
    expect(rules[0].pattern).toBe('experiments')
  })

  test('detects trailing slash', () => {
    const rules = parseRules('legacy/')
    expect(rules[0].trailingSlash).toBe(true)
    expect(rules[0].pattern).toBe('legacy')
  })

  test('handles escaped # and !', () => {
    const rules = parseRules('\\#file\n\\!important')
    expect(rules[0].pattern).toBe('#file')
    expect(rules[0].negated).toBe(false)
    expect(rules[1].pattern).toBe('!important')
    expect(rules[1].negated).toBe(false)
  })

  test('trims whitespace', () => {
    const rules = parseRules('  legacy  ')
    expect(rules[0].pattern).toBe('legacy')
  })
})

describe('basic matching (rule 2)', () => {
  test('bare pattern matches at any segment-aligned position', () => {
    const m = createMatcher('legacy')
    expect(m('legacy/a1')).toBe(true)
    expect(m('proj/legacy/a1')).toBe(true)
    expect(m('proj/legacy/deep/a1')).toBe(true)
  })

  test('bare pattern requires segment boundary', () => {
    const m = createMatcher('legacy')
    expect(m('proj/legacystuff/a1')).toBe(false)
  })
})

describe('root anchoring (rule 3)', () => {
  test('anchored pattern matches from root', () => {
    const m = createMatcher('/projects')
    expect(m('projects/a1')).toBe(true)
    expect(m('projects/web/a1')).toBe(true)
  })

  test('anchored pattern does not match nested', () => {
    const m = createMatcher('/projects')
    expect(m('other/projects/a1')).toBe(false)
  })
})

describe('trailing slash — direct children only (rule 4)', () => {
  test('trailing slash matches direct children', () => {
    const m = createMatcher('legacy/')
    expect(m('legacy/a1')).toBe(true)
    expect(m('proj/legacy/a1')).toBe(true)
  })

  test('trailing slash does not match deeper nesting', () => {
    const m = createMatcher('legacy/')
    expect(m('legacy/deep/a1')).toBe(false)
    expect(m('proj/legacy/deep/a1')).toBe(false)
  })
})

describe('double star (rule 5)', () => {
  test('pattern/**/leaf matches at varying depths', () => {
    const m = createMatcher('legacy/**/test')
    // These are full session paths — "test" is the session ID
    expect(m('legacy/test')).toBe(true)
    expect(m('legacy/deep/test')).toBe(true)
    expect(m('legacy/deep/nested/test')).toBe(true)
  })

  test('pattern/** is equivalent to bare pattern', () => {
    const bare = createMatcher('legacy')
    const star = createMatcher('legacy/**')
    const paths = ['legacy/a1', 'proj/legacy/a1', 'proj/legacy/deep/a1']
    for (const p of paths) {
      expect(star(p)).toBe(bare(p))
    }
  })
})

describe('single star (rule 6)', () => {
  test('pattern/* matches as prefix (one level + extra OK)', () => {
    const m = createMatcher('legacy/*')
    expect(m('legacy/a1')).toBe(true)
    expect(m('legacy/deep/a1')).toBe(true) // prefix match: legacy/deep matches, a1 is extra
  })

  test('web* matches segment starting with web', () => {
    const m = createMatcher('web*')
    expect(m('proj/webinar/a1')).toBe(true)
    expect(m('webinar/a1')).toBe(true)
  })

  test('bare * matches any single segment', () => {
    const m = createMatcher('*')
    expect(m('anything/a1')).toBe(true)
  })
})

describe('last match wins (rule 7)', () => {
  test('negation after ignore re-includes', () => {
    const m = createMatcher('legacy\n!legacy/keep')
    // legacy/keep is a session path: folder "legacy", session "keep"
    expect(m('legacy/keep')).toBe(false) // re-included by !legacy/keep
    expect(m('legacy/other')).toBe(true) // still ignored by legacy
  })

  test('later ignore overrides negation', () => {
    const m = createMatcher('legacy\n!legacy/keep\nlegacy')
    expect(m('legacy/keep')).toBe(true) // last "legacy" wins, so ignored
  })
})

describe('negation (rule 8)', () => {
  test('negation re-includes previously ignored sessions', () => {
    const m = createMatcher('legacy\n!legacy/keep')
    expect(m('legacy/other')).toBe(true) // ignored
    expect(m('legacy/keep')).toBe(false) // re-included
  })
})

describe('edge cases', () => {
  test('empty file includes everything', () => {
    const m = createMatcher('')
    expect(m('any/session')).toBe(false)
  })

  test('only comments includes everything', () => {
    const m = createMatcher('# just a comment\n# another')
    expect(m('any/session')).toBe(false)
  })

  test('pattern with no matching sessions has no effect', () => {
    const m = createMatcher('nonexistent')
    expect(m('proj/other/a1')).toBe(false)
  })

  test('trailing slash combined with root anchor', () => {
    const m = createMatcher('/experiments/')
    expect(m('experiments/a1')).toBe(true)
    expect(m('experiments/deep/a1')).toBe(false)
    expect(m('other/experiments/a1')).toBe(false)
  })
})

describe('combined scenarios', () => {
  test('complex merlinignore file', () => {
    const content = `
# Ignore all legacy sessions
legacy

# But keep the important ones
!legacy/keep

# Ignore all experiments from root
/experiments

# Only direct children of temp
temp/

# Anything starting with test
test*
`
    const m = createMatcher(content)

    expect(m('legacy/abc')).toBe(true) // ignored by "legacy"
    expect(m('legacy/keep')).toBe(false) // re-included by "!legacy/keep"
    expect(m('proj/legacy/abc')).toBe(true) // ignored by "legacy"
    expect(m('experiments/abc')).toBe(true) // ignored by "/experiments"
    expect(m('other/experiments/abc')).toBe(false) // not matched (anchored)
    expect(m('temp/abc')).toBe(true) // ignored by "temp/"
    expect(m('temp/deep/abc')).toBe(false) // not matched (trailing slash)
    expect(m('proj/testing/abc')).toBe(true) // "test*" matches "testing"
  })
})

describe('slash patterns as prefix match', () => {
  test('slash pattern matches as prefix of session path', () => {
    const m = createMatcher('work/mer*')
    expect(m('work/mercury/sess')).toBe(true)
    expect(m('work/merlin/sess')).toBe(true)
    expect(m('work/other/sess')).toBe(false)
  })

  test('anchored slash pattern matches prefix from root', () => {
    const m = createMatcher('/work/mer*')
    expect(m('work/mercury/sess')).toBe(true)
    expect(m('other/work/merlin/sess')).toBe(false)
  })

  test('unanchored slash pattern matches prefix at any position', () => {
    const m = createMatcher('sub/mer*')
    expect(m('work/sub/merlin/sess')).toBe(true)
    expect(m('sub/merlin/sess')).toBe(true)
  })

  test('negated slash prefix re-includes subtree', () => {
    const m = createMatcher('**\n!work/mer*')
    expect(m('work/mercury/sess')).toBe(false) // re-included
    expect(m('work/other/sess')).toBe(true) // still ignored
  })

  test('trailing slash still means direct children only', () => {
    const m = createMatcher('legacy/')
    expect(m('legacy/a1')).toBe(true)
    expect(m('legacy/deep/a1')).toBe(false)
  })
})

describe('isSessionIgnored — hierarchical .merlinignore files', () => {
  test('root .merlinignore applies to all sessions', async () => {
    const fs = fakeFS({
      '/data/.merlinignore': 'legacy',
    })
    expect(await isSessionIgnored('/data', 'legacy/abc', fs)).toBe(true)
    expect(await isSessionIgnored('/data', 'projects/legacy/abc', fs)).toBe(true)
    expect(await isSessionIgnored('/data', 'projects/other/abc', fs)).toBe(false)
  })

  test('deeper .merlinignore sees paths relative to its directory', async () => {
    const fs = fakeFS({
      // root has no .merlinignore
      '/data/projects/.merlinignore': 'draft',
    })
    // session "projects/draft/abc" — relative to /data/projects is "draft/abc"
    expect(await isSessionIgnored('/data', 'projects/draft/abc', fs)).toBe(true)
    // session "projects/live/abc" — "draft" doesn't match "live"
    expect(await isSessionIgnored('/data', 'projects/live/abc', fs)).toBe(false)
    // session "other/draft/abc" — /data/other/.merlinignore doesn't exist
    expect(await isSessionIgnored('/data', 'other/draft/abc', fs)).toBe(false)
  })

  test('deeper file overrides shallower (last match wins across files)', async () => {
    const fs = fakeFS({
      '/data/.merlinignore': 'legacy',
      '/data/projects/.merlinignore': '!legacy',
    })
    // Root ignores "legacy", but /data/projects re-includes it
    expect(await isSessionIgnored('/data', 'projects/legacy/abc', fs)).toBe(false)
    // Outside /data/projects, root rule still applies
    expect(await isSessionIgnored('/data', 'other/legacy/abc', fs)).toBe(true)
  })

  test('anchored pattern in deeper file anchors to that directory', async () => {
    const fs = fakeFS({
      '/data/projects/.merlinignore': '/web',
    })
    // /web anchored to /data/projects — matches "web/abc" relative to it
    expect(await isSessionIgnored('/data', 'projects/web/abc', fs)).toBe(true)
    // "other/web" relative to /data/projects — anchored, doesn't match
    expect(await isSessionIgnored('/data', 'projects/other/web/abc', fs)).toBe(false)
  })

  test('multiple files at different depths compose correctly', async () => {
    const fs = fakeFS({
      '/root/.merlinignore': 'temp\ndraft',
      '/root/projects/.merlinignore': '!draft',
      '/root/projects/web/.merlinignore': 'draft',
    })
    // temp is ignored everywhere (only root rule)
    expect(await isSessionIgnored('/root', 'projects/web/temp/abc', fs)).toBe(true)
    // draft in projects — root ignores, projects re-includes
    expect(await isSessionIgnored('/root', 'projects/draft/abc', fs)).toBe(false)
    // draft in projects/web — root ignores, projects re-includes, web re-ignores
    expect(await isSessionIgnored('/root', 'projects/web/draft/abc', fs)).toBe(true)
    // draft outside projects — only root rule applies
    expect(await isSessionIgnored('/root', 'other/draft/abc', fs)).toBe(true)
  })

  test('no .merlinignore files means everything is included', async () => {
    const fs = fakeFS({})
    expect(await isSessionIgnored('/data', 'any/path/session', fs)).toBe(false)
  })

  test('trailing slash in deeper file scopes correctly', async () => {
    const fs = fakeFS({
      '/data/projects/.merlinignore': 'scratch/',
    })
    // "scratch/" means direct children only, relative to /data/projects
    expect(await isSessionIgnored('/data', 'projects/scratch/abc', fs)).toBe(true)
    expect(await isSessionIgnored('/data', 'projects/scratch/deep/abc', fs)).toBe(false)
  })
})
