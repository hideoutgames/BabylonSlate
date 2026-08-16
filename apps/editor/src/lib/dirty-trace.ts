export type DirtyTraceEntry = { kind: string; id: string };

const entries: DirtyTraceEntry[] = [];

/** Last document mutations that set dirty. Test-mode Save All diagnosis. */
export function recordDocumentDirty(kind: string, id: string): void {
  entries.push({ kind, id });
  if (entries.length > 32) entries.shift();
}

export function documentDirtyTrace(): DirtyTraceEntry[] {
  return [...entries];
}

export function clearDocumentDirtyTrace(): void {
  entries.length = 0;
}
