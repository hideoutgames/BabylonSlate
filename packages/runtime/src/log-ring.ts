export type LogSeverity = "verbose" | "log" | "warning" | "error";

export interface LogEntry {
  severity: LogSeverity;
  category: string;
  message: string;
  frameId: number;
  tickIndex?: number;
}

export class LogRingBuffer {
  private readonly capacity: number;
  private readonly items: LogEntry[] = [];

  constructor(capacity = 512) {
    this.capacity = capacity;
  }

  push(entry: LogEntry): void {
    if (this.items.length >= this.capacity) {
      this.items.shift();
    }
    this.items.push(entry);
  }

  entries(): readonly LogEntry[] {
    return this.items;
  }

  clear(): void {
    this.items.length = 0;
  }
}
