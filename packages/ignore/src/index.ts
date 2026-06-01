/**
 * @merlin/ignore — .merlinignore parser and matcher.
 *
 * Controls which agentic coding sessions are ignored during discovery
 * and processing. Supports gitignore-like glob patterns with hierarchical
 * .merlinignore files.
 */

export type { MerlinIgnoreRule } from './merlinignore.ts'
export {
  createMatcher,
  isIgnored,
  isSessionIgnored,
  parseRules,
} from './merlinignore.ts'
