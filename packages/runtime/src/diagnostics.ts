export interface RuntimeDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning";
  assetGuid?: string;
  graphId?: string;
  nodeId?: string;
  bodyLine?: number;
  btNodeId?: string;
  stack?: string;
  frameId: number;
  tickIndex?: number;
  count?: number;
}

export interface SessionReportEntry extends RuntimeDiagnostic {
  count: number;
  firstFrameId: number;
  lastFrameId: number;
}

const DEFAULT_CAP = 64;

export class SessionDiagnosticAggregator {
  private readonly cap: number;
  private readonly map = new Map<string, SessionReportEntry>();
  private dropped = 0;

  constructor(cap = DEFAULT_CAP) {
    this.cap = cap;
  }

  push(diag: RuntimeDiagnostic): void {
    const key = `${diag.code}|${diag.assetGuid ?? ""}|${diag.nodeId ?? ""}`;
    const existing = this.map.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastFrameId = diag.frameId;
      existing.message = diag.message;
      return;
    }
    if (this.map.size >= this.cap) {
      this.dropped += 1;
      return;
    }
    this.map.set(key, {
      ...diag,
      count: 1,
      firstFrameId: diag.frameId,
      lastFrameId: diag.frameId,
    });
  }

  entries(): SessionReportEntry[] {
    return [...this.map.values()];
  }

  droppedCount(): number {
    return this.dropped;
  }

  clear(): void {
    this.map.clear();
    this.dropped = 0;
  }

  isEmpty(): boolean {
    return this.map.size === 0;
  }
}
