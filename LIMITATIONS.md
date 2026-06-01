# Known Limitations

## Project Collapse

### Collapse requires at least one session in the root project

Collapsing merges sessions from nested project directories (e.g. `myapp/daemon`, `myapp/processor`) into the parent project (`myapp`). However, if the parent has zero sessions of its own, discovery doesn't create a project entry for it — there's nothing to collapse into.

**Workaround:** Start at least one CC session in the root project directory.

### Processing stores data per-original-project, not per-collapsed-project

When `processProject(cwd)` is called, it discovers sessions in all nested directories and processes them. However, each session's output is stored under its **own** project directory (`~/.merlin/projects/<encoded-dir>/`), not the parent's.

This means:
- Each nested project has its own `~/.merlin/projects/<encoded-dir>/` output
- Each nested project has its own `index.json` manifest
- Collapse/uncollapse never moves data on disk

This is intentional: collapse is a reversible workspace-level concern and shouldn't alter the data layout.
