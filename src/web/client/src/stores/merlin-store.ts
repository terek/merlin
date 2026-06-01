import { applyPatch, type Operation } from 'fast-json-patch'
import { create } from 'zustand'
import type { ActiveSession, LeanTurn, MerlinModel, RawTurn, Segment, SessionSummary, SessionTask } from '@/types/model'
import type { ClerkMessageEntry, ClientMessage, DaemonMessage } from '@/types/protocol'

// Immutably update sessions in a project within the model
function _updateSessions(model: MerlinModel, cwd: string, fn: (s: SessionSummary) => SessionSummary): MerlinModel {
  const project = model.projects[cwd]
  if (!project) return model
  const sessions = project.sessions.map(fn)
  const running = sessions.filter((s) => s.ppStatus === 'running').length
  const processed = sessions.filter((s) => s.ppStatus === 'processed').length
  const error = sessions.filter((s) => s.ppStatus === 'error').length
  const outdated = sessions.filter((s) => s.ppStatus === 'outdated').length
  const missing = sessions.filter((s) => s.ppStatus === 'missing' || !s.ppStatus).length
  return {
    ...model,
    projects: {
      ...model.projects,
      [cwd]: {
        ...project,
        sessions,
        preprocessing: {
          total: sessions.length,
          running,
          processed,
          error,
          outdated,
          missing,
        },
      },
    },
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
  done: boolean
  /** For role='tool': the tool name (e.g. 'search_tasks'). Used by debug rendering. */
  tool?: string
  /** For role='tool': the tool's result content as fed back to the LLM. */
  result?: string
}

/**
 * Flatten a Clerk study session snapshot into renderable transcript lines.
 * Walks once: user/assistant entries map to bubbles; tool_results expand into
 * one tool ChatMessage per result, with the tool name looked up from the
 * preceding assistant.toolCalls entries (matched by callId).
 */
function snapshotToChatMessages(entries: ClerkMessageEntry[]): ChatMessage[] {
  const out: ChatMessage[] = []
  const callIdToName = new Map<string, string>()
  for (const e of entries) {
    if (e.role === 'user' && e.text) {
      out.push({ role: 'user', text: e.text, done: true })
    } else if (e.role === 'assistant') {
      if (e.text) out.push({ role: 'assistant', text: e.text, done: true })
      if (e.toolCalls) for (const tc of e.toolCalls) callIdToName.set(tc.id, tc.name)
    } else if (e.role === 'tool_results' && e.toolResults) {
      for (const tr of e.toolResults) {
        const name = callIdToName.get(tr.callId) ?? 'tool'
        out.push({ role: 'tool', text: `[${name}]`, done: true, tool: name, result: tr.content })
      }
    }
  }
  return out
}

export type NavigationFocus =
  | { level: 'root' }
  | { level: 'host' }
  | { level: 'project'; cwd: string }
  | { level: 'session'; cwd: string; sessionId: string; sessionCwd?: string }

export type HostFilter = 'active' | 'archived'
export type ProjectTab = 'sessions' | 'timeline' | 'organizer'
export type SessionTab = 'raw' | 'lean' | 'tasks'

export interface OrganizerTaskRename {
  /** Composite id: "${sessionId}/${taskId}" */
  taskId: string
  name: string
  group?: string
  note?: string
}
export interface OrganizerData {
  pending: boolean
  error?: string
  tasks: OrganizerTaskRename[]
  generatedAt?: string
}

interface MerlinState {
  // Connection
  connected: boolean
  daemonName: string | null

  // Navigation
  focus: NavigationFocus

  // Per-level view state
  hostFilter: HostFilter
  projectTab: ProjectTab
  sessionTab: SessionTab

  // Per-page search query
  hostSearch: string
  projectSearch: Map<string, string> // keyed by cwd
  sessionSearch: Map<string, string> // keyed by cwd

  // Model (metadata scope)
  model: MerlinModel | null

  // Sessions (session scope, keyed by sessionId)
  sessions: Map<string, ActiveSession>

  // Preprocessed segments (keyed by cwd) — legacy
  segmentsByProject: Map<string, unknown[]>
  segmentsLoading: Set<string>

  // Raw turns (keyed by sessionId)
  rawTurnsBySession: Map<string, { turns: RawTurn[]; total: number; title: string | null }>
  rawTurnsLoading: Set<string>

  // Lean turns from processor (keyed by sessionId)
  leanTurnsBySession: Map<string, { turns: LeanTurn[]; title: string | null; tasks?: SessionTask[] }>
  leanTurnsLoading: Set<string>

  // Session segments from processor (keyed by sessionId)
  sessionSegments: Map<string, Segment[]>
  sessionSegmentsLoading: Set<string>

  // Tasks per session, grouped by project cwd (for Sessions tab overview)
  tasksByProject: Map<string, Record<string, SessionTask[]>>
  tasksByProjectLoading: Set<string>

  // Semantic task search (keyed by cwd). Tracks the latest in-flight requestId
  // so out-of-order daemon replies can be discarded.
  taskSearchByProject: Map<
    string,
    {
      query: string
      requestId: string
      pending: boolean
      results: Array<{ sessionId: string; taskId: string; score: number; task: SessionTask }>
      error?: string
    }
  >

  // Organizer (LLM-driven renames), keyed by cwd. In-memory only.
  organizerByProject: Map<string, OrganizerData>

  // Chat (Study mode — one active session per project)
  chatMessages: ChatMessage[]
  chatStreaming: boolean
  chatProjectCwd: string | null
  /** System prompt the LLM would see; populated by clerk_active. Null on first load. */
  chatSystemPrompt: string | null

  // WebSocket send function (set by the hook)
  _send: ((msg: ClientMessage) => void) | null

  // Actions
  handleMessage: (msg: DaemonMessage) => void
  sendCommand: (msg: ClientMessage) => void
  setConnected: (connected: boolean) => void
  setSend: (fn: (msg: ClientMessage) => void) => void

  // Navigation
  navigate: (focus: NavigationFocus) => void
  setHostFilter: (filter: HostFilter) => void
  setProjectTab: (tab: ProjectTab) => void
  setSessionTab: (tab: SessionTab) => void
  setHostSearch: (q: string) => void
  setProjectSearch: (cwd: string, q: string) => void
  setSessionSearch: (cwd: string, q: string) => void

  // Data fetching
  requestSegments: (cwd: string) => void
  requestRawTurns: (cwd: string, sessionId: string) => void
  requestLeanTurns: (cwd: string, sessionId: string) => void
  requestSessionSegments: (cwd: string, sessionId: string) => void
  requestProjectTasks: (cwd: string) => void
  searchProjectTasks: (cwd: string, query: string) => void
  clearProjectTaskSearch: (cwd: string) => void
  requestOrganizer: (cwd: string, refresh?: boolean) => void

  // Chat actions
  startChat: (cwd: string) => void
  sendChatMessage: (text: string) => void
  interruptChat: () => void
  clearChat: () => void

  // Processing actions (two buttons: process + delete)
  processProject: (cwd: string) => void
  processSession: (cwd: string, sessionId: string) => void
  processAll: () => void
  deleteProcessing: (cwd: string, sessionId?: string) => void
  reembedProject: (cwd: string) => void
}

export const useMerlinStore = create<MerlinState>((set, get) => ({
  connected: false,
  daemonName: null,
  focus: { level: 'host' } as NavigationFocus,
  hostFilter: 'active' as HostFilter,
  projectTab: 'sessions' as ProjectTab,
  sessionTab: 'raw' as SessionTab,
  hostSearch: '',
  projectSearch: new Map(),
  sessionSearch: new Map(),
  model: null,
  sessions: new Map(),
  segmentsByProject: new Map(),
  segmentsLoading: new Set(),
  rawTurnsBySession: new Map(),
  rawTurnsLoading: new Set(),
  leanTurnsBySession: new Map(),
  leanTurnsLoading: new Set(),
  sessionSegments: new Map(),
  sessionSegmentsLoading: new Set(),
  tasksByProject: new Map(),
  tasksByProjectLoading: new Set(),
  taskSearchByProject: new Map(),
  organizerByProject: new Map(),
  chatMessages: [],
  chatStreaming: false,
  chatProjectCwd: null,
  chatSystemPrompt: null,
  _send: null,

  setConnected: (connected) => {
    if (!connected) {
      set({
        connected,
        rawTurnsLoading: new Set(),
        segmentsLoading: new Set(),
        leanTurnsLoading: new Set(),
        sessionSegmentsLoading: new Set(),
        tasksByProjectLoading: new Set(),
      })
    } else {
      set({ connected })
    }
  },
  setSend: (fn) => set({ _send: fn }),

  navigate: (focus) => {
    const prev = get().focus
    if (prev.level === 'session') {
      get().sendCommand({ type: 'unsubscribe', scope: 'session', sessionId: prev.sessionId })
    }
    if (focus.level === 'session') {
      get().sendCommand({ type: 'subscribe', scope: 'session', sessionId: focus.sessionId })
    }
    if (focus.level === 'project' || focus.level === 'session') {
      const { chatProjectCwd } = get()
      if (chatProjectCwd !== focus.cwd) {
        set({ chatProjectCwd: focus.cwd, chatMessages: [], chatStreaming: false, chatSystemPrompt: null })
        // Pull whatever active study session the daemon has for this project.
        get().sendCommand({ type: 'clerk_load', cwd: focus.cwd })
      }
    }
    set({ focus })
  },

  setHostFilter: (filter) => set({ hostFilter: filter }),
  setProjectTab: (tab) => set({ projectTab: tab }),
  setSessionTab: (tab) => set({ sessionTab: tab }),
  setHostSearch: (q) => set({ hostSearch: q }),
  setProjectSearch: (cwd, q) =>
    set((s) => {
      const m = new Map(s.projectSearch)
      if (q) m.set(cwd, q)
      else m.delete(cwd)
      return { projectSearch: m }
    }),
  setSessionSearch: (cwd, q) =>
    set((s) => {
      const m = new Map(s.sessionSearch)
      if (q) m.set(cwd, q)
      else m.delete(cwd)
      return { sessionSearch: m }
    }),

  sendCommand: (msg) => {
    const { _send } = get()
    _send?.(msg)
  },

  handleMessage: (msg) => {
    switch (msg.type) {
      case 'snapshot':
        if (msg.scope === 'metadata') {
          set({ model: msg.data, daemonName: msg.data.host.name })
        } else if (msg.scope === 'session') {
          set((s) => {
            const sessions = new Map(s.sessions)
            sessions.set(msg.sessionId, msg.data)
            return { sessions }
          })
        }
        break

      case 'patch':
        if (msg.scope === 'metadata') {
          set((s) => {
            if (!s.model) return s
            const patched = applyPatch(structuredClone(s.model), msg.ops as Operation[]).newDocument

            // Invalidate cached lean turns / segments for sessions that just became 'processed'
            const leanTurnsBySession = new Map(s.leanTurnsBySession)
            const sessionSegments = new Map(s.sessionSegments)
            const tasksByProject = new Map(s.tasksByProject)
            let invalidated = false
            for (const project of Object.values(patched.projects)) {
              for (const sess of project.sessions) {
                const prev = s.model?.projects[project.cwd]?.sessions.find(
                  (ps: SessionSummary) => ps.sessionId === sess.sessionId,
                )
                if (sess.ppStatus === 'processed' && prev?.ppStatus !== 'processed') {
                  leanTurnsBySession.delete(sess.sessionId)
                  sessionSegments.delete(sess.sessionId)
                  tasksByProject.delete(project.cwd)
                  invalidated = true
                }
              }
            }

            return invalidated
              ? { model: patched, leanTurnsBySession, sessionSegments, tasksByProject }
              : { model: patched }
          })
        } else if (msg.scope === 'session') {
          set((s) => {
            const existing = s.sessions.get(msg.sessionId)
            if (!existing) return s
            const sessions = new Map(s.sessions)
            const patched = applyPatch(structuredClone(existing), msg.ops as Operation[]).newDocument
            sessions.set(msg.sessionId, patched)
            return { sessions }
          })
        }
        break

      case 'clerk_chunk':
        set((s) => {
          if (msg.cwd !== s.chatProjectCwd) return s
          const msgs = [...s.chatMessages]
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant' && !last.done) {
            msgs[msgs.length - 1] = { ...last, text: last.text + msg.text }
          } else {
            msgs.push({ role: 'assistant', text: msg.text, done: false })
          }
          return { chatMessages: msgs }
        })
        break

      case 'clerk_tool_activity':
        set((s) => {
          if (msg.cwd !== s.chatProjectCwd) return s
          return {
            chatMessages: [
              ...s.chatMessages,
              {
                role: 'tool' as const,
                text: `[${msg.tool}] ${msg.description}`,
                done: true,
                tool: msg.tool,
              },
            ],
          }
        })
        break

      case 'clerk_tool_result':
        // Attach the result to the most recent tool message lacking one. Order
        // is guaranteed by the daemon flush logic — activities and results are
        // sequential per the agent's tool-use loop.
        set((s) => {
          if (msg.cwd !== s.chatProjectCwd) return s
          const msgs = [...s.chatMessages]
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i]
            if (m.role === 'tool' && m.tool === msg.tool && !m.result) {
              msgs[i] = { ...m, result: msg.content }
              break
            }
          }
          return { chatMessages: msgs }
        })
        break

      case 'clerk_done':
        set((s) => {
          if (msg.cwd !== s.chatProjectCwd) return s
          const msgs = [...s.chatMessages]
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant' && !last.done) {
            msgs[msgs.length - 1] = { ...last, done: true }
          }
          return { chatMessages: msgs, chatStreaming: false }
        })
        break

      case 'clerk_error':
        set((s) => {
          if (msg.cwd !== s.chatProjectCwd) return s
          return {
            chatMessages: [...s.chatMessages, { role: 'error' as const, text: msg.error, done: true }],
            chatStreaming: false,
          }
        })
        break

      case 'clerk_active':
        set((s) => {
          if (msg.cwd !== s.chatProjectCwd) return s
          return {
            chatMessages: snapshotToChatMessages(msg.messages),
            chatSystemPrompt: msg.systemPrompt,
          }
        })
        break

      case 'segments':
        set((s) => {
          const segmentsByProject = new Map(s.segmentsByProject)
          segmentsByProject.set(msg.cwd, msg.sessions)
          const segmentsLoading = new Set(s.segmentsLoading)
          segmentsLoading.delete(msg.cwd)
          return { segmentsByProject, segmentsLoading }
        })
        break

      case 'raw_turns':
        set((s) => {
          const rawTurnsBySession = new Map(s.rawTurnsBySession)
          rawTurnsBySession.set(msg.sessionId, { turns: msg.turns, total: msg.total, title: msg.title })
          const rawTurnsLoading = new Set(s.rawTurnsLoading)
          rawTurnsLoading.delete(msg.sessionId)
          return { rawTurnsBySession, rawTurnsLoading }
        })
        break

      case 'lean_turns':
        set((s) => {
          const leanTurnsBySession = new Map(s.leanTurnsBySession)
          leanTurnsBySession.set(msg.sessionId, { turns: msg.turns, title: msg.title, tasks: msg.tasks })
          const leanTurnsLoading = new Set(s.leanTurnsLoading)
          leanTurnsLoading.delete(msg.sessionId)
          return { leanTurnsBySession, leanTurnsLoading }
        })
        break

      case 'session_segments':
        set((s) => {
          const sessionSegments = new Map(s.sessionSegments)
          sessionSegments.set(msg.sessionId, msg.segments)
          const sessionSegmentsLoading = new Set(s.sessionSegmentsLoading)
          sessionSegmentsLoading.delete(msg.sessionId)
          return { sessionSegments, sessionSegmentsLoading }
        })
        break

      case 'project_tasks':
        set((s) => {
          const tasksByProject = new Map(s.tasksByProject)
          tasksByProject.set(msg.cwd, msg.tasksBySession)
          const tasksByProjectLoading = new Set(s.tasksByProjectLoading)
          tasksByProjectLoading.delete(msg.cwd)
          return { tasksByProject, tasksByProjectLoading }
        })
        break

      case 'organizer':
        set((s) => {
          const next = new Map(s.organizerByProject)
          next.set(msg.cwd, {
            pending: msg.pending,
            error: msg.error,
            tasks: msg.tasks,
            generatedAt: msg.generatedAt,
          })
          return { organizerByProject: next }
        })
        break

      case 'search_tasks_results':
        set((s) => {
          const current = s.taskSearchByProject.get(msg.cwd)
          // Drop responses that don't match the latest in-flight request.
          if (!current || current.requestId !== msg.requestId) return s
          const next = new Map(s.taskSearchByProject)
          next.set(msg.cwd, {
            query: msg.query,
            requestId: msg.requestId,
            pending: false,
            results: msg.results,
            error: msg.error,
          })
          return { taskSearchByProject: next }
        })
        break

      case 'error':
        break
    }
  },

  requestSegments: (cwd) => {
    const { segmentsLoading, sendCommand } = get()
    if (segmentsLoading.has(cwd)) return
    set((s) => ({ segmentsLoading: new Set(s.segmentsLoading).add(cwd) }))
    sendCommand({ type: 'get_segments', cwd })
  },

  requestRawTurns: (cwd, sessionId) => {
    const { rawTurnsLoading, connected, sendCommand } = get()
    if (rawTurnsLoading.has(sessionId) || !connected) return
    set((s) => ({ rawTurnsLoading: new Set(s.rawTurnsLoading).add(sessionId) }))
    sendCommand({ type: 'get_raw_turns', cwd, sessionId })
  },

  requestLeanTurns: (cwd, sessionId) => {
    const { leanTurnsLoading, connected, sendCommand } = get()
    if (leanTurnsLoading.has(sessionId) || !connected) return
    set((s) => ({ leanTurnsLoading: new Set(s.leanTurnsLoading).add(sessionId) }))
    sendCommand({ type: 'get_lean_turns', cwd, sessionId })
  },

  requestSessionSegments: (cwd, sessionId) => {
    const { sessionSegmentsLoading, connected, sendCommand } = get()
    if (sessionSegmentsLoading.has(sessionId) || !connected) return
    set((s) => ({ sessionSegmentsLoading: new Set(s.sessionSegmentsLoading).add(sessionId) }))
    sendCommand({ type: 'get_session_segments', cwd, sessionId })
  },

  requestProjectTasks: (cwd) => {
    const { tasksByProjectLoading, connected, sendCommand } = get()
    if (tasksByProjectLoading.has(cwd) || !connected) return
    set((s) => ({ tasksByProjectLoading: new Set(s.tasksByProjectLoading).add(cwd) }))
    sendCommand({ type: 'get_project_tasks', cwd })
  },

  searchProjectTasks: (cwd, query) => {
    const { connected, sendCommand } = get()
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      get().clearProjectTaskSearch(cwd)
      return
    }
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    set((s) => {
      const next = new Map(s.taskSearchByProject)
      const prev = next.get(cwd)
      next.set(cwd, {
        query,
        requestId,
        pending: true,
        results: prev?.results ?? [],
        error: undefined,
      })
      return { taskSearchByProject: next }
    })
    if (connected) {
      sendCommand({ type: 'search_tasks', cwd, query: trimmed, requestId })
    }
  },

  requestOrganizer: (cwd, refresh = false) => {
    const { connected, sendCommand } = get()
    if (!connected) return
    // Optimistic: mark pending immediately so the UI shows the spinner.
    set((s) => {
      const prev = s.organizerByProject.get(cwd)
      const next = new Map(s.organizerByProject)
      next.set(cwd, {
        pending: true,
        tasks: prev?.tasks ?? [],
        error: undefined,
        generatedAt: prev?.generatedAt,
      })
      return { organizerByProject: next }
    })
    sendCommand({ type: 'get_organizer', cwd, refresh })
  },

  clearProjectTaskSearch: (cwd) => {
    set((s) => {
      if (!s.taskSearchByProject.has(cwd)) return s
      const next = new Map(s.taskSearchByProject)
      next.delete(cwd)
      return { taskSearchByProject: next }
    })
  },

  startChat: (cwd) => {
    set({ chatProjectCwd: cwd, chatMessages: [], chatStreaming: false, chatSystemPrompt: null })
    get().sendCommand({ type: 'clerk_load', cwd })
  },

  sendChatMessage: (text) => {
    const { chatProjectCwd, sendCommand } = get()
    if (!chatProjectCwd) return
    set((s) => ({
      chatMessages: [...s.chatMessages, { role: 'user' as const, text, done: true }],
      chatStreaming: true,
    }))
    sendCommand({ type: 'clerk_message', cwd: chatProjectCwd, text })
  },

  interruptChat: () => {
    const { chatProjectCwd, sendCommand } = get()
    if (!chatProjectCwd) return
    set({ chatStreaming: false })
    sendCommand({ type: 'clerk_interrupt', cwd: chatProjectCwd })
  },

  clearChat: () => {
    set({ chatMessages: [], chatStreaming: false })
  },

  processProject: (cwd) => {
    get().sendCommand({ type: 'process_project', cwd })
  },

  processSession: (cwd, sessionId) => {
    get().sendCommand({ type: 'process_session', cwd, sessionId })
  },

  processAll: () => {
    get().sendCommand({ type: 'process_all' })
  },

  deleteProcessing: (cwd, sessionId) => {
    set((s) => {
      if (!s.model) return s
      return {
        model: _updateSessions(s.model, cwd, (sess) =>
          !sessionId || sess.sessionId === sessionId
            ? { ...sess, ppStatus: 'missing' as const, ppTurnsCovered: undefined }
            : sess,
        ),
      }
    })
    get().sendCommand(sessionId ? { type: 'delete_processing', cwd, sessionId } : { type: 'delete_processing', cwd })
  },

  reembedProject: (cwd) => {
    get().sendCommand({ type: 'reembed_project', cwd })
  },
}))
