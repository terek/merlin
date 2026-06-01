import { applyPatch, compare, type Operation } from 'fast-json-patch'

/**
 * Generate JSON Patch ops (RFC 6902) between two objects.
 * Returns empty array if objects are identical.
 */
export function generatePatch<T extends object>(shadow: T, current: T): Operation[] {
  return compare(shadow, current)
}

/**
 * Apply JSON Patch ops to a target object. Returns a new object (does not mutate).
 */
export function applyOps<T extends object>(target: T, ops: Operation[]): T {
  if (ops.length === 0) return target
  const clone = structuredClone(target)
  const result = applyPatch(clone, ops, true, false)
  return result.newDocument as T
}

/**
 * Deep clone an object for shadow copy storage.
 */
export function snapshot<T>(obj: T): T {
  return structuredClone(obj)
}
