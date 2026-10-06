import { describe, expect, it } from "vitest";
import {
  AssetLoadingService,
  type AssetCatalogRecord,
  type AssetLoadingServiceOptions,
  type AssetRepresentation,
  type LoadedAsset,
} from "./asset-loading-service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function catalog(id: string, requiredDependencies: string[] = []): AssetCatalogRecord {
  return { id, rootId: "project", revision: "1", requiredDependencies };
}

function setup(
  records: AssetCatalogRecord[],
  load: AssetRepresentation<string>["load"],
  options: Partial<Pick<AssetLoadingServiceOptions, "budgets" | "now">> = {},
) {
  const assets = new Map(records.map((asset) => [asset.id, asset]));
  const service = new AssetLoadingService({
    projectId: "project-session", ...options,
    resolve(id) {
      const asset = assets.get(id);
      if (!asset) throw new Error(`Missing ${id}`);
      return asset;
    },
    representation: () => ({
      key: "source", estimate: { sourceBytes: 4, decodedBytes: 8, temporaryBytes: 8 }, load,
    }),
  });
  return { service, assets };
}

describe("project asset loading", () => {
  it("allows simultaneous panels to share a compatible replacement slot", async () => {
    const { service } = setup([catalog("model")], async () => ({ value: "shared source" }));
    const scope = service.createScope("model editor");
    expect(await Promise.all([scope.acquireLatest("preview", "model"), scope.acquireLatest("preview", "model")]))
      .toEqual(["shared source", "shared source"]);
    expect(service.snapshot().loads).toBe(1);
    scope.dispose();
    service.trim({ force: true });
    expect(service.snapshot().entries).toEqual([]);
    service.dispose();
  });

  it("retains a valid replacement slot on failure and releases older revisions after successful preparation", async () => {
    const disposed: string[] = [];
    let broken = false;
    const { service, assets } = setup([catalog("texture")], async (asset) => {
      if (broken) throw new Error("Decoder rejected replacement");
      return { value: asset.revision, dispose: () => { disposed.push(asset.revision); } };
    });
    const editor = service.createScope("Texture Preview");
    expect(await editor.acquireLatest("texture", "texture")).toBe("1");
    assets.set("texture", { ...catalog("texture"), revision: "2" });
    broken = true;
    await expect(editor.acquireLatest("texture", "texture")).rejects.toMatchObject({ code: "load" });
    service.trim({ force: true });
    expect(disposed).toEqual([]);
    broken = false;
    expect(await editor.acquireLatest("texture", "texture")).toBe("2");
    service.trim({ force: true });
    expect(disposed).toEqual(["1"]);
    expect(service.snapshot().entries).toHaveLength(1);
    editor.dispose();
    service.trim({ force: true });
    expect(disposed).toEqual(["1", "2"]);
    service.dispose();
  });

  it("loads only the required closure, deduplicates cycles, and releases shared data only after its final owner", async () => {
    const loaded: string[] = [];
    const disposed: string[] = [];
    const { service } = setup([catalog("scene", ["model"]), catalog("model", ["scene"]), catalog("deferred")], async (asset) => {
      loaded.push(asset.id);
      return { value: asset.id, dispose: () => { disposed.push(asset.id); } };
    });
    const first = service.createScope("first scene instance");
    const second = service.createScope("second scene instance");
    expect(await Promise.all([first.acquire("scene"), second.acquire("scene")])).toEqual(["scene", "scene"]);
    expect(loaded.sort()).toEqual(["model", "scene"]);
    expect(service.snapshot()).toMatchObject({ sourceBytes: 8, decodedBytes: 16, temporaryBytes: 0, loads: 2 });
    first.dispose();
    service.trim({ force: true });
    expect(disposed).toEqual([]);
    expect(service.snapshot().entries.every((entry) => entry.owners.length === 1)).toBe(true);
    second.dispose();
    service.trim({ force: true });
    expect(disposed.sort()).toEqual(["model", "scene"]);
    expect(service.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, entries: [] });
    service.dispose();
  });

  it("cancels one waiter without aborting a surviving consumer's read", async () => {
    const result = deferred<LoadedAsset<string>>();
    const started = deferred<AbortSignal>();
    const { service } = setup([catalog("model")], async (_asset, signal) => {
      started.resolve(signal);
      return result.promise;
    });
    const first = service.createScope("cancelled instance");
    const second = service.createScope("surviving instance");
    const firstLoad = first.acquire("model");
    const failure = expect(firstLoad).rejects.toMatchObject({ code: "cancelled" });
    const secondLoad = second.acquire("model");
    const signal = await started.promise;
    first.dispose();
    await failure;
    expect(signal.aborted).toBe(false);
    result.resolve({ value: "usable model" });
    expect(await secondLoad).toBe("usable model");
    expect(service.snapshot().loads).toBe(1);
    service.dispose();
  });

  it("settles cancelled operations and disposes late results after switching projects", async () => {
    const result = deferred<LoadedAsset<string>>();
    const started = deferred<void>();
    let disposed = false;
    const { service } = setup([catalog("model")], async () => { started.resolve(); return result.promise; });
    const load = service.createScope("old project").acquire("model");
    const failure = expect(load).rejects.toMatchObject({ code: "cancelled" });
    await started.promise;
    service.dispose();
    await failure;
    result.resolve({ value: "old result", dispose: () => { disposed = true; } });
    await result.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(true);
    expect(service.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, temporaryBytes: 0, active: 0, entries: [] });
  });

  it("releases a completed resource and reservations when cancellation interrupts a stalled freshness check", async () => {
    const validating = deferred<void>();
    const freshness = deferred<AssetCatalogRecord>();
    const disposed = deferred<void>();
    let lookups = 0;
    const service = new AssetLoadingService({
      projectId: "project",
      resolve: () => {
        if (++lookups === 1) return catalog("model");
        validating.resolve();
        return freshness.promise;
      },
      representation: () => ({
        key: "source", estimate: { sourceBytes: 4, decodedBytes: 8, temporaryBytes: 8 },
        load: async () => ({ value: "loaded", dispose: () => disposed.resolve() }),
      }),
    });
    const scope = service.createScope("scene instance");
    const request = scope.acquire("model");
    const failure = expect(request).rejects.toMatchObject({ code: "cancelled" });
    await validating.promise;
    scope.dispose();
    await failure;
    await disposed.promise;
    expect(service.snapshot()).toMatchObject({
      sourceBytes: 0, decodedBytes: 0, temporaryBytes: 0,
      reservedSourceBytes: 0, reservedDecodedBytes: 0, active: 0, entries: [],
    });
    // Late metadata cannot resurrect the discarded result.
    freshness.resolve(catalog("model"));
    service.dispose();
  });

  it("rejects stale results and permits a retry at the new revision", async () => {
    const result = deferred<LoadedAsset<string>>();
    const started = deferred<void>();
    let disposed = false;
    let attempts = 0;
    const { service, assets } = setup([catalog("model")], async () => {
      if (++attempts === 1) { started.resolve(); return result.promise; }
      return { value: "revision 2" };
    });
    const scope = service.createScope("actor");
    const first = scope.acquire("model");
    const failure = expect(first).rejects.toMatchObject({ code: "stale", assetId: "model", consumer: "actor" });
    await started.promise;
    assets.set("model", { ...catalog("model"), revision: "2" });
    result.resolve({ value: "revision 1", dispose: () => { disposed = true; } });
    await failure;
    expect(disposed).toBe(true);
    expect(await scope.acquire("model")).toBe("revision 2");
    service.dispose();
  });

  it("rolls back failed dependency ownership and retries without poisoning the cache", async () => {
    let fail = true;
    const { service } = setup([catalog("scene", ["texture"]), catalog("texture")], async (asset) => {
      if (asset.id === "texture" && fail) throw new Error("Corrupt image");
      return { value: asset.id };
    });
    const scope = service.createScope("scene instance");
    await expect(scope.acquire("scene")).rejects.toMatchObject({ code: "load", assetId: "texture" });
    expect(service.getLoadState("texture")).toBe("failed");
    expect(service.getLoadState("scene")).toBe("failed");
    expect(service.snapshot().entries.every((entry) => entry.owners.length === 0)).toBe(true);
    fail = false;
    expect(await scope.acquire("scene")).toBe("scene");
    expect(service.getLoadState("scene")).toBe("ready");
    service.dispose();
  });

  it("reports root readiness only after required dependencies finish and preserves a surviving waiter on cancellation", async () => {
    const dependencyStarted = deferred<void>();
    const dependency = deferred<LoadedAsset<string>>();
    const { service } = setup([catalog("scene", ["model"]), catalog("model")], async asset => {
      if (asset.id === "model") { dependencyStarted.resolve(); return dependency.promise; }
      return { value: asset.id };
    });
    const first = service.createScope("first scene");
    const second = service.createScope("second scene");
    const cancelled = expect(first.acquire("scene")).rejects.toMatchObject({ code: "cancelled" });
    const surviving = second.acquire("scene");
    await dependencyStarted.promise;
    expect(service.getLoadState("scene")).toBe("loading");
    first.dispose();
    await cancelled;
    expect(service.getLoadState("scene")).toBe("loading");
    dependency.resolve({ value: "model" });
    expect(await surviving).toBe("scene");
    expect(service.getLoadState("scene")).toBe("ready");
    service.dispose();
  });

  it("reports missing dependency preparation as a failed root before any payload work begins", async () => {
    const { service } = setup([catalog("scene", ["missing"])], async () => ({ value: "unused" }));
    await expect(service.createScope("scene").acquire("scene")).rejects.toMatchObject({ code: "missing" });
    expect(service.getLoadState("scene")).toBe("failed");
    expect(service.snapshot().loads).toBe(0);
    service.dispose();
  });

  it("fails oversized and overlapping replacements promptly while preserving the live revision", async () => {
    const { service, assets } = setup([catalog("model")], async (asset) => ({ value: asset.revision }), {
      budgets: { sourceBytes: 4, decodedBytes: 8, temporaryBytes: 8 },
    });
    const scope = service.createScope("actor");
    expect(await scope.acquire("model")).toBe("1");
    assets.set("model", { ...catalog("model"), revision: "2" });
    await expect(scope.acquire("model")).rejects.toMatchObject({ code: "budget" });
    const huge: AssetRepresentation = {
      key: "huge", estimate: { sourceBytes: 5, decodedBytes: 0, temporaryBytes: 0 },
      load: async () => { throw new Error("An oversized asset must not start reading"); },
    };
    await expect(scope.acquire("model", huge)).rejects.toMatchObject({ code: "budget" });
    expect(service.snapshot()).toMatchObject({ sourceBytes: 4, decodedBytes: 8, temporaryBytes: 0 });
    expect(service.snapshot().entries.find((entry) => entry.revision === "1")).toMatchObject({ state: "ready", owners: ["actor"] });
    service.dispose();

    const pending = deferred<LoadedAsset<string>>();
    const started = deferred<void>();
    const saturated = setup([catalog("model")], async () => { started.resolve(); return pending.promise; }, {
      budgets: { sourceBytes: 4, decodedBytes: 8, temporaryBytes: 8, concurrency: 1 },
    }).service;
    const waiting = saturated.createScope("waiting actor");
    const inFlight = waiting.acquire("model");
    await started.promise;
    for (const estimate of [
      { sourceBytes: 5, decodedBytes: 0, temporaryBytes: 0 },
      { sourceBytes: 0, decodedBytes: 9, temporaryBytes: 0 },
      { sourceBytes: 0, decodedBytes: 0, temporaryBytes: 9 },
    ]) await expect(waiting.acquire("model", { ...huge, key: JSON.stringify(estimate), estimate })).rejects.toMatchObject({ code: "budget" });
    expect(saturated.snapshot()).toMatchObject({ active: 1, queued: 0, temporaryBytes: 8, reservedSourceBytes: 4, reservedDecodedBytes: 8 });
    pending.resolve({ value: "surviving load" });
    expect(await inFlight).toBe("surviving load");
    saturated.dispose();
  });

  it("bounds in-flight reservations and admits gameplay before queued background work", async () => {
    const first = deferred<LoadedAsset<string>>();
    const started = deferred<void>();
    const order: string[] = [];
    const { service } = setup([catalog("first"), catalog("thumbnail"), catalog("actor")], async (asset) => {
      order.push(asset.id);
      if (asset.id === "first") { started.resolve(); return first.promise; }
      return { value: asset.id };
    }, { budgets: { temporaryBytes: 8, concurrency: 3 } });
    const scope = service.createScope("test session");
    const a = scope.acquire("first");
    await started.promise;
    const b = scope.acquire("thumbnail", undefined, { priority: "background" });
    const c = scope.acquire("actor", undefined, { priority: "gameplay" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(service.snapshot()).toMatchObject({ temporaryBytes: 8, active: 1, queued: 2 });
    first.resolve({ value: "first" });
    await Promise.all([a, b, c]);
    expect(order).toEqual(["first", "actor", "thumbnail"]);
    service.dispose();
  });

  it("evicts the least recently released unowned entry under pressure and keeps a short warm cache", async () => {
    let time = 0;
    const disposed: string[] = [];
    const { service } = setup([catalog("old"), catalog("recent"), catalog("next")], async (asset) => ({
      value: asset.id, dispose: () => { disposed.push(asset.id); },
    }), { now: () => time, budgets: { sourceBytes: 8, decodedBytes: 16, retentionMs: 1_000 } });
    const old = service.createScope("old actor");
    await old.acquire("old");
    old.dispose();
    time = 100;
    const recent = service.createScope("recent actor");
    await recent.acquire("recent");
    recent.dispose();
    service.trim();
    expect(disposed).toEqual([]);
    const next = service.createScope("next actor");
    await next.acquire("next");
    expect(disposed).toEqual(["old"]);
    time = 1_200;
    service.trim();
    expect(disposed).toEqual(["old", "recent"]);
    expect(service.snapshot()).toMatchObject({ sourceBytes: 4, decodedBytes: 8 });
    service.dispose();
  });

  it("releases a partially completed preload group when another asset fails", async () => {
    const { service } = setup([catalog("okay"), catalog("bad")], async (asset) => {
      if (asset.id === "bad") throw new Error("Missing payload");
      return { value: asset.id };
    });
    const scope = service.createScope("preload node");
    await expect(scope.preload(["okay", "bad"])).rejects.toMatchObject({ assetId: "bad" });
    service.trim({ force: true });
    expect(service.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, entries: [] });
    service.dispose();
  });
});
