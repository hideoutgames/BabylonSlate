/** Project-scoped source/CPU loading. Engine resources remain in ResourceCache. */
export type AssetLoadState = "unloaded" | "loading" | "ready" | "failed";
export type AssetLoadPriority = "gameplay" | "preload" | "background";

export interface AssetCatalogRecord {
  id: string;
  rootId: string;
  revision: string;
  requiredDependencies: readonly string[];
}

export interface AssetMemoryEstimate {
  sourceBytes: number;
  decodedBytes: number;
  temporaryBytes: number;
}

export interface LoadedAsset<T> {
  value: T;
  sourceBytes?: number;
  decodedBytes?: number;
  /** Release decoded maps, object URLs, and other external strong references. */
  dispose?: () => void;
}

export interface AssetRepresentation<T = unknown> {
  /** Include format/settings and, for scene-owned values, the scene identity. */
  key: string;
  estimate: AssetMemoryEstimate;
  /** Load/decode this asset only; the service prepares its required closure. */
  load: (asset: AssetCatalogRecord, signal: AbortSignal) => Promise<LoadedAsset<T>>;
}

export interface AssetLoadingBudgets {
  sourceBytes: number;
  decodedBytes: number;
  temporaryBytes: number;
  concurrency: number;
  retentionMs: number;
}

export interface AssetLoadingServiceOptions {
  projectId: string;
  resolve: (id: string) => AssetCatalogRecord | Promise<AssetCatalogRecord>;
  representation: (asset: AssetCatalogRecord) => AssetRepresentation;
  budgets?: Partial<AssetLoadingBudgets>;
  now?: () => number;
}

export interface AssetAcquireOptions {
  priority?: AssetLoadPriority;
  signal?: AbortSignal;
  /** Document editors and individual representation reads do not prepare runtime consumers. */
  dependencies?: "required" | "none";
}

export interface AssetPreloadOptions extends AssetAcquireOptions {
  onProgress?: (progress: { completed: number; total: number }) => void;
}

export type AssetLoadErrorCode = "missing" | "load" | "budget" | "stale" | "cancelled";

export class AssetLoadError extends Error {
  readonly code: AssetLoadErrorCode;
  readonly assetId: string;
  readonly consumer: string;
  constructor(
    code: AssetLoadErrorCode,
    assetId: string,
    consumer: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Asset ${assetId} requested by ${consumer}: ${message}`, options);
    this.code = code;
    this.assetId = assetId;
    this.consumer = consumer;
    this.name = "AssetLoadError";
  }
}

export interface AssetLoadingSnapshot {
  sourceBytes: number;
  decodedBytes: number;
  reservedSourceBytes: number;
  reservedDecodedBytes: number;
  temporaryBytes: number;
  active: number;
  queued: number;
  cacheHits: number;
  loads: number;
  entries: Array<{
    assetId: string;
    rootId: string;
    revision: string;
    representation: string;
    state: AssetLoadState;
    owners: string[];
    sourceBytes: number;
    decodedBytes: number;
    error?: string;
  }>;
}

interface Acquisition {
  owner: string;
  entries: Set<CacheEntry>;
  controller: AbortController;
}

interface CacheEntry {
  key: string;
  asset: AssetCatalogRecord;
  representation: Pick<AssetRepresentation, "key" | "estimate">;
  load?: AssetRepresentation["load"];
  owners: Set<Acquisition>;
  controller: AbortController;
  state: AssetLoadState;
  priority: number;
  order: number;
  lastUsed: number;
  sourceBytes: number;
  decodedBytes: number;
  result?: LoadedAsset<unknown>;
  error?: Error;
  promise?: Promise<LoadedAsset<unknown>>;
  resolve?: (result: LoadedAsset<unknown>) => void;
  reject?: (error: unknown) => void;
  /** Cache keys only: this readiness record must not retain dependency values. */
  preparedDependencies?: string[];
}

interface RootRequestState {
  assetId: string;
  representation?: string;
  order: number;
  state: "loading" | "ready" | "failed";
  lastUsed: number;
}

const PRIORITY: Record<AssetLoadPriority, number> = { gameplay: 0, preload: 1, background: 2 };
const MiB = 1024 * 1024;

/** Configurable initial limits; device-specific defaults require physical-device measurements. */
const DEFAULT_BUDGETS: AssetLoadingBudgets = {
  sourceBytes: 128 * MiB,
  decodedBytes: 128 * MiB,
  temporaryBytes: 64 * MiB,
  concurrency: 4,
  retentionMs: 1_000,
};

function byteCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid asset memory estimate: ${value}`);
  return value;
}

/**
 * One service per project session. Requests own the complete required closure,
 * rather than creating ownership edges between cache entries, so cycles can be
 * loaded and later evicted. Deferred references never enter that closure.
 */
export class AssetLoadingService {
  private readonly options: AssetLoadingServiceOptions;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly scopes = new Set<AssetLoadScope>();
  private readonly rootRequests = new Map<Acquisition, RootRequestState>();
  private readonly rootFailures = new Map<string, RootRequestState>();
  private readonly queue: CacheEntry[] = [];
  private readonly budgets: AssetLoadingBudgets;
  private readonly now: () => number;
  private sourceBytes = 0;
  private decodedBytes = 0;
  private reservedSourceBytes = 0;
  private reservedDecodedBytes = 0;
  private temporaryBytes = 0;
  private active = 0;
  private order = 0;
  private cacheHits = 0;
  private loads = 0;
  private disposed = false;
  private trimTimer?: ReturnType<typeof setTimeout>;

  constructor(options: AssetLoadingServiceOptions) {
    this.options = options;
    this.budgets = { ...DEFAULT_BUDGETS, ...options.budgets };
    for (const value of Object.values(this.budgets)) byteCount(value);
    if (this.budgets.concurrency === 0) throw new Error("Asset loading concurrency must be positive");
    this.now = options.now ?? Date.now;
  }

  createScope(owner: string): AssetLoadScope {
    if (this.disposed) throw new Error("Asset loading session is disposed");
    const scope = new AssetLoadScope(this, owner);
    this.scopes.add(scope);
    return scope;
  }

  getLoadState(assetId: string, representation?: string): AssetLoadState {
    const matches = (request: RootRequestState) => request.assetId === assetId
      && (!representation || request.representation === representation);
    const requests = [...this.rootRequests.values()].filter(matches);
    if (requests.some(request => request.state === "loading")) return "loading";
    let latest: CacheEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.asset.id === assetId && (!representation || entry.representation.key === representation)
        && (!latest || entry.order > latest.order)) latest = entry;
    }
    const failure = [...this.rootFailures.values()].filter(matches).sort((a, b) => b.order - a.order)[0];
    const newestReady = Math.max(latest?.order ?? -1, ...requests.map(request => request.order));
    if (failure && failure.order > newestReady) return "failed";
    if (latest?.state === "ready") {
      for (const key of latest.preparedDependencies ?? []) {
        const dependency = this.entries.get(key);
        if (!dependency) return "unloaded";
        if (dependency.state !== "ready") return dependency.state;
      }
    }
    return latest?.state ?? "unloaded";
  }

  snapshot(): AssetLoadingSnapshot {
    return {
      sourceBytes: this.sourceBytes, decodedBytes: this.decodedBytes,
      reservedSourceBytes: this.reservedSourceBytes, reservedDecodedBytes: this.reservedDecodedBytes,
      temporaryBytes: this.temporaryBytes, active: this.active, queued: this.queue.length,
      cacheHits: this.cacheHits, loads: this.loads,
      entries: [...this.entries.values()].map((entry) => ({
        assetId: entry.asset.id, rootId: entry.asset.rootId, revision: entry.asset.revision,
        representation: entry.representation.key, state: entry.state,
        owners: [...new Set([...entry.owners].map((owner) => owner.owner))],
        sourceBytes: entry.sourceBytes, decodedBytes: entry.decodedBytes, error: entry.error?.message,
      })),
    };
  }

  /** Eviction never touches an owned entry, including during replacement loads. */
  trim(options: { force?: boolean } = {}): void {
    const before = this.now() - this.budgets.retentionMs;
    for (const entry of [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (entry.owners.size === 0 && entry.state !== "loading" && (options.force || entry.lastUsed <= before)) {
        this.evict(entry);
      }
    }
    for (const [key, failure] of this.rootFailures) {
      if (options.force || failure.lastUsed <= before) this.rootFailures.delete(key);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const scope of [...this.scopes]) scope.dispose();
    if (this.trimTimer !== undefined) clearTimeout(this.trimTimer);
    this.trimTimer = undefined;
    this.trim({ force: true });
  }

  /** @internal Use a scope so successful requests always have a release boundary. */
  async acquire<T>(
    ticket: Acquisition,
    assetId: string,
    representation: AssetRepresentation<T> | undefined,
    options: AssetAcquireOptions,
  ): Promise<T> {
    const signal = ticket.controller.signal;
    const check = () => {
      if (signal.aborted || this.disposed) throw this.error("cancelled", assetId, ticket.owner, "request cancelled");
    };
    check();
    const request: RootRequestState = {
      assetId, representation: representation?.key, order: this.order++, state: "loading", lastUsed: this.now(),
    };
    this.rootRequests.set(ticket, request);
    try {
      const records = new Map<string, AssetCatalogRecord>();
      const visited = new Set<string>();
      const visit = async (id: string): Promise<void> => {
        if (visited.has(id)) return;
        visited.add(id);
        check();
        let record: AssetCatalogRecord;
        try { record = await this.options.resolve(id); }
        catch (cause) { throw this.error("missing", id, ticket.owner, errorMessage(cause), cause); }
        check();
        records.set(id, record);
        if (options.dependencies !== "none") {
          for (const dependency of record.requiredDependencies) await visit(dependency);
        }
      };
      await abortable(visit(assetId), signal, () => this.error("cancelled", assetId, ticket.owner, "request cancelled"));
      check();
      const promises: Array<Promise<LoadedAsset<unknown>>> = [];
      let root: CacheEntry | undefined;
      for (const [id, asset] of records) {
        const selected = id === assetId && representation ? representation : this.options.representation(asset);
        const entry = this.retain(ticket, asset, selected, options.priority ?? "gameplay");
        promises.push(entry.promise ?? Promise.resolve(entry.result!));
        if (id === assetId) { root = entry; request.representation = selected.key; }
      }
      this.pump();
      await abortable(Promise.all(promises), signal, () => this.error("cancelled", assetId, ticket.owner, "request cancelled"));
      await abortable(Promise.all([...records.values()].map(async (asset) => {
        const current = await this.options.resolve(asset.id);
        if (current.revision !== asset.revision || current.rootId !== asset.rootId) {
          throw this.error("stale", asset.id, ticket.owner, "asset changed while dependencies loaded; retry the current revision");
        }
      })), signal, () => this.error("cancelled", assetId, ticket.owner, "request cancelled"));
      check();
      request.state = "ready";
      root!.preparedDependencies = [...ticket.entries].filter(entry => entry !== root).map(entry => entry.key);
      this.rootFailures.delete(JSON.stringify([assetId, request.representation]));
      return root!.result!.value as T;
    } catch (error) {
      if (!signal.aborted && !this.disposed) {
        this.rootFailures.set(JSON.stringify([assetId, request.representation]), {
          ...request, state: "failed", order: this.order++, lastUsed: this.now(),
        });
      }
      throw error;
    }
  }

  /** @internal */
  release(ticket: Acquisition): void {
    this.rootRequests.delete(ticket);
    ticket.controller.abort();
    for (const entry of ticket.entries) {
      entry.owners.delete(ticket);
      entry.lastUsed = this.now();
      if (entry.owners.size === 0 && entry.state === "loading") {
        entry.controller.abort();
        this.fail(entry, this.error("cancelled", entry.asset.id, ticket.owner, "final consumer released"));
        const index = this.queue.indexOf(entry);
        if (index !== -1) this.queue.splice(index, 1);
        this.evict(entry);
      }
    }
    ticket.entries.clear();
    if (!this.disposed && this.trimTimer === undefined) {
      this.trimTimer = setTimeout(() => {
        this.trimTimer = undefined;
        this.trim();
        if (this.rootFailures.size || [...this.entries.values()].some((entry) => !entry.owners.size)) this.scheduleTrim();
      }, this.budgets.retentionMs);
      // A cache grace period should not keep command-line consumers alive.
      (this.trimTimer as unknown as { unref?: () => void }).unref?.();
    }
    this.pump();
  }

  /** @internal */
  releaseScope(scope: AssetLoadScope): void { this.scopes.delete(scope); }

  private scheduleTrim(): void {
    if (this.trimTimer !== undefined || this.disposed) return;
    this.trimTimer = setTimeout(() => {
      this.trimTimer = undefined;
      this.trim();
      if (this.rootFailures.size || [...this.entries.values()].some((entry) => !entry.owners.size)) this.scheduleTrim();
    }, Math.max(1, this.budgets.retentionMs));
    (this.trimTimer as unknown as { unref?: () => void }).unref?.();
  }

  private retain(ticket: Acquisition, asset: AssetCatalogRecord, representation: AssetRepresentation, priority: AssetLoadPriority): CacheEntry {
    const key = JSON.stringify([this.options.projectId, asset.rootId, asset.id, asset.revision, representation.key]);
    let entry = this.entries.get(key);
    if (entry?.state === "failed") { this.evict(entry); entry = undefined; }
    if (entry) {
      this.cacheHits++;
      entry.priority = Math.min(entry.priority, PRIORITY[priority]);
    } else {
      for (const value of Object.values(representation.estimate)) byteCount(value);
      entry = {
        key, asset, representation: { key: representation.key, estimate: representation.estimate }, load: representation.load,
        state: "loading", owners: new Set(), controller: new AbortController(),
        priority: PRIORITY[priority], order: this.order++, lastUsed: this.now(), sourceBytes: 0, decodedBytes: 0,
      };
      const created = entry;
      created.promise = new Promise((resolve, reject) => { created.resolve = resolve; created.reject = reject; });
      // Retention of later dependencies can throw before Promise.all is installed.
      void created.promise.catch(() => undefined);
      this.entries.set(key, created);
      this.queue.push(created);
    }
    entry.owners.add(ticket);
    ticket.entries.add(entry);
    return entry;
  }

  private pump(): void {
    if (this.disposed) return;
    this.queue.sort((a, b) => a.priority - b.priority || a.order - b.order);
    while (this.active < this.budgets.concurrency && this.queue.length) {
      const entry = this.queue[0];
      const memory = entry.representation.estimate;
      if (memory.sourceBytes > this.budgets.sourceBytes || memory.decodedBytes > this.budgets.decodedBytes
        || memory.temporaryBytes > this.budgets.temporaryBytes) {
        this.queue.shift();
        this.fail(entry, this.budgetError(entry, "request exceeds the configured budget"));
        continue;
      }
      if (!this.fits(memory)) {
        for (const candidate of [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed)) {
          if (candidate.owners.size === 0 && candidate.state !== "loading") this.evict(candidate);
          if (this.fits(memory)) break;
        }
      }
      if (!this.fits(memory)) {
        if (this.active > 0) break;
        this.queue.shift();
        this.fail(entry, this.budgetError(entry, "active consumers retain the available budget; release ownership or raise the configured limit"));
        continue;
      }
      this.queue.shift();
      this.active++;
      this.loads++;
      this.reservedSourceBytes += memory.sourceBytes;
      this.reservedDecodedBytes += memory.decodedBytes;
      this.temporaryBytes += memory.temporaryBytes;
      void this.run(entry);
    }
  }

  private fits(memory: AssetMemoryEstimate): boolean {
    return this.sourceBytes + this.reservedSourceBytes + memory.sourceBytes <= this.budgets.sourceBytes
      && this.decodedBytes + this.reservedDecodedBytes + memory.decodedBytes <= this.budgets.decodedBytes
      && this.temporaryBytes + memory.temporaryBytes <= this.budgets.temporaryBytes;
  }

  private async run(entry: CacheEntry): Promise<void> {
    const memory = entry.representation.estimate;
    let result: LoadedAsset<unknown> | undefined;
    try {
      // A decoder may close over its source buffer. Keep that callback only for
      // the operation, so a CPU cache entry cannot retain evicted source bytes.
      const load = entry.load!;
      entry.load = undefined;
      result = await load(entry.asset, entry.controller.signal);
      const cancelled = () => this.error("cancelled", entry.asset.id, this.owner(entry), "request cancelled before publication");
      if (entry.controller.signal.aborted || this.disposed) throw cancelled();
      // Metadata validation owns no decoded resource. Stop waiting for a slow
      // provider as soon as the final consumer leaves, and dispose the result.
      const current = await abortable(Promise.resolve(this.options.resolve(entry.asset.id)), entry.controller.signal, cancelled);
      if (entry.controller.signal.aborted || this.disposed || this.entries.get(entry.key) !== entry) {
        throw cancelled();
      }
      if (current.revision !== entry.asset.revision || current.rootId !== entry.asset.rootId) {
        throw this.error("stale", entry.asset.id, this.owner(entry), "asset changed during loading; retry the current revision");
      }
      const sourceBytes = byteCount(result.sourceBytes ?? memory.sourceBytes);
      const decodedBytes = byteCount(result.decodedBytes ?? memory.decodedBytes);
      if (this.sourceBytes + this.reservedSourceBytes - memory.sourceBytes + sourceBytes > this.budgets.sourceBytes
        || this.decodedBytes + this.reservedDecodedBytes - memory.decodedBytes + decodedBytes > this.budgets.decodedBytes) {
        throw this.budgetError(entry, "decoded result exceeds its reserved budget");
      }
      entry.sourceBytes = sourceBytes;
      entry.decodedBytes = decodedBytes;
      this.sourceBytes += sourceBytes;
      this.decodedBytes += decodedBytes;
      entry.result = result;
      entry.state = "ready";
      entry.lastUsed = this.now();
      entry.resolve!(result);
      this.clearPromise(entry);
      result = undefined;
    } catch (cause) {
      this.fail(entry, cause instanceof AssetLoadError ? cause
        : this.error("load", entry.asset.id, this.owner(entry), errorMessage(cause), cause));
    } finally {
      try { result?.dispose?.(); }
      catch (cause) { entry.error = this.error("load", entry.asset.id, this.owner(entry), `cleanup failed: ${errorMessage(cause)}`, cause); }
      finally {
        this.active--;
        this.reservedSourceBytes -= memory.sourceBytes;
        this.reservedDecodedBytes -= memory.decodedBytes;
        this.temporaryBytes -= memory.temporaryBytes;
        this.pump();
      }
    }
  }

  private fail(entry: CacheEntry, error: Error): void {
    if (entry.state !== "loading") return;
    entry.state = "failed";
    entry.error = error;
    entry.reject?.(error);
    this.clearPromise(entry);
  }

  private clearPromise(entry: CacheEntry): void {
    entry.promise = undefined;
    entry.resolve = undefined;
    entry.reject = undefined;
  }

  private evict(entry: CacheEntry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    this.sourceBytes -= entry.sourceBytes;
    this.decodedBytes -= entry.decodedBytes;
    entry.sourceBytes = 0;
    entry.decodedBytes = 0;
    const result = entry.result;
    entry.result = undefined;
    entry.load = undefined;
    this.clearPromise(entry);
    try { result?.dispose?.(); }
    catch (cause) { entry.error = this.error("load", entry.asset.id, this.owner(entry), `cleanup failed: ${errorMessage(cause)}`, cause); }
  }

  private owner(entry: CacheEntry): string { return entry.owners.values().next().value?.owner ?? "released consumer"; }
  private budgetError(entry: CacheEntry, message: string): AssetLoadError {
    return this.error("budget", entry.asset.id, this.owner(entry), message);
  }
  private error(code: AssetLoadErrorCode, assetId: string, owner: string, message: string, cause?: unknown): AssetLoadError {
    return new AssetLoadError(code, assetId, owner, message, cause === undefined ? undefined : { cause });
  }
}

/** Ownership is normally hidden inside a scene, editor, preview, or preload. */
export class AssetLoadScope {
  private readonly service: AssetLoadingService;
  readonly owner: string;
  private readonly acquisitions = new Set<Acquisition>();
  private readonly preloads = new Set<AssetLoadScope>();
  private readonly replacements = new Map<string, { assetId: string; key: string; pending: boolean; ticket?: Acquisition }>();
  private disposed = false;

  constructor(service: AssetLoadingService, owner: string) {
    this.service = service;
    this.owner = owner;
  }

  async acquire<T = unknown>(assetId: string, representation?: AssetRepresentation<T>, options: AssetAcquireOptions = {}): Promise<T> {
    return (await this.acquireTicket(assetId, representation, options)).value;
  }

  /** Preserve the previous resource until a replacement has fully prepared. */
  async acquireLatest<T = unknown>(slot: string, assetId: string, representation?: AssetRepresentation<T>, options: AssetAcquireOptions = {}): Promise<T> {
    const previous = this.replacements.get(slot);
    const current = { assetId, key: representation?.key ?? "default", pending: true, ticket: previous?.ticket };
    this.replacements.set(slot, current);
    let loaded: { value: T; ticket: Acquisition };
    try { loaded = await this.acquireTicket(assetId, representation, options); }
    finally { current.pending = false; }
    const { value, ticket } = loaded;
    const latest = this.replacements.get(slot);
    if (latest !== current) {
      // Several panels can request the same slot together. Their compatible
      // result remains owned by the most recent request, without failing a panel.
      if (latest?.assetId === assetId && latest.key === current.key) {
        if (latest.pending || !latest.ticket) {
          if (latest.ticket) {
            this.service.release(latest.ticket);
            this.acquisitions.delete(latest.ticket);
          }
          latest.ticket = ticket;
          return value;
        }
        const keys = new Set([...latest.ticket.entries].map((entry) => entry.key));
        if ([...ticket.entries].every((entry) => keys.has(entry.key))) {
          this.service.release(ticket);
          this.acquisitions.delete(ticket);
          return value;
        }
      }
      this.service.release(ticket);
      this.acquisitions.delete(ticket);
      throw new AssetLoadError("stale", assetId, this.owner, "a newer request replaced this consumer's resource");
    }
    if (current.ticket) {
      this.service.release(current.ticket);
      this.acquisitions.delete(current.ticket);
    }
    current.ticket = ticket;
    return value;
  }

  private async acquireTicket<T>(assetId: string, representation: AssetRepresentation<T> | undefined, options: AssetAcquireOptions): Promise<{ value: T; ticket: Acquisition }> {
    if (this.disposed) throw new AssetLoadError("cancelled", assetId, this.owner, "scope is disposed");
    const ticket: Acquisition = { owner: this.owner, entries: new Set(), controller: new AbortController() };
    this.acquisitions.add(ticket);
    const abort = () => this.service.release(ticket);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      return { value: await this.service.acquire<T>(ticket, assetId, representation, options), ticket };
    } catch (error) {
      this.service.release(ticket);
      this.acquisitions.delete(ticket);
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async preload(assetIds: readonly string[], options: AssetPreloadOptions = {}): Promise<void> {
    if (this.disposed) throw new AssetLoadError("cancelled", assetIds[0] ?? "preload", this.owner, "scope is disposed");
    const ids = [...new Set(assetIds)];
    let completed = 0;
    options.onProgress?.({ completed, total: ids.length });
    const preload = this.service.createScope(`${this.owner} (preload)`);
    this.preloads.add(preload);
    try {
      await Promise.all(ids.map(async (id) => {
        await preload.acquire(id, undefined, { ...options, priority: options.priority ?? "preload" });
        options.onProgress?.({ completed: ++completed, total: ids.length });
      }));
    } catch (error) {
      preload.dispose();
      this.preloads.delete(preload);
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const preload of this.preloads) preload.dispose();
    this.preloads.clear();
    this.replacements.clear();
    for (const acquisition of this.acquisitions) this.service.release(acquisition);
    this.acquisitions.clear();
    this.service.releaseScope(this);
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function abortable<T>(promise: Promise<T>, signal: AbortSignal, error: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(error());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
