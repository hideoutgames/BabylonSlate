export type DirtyTraceEntry = { kind: string; id: string; via: string };

export type SaveAllTrace = {
  ok: boolean;
  reason: string;
  dirtyBefore: number;
  dirtyAfter: number;
  error?: string;
};

const entries: DirtyTraceEntry[] = [];
let lastSaveAll: SaveAllTrace | null = null;
type SaveAllPhase = "started" | "audio-reverb" | "navigation" | "documents" | "compile" | "project" | "mtime" | "journal" | "callbacks";
export type SaveAllProgress = {
  invocation: number;
  phase: SaveAllPhase;
  pending: boolean;
  elapsedMs: number;
  phaseElapsedMs: number;
};
let saveInvocation = 0;
let progress: { invocation: number; phase: SaveAllPhase; pending: boolean; startedAt: number; phaseStartedAt: number; endedAt: number | null } | null = null;

/** Bounded diagnostics for the latest invocation, separate from its outcome. */
export function beginSaveAllProgress() {
  const invocation = ++saveInvocation;
  const now = performance.now();
  progress = { invocation, phase: "started", pending: true, startedAt: now, phaseStartedAt: now, endedAt: null };
  return {
    phase(phase: SaveAllPhase) {
      if (progress?.invocation !== invocation || !progress.pending) return;
      progress.phase = phase;
      progress.phaseStartedAt = performance.now();
    },
    finish() {
      if (progress?.invocation !== invocation || !progress.pending) return;
      progress.pending = false;
      progress.endedAt = performance.now();
    },
  };
}

export function saveAllProgress(): SaveAllProgress | null {
  if (!progress) return null;
  const end = progress.endedAt ?? performance.now();
  return {
    invocation: progress.invocation,
    phase: progress.phase,
    pending: progress.pending,
    elapsedMs: end - progress.startedAt,
    phaseElapsedMs: end - progress.phaseStartedAt,
  };
}

function dirtyCallerLabel(): string {
  const line = new Error().stack?.split("\n")[3] ?? "";
  return line.trim().replace(/^at\s+/, "").slice(0, 160);
}

/** Last document mutations that set dirty. Test-mode Save All diagnosis. */
export function recordDocumentDirty(kind: string, id: string): void {
  entries.push({ kind, id, via: dirtyCallerLabel() });
  if (entries.length > 32) entries.shift();
}

export function documentDirtyTrace(): DirtyTraceEntry[] {
  return [...entries];
}

export function clearDocumentDirtyTrace(): void {
  entries.length = 0;
}

export function recordSaveAllTrace(entry: SaveAllTrace): void {
  lastSaveAll = entry;
}

export function saveAllTrace(): SaveAllTrace | null {
  return lastSaveAll;
}
