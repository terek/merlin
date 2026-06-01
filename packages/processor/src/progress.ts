/**
 * Progress event types emitted during processing.
 *
 * The processor emits ProgressEvent (fully qualified with cwd+sessionId).
 * Inner emitters (summarizer, concept-extractor, lean-session) emit InnerProgressEvent;
 * the processor wraps them with session context before forwarding.
 */

export type ProgressEvent =
  | { kind: 'log'; msg: string }
  | { kind: 'session-start'; cwd: string; sessionId: string }
  | { kind: 'session-done'; cwd: string; sessionId: string }
  | { kind: 'turns'; cwd: string; sessionId: string; done: number; discovered: number }
  | { kind: 'tasks'; cwd: string; sessionId: string; done: number; discovered: number }
  | { kind: 'embeddings'; cwd: string; sessionId: string; done: number; discovered: number }

export type InnerProgressEvent =
  | { kind: 'log'; msg: string }
  | { kind: 'turns'; done: number; discovered: number }
  | { kind: 'tasks'; done: number; discovered: number }
  | { kind: 'embeddings'; done: number; discovered: number }
