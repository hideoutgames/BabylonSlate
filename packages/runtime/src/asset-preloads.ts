import type { RuntimeAssetLoadState, RuntimeAssetPreloadOptions, RuntimeAssetPreloadResult } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";

let nextSessionId = 0;
interface Preload {
  ownerId: string;
  progress: number;
  resolve: ((result: RuntimeAssetPreloadResult) => void) | null;
  onProgress?: (progress: number) => void;
}

/** Worker-side ownership. The main host is authoritative for source/resource state. */
export class RuntimeAssetPreloads {
  private readonly sessionId = ++nextSessionId;
  private nextId = 0;
  private stopped = false;
  private readonly preloads = new Map<string, Preload>();
  private readonly states = new Map<string, RuntimeAssetLoadState>();
  private readonly automatic = new Map<string, Map<string, Promise<void>>>();

  private readonly emit: (message: CommandMessage) => void;
  constructor(emit: (message: CommandMessage) => void) { this.emit = emit; }

  /** Repeated ordinary operations share transactional preparation for this consumer. */
  prepare(assetGuids: readonly string[], ownerId: string): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("The asset loading session has ended"));
    const guids = [...new Set(assetGuids.map(guid => guid.trim()).filter(Boolean))].sort();
    if (!guids.length) return Promise.resolve();
    const key = JSON.stringify(guids);
    let owned = this.automatic.get(ownerId);
    if (!owned) { owned = new Map(); this.automatic.set(ownerId, owned); }
    const ownerAssets = owned;
    const existing = ownerAssets.get(key);
    if (existing) return existing;
    // Submit the entire set together: the host releases every new dependency if
    // any one fails. Splitting into per-GUID preloads would retain partial success.
    const operation = this.acquire(guids, ownerId).then(result => {
      if (!result.success) throw new Error(`Asset ${guids.join(", ")}, requested by ${ownerId}: ${result.errorMessage}`);
    }).catch(error => {
      if (ownerAssets.get(key) === operation) ownerAssets.delete(key);
      if (!ownerAssets.size && this.automatic.get(ownerId) === ownerAssets) this.automatic.delete(ownerId);
      throw error;
    });
    ownerAssets.set(key, operation);
    return operation;
  }

  acquire(assetGuids: readonly string[], ownerId: string, options: RuntimeAssetPreloadOptions = {}): Promise<RuntimeAssetPreloadResult> {
    if (this.stopped) return Promise.resolve({ preloadId: "", success: false, progress: 0, errorMessage: "The asset loading session has ended" });
    const guids = [...new Set(assetGuids.filter(guid => typeof guid === "string" && guid.trim()).map(guid => guid.trim()))];
    const preloadId = `asset-preload:${this.sessionId}:${++this.nextId}`;
    const promise = new Promise<RuntimeAssetPreloadResult>(resolve => {
      this.preloads.set(preloadId, { ownerId: options.sessionWide ? "session" : ownerId, progress: 0, resolve, onProgress: options.onProgress });
    });
    try {
      options.onProgress?.(0);
      this.emit({ type: "assetPreload", preloadId, ownerId: options.sessionWide ? "session" : ownerId, assetGuids: guids });
    } catch (error) {
      const entry = this.preloads.get(preloadId);
      this.preloads.delete(preloadId);
      entry?.resolve?.({ preloadId, success: false, progress: 0, errorMessage: String(error) });
      try { this.emit({ type: "assetPreloadRelease", preloadId }); } catch { /* The failed transport cannot retain local ownership. */ }
    }
    return promise;
  }

  receive(result: { preloadId: string; success: boolean; error?: string; progress?: number }): void {
    const entry = this.preloads.get(result.preloadId);
    if (!entry || this.stopped || !entry.resolve) return;
    const progress = result.progress === undefined ? 1 : Math.max(0, Math.min(1, result.progress));
    entry.progress = Number.isFinite(progress) ? Math.max(entry.progress, progress) : entry.progress;
    try { entry.onProgress?.(entry.progress); }
    catch (error) { result = { ...result, success: false, error: `Asset preload progress callback failed: ${String(error)}` }; }
    if (result.success && entry.progress < 1) return;
    const resolve = entry.resolve;
    entry.resolve = null;
    entry.onProgress = undefined;
    resolve({ preloadId: result.preloadId, success: result.success, progress: entry.progress, errorMessage: result.error ?? "" });
    if (!result.success) this.release(result.preloadId);
  }

  release(preloadId: string): void {
    const entry = this.preloads.get(preloadId);
    if (!entry) return;
    this.preloads.delete(preloadId);
    entry.resolve?.({ preloadId, success: false, progress: entry.progress, errorMessage: `Asset preload cancelled for ${entry.ownerId}` });
    entry.onProgress = undefined;
    this.emit({ type: "assetPreloadRelease", preloadId });
  }

  releaseOwner(ownerId: string): void {
    this.automatic.delete(ownerId);
    for (const [id, entry] of this.preloads) if (entry.ownerId === ownerId) this.release(id);
  }

  /** A prepared spawn hands its temporary ownership to the new actor. */
  transferOwner(preloadId: string, ownerId: string): void {
    const entry = this.preloads.get(preloadId);
    if (entry) entry.ownerId = ownerId;
  }

  setStates(states: readonly { guid: string; state: RuntimeAssetLoadState }[]): void {
    if (this.stopped) return;
    for (const entry of states) this.states.set(entry.guid, entry.state);
  }

  getState(guid: string): RuntimeAssetLoadState { return this.states.get(guid) ?? "unloaded"; }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const id of [...this.preloads.keys()]) this.release(id);
    this.states.clear();
    this.automatic.clear();
  }
}
