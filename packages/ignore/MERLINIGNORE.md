# .merlinignore spec

## Context

`.merlinignore` controls which agentic coding sessions are ignored. A session is identified by its full path: `<folder-path>/<session-id>`, e.g. `projects/web/b1af3`. There are no files — sessions are the leaves.

## Rules

1. Each line is a glob pattern matched against session paths relative to .merlingnore
2. Patterns match against any segment-aligned position in the path
3. Leading `/` anchors to root
4. Trailing `/` matches only direct child sessions of that folder
5. `**` matches zero or more segments
6. `*` matches within a segment (does not match `/`)
7. Evaluated top-to-bottom, last match wins
8. Default: included. Lines starting with `!` re-include.
9. `#` for comments, blank lines ignored

## Examples

```
legacy          # matches proj/legacy/x AND proj/legacy/deep/x
legacy/         # matches proj/legacy/x but NOT proj/legacy/deep/x
/experiments    # matches experiments/x but NOT proj/experiments/x
legacy/**       # same as bare legacy
web*            # matches segment "webinar" anywhere in path
!legacy/keep    # re-includes sessions matching "keep" under legacy
```

## Test ideas

### Basic matching (rule 2)
- `legacy` matches `legacy/a1`, `proj/legacy/a1`, `proj/legacy/deep/a1`
- `legacy` does NOT match `proj/legacystuff/a1`

### Root anchoring (rule 3)
- `/projects` matches `projects/a1`, `projects/web/a1`
- `/projects` does NOT match `other/projects/a1`

### Trailing slash — direct children only (rule 4)
- `legacy/` matches `legacy/a1`, `proj/legacy/a1`
- `legacy/` does NOT match `legacy/deep/a1`, `proj/legacy/deep/a1`

### Double star (rule 5)
- `legacy/**/test` matches `legacy/test`, `legacy/deep/test`, `legacy/deep/nested/test`
- `legacy/**` is equivalent to `legacy`

### Single star (rule 6)
- `legacy/*` matches `legacy/a1` but NOT `legacy/deep/a1`
- `web*` matches segment `webinar` — so `proj/webinar/a1` matches
- `*` alone matches any single-segment session path like `a1`

### Last match wins (rule 7)
- Lines: `legacy`, `!legacy/keep` → `legacy/keep` is included, `legacy/other` is ignored
- Lines: `legacy`, `!legacy/keep`, `legacy` → `legacy/keep` is ignored (last rule wins)

### Negation (rule 8)
- `!legacy` re-includes previously ignored sessions under legacy
- Negation works unconditionally (no parent-exclusion trap)

### Edge cases
- Empty file → everything included
- Only comments → everything included
- Pattern with no matching sessions → no effect
- Leading and trailing whitespace on lines → trim or error? (decide)
- Escaped `#` or `!` at start of pattern → support `\#`, `\!`? (decide)
- Trailing `/` combined with root anchor: `/experiments/` matches `experiments/a1` but not `experiments/deep/a1` and not `other/experiments/a1`
- `**/` as a pattern — matches direct children everywhere? (decide)