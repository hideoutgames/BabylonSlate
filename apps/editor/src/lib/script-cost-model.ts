import type { PerformanceProfile, PerformanceScriptEntry } from "@haptic/debugger";
import { formatEventTitle, humanizePropertyLabel } from "@haptic/editor-kit";

/** Calls and time over a recording, for one entry point or for a Class's entry points together. */
export type ScriptCost = {
  calls: number;
  totalMs: number;
  /** Total time over the recording's ticks: its average share of a tick. */
  perTickMs: number | null;
  /** The most time in a single tick. */
  worstTickMs: number;
};
export type ScriptCostEntryRow = ScriptCost & { key: string; label: string; entry: PerformanceScriptEntry };
export type ScriptCostClassRow = ScriptCost & { key: string; label: string; entries: ScriptCostEntryRow[] };

/** The entry as the graph names it, for an entry recorded without its canvas title. */
export function scriptEntryLabel(entry: PerformanceScriptEntry): string {
  if (entry.title) return entry.title;
  // Lifecycle events run as `on<Name>`: `onBeginPlay` is Event Begin Play.
  if (!entry.event) return humanizePropertyLabel(entry.exportName);
  return formatEventTitle(entry.event.replace(/^on([A-Z])/, (_match, first: string) => first.toLowerCase()));
}

/**
 * A recording's script costs by Class, slowest first, each with its events and functions, slowest first.
 * Every row counts its own time, not the functions and events it called, so a Class's entries add up to it.
 */
export function scriptCosts(profile: PerformanceProfile): ScriptCostClassRow[] {
  const ticks = profile.ticks.count;
  const width = profile.scripts.columns.length;
  type Sums = { calls: number; totalMs: number; worstTickMs: number };
  const entries = profile.scriptEntries.map((): Sums => ({ calls: 0, totalMs: 0, worstTickMs: 0 }));
  // A Class's time in each tick, to find its worst tick.
  const classTicks = new Map<string, Map<number, number>>();
  const classKey = (entry: PerformanceScriptEntry) => `${entry.assetGuid}\u0000${entry.classId}`;
  for (const chunk of profile.scripts.chunks) {
    for (let at = 0; at + width <= chunk.length; at += width) {
      const [tickId, index, calls, ms] = [chunk[at]!, chunk[at + 1]!, chunk[at + 2]!, chunk[at + 3]!];
      const sums = entries[index];
      const entry = profile.scriptEntries[index];
      if (!sums || !entry) continue;
      sums.calls += calls;
      sums.totalMs += ms;
      sums.worstTickMs = Math.max(sums.worstTickMs, ms);
      const byTick = classTicks.get(classKey(entry)) ?? new Map<number, number>();
      byTick.set(tickId, (byTick.get(tickId) ?? 0) + ms);
      classTicks.set(classKey(entry), byTick);
    }
  }
  const perTick = (ms: number) => ticks > 0 ? ms / ticks : null;
  const classes = new Map<string, ScriptCostClassRow>();
  profile.scriptEntries.forEach((entry, index) => {
    const sums = entries[index]!;
    if (sums.calls === 0) return;
    const key = classKey(entry);
    let row = classes.get(key);
    if (!row) {
      row = { key, label: entry.className || humanizePropertyLabel(entry.classId), calls: 0, totalMs: 0, perTickMs: null,
        worstTickMs: Math.max(0, ...(classTicks.get(key)?.values() ?? [])), entries: [] };
      classes.set(key, row);
    }
    row.calls += sums.calls;
    row.totalMs += sums.totalMs;
    row.entries.push({ ...sums, key: `${key}\u0000${entry.exportName}`, label: scriptEntryLabel(entry), entry, perTickMs: perTick(sums.totalMs) });
  });
  const slowest = (a: ScriptCost, b: ScriptCost) => b.totalMs - a.totalMs;
  return [...classes.values()]
    .map((row) => ({ ...row, perTickMs: perTick(row.totalMs), entries: row.entries.sort(slowest) }))
    .sort(slowest);
}
