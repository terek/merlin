/**
 * Test fixtures: synthetic raw Claude Code session JSONL data.
 *
 * Each fixture is a function returning JSONL string content, designed
 * to exercise specific parsing/processing edge cases.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonl(...objects: Record<string, unknown>[]): string {
  return `${objects.map((o) => JSON.stringify(o)).join('\n')}\n`
}

let uuidCounter = 0
function uuid(): string {
  return `test-uuid-${String(++uuidCounter).padStart(4, '0')}`
}

function msgId(): string {
  return `msg_${String(++uuidCounter).padStart(8, '0')}`
}

function toolId(): string {
  return `toolu_${String(++uuidCounter).padStart(8, '0')}`
}

function ts(minutesOffset: number): string {
  const base = new Date('2026-03-15T10:00:00.000Z')
  base.setMinutes(base.getMinutes() + minutesOffset)
  return base.toISOString()
}

function userEntry(text: string, minutesOffset: number, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'user',
    uuid: uuid(),
    parentUuid: null,
    sessionId: 'aaaabbbb-1111-2222-3333-444455556666',
    cwd: '/Users/test/project',
    version: '2.1.74',
    slug: 'test-session',
    timestamp: ts(minutesOffset),
    isSidechain: false,
    userType: 'external',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    ...extra,
  }
}

function assistantEntry(
  text: string,
  minutesOffset: number,
  overrides?: {
    messageId?: string
    toolUses?: Array<{ name: string; id: string; input?: Record<string, unknown> }>
    usage?: Record<string, unknown>
  },
): Record<string, unknown> {
  const mid = overrides?.messageId || msgId()
  const content: Record<string, unknown>[] = []

  if (text) {
    content.push({ type: 'text', text })
  }

  if (overrides?.toolUses) {
    for (const tu of overrides.toolUses) {
      content.push({
        type: 'tool_use',
        id: tu.id,
        name: tu.name,
        input: tu.input || {},
      })
    }
  }

  return {
    type: 'assistant',
    uuid: uuid(),
    parentUuid: null,
    sessionId: 'aaaabbbb-1111-2222-3333-444455556666',
    cwd: '/Users/test/project',
    version: '2.1.74',
    timestamp: ts(minutesOffset),
    isSidechain: false,
    message: {
      id: mid,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: 'end_turn',
      usage: overrides?.usage || {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 30,
      },
    },
  }
}

function progressEntry(minutesOffset: number): Record<string, unknown> {
  return {
    type: 'progress',
    uuid: uuid(),
    timestamp: ts(minutesOffset),
    data: { type: 'hook_progress', hookEvent: 'PostToolUse' },
  }
}

function customTitleEntry(title: string): Record<string, unknown> {
  return {
    type: 'custom-title',
    customTitle: title,
    sessionId: 'aaaabbbb-1111-2222-3333-444455556666',
    timestamp: ts(0),
  }
}

function systemEntry(content: string, minutesOffset: number): Record<string, unknown> {
  return {
    type: 'user',
    uuid: uuid(),
    sessionId: 'aaaabbbb-1111-2222-3333-444455556666',
    timestamp: ts(minutesOffset),
    isSidechain: false,
    userType: 'external',
    message: {
      role: 'user',
      content: [{ type: 'text', text: content }],
    },
  }
}

// ---------------------------------------------------------------------------
// Reset counter between fixtures
// ---------------------------------------------------------------------------
export function resetCounters(): void {
  uuidCounter = 0
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal session: one user prompt, one assistant response.
 */
export function minimalSession(): string {
  resetCounters()
  return jsonl(
    userEntry('Hello, help me with my project', 0),
    assistantEntry(
      "I'd be happy to help! Let me look at your project structure to understand what we're working with.",
      1,
    ),
  )
}

/**
 * Multi-turn session: 3 user prompts with assistant responses.
 */
export function multiTurnSession(): string {
  resetCounters()
  return jsonl(
    customTitleEntry('Refactoring the auth module'),
    userEntry('Can you look at the auth module and suggest improvements?', 0),
    assistantEntry(
      "I've reviewed the auth module. Here are the key issues:\n1. No token refresh logic\n2. Passwords stored in plaintext\n3. Missing rate limiting on login endpoint",
      2,
      {
        usage: {
          input_tokens: 500,
          output_tokens: 200,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 100,
        },
      },
    ),
    userEntry('Fix the password storage first, use bcrypt', 5),
    assistantEntry(
      "I've updated the password storage to use bcrypt with a cost factor of 12. Here are the changes:\n- Added bcrypt dependency\n- Modified User.setPassword() to hash with bcrypt\n- Updated User.verifyPassword() to use bcrypt.compare()\n- Added migration to rehash existing passwords on next login",
      8,
      {
        usage: {
          input_tokens: 800,
          output_tokens: 400,
          cache_read_input_tokens: 1500,
          cache_creation_input_tokens: 50,
        },
      },
    ),
    userEntry('Now add rate limiting to the login endpoint', 10),
    assistantEntry(
      "Done! I've added rate limiting using a sliding window approach:\n- 5 attempts per IP per 15 minutes\n- Exponential backoff after 3 failures\n- Redis-backed for distributed deployments",
      15,
      {
        usage: {
          input_tokens: 600,
          output_tokens: 300,
          cache_read_input_tokens: 1200,
          cache_creation_input_tokens: 40,
        },
      },
    ),
  )
}

/**
 * Session with multi-message assistant response (same message ID, split across lines).
 */
export function splitAssistantSession(): string {
  resetCounters()
  const mid = 'msg_split_test_001'
  return jsonl(
    userEntry('Explain the database schema', 0),
    // First chunk of assistant response
    assistantEntry('The database has three main tables:', 1, {
      messageId: mid,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    }),
    // Progress event in between (should be ignored)
    progressEntry(1.5),
    // Second chunk with same message ID — should merge
    assistantEntry(
      '1. Users - stores credentials and profile\n2. Sessions - active auth sessions\n3. Permissions - role-based access control',
      2,
      {
        messageId: mid,
        usage: { input_tokens: 100, output_tokens: 80, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
      },
    ),
  )
}

/**
 * Session with interruption patterns that should be filtered.
 */
export function interruptionSession(): string {
  resetCounters()
  return jsonl(
    userEntry('Start the refactoring', 0),
    assistantEntry('Starting the refactoring process. Let me first analyze the codebase.', 1),
    // Interrupted for tool use (subagent spawn noise) — should be filtered
    systemEntry('[Request interrupted by user for tool use]', 2),
    assistantEntry("I've completed the analysis. Here are the refactoring changes I made to improve code quality.", 3),
    // Real user input after interrupt prefix
    userEntry('[Request interrupted by user]\nActually, focus on the API layer only', 5),
    assistantEntry(
      "Got it, focusing on the API layer. I've restructured the route handlers and added proper middleware.",
      7,
    ),
    // Pure Ctrl+C interrupt — should be filtered
    systemEntry('[Request interrupted by user]', 8),
    userEntry('Looks good, ship it', 10),
    assistantEntry('All changes committed and pushed. The API refactoring is complete.', 11),
  )
}

/**
 * Session with tool uses and subagent launches.
 */
export function toolUseSession(): string {
  resetCounters()
  const tid1 = toolId()
  const tid2 = toolId()
  const tid3 = toolId()
  return jsonl(
    userEntry('Find all TODO comments and fix them', 0),
    assistantEntry('Let me search for TODO comments across the codebase.', 1, {
      toolUses: [{ name: 'Grep', id: tid1, input: { pattern: 'TODO', path: '.' } }],
    }),
    assistantEntry('Found 12 TODOs. Let me fix them systematically.', 3, {
      toolUses: [
        { name: 'Edit', id: tid2, input: { file_path: 'src/auth.ts' } },
        {
          name: 'Agent',
          id: tid3,
          input: {
            description: 'Fix TODOs in tests',
            subagent_type: 'Explore',
            prompt: 'Find and fix TODO comments in test files',
          },
        },
      ],
    }),
    assistantEntry(
      'All 12 TODO comments have been resolved. 8 were fixed directly and 4 were delegated to a subagent.',
      10,
    ),
  )
}

/**
 * Session with system XML tags that should be filtered from user messages.
 */
export function systemXmlSession(): string {
  resetCounters()
  return jsonl(
    // System reminder — should be filtered entirely
    systemEntry('<system-reminder>\nCalled the Read tool\n</system-reminder>', 0),
    userEntry('What does this function do?', 1),
    assistantEntry('This function handles authentication by validating the JWT token and checking permissions.', 2),
    // Task notification — should be filtered
    systemEntry('<task-notification type="completed">Task 1 done</task-notification>', 3),
    // Command — should be filtered
    systemEntry('<command-name>/commit</command-name>\n<command-message>commit</command-message>', 4),
    userEntry('Thanks, now add error handling', 5),
    assistantEntry("I've added comprehensive error handling with proper HTTP status codes and error messages.", 6),
  )
}

/**
 * Session with multiple assistant turns that get collapsed.
 * Tests the response-picking logic.
 */
export function multiResponseSession(): string {
  resetCounters()
  return jsonl(
    userEntry('Refactor the database module', 0),
    // Multiple assistant turns — should be collapsed
    assistantEntry('Let me look at the database module first.', 1),
    assistantEntry('I see several issues with the current implementation.', 2),
    assistantEntry('ok', 3), // Short response — should trigger merge with previous
    userEntry('What about the tests?', 5),
    // Single substantial response
    assistantEntry(
      "The tests are well-structured but missing edge cases. I've added tests for null inputs, concurrent access, and connection timeouts. All 47 tests pass.",
      7,
    ),
  )
}

/**
 * Empty/metadata-only session (should be skippable by size check).
 */
export function tinySession(): string {
  resetCounters()
  return jsonl({ type: 'custom-title', customTitle: 'Quick test', sessionId: 'tiny-session', timestamp: ts(0) })
}

/**
 * Session with usage data for testing token aggregation.
 */
export function usageTrackingSession(): string {
  resetCounters()
  return jsonl(
    userEntry('Task 1', 0),
    assistantEntry('Response 1', 1, {
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 },
    }),
    userEntry('Task 2', 5),
    assistantEntry('Response 2', 6, {
      usage: { input_tokens: 150, output_tokens: 75, cache_read_input_tokens: 300, cache_creation_input_tokens: 45 },
    }),
    userEntry('Task 3', 10),
    assistantEntry('Response 3', 11, {
      usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 400, cache_creation_input_tokens: 60 },
    }),
  )
}

/**
 * Session where user interrupts the agent and retypes — consecutive user
 * prompts with no assistant response in between should be merged.
 * Modeled after a real session where Enter/Shift+Enter wasn't working.
 */
export function consecutiveUserPromptsSession(): string {
  resetCounters()
  return jsonl(
    userEntry('Brainstorm about the project', 0),
    assistantEntry('Let me explore the codebase to understand the current state.', 1),
    // User interrupts (Ctrl+C)
    systemEntry('[Request interrupted by user]', 2),
    // User tries to type but accidentally submits partial prompt
    userEntry('The main questions for planning:', 3),
    // Interrupted again
    systemEntry('[Request interrupted by user]', 3.5),
    // Same partial prompt again
    userEntry('The main questions for planning:', 4),
    // Interrupted again
    systemEntry('[Request interrupted by user]', 4.5),
    // Finally the full message ~9 minutes later
    userEntry('sorry, cant type enter; anyhow: the main questions: 1. data model 2. sync protocol 3. relay design', 12),
    assistantEntry(
      'Great questions! Here is my analysis of each:\n1. Data model: use a flat store with JSON patches\n2. Sync: shadow copies with incremental diffs\n3. Relay: simple WebSocket broker with token-based rooms',
      15,
    ),
  )
}

/**
 * Session with no usage data at all.
 */
export function noUsageSession(): string {
  resetCounters()
  return jsonl(userEntry('Hello', 0), assistantEntry('Hi there!', 1, { usage: {} }))
}

/**
 * Session where the last message is a user prompt with no response
 * (session ended mid-conversation). Should drop the trailing prompt.
 */
export function trailingPromptSession(): string {
  resetCounters()
  return jsonl(
    userEntry('First question', 0),
    assistantEntry('Here is the answer to your first question, covering all the details you need.', 1),
    userEntry('Second question that never got answered', 5),
  )
}

/**
 * Large-ish session for incremental update testing.
 * Returns a base session and an extended version with more turns.
 */
export function incrementalSession(): { base: string; extended: string } {
  resetCounters()
  const basePart = jsonl(
    customTitleEntry('Incremental test'),
    userEntry('Initial setup', 0),
    assistantEntry('Set up the project with the basic scaffolding and configuration files.', 2),
    userEntry('Add the database layer', 5),
    assistantEntry('Added PostgreSQL integration with connection pooling and migrations.', 8),
  )

  // Extended version adds more turns
  const extendedPart = jsonl(
    userEntry('Now add caching', 15),
    assistantEntry('Implemented Redis caching layer with TTL support and cache invalidation hooks.', 20),
  )

  return {
    base: basePart,
    extended: basePart + extendedPart,
  }
}

// Export session IDs used in fixtures for assertion convenience
export const FIXTURE_SESSION_ID = 'aaaabbbb-1111-2222-3333-444455556666'
export const FIXTURE_SESSION_PREFIX = 'aaaabbbb'
