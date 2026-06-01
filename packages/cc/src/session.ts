import { RollingBuffer } from './rolling-buffer.ts'
import type { CCEvent, PendingApproval, PendingQuestion, SessionState } from './types.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export type SpecialKey = 'ctrl-c' | 'enter' | 'ctrl-d' | 'arrow-up' | 'arrow-down' | 'y' | 'n'

// Bun's pipe stdin is a FileSink at runtime but typed as ReadableStream in some signatures.
interface ProcStdin {
  write(chunk: string): void
  end(): void
}

export interface StateChangeEvent {
  sessionId: string
  previous: SessionState
  current: SessionState
  timestamp: number
}

export interface CCSessionObserver {
  onStateChange?(event: StateChangeEvent): void
  onData?(line: string): void
  onExit?(exitCode: number): void
}

export interface CCSessionOptions {
  id: string
  workingDirectory: string
  agentBinary?: string
  agentArgs?: string[]
  bufferCapacity?: number
  resumeSessionId?: string
}

// ── Env vars to strip (CC refuses to start when nested) ─────────────────────

const STRIP_ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']

// ── Helper: extract plain text from a Claude content value ───────────────────

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'text',
      )
      .map((b) => b.text)
      .join('')
  }
  return ''
}

// ─────────────────────────────────────────────────────────────────────────────

export class CCSession {
  readonly id: string
  readonly workingDirectory: string

  private buffer: RollingBuffer
  private pendingSubagentIds = new Set<string>()
  private currentState: SessionState = 'starting'
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private agentBinary: string
  private agentArgs: string[]
  private observers: CCSessionObserver[] = []

  // Tool-approval state
  private _pendingApproval: PendingApproval | null = null
  private _pendingApprovalRequestId: string | null = null
  private _selectedOption = 0

  // AskUserQuestion state
  private _pendingQuestion: PendingQuestion | null = null
  private _pendingQuestionRequestId: string | null = null
  private _pendingQuestionInput: Record<string, unknown> | null = null

  // CC session ID captured from events
  private _ccSessionId: string | null = null

  // Optional session ID to resume (--resume flag)
  private resumeSessionId?: string

  // Stderr capture
  _lastStderr = ''
  private _stderrDone: Promise<void> = Promise.resolve()

  constructor(options: CCSessionOptions) {
    this.id = options.id
    this.workingDirectory = options.workingDirectory
    this.agentBinary = options.agentBinary ?? 'claude'
    this.agentArgs = options.agentArgs ?? []
    this.resumeSessionId = options.resumeSessionId
    this.buffer = new RollingBuffer(options.bufferCapacity ?? 2000)
  }

  // ── Observer pattern ───────────────────────────────────────────────────────

  addObserver(observer: CCSessionObserver): void {
    this.observers.push(observer)
  }

  removeObserver(observer: CCSessionObserver): void {
    this.observers = this.observers.filter((o) => o !== observer)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const { existsSync } = await import('node:fs')
    if (!existsSync(this.workingDirectory)) {
      throw new Error(`Working directory does not exist: ${this.workingDirectory}`)
    }

    const cmd = [
      this.agentBinary,
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      ...(this.resumeSessionId ? ['--resume', this.resumeSessionId] : []),
      ...this.agentArgs,
    ]

    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    for (const key of STRIP_ENV_KEYS) {
      delete env[key]
    }

    this.proc = Bun.spawn(cmd, {
      cwd: this.workingDirectory,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    this._setState('starting')
    void this._startReadLoop()

    if (this.proc.stderr) {
      this._stderrDone = (async () => {
        const r = (this.proc!.stderr as ReadableStream<Uint8Array>).getReader()
        let buf = ''
        try {
          while (true) {
            const { done, value } = await r.read()
            if (done) break
            buf += new TextDecoder().decode(value)
          }
        } catch {
          /* ignore */
        }
        if (buf.trim()) this._lastStderr = buf.trim()
      })()
    }

    void this.proc.exited.then((code: number) => this._handleExit(code))
    // CC JSON mode emits nothing until the first user turn — transition to idle immediately.
    this._setState('idle')
  }

  // ── Stdout read loop ───────────────────────────────────────────────────────

  private async _startReadLoop(): Promise<void> {
    if (!this.proc?.stdout) return
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let partial = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        partial += decoder.decode(value)
        const lines = partial.split('\n')
        partial = lines.pop()!
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed) this._handleLine(trimmed)
        }
      }
    } catch {
      // stream closed — exit handler will fire
    }
    if (partial.trim()) {
      this._handleLine(partial.trim())
    }
  }

  // ── Public for unit testing ────────────────────────────────────────────────

  _handleLine(line: string): void {
    let event: CCEvent
    try {
      event = JSON.parse(line) as CCEvent
    } catch {
      return
    }
    if (this.currentState === 'starting') this._setState('idle')
    this._dispatchEvent(event)
  }

  private _dispatchEvent(event: CCEvent): void {
    if (!this._ccSessionId && typeof event.sessionId === 'string') {
      this._ccSessionId = event.sessionId
    }

    switch (event.type) {
      // ── Noise / intermediates ─────────────────────────────────────────────
      case 'keep_alive':
      case 'streamlined_text':
      case 'streamlined_tool_use_summary':
      case 'stream_event':
        return

      // ── Content events ────────────────────────────────────────────────────
      case 'system': {
        const parts: string[] = []
        const textContent = extractText(event.content)
        if (textContent) parts.push(textContent)
        if (event.session_id) parts.push(`session:${event.session_id}`)
        if (event.model) parts.push(`model:${event.model}`)
        if (event.cwd) parts.push(`cwd:${event.cwd}`)
        if (parts.length > 0) this._pushLine(`[system] ${parts.join(' | ').slice(0, 200)}`)
        break
      }

      case 'assistant': {
        const msg = (event.message ?? event) as Record<string, unknown>
        const content = msg.content
        const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
        for (const block of blocks) {
          if (block.type === 'text') {
            const text = (block.text as string) ?? ''
            if (text.trim()) this._pushLine(`[assistant] ${text.slice(0, 4000)}`)
          } else if (block.type === 'tool_use') {
            const name = (block.name as string) ?? 'tool'
            if (name === 'AskUserQuestion') {
              this._handleAskUserQuestion(block.input as Record<string, unknown>)
            } else if (name === 'Agent') {
              const input = block.input as Record<string, unknown> | undefined
              const desc = (input?.description as string) ?? 'subagent'
              this.pendingSubagentIds.add(block.id as string)
              this._pushLine(`[subagent] ${desc}`)
            } else {
              const inputStr = block.input ? JSON.stringify(block.input).slice(0, 120) : ''
              this._pushLine(`[tool:${name}] ${inputStr}`)
            }
          }
        }
        // Fallback for plain string content
        if (typeof content === 'string' && content.trim()) {
          this._pushLine(`[assistant] ${content.slice(0, 400)}`)
        }
        break
      }

      case 'user': {
        const msg = (event.message ?? event) as Record<string, unknown>
        const content = msg.content
        if (typeof content === 'string') {
          if (content.trim()) this._pushLine(`[user] ${content.slice(0, 300)}`)
        } else {
          const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
          for (const block of blocks) {
            if (block.type === 'text') {
              const text = (block.text as string) ?? ''
              if (text.trim()) this._pushLine(`[user] ${text.slice(0, 300)}`)
            } else if (block.type === 'tool_result') {
              const toolUseId = block.tool_use_id as string
              if (toolUseId && this.pendingSubagentIds.has(toolUseId)) {
                this.pendingSubagentIds.delete(toolUseId)
                const tur = (event.toolUseResult ?? event.tool_use_result) as Record<string, unknown> | undefined
                const resultText = extractText(block.content)
                const agentId = (tur?.agentId as string) ?? resultText.match(/agentId:\s*(\S+)/)?.[1] ?? ''
                if (tur) {
                  const tools = (tur.totalToolUseCount as number) ?? 0
                  const ms = (tur.totalDurationMs as number) ?? 0
                  this._pushLine(`[subagent:done:${agentId}] ${tools} tools, ${Math.round(ms / 1000)}s`)
                } else {
                  const m = resultText.match(/tool_uses:\s*(\d+).*?duration_ms:\s*(\d+)/s)
                  if (m)
                    this._pushLine(
                      `[subagent:done:${agentId}] ${m[1]} tools, ${Math.round(parseInt(m[2], 10) / 1000)}s`,
                    )
                  else this._pushLine(`[subagent:done:${agentId}]`)
                }
              } else {
                const text = extractText(block.content)
                this._pushLine(`[result] ${(text || '(empty)').slice(0, 300)}`)
              }
            }
          }
        }
        break
      }

      // Legacy top-level tool events (pre-2.1.59)
      case 'tool_use': {
        const name = (event.name as string) ?? 'tool'
        if (name === 'Agent') {
          const input = event.input as Record<string, unknown> | undefined
          const desc = (input?.description as string) ?? 'subagent'
          this.pendingSubagentIds.add(event.id as string)
          this._pushLine(`[subagent] ${desc}`)
        } else {
          const inputStr = event.input ? JSON.stringify(event.input).slice(0, 120) : ''
          this._pushLine(`[tool:${name}] ${inputStr}`)
        }
        break
      }

      case 'tool_result': {
        const text = extractText(event.content)
        this._pushLine(`[result] ${(text || '(empty)').slice(0, 300)}`)
        break
      }

      case 'thinking': {
        const text = (event.thinking as string) ?? ''
        if (text.trim()) this._pushLine(`[thinking] ${text.slice(0, 150)}`)
        break
      }

      // ── Turn complete ─────────────────────────────────────────────────────
      case 'result': {
        if (typeof event.session_id === 'string') {
          this._ccSessionId = event.session_id
        }
        this._pushLine('[turn complete]')
        this._clearPendingApproval()
        this._setState(this._pendingQuestion ? 'waitingForInput' : 'idle')
        break
      }

      // ── Tool-permission request ───────────────────────────────────────────
      case 'control_request': {
        const req = event.request as Record<string, unknown> | undefined
        if (req?.subtype === 'can_use_tool') {
          this._handleToolRequest(event.request_id as string, req)
        }
        break
      }

      default:
        break
    }
  }

  private _handleAskUserQuestion(input: Record<string, unknown>): void {
    const rawQuestions = input.questions as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return

    const questions = rawQuestions.map((q) => ({
      question: (q.question as string) ?? '',
      header: (q.header as string) ?? '',
      multiSelect: (q.multiSelect as boolean) ?? false,
      options: (Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : []).map((o) => ({
        label: (o.label as string) ?? '',
        description: (o.description as string) ?? '',
      })),
    }))

    this._pendingQuestion = { questions }

    for (const q of questions) {
      const opts = q.options.map((o, i) => `${i + 1}. ${o.label}`).join(', ')
      this._pushLine(`[question] ${q.question} [${opts}]`)
    }
  }

  private _handleToolRequest(requestId: string, req: Record<string, unknown>): void {
    const toolName = (req.tool_name as string) ?? 'unknown'
    const toolInput = (req.input as Record<string, unknown>) ?? {}

    if (toolName === 'AskUserQuestion') {
      this._pendingQuestionRequestId = requestId
      this._pendingQuestionInput = toolInput
      if (!this._pendingQuestion) {
        this._handleAskUserQuestion(toolInput)
      }
      this._setState('waitingForInput')
      return
    }

    const rawSuggestions = (req.permission_suggestions as string[]) ?? []

    const options =
      rawSuggestions.length > 0
        ? rawSuggestions.map((key) => ({
            key,
            label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          }))
        : [
            { key: 'allow', label: 'Allow' },
            { key: 'deny', label: 'Deny' },
          ]

    this._pendingApproval = { toolName, toolInput, options }
    this._pendingApprovalRequestId = requestId
    this._selectedOption = 0

    this._pushLine(`[approval needed:${toolName}] ${JSON.stringify(toolInput).slice(0, 100)}`)
    this._setState(rawSuggestions.length > 1 ? 'offeringChoices' : 'waitingForInput')
  }

  // ── Low-level helpers ──────────────────────────────────────────────────────

  private _pushLine(line: string): void {
    this.buffer.push(line)
    for (const obs of this.observers) obs.onData?.(line)
  }

  private _writeLine(json: string): void {
    if (!this.proc?.stdin) return
    ;(this.proc.stdin as unknown as ProcStdin).write(`${json}\n`)
  }

  private _sendInterrupt(): void {
    this._writeLine(
      JSON.stringify({
        type: 'control_request',
        request_id: crypto.randomUUID(),
        request: { subtype: 'interrupt' },
      }),
    )
  }

  private _respondToQuestion(answerText: string): void {
    if (!this._pendingQuestionRequestId || !this._pendingQuestion) return

    const answers: Record<string, string> = {}
    for (const q of this._pendingQuestion.questions) {
      const match = q.options.find((o) => o.label.toLowerCase() === answerText.toLowerCase()) ?? q.options[0]
      answers[q.question] = match?.label ?? answerText
    }

    this._writeLine(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: this._pendingQuestionRequestId,
          response: {
            behavior: 'allow',
            updatedInput: {
              ...this._pendingQuestionInput,
              answers,
            },
          },
        },
      }),
    )

    this._pushLine(`[user] ${answerText}`)
    this._pendingQuestion = null
    this._pendingQuestionRequestId = null
    this._pendingQuestionInput = null
    this._setState('busy')
  }

  private _respondToToolRequest(optionKey: string): void {
    if (!this._pendingApprovalRequestId) return
    this._writeLine(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: this._pendingApprovalRequestId,
          response: { behavior: optionKey },
        },
      }),
    )
    this._clearPendingApproval()
    this._setState('busy')
  }

  private _clearPendingApproval(): void {
    this._pendingApproval = null
    this._pendingApprovalRequestId = null
    this._selectedOption = 0
  }

  private _handleExit(exitCode: number): void {
    this._stderrDone.then(() => {
      this._setState('exited')
      for (const obs of this.observers) obs.onExit?.(exitCode)
    })
  }

  private _setState(next: SessionState): void {
    if (next === this.currentState) return
    const event: StateChangeEvent = {
      sessionId: this.id,
      previous: this.currentState,
      current: next,
      timestamp: Date.now(),
    }
    this.currentState = next
    for (const obs of this.observers) obs.onStateChange?.(event)
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  contextLines(): string[] {
    return this.buffer.getLines()
  }

  state(): SessionState {
    return this.currentState
  }

  pendingApproval(): PendingApproval | null {
    return this._pendingApproval
  }

  pendingQuestion(): PendingQuestion | null {
    return this._pendingQuestion
  }

  pid(): number | undefined {
    return this.proc?.pid
  }

  ccSessionId(): string | undefined {
    return this._ccSessionId ?? undefined
  }

  /** Pre-populate the context buffer from a CC JSONL conversation history file. */
  async preloadHistory(jsonlPath: string, maxEvents = 800): Promise<void> {
    try {
      const text = await Bun.file(jsonlPath).text()
      const allLines = text.split('\n').filter((l) => l.trim())
      const lines = allLines.slice(-maxEvents)
      for (const line of lines) {
        try {
          this._dispatchEvent(JSON.parse(line) as CCEvent)
        } catch {
          /* skip corrupt lines */
        }
      }
    } catch {
      /* file not found or unreadable */
    }
  }

  write(text: string): void {
    if (this._pendingQuestion && this._pendingQuestionRequestId) {
      this._respondToQuestion(text)
      return
    }

    this._pendingQuestion = null
    this._writeLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }),
    )
    this._setState('busy')
  }

  writeKey(key: SpecialKey): void {
    switch (key) {
      case 'ctrl-c':
        this._sendInterrupt()
        break
      case 'ctrl-d':
        if (this.proc?.stdin) (this.proc.stdin as unknown as ProcStdin).end()
        break
      case 'y':
        if (this._pendingApproval) {
          const opt =
            this._pendingApproval.options.find((o) => o.key.includes('allow')) ?? this._pendingApproval.options[0]
          this._respondToToolRequest(opt.key)
        }
        break
      case 'n':
        if (this._pendingApproval) {
          const opt =
            this._pendingApproval.options.find((o) => o.key.includes('deny')) ?? this._pendingApproval.options.at(-1)!
          this._respondToToolRequest(opt.key)
        }
        break
      case 'arrow-up':
        if (this._pendingApproval) {
          this._selectedOption = Math.max(0, this._selectedOption - 1)
        }
        break
      case 'arrow-down':
        if (this._pendingApproval) {
          this._selectedOption = Math.min(this._pendingApproval.options.length - 1, this._selectedOption + 1)
        }
        break
      case 'enter':
        if (this._pendingApproval) {
          this._respondToToolRequest(this._pendingApproval.options[this._selectedOption].key)
        }
        break
    }
  }

  approve(optionKey: string): void {
    if (this._pendingApproval) {
      this._respondToToolRequest(optionKey)
    }
  }

  deny(): void {
    if (this._pendingApproval) {
      const opt =
        this._pendingApproval.options.find((o) => o.key.includes('deny')) ?? this._pendingApproval.options.at(-1)!
      this._respondToToolRequest(opt.key)
    }
  }

  kill(): void {
    if (!this.proc) return
    try {
      if (this.proc.stdin) (this.proc.stdin as unknown as ProcStdin).end()
      const proc = this.proc
      setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* already dead */
        }
      }, 1500)
    } catch {
      /* already dead */
    }
  }

  wait(): Promise<number> {
    if (!this.proc) return Promise.resolve(-1)
    return this.proc.exited
  }
}
