/**
 * Fixed-capacity circular buffer of strings.
 * Used for contextLines in CC sessions.
 */
export class RollingBuffer {
  private lines: string[] = []

  constructor(private capacity: number = 2000) {}

  /** Push a single pre-formatted entry. */
  push(entry: string): void {
    this.lines.push(entry)
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity)
    }
  }

  /** Get a copy of all lines. */
  getLines(): string[] {
    return [...this.lines]
  }

  /** Get the last N lines. */
  tail(n: number): string[] {
    return this.lines.slice(-n)
  }

  /** Current number of lines. */
  get length(): number {
    return this.lines.length
  }

  /** Clear all lines. */
  clear(): void {
    this.lines = []
  }
}
