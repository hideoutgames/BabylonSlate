import type { PerformanceScriptEntry, ScriptBundleEntry } from "@haptic/bridge";

/** The most entry points one recording names; calls into further entries are timed but not reported. */
export const SCRIPT_COST_ENTRY_LIMIT = 1024;

type Meter = { index: number; calls: number; ms: number; ran: boolean };

/**
 * While a profile records, times each compiled entry point the script host calls (an event, a
 * function, an interface handler or a transition rule) by Class and entry. A call's time is its own:
 * the entries it calls are timed as themselves and left out of it, so one recording's rows add up to
 * the time scripts ran. A latent entry is timed until its first wait.
 */
export class ScriptCostMeter {
  private readonly meters = new Map<ScriptBundleEntry, Map<string, Meter | null>>();
  /** Every entry by asset, Class and export, so scripts reloaded while recording keep their rows. */
  private readonly byName = new Map<string, Meter | null>();
  private readonly entries: PerformanceScriptEntry[] = [];
  private sentEntries = 0;
  /** The entries that ran this tick, in first-run order. */
  private ran: Meter[] = [];
  // The calls in progress, innermost last: each one's entry, start, and the time of the calls inside it.
  private readonly stackMeters: Array<Meter | null> = [];
  private readonly stackStarted: number[] = [];
  private readonly stackNested: number[] = [];
  private depth = 0;
  private readonly now: () => number;

  constructor(now: () => number) { this.now = now; }

  /** The number of entries that ran this tick: the rows `drainTick` writes. */
  get ranCount(): number { return this.ran.length; }

  enter(script: ScriptBundleEntry, exportName: string): void {
    const depth = this.depth++;
    this.stackMeters[depth] = this.meterFor(script, exportName);
    this.stackNested[depth] = 0;
    this.stackStarted[depth] = this.now();
  }

  exit(): void {
    if (this.depth === 0) return;
    const depth = --this.depth;
    const elapsed = this.now() - this.stackStarted[depth]!;
    if (depth > 0) this.stackNested[depth - 1]! += elapsed;
    const meter = this.stackMeters[depth];
    this.stackMeters[depth] = null;
    if (!meter) return;
    meter.calls++;
    meter.ms += Math.max(0, elapsed - this.stackNested[depth]!);
    if (!meter.ran) { meter.ran = true; this.ran.push(meter); }
  }

  /** Writes this tick's row for each entry that ran, as entry index, calls and milliseconds, then starts the next tick. */
  drainTick(write: (entry: number, calls: number, ms: number) => void): void {
    for (const meter of this.ran) {
      write(meter.index, meter.calls, meter.ms);
      meter.calls = 0; meter.ms = 0; meter.ran = false;
    }
    this.ran = [];
  }

  /** The entries first used since the last call, in index order. */
  takeNewEntries(): PerformanceScriptEntry[] {
    const fresh = this.entries.slice(this.sentEntries);
    this.sentEntries = this.entries.length;
    return fresh;
  }

  private meterFor(script: ScriptBundleEntry, exportName: string): Meter | null {
    let byExport = this.meters.get(script);
    if (!byExport) { byExport = new Map(); this.meters.set(script, byExport); }
    let meter = byExport.get(exportName);
    if (meter !== undefined) return meter;
    const name = `${script.assetGuid}\u0000${script.classId}\u0000${exportName}`;
    meter = this.byName.get(name);
    if (meter !== undefined) { byExport.set(exportName, meter); return meter; }
    meter = this.entries.length < SCRIPT_COST_ENTRY_LIMIT ? { index: this.entries.length, calls: 0, ms: 0, ran: false } : null;
    this.byName.set(name, meter);
    if (meter) {
      const point = script.entryPoints.find((candidate) => candidate.name === exportName);
      this.entries.push({
        assetGuid: script.assetGuid, classId: script.classId, exportName,
        ...(script.className !== undefined ? { className: script.className } : {}),
        ...(point?.event !== undefined ? { event: point.event } : {}),
        ...(point?.title !== undefined ? { title: point.title } : {}),
        ...(point?.graphId !== undefined ? { graphId: point.graphId } : {}),
        ...(point?.nodeId !== undefined ? { nodeId: point.nodeId } : {}),
      });
    }
    byExport.set(exportName, meter);
    return meter;
  }
}
