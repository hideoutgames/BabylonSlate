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
