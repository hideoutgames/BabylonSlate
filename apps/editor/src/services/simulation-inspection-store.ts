import type {
  RuntimeIdentityCursor, RuntimeIdentityRow, RuntimeInspectorPayload, RuntimeInspectorResult,
  RuntimeObjectIdentity,
} from "@babylonslate/bridge";
import type { RuntimeInspectionAction, RuntimeInspectionWriteOptions } from "./runtime-inspector-client";

type Selection = Extract<RuntimeInspectorPayload, { kind: "selection" }>;
export type RuntimeInspectionTransport = (action: RuntimeInspectionAction, options?: RuntimeInspectionWriteOptions) => Promise<RuntimeInspectorResult>;
export type SimulationInspectionState = {
  connected: boolean;
  rows: readonly RuntimeIdentityRow[];
  selected: RuntimeObjectIdentity | null;
  selection: Selection | null;
  identityError: string | null;
  selectionError: string | null;
  tickIndex: number;
  identitiesLimited: boolean;
  moreIdentities: boolean;
};
const emptyState = (): SimulationInspectionState => ({
  connected: false, rows: [], selected: null, selection: null,
  identityError: null, selectionError: null, tickIndex: 0, identitiesLimited: false, moreIdentities: false,
});
const MAX_IDENTITIES = 4096;
export const runtimeIdentityKey = (identity: RuntimeObjectIdentity): string => JSON.stringify([
  identity.sceneInstanceId, identity.actorGuid, identity.actorToken, identity.componentGuid ?? null, identity.componentToken ?? null,
]);

/** Selected, bounded data only. No requests or timers survive the last visible consumer. */
export class SimulationInspectionStore {
  private state = emptyState();
  private readonly listeners = new Set<() => void>();
  private readonly consumers = { identities: 0, selection: 0 };
  private transport: RuntimeInspectionTransport | null = null;
  private generation = 0;
  private selectionGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading = false;
  private structuralRevision: number | undefined;
  private commandRevision = -1;
  private cursor: RuntimeIdentityCursor | undefined;
  private loadNext = false;
  private selectionOffset = 0;
  private identityBytes = 0;

  getSnapshot = (): SimulationInspectionState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<SimulationInspectionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  attach(transport: RuntimeInspectionTransport): () => void {
    const generation = ++this.generation;
    this.transport = transport;
    this.structuralRevision = undefined;
    this.commandRevision = -1;
    this.cursor = undefined;
    this.reading = false;
    this.state = emptyState();
    this.publish({ connected: true });
    this.schedule(0);
    return () => {
      if (this.generation !== generation) return;
      ++this.generation;
      this.transport = null;
      this.clearTimer();
      this.publish({ ...emptyState() });
    };
  }

  consume(kind: "identities" | "selection"): () => void {
    this.consumers[kind]++;
    this.schedule(0);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.consumers[kind]--;
      if (!this.hasConsumers()) this.clearTimer();
    };
  }

  select = (selected: RuntimeObjectIdentity | null): void => {
    if (selected && this.state.selected && runtimeIdentityKey(selected) === runtimeIdentityKey(this.state.selected)) return;
    ++this.selectionGeneration;
    this.selectionOffset = 0;

    this.publish({ selected, selection: null, selectionError: null });
    this.schedule(0);
  };
  loadMoreIdentities = (): void => { if (this.cursor && !this.state.identitiesLimited) { this.loadNext = true; this.schedule(0); } };
  loadMoreProperties = (): void => {
    if (this.state.selection?.nextOffset !== undefined) {
      this.selectionOffset = this.state.selection.nextOffset;

      this.schedule(0);
    }
  };

  firstProperties = (): void => { this.selectionOffset = 0; this.schedule(0); };

  async request(action: RuntimeInspectionAction, options?: RuntimeInspectionWriteOptions): Promise<RuntimeInspectorResult> {
    const transport = this.transport;
    if (!transport) throw new Error("The Simulation session is no longer available.");
    const generation = this.generation;
    const result = await transport(action, options);
    if (generation !== this.generation) throw new Error("The Simulation session changed before this request completed.");
    if (!result.success) throw new Error(result.reason ?? "The runtime rejected this request.");
    const payload = result.payload;
    if (payload?.kind === "mutation") {
      this.commandRevision = Math.max(this.commandRevision, result.commandRevision);
      const current = this.state.selection;
      if (current && runtimeIdentityKey(current.target) === runtimeIdentityKey(payload.target)) {
        // Polls issued before this acknowledgement cannot overwrite its value.
        let selection = current;
        if (action.kind === "setTransform") {
          selection = { ...current, transform: payload.effectiveValue as unknown as Selection["transform"] };
        } else if (action.kind === "setProperty" || action.kind === "setMaterialParameter") {
          const key = action.kind === "setProperty" ? action.property : `material:${action.parameter}`;
          selection = { ...current, properties: current.properties.map(property => property.key === key
            ? { ...property, value: payload.effectiveValue } : property) };
        }
        this.publish({ selection, tickIndex: result.tickIndex });
      }
    }
    return result;
  }

  private hasConsumers(): boolean { return this.consumers.identities + this.consumers.selection > 0; }
  private clearTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  private schedule(delay: number): void {
    if (!this.transport || !this.hasConsumers() || this.reading || this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, delay);
  }
  private async poll(): Promise<void> {
    const transport = this.transport;
    if (!transport || !this.hasConsumers() || this.reading) return;
    this.reading = true;
    const generation = this.generation;
    const selectionGeneration = this.selectionGeneration;
    const patch: Partial<SimulationInspectionState> = {};
    try {
      const extending = this.loadNext && !!this.cursor;
      this.loadNext = false;
      const result = await transport(extending ? { kind: "identities", cursor: this.cursor } : { kind: "identities", knownRevision: this.structuralRevision });
      if (generation !== this.generation || !this.hasConsumers()) return;
      if (!result.success) patch.identityError = result.reason ?? "Runtime identities are unavailable.";
      else if (result.payload?.kind === "identities") {
        const payload = result.payload;
        patch.identityError = null;
        if (!payload.unchanged) {
          const rows = extending ? [...this.state.rows] : [];
          let bytes = extending ? this.identityBytes : 0;
          let limited = false;
          for (const row of payload.rows) {
            const cost = JSON.stringify(row).length * 2;
            if (rows.length >= MAX_IDENTITIES || bytes + cost > 512 * 1024) { limited = true; break; }
            rows.push(row); bytes += cost;
          }
          this.identityBytes = bytes;
          patch.rows = rows;
          patch.identitiesLimited = limited || (rows.length >= MAX_IDENTITIES && !!payload.nextCursor);
          this.cursor = payload.nextCursor;
          patch.moreIdentities = !!this.cursor;
          this.structuralRevision = result.structuralRevision;
        }
      }
      const target = this.state.selected;
      if (target && this.consumers.selection > 0) {
        const offset = this.selectionOffset;
        const detail = await transport({ kind: "selection", target, ...(offset ? { offset } : {}) });
        if (generation !== this.generation || selectionGeneration !== this.selectionGeneration || !this.consumers.selection) return;
        patch.tickIndex = detail.tickIndex;
        if (!detail.success) { patch.selection = null; patch.selectionError = detail.reason ?? "The selected runtime object is unavailable."; }
        else if (detail.payload?.kind === "selection" && detail.commandRevision >= this.commandRevision) {
          patch.selectionError = null;
          patch.selection = detail.payload;
        }
      }
      if (Object.keys(patch).length) this.publish(patch);
    } catch (error) {
      if (generation === this.generation && this.hasConsumers()) this.publish({ identityError: String(error),
        ...(this.consumers.selection && this.state.selected ? { selectionError: String(error) } : {}) });
    } finally {
      if (generation === this.generation) { this.reading = false; this.schedule(200); }
    }
  }
}
