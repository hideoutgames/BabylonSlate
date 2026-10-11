import {
  ASSET_LOAD_PRIORITY_SCHEDULING,
  type AssetLoadHandleState,
  type AssetLoadPriorityName,
  type RuntimeAssetLoadState,
  type RuntimeAssetPreloadOptions,
  type RuntimeAssetPreloadResult,
} from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";

let nextSessionId = 0;
interface Preload {
  ownerId: string;
  assetGuids: readonly string[];
  /** Monotonic; 1 only once Loaded. */
  progress: number;
  state: Exclude<AssetLoadHandleState, "Released">;
  errorMessage: string;
  /** A script's load handle stays queryable after it fails until released; a consumer's load does not. */
  handle: boolean;
  /** The host holds sources for this request. */
  hosted: boolean;
  waiters: Set<(result: RuntimeAssetPreloadResult) => void>;
}

/**
 * Worker-side ownership of host source requests. The main host is
 * authoritative for source/resource state. A request is either a consumer's
 * on-demand load (`acquire`, `prepare`) or a script's load handle (`request`),
 * which scripts wait on, query and release by its id.
 */
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

  /** A consumer's load: settles when the host reports the closure prepared, or when it is released. */
  acquire(assetGuids: readonly string[], ownerId: string, options: RuntimeAssetPreloadOptions = {}, signal?: AbortSignal): Promise<RuntimeAssetPreloadResult> {
    if (this.stopped) return Promise.resolve({ preloadId: "", success: false, progress: 0, errorMessage: "The asset loading session has ended" });
    if (signal?.aborted) return Promise.resolve({ preloadId: "", success: false, progress: 0, errorMessage: "The asset preload was cancelled" });
    const [preloadId, entry] = this.create(assetGuids, ownerId, options, false);
    const promise = new Promise<RuntimeAssetPreloadResult>(resolve => entry.waiters.add(resolve));
    const abort = () => this.release(preloadId);
    signal?.addEventListener("abort", abort, { once: true });
    this.send(preloadId, entry, options);
    return signal ? promise.finally(() => signal.removeEventListener("abort", abort)) : promise;
  }

  /**
   * A script's load request. Its handle is returned at once and stays queryable
   * until released, even after the load fails. No assets means nothing to load.
   */
  request(assetGuids: readonly string[], ownerId: string, options: RuntimeAssetPreloadOptions = {}): string {
    if (this.stopped) return "";
    const [preloadId, entry] = this.create(assetGuids, ownerId, options, true);
    if (entry.assetGuids.length) this.send(preloadId, entry, options);
    else this.settle(preloadId, entry, true, "");
    return preloadId;
  }

  /** A script handle that has already failed, for a request the host cannot attempt. */
  requestFailed(ownerId: string, errorMessage: string, options: RuntimeAssetPreloadOptions = {}): string {
    if (this.stopped) return "";
    const [preloadId, entry] = this.create([], ownerId, options, true);
    this.settle(preloadId, entry, false, errorMessage);
    return preloadId;
  }

  /** Settles when the handle is Loaded or Failed; a released or unknown handle fails at once. */
  wait(preloadId: string): Promise<RuntimeAssetPreloadResult> {
    const entry = this.preloads.get(preloadId);
    if (!entry?.handle) {
      return Promise.resolve({ preloadId, success: false, progress: 0,
        errorMessage: `Load handle ${preloadId ? `${preloadId} ` : ""}was released or does not exist` });
    }
    if (entry.state === "Loading") return new Promise(resolve => entry.waiters.add(resolve));
    return Promise.resolve({ preloadId, success: entry.state === "Loaded", progress: entry.progress, errorMessage: entry.errorMessage });
  }

  handleState(preloadId: string): AssetLoadHandleState {
    const entry = this.preloads.get(preloadId);
    return entry?.handle ? entry.state : "Released";
  }

  handleProgress(preloadId: string): number {
    const entry = this.preloads.get(preloadId);
    return entry?.handle ? entry.progress : 0;
  }

  receive(result: { preloadId: string; success: boolean; error?: string; progress?: number }): void {
    const entry = this.preloads.get(result.preloadId);
    if (!entry || this.stopped || entry.state !== "Loading") return;
    if (result.success) {
      const progress = result.progress === undefined ? 1 : Math.max(0, Math.min(1, result.progress));
      if (Number.isFinite(progress)) entry.progress = Math.max(entry.progress, progress);
      if (entry.progress >= 1) this.settle(result.preloadId, entry, true, "");
      return;
    }
    this.settle(result.preloadId, entry, false, result.error ?? "");
    // The host drops a failed request's sources; a script's handle keeps its error.
    if (entry.handle) this.dropHost(result.preloadId, entry);
    else this.release(result.preloadId);
  }

  release(preloadId: string): void {
    const entry = this.preloads.get(preloadId);
    if (!entry) return;
    this.preloads.delete(preloadId);
    if (entry.state === "Loading") this.settle(preloadId, entry, false, `Asset preload cancelled for ${entry.ownerId}`);
    this.dropHost(preloadId, entry);
  }

  /** A script releases only its load handles; a consumer's load has no id a script holds. */
  releaseHandle(preloadId: string): void {
    if (this.preloads.get(preloadId)?.handle) this.release(preloadId);
  }

  releaseOwner(ownerId: string): void {
    this.automatic.delete(ownerId);
    for (const [id, entry] of this.preloads) if (entry.ownerId === ownerId) this.release(id);
  }

  /** Releases the owner's load handles that include the asset; consumers' own loads are untouched. */
  unload(assetGuid: string, ownerId: string): void {
    const guid = assetGuid.trim();
    for (const [id, entry] of [...this.preloads]) {
      if (entry.handle && entry.ownerId === ownerId && entry.assetGuids.includes(guid)) this.release(id);
    }
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

  private create(assetGuids: readonly string[], ownerId: string, options: RuntimeAssetPreloadOptions, handle: boolean): [string, Preload] {
    const guids = [...new Set(assetGuids.filter(guid => typeof guid === "string" && guid.trim()).map(guid => guid.trim()))];
    const preloadId = `asset-preload:${this.sessionId}:${++this.nextId}`;
    const entry: Preload = { ownerId: options.sessionWide ? "session" : ownerId, assetGuids: guids, progress: 0, state: "Loading",
      errorMessage: "", handle, hosted: false, waiters: new Set() };
    this.preloads.set(preloadId, entry);
    return [preloadId, entry];
  }

  private send(preloadId: string, entry: Preload, options: RuntimeAssetPreloadOptions): void {
    entry.hosted = true;
    try {
      this.emit({ type: "assetPreload", preloadId, ownerId: entry.ownerId, assetGuids: [...entry.assetGuids],
        // A script may pass any string; anything but a known priority schedules as Normal.
        priority: ASSET_LOAD_PRIORITY_SCHEDULING[options.priority as AssetLoadPriorityName] ?? ASSET_LOAD_PRIORITY_SCHEDULING.Normal });
    } catch (error) {
      if (!entry.handle) this.preloads.delete(preloadId);
      this.settle(preloadId, entry, false, String(error));
      try { this.dropHost(preloadId, entry); } catch { /* The failed transport cannot retain local ownership. */ }
    }
  }

  private settle(preloadId: string, entry: Preload, success: boolean, errorMessage: string): void {
    entry.state = success ? "Loaded" : "Failed";
    entry.errorMessage = errorMessage;
    if (success) entry.progress = 1;
    const result = { preloadId, success, progress: entry.progress, errorMessage };
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const resolve of waiters) resolve(result);
  }

  private dropHost(preloadId: string, entry: Preload): void {
    if (!entry.hosted) return;
    entry.hosted = false;
    this.emit({ type: "assetPreloadRelease", preloadId });
  }
}
