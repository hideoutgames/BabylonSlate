import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ThumbnailCaptureResult } from "@babylonslate/render";
import { enqueueModelThumbnailJobs } from "../lib/model-thumbnail-queue";
import { holdBlockingSceneLoad } from "../lib/blocking-scene-loads";
import { ModelThumbnailCaptureHost } from "./model-thumbnail-capture-host";

function captured(bytes: number[] = [137, 80, 78, 71]): ThumbnailCaptureResult {
  return { outcome: "captured", png: new Uint8Array(bytes) };
}
const expired: ThumbnailCaptureResult = { outcome: "expired", reason: "ceiling" };
const retryCeilingMs = vi.hoisted(() => 300_000);

const captureModelThumbnailPng = vi.fn<
  (
    engine: unknown,
    bytes: Uint8Array,
    slots: unknown,
    resolveMaterial: (guid: string) => unknown,
    maxEdge?: number,
    options?: {
      importScale?: number;
      clipName?: string;
      sourceClipBytes?: Uint8Array | null;
      signal?: AbortSignal;
      ceilingMs?: number;
    },
  ) => Promise<ThumbnailCaptureResult>
>(async () => captured());
const MaterialLibrary = vi.fn();
const captureAssetThumbnailPng = vi.fn<(...args: unknown[]) => Promise<ThumbnailCaptureResult>>(async () => captured());
const prepareAssetThumbnailInput = vi.fn<(input: unknown) => Promise<{ kind: string; materials: Map<string, unknown> }>>(async () => ({ kind: "Material", materials: new Map() }));
let projectGuid = "project-a";
let thumbnailsEnabled = true;
const resourceCacheForEngine = vi.fn(() => ({}));
const collectPlayMaterialLibrary = vi.fn(async () => ({
  documents: new Map(),
  functions: new Map(),
  textureGuids: [],
}));
const collectPlayTextureBytes = vi.fn(async () => new Map());
const writeAssetThumbnail = vi.fn<(guid: string, png: Uint8Array, options?: { cacheKey: string; projectGuid: string }) => Promise<void>>(async () => undefined);
const scopes: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
const createAssetLoadScope = vi.fn(() => {
  const scope = { dispose: vi.fn() };
  scopes.push(scope);
  return scope;
});
const readAssetChunk = vi.fn<
  (path: string, kind: string, options?: { scope?: unknown; signal?: AbortSignal; priority?: string }) => Promise<Uint8Array | null>
>(async () => new Uint8Array([1, 2, 3, 4]));
const assets = new Map<
  string,
  { path: string; header: { type: string; payload: Record<string, unknown> } }
>();

vi.mock("@babylonslate/render", () => ({
  captureAssetThumbnailPng: (...args: unknown[]) => captureAssetThumbnailPng(...args),
  captureModelThumbnailPng: (
    engine: unknown,
    bytes: Uint8Array,
    slots: unknown,
    resolveMaterial: (guid: string) => unknown,
    maxEdge?: number,
    options?: {
      importScale?: number;
      clipName?: string;
      sourceClipBytes?: Uint8Array | null;
      signal?: AbortSignal;
      ceilingMs?: number;
    },
  ) =>
    captureModelThumbnailPng(
      engine,
      bytes,
      slots,
      resolveMaterial,
      maxEdge,
      options,
    ),
  MaterialLibrary: class {
    constructor() {
      MaterialLibrary();
    }
    acquire() {
      return { ok: false, diagnostics: [] };
    }
    dispose() {}
  },
  resourceCacheForEngine: () => resourceCacheForEngine(),
  getMaterialTexture: vi.fn(),
  materialUnavailable: () => true,
  SCENE_CAPTURE_RETRY_CEILING_MS: retryCeilingMs,
}));

vi.mock("../lib/asset-thumbnail-input", () => ({
  prepareAssetThumbnailInput: (input: unknown) => prepareAssetThumbnailInput(input),
}));

const sharedEngine = vi.hoisted(() => ({ engine: { id: "shared-engine" } as unknown, generation: 1 }));

vi.mock("../context/play-context", () => ({
  useOptionalPlay: () => ({
    ensureSharedEngine: () => sharedEngine.engine,
    sharedEngineGeneration: sharedEngine.generation,
  }),
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  thumbnailsEnabled,
  projectGuid,
  assetRegistry: { getByGuid: (guid: string) => assets.get(guid) },
  readAssetChunk,
  createAssetLoadScope,
  collectPlayMaterialLibrary,
  collectPlayTextureBytes,
  writeAssetThumbnail,
})));

afterEach(() => {
  cleanup();
  captureModelThumbnailPng
    .mockReset()
    .mockResolvedValue(captured());
  MaterialLibrary.mockClear();
  resourceCacheForEngine.mockClear();
  collectPlayMaterialLibrary.mockClear();
  collectPlayTextureBytes.mockClear();
  writeAssetThumbnail.mockClear();
  createAssetLoadScope.mockClear();
  scopes.length = 0;
  readAssetChunk.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
  assets.clear();
  projectGuid = "project-a";
  thumbnailsEnabled = true;
  captureAssetThumbnailPng.mockReset().mockResolvedValue(captured());
  prepareAssetThumbnailInput.mockClear();
  sharedEngine.engine = { id: "shared-engine" };
  sharedEngine.generation = 1;
});

describe("ModelThumbnailCaptureHost", () => {
  it.each(["Material", "Class"] as const)("captures a saved %s with its revision and project write guard", async (type) => {
    assets.set("asset", { path: "assets/preview.babasset", header: { type, payload: {} } });
    render(<ModelThumbnailCaptureHost />);
    const job = { guid: "asset", path: "assets/preview.babasset", type, payload: {}, cacheKey: "asset.revision-1", projectGuid, onlyIfMissing: true };
    enqueueModelThumbnailJobs([job, job]);
    await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledWith("asset", expect.any(Uint8Array), { cacheKey: "asset.revision-1", projectGuid: "project-a" }));
    expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(1);
    expect(captureModelThumbnailPng).not.toHaveBeenCalled();
    expect(scopes[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("keeps a backfill job until the shared Engine is registered", async () => {
    sharedEngine.engine = null;
    sharedEngine.generation = 0;
    assets.set("asset", { path: "assets/preview.babasset", header: { type: "Material", payload: {} } });
    const view = render(<ModelThumbnailCaptureHost />);
    enqueueModelThumbnailJobs([{ guid: "asset", path: "assets/preview.babasset", type: "Material", payload: {}, cacheKey: "asset.revision-1", projectGuid, onlyIfMissing: true }]);
    await waitFor(() => expect(scopes[0]?.dispose).toHaveBeenCalledOnce());
    expect(captureAssetThumbnailPng).not.toHaveBeenCalled();
    sharedEngine.engine = { id: "shared-engine" };
    sharedEngine.generation = 1;
    view.rerender(<ModelThumbnailCaptureHost />);
    await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledWith("asset", expect.any(Uint8Array), { cacheKey: "asset.revision-1", projectGuid: "project-a" }));
    expect(captureAssetThumbnailPng).toHaveBeenCalledOnce();
  });

  it.each(["project switch", "disabled thumbnails", "unmount"])("discards an in-flight capture after %s", async (change) => {
    let finish!: (capture: ThumbnailCaptureResult) => void;
    captureAssetThumbnailPng.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    assets.set("asset", { path: "assets/preview.babasset", header: { type: "Material", payload: {} } });
    const view = render(<ModelThumbnailCaptureHost />);
    enqueueModelThumbnailJobs([{ guid: "asset", path: "assets/preview.babasset", type: "Material", payload: {}, projectGuid, cacheKey: "old" }]);
    await waitFor(() => expect(captureAssetThumbnailPng).toHaveBeenCalledOnce());
    const shouldContinue = captureAssetThumbnailPng.mock.calls[0]![2] as () => boolean;
    expect(shouldContinue()).toBe(true);
    if (change === "project switch") projectGuid = "project-b";
    if (change === "disabled thumbnails") thumbnailsEnabled = false;
    if (change === "unmount") view.unmount();
    else view.rerender(<ModelThumbnailCaptureHost />);
    expect(shouldContinue()).toBe(false);
    expect(scopes[0]!.dispose).toHaveBeenCalledOnce();
    finish(captured([1]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeAssetThumbnail).not.toHaveBeenCalled();
    expect(scopes[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("replaces queued saves with the newest revision without overlapping captures", async () => {
    let finish!: (capture: ThumbnailCaptureResult) => void;
    captureAssetThumbnailPng.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    assets.set("asset", { path: "assets/preview.babasset", header: { type: "Material", payload: {} } });
    render(<ModelThumbnailCaptureHost />);
    const job = { guid: "asset", path: "assets/preview.babasset", type: "Material" as const, payload: {}, projectGuid };
    enqueueModelThumbnailJobs([{ ...job, cacheKey: "old" }]);
    await waitFor(() => expect(captureAssetThumbnailPng).toHaveBeenCalledOnce());
    enqueueModelThumbnailJobs([{ ...job, cacheKey: "middle" }, { ...job, cacheKey: "new" }]);
    expect(captureAssetThumbnailPng).toHaveBeenCalledOnce();
    finish(captured([1]));
    await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledWith("asset", expect.any(Uint8Array), { projectGuid, cacheKey: "new" }));
    expect(writeAssetThumbnail).toHaveBeenCalledOnce();
    expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(2);
  });

  // Uncached captures compile shaders on the shared Engine, which a blocking scene load would count as its own progress.
  describe("while a blocking scene load is open", () => {
    const holds: Array<() => void> = [];
    afterEach(() => { for (const release of holds.splice(0)) release(); });
    const openLoad = () => { const release = holdBlockingSceneLoad(); holds.push(release); return release; };
    const material = { guid: "asset", path: "assets/preview.babasset", type: "Material" as const, payload: {}, cacheKey: "asset.revision-1", projectGuid };

    it("starts no capture until the load closes", async () => {
      assets.set("asset", { path: material.path, header: { type: "Material", payload: {} } });
      const closeLoad = openLoad();
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([material]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(createAssetLoadScope).not.toHaveBeenCalled();
      expect(captureAssetThumbnailPng).not.toHaveBeenCalled();
      closeLoad();
      await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledWith("asset", expect.any(Uint8Array), { cacheKey: "asset.revision-1", projectGuid: "project-a" }));
      expect(captureAssetThumbnailPng).toHaveBeenCalledOnce();
    });

    it("stops the capture in progress when a load opens and captures the asset again once it closes", async () => {
      let finish!: (capture: ThumbnailCaptureResult) => void;
      captureAssetThumbnailPng.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      assets.set("asset", { path: material.path, header: { type: "Material", payload: {} } });
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([material]);
      await waitFor(() => expect(captureAssetThumbnailPng).toHaveBeenCalledOnce());
      const shouldContinue = captureAssetThumbnailPng.mock.calls[0]![2] as () => boolean;
      const closeLoad = openLoad();
      expect(shouldContinue()).toBe(false);
      expect(scopes[0]!.dispose).toHaveBeenCalledOnce();
      finish(captured([1]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(writeAssetThumbnail).not.toHaveBeenCalled();
      expect(captureAssetThumbnailPng).toHaveBeenCalledOnce();
      closeLoad();
      await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledOnce());
      expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(2);
    });

    it("starts no retry of a capture that ran out of time until the load closes", async () => {
      let closeLoad!: () => void;
      // The load opens after the capture ended, while its retry waits for an idle queue.
      captureAssetThumbnailPng.mockImplementationOnce(async () => {
        setTimeout(() => { closeLoad = openLoad(); }, 0);
        return expired;
      });
      assets.set("asset", { path: material.path, header: { type: "Material", payload: {} } });
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([material]);
      await waitFor(() => expect(captureAssetThumbnailPng).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(captureAssetThumbnailPng).toHaveBeenCalledOnce();
      closeLoad();
      await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledOnce());
      expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(2);
    });
  });

  describe("a capture that runs out of time", () => {
    const register = (guid: string) => assets.set(guid, { path: `assets/${guid}.babasset`, header: { type: "Material", payload: {} } });
    const backfill = (guid: string, revision = 1) => ({
      guid, path: `assets/${guid}.babasset`, type: "Material" as const, payload: {}, cacheKey: `${guid}.revision-${revision}`, projectGuid, onlyIfMissing: true,
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const capturedPaths = () => prepareAssetThumbnailInput.mock.calls.map(([input]) => (input as { asset: { path: string } }).asset.path);
    const ceilings = () => captureAssetThumbnailPng.mock.calls.map((call) => call[4]);
    const writtenGuids = () => writeAssetThumbnail.mock.calls.map(([guid]) => guid);

    it("is retried once with a longer ceiling and keeps the thumbnail the retry produces", async () => {
      register("a");
      captureAssetThumbnailPng.mockResolvedValueOnce(expired);
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([backfill("a")]);
      await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledWith("a", expect.any(Uint8Array), { cacheKey: "a.revision-1", projectGuid }));
      expect(writeAssetThumbnail).toHaveBeenCalledOnce();
      expect(ceilings()).toEqual([undefined, retryCeilingMs]);
      expect(scopes).toHaveLength(2);
      expect(scopes.every((scope) => scope.dispose.mock.calls.length === 1)).toBe(true);
    });

    it("is retried with the longer ceiling for a Model too", async () => {
      captureModelThumbnailPng.mockResolvedValueOnce(expired);
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([{ guid: "model", path: "assets/model.babasset", payload: {} }]);
      await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledWith("model", expect.any(Uint8Array)));
      expect(captureModelThumbnailPng.mock.calls.map((call) => call[5]?.ceilingMs)).toEqual([undefined, retryCeilingMs]);
    });

    it("keeps the type icon when the retry runs out too, and a repeated backfill does not start another", async () => {
      register("a");
      captureAssetThumbnailPng.mockResolvedValue(expired);
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([backfill("a")]);
      await waitFor(() => expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(2));
      enqueueModelThumbnailJobs([backfill("a")]);
      await settle();
      expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(2);
      expect(writeAssetThumbnail).not.toHaveBeenCalled();
      expect(scopes.every((scope) => scope.dispose.mock.calls.length === 1)).toBe(true);
    });

    // A longer ceiling does not change a wait that saw no progress for its whole bound.
    it.each<[string, ThumbnailCaptureResult]>([
      ["failed", { outcome: "failed" }],
      ["expired on a wait's bound", { outcome: "expired", reason: "bound" }],
    ])("is not retried when the capture %s", async (_name, result) => {
      register("a");
      captureAssetThumbnailPng.mockResolvedValue(result);
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([backfill("a")]);
      await waitFor(() => expect(captureAssetThumbnailPng).toHaveBeenCalledOnce());
      await settle();
      expect(captureAssetThumbnailPng).toHaveBeenCalledOnce();
      expect(writeAssetThumbnail).not.toHaveBeenCalled();
    });

    it("is retried only after the work queued behind it", async () => {
      register("a");
      register("b");
      captureAssetThumbnailPng.mockResolvedValueOnce(expired);
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([backfill("a"), backfill("b")]);
      await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledTimes(2));
      expect(capturedPaths()).toEqual(["assets/a.babasset", "assets/b.babasset", "assets/a.babasset"]);
      expect(writtenGuids()).toEqual(["b", "a"]);
    });

    it("is replaced by a newer save of the asset", async () => {
      register("a");
      register("b");
      let finishB!: (capture: ThumbnailCaptureResult) => void;
      captureAssetThumbnailPng
        .mockResolvedValueOnce(expired)
        .mockImplementationOnce(() => new Promise((resolve) => { finishB = resolve; }));
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([backfill("a"), backfill("b")]);
      await waitFor(() => expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(2));
      enqueueModelThumbnailJobs([backfill("a", 2)]);
      finishB(captured([1]));
      await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledWith("a", expect.any(Uint8Array), { cacheKey: "a.revision-2", projectGuid }));
      await settle();
      expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(3);
      expect(writtenGuids()).toEqual(["b", "a"]);
    });

    it("is interrupted by new work, which goes first, and runs again afterwards", async () => {
      register("a");
      register("b");
      let holdRetry!: (capture: ThumbnailCaptureResult) => void;
      captureAssetThumbnailPng
        .mockResolvedValueOnce(expired)
        .mockImplementationOnce(() => new Promise((resolve) => { holdRetry = resolve; }));
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([backfill("a")]);
      await waitFor(() => expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(2));
      const retryWanted = captureAssetThumbnailPng.mock.calls[1]![2] as () => boolean;
      expect(retryWanted()).toBe(true);
      enqueueModelThumbnailJobs([backfill("b")]);
      expect(retryWanted()).toBe(false);
      expect(scopes[1]!.dispose).toHaveBeenCalledOnce();
      holdRetry({ outcome: "cancelled" });
      await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledTimes(2));
      expect(capturedPaths()).toEqual(["assets/a.babasset", "assets/a.babasset", "assets/b.babasset", "assets/a.babasset"]);
      expect(ceilings()).toEqual([undefined, retryCeilingMs, undefined, retryCeilingMs]);
      expect(writtenGuids()).toEqual(["b", "a"]);
    });

    // Each run starts over, so a steady trickle of saves must not make one retry burn its ceiling again and again.
    it("spends its attempt when new work has interrupted it three times", async () => {
      for (const guid of ["a", "b", "c", "d"]) register(guid);
      const retryRuns: Array<(capture: ThumbnailCaptureResult) => void> = [];
      const holdRetry = () => new Promise<ThumbnailCaptureResult>((resolve) => { retryRuns.push(resolve); });
      captureAssetThumbnailPng
        .mockResolvedValueOnce(expired)
        .mockImplementationOnce(holdRetry).mockResolvedValueOnce(captured())
        .mockImplementationOnce(holdRetry).mockResolvedValueOnce(captured())
        .mockImplementationOnce(holdRetry).mockResolvedValueOnce(captured());
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([backfill("a")]);
      for (const [index, guid] of ["b", "c", "d"].entries()) {
        await waitFor(() => expect(retryRuns).toHaveLength(index + 1));
        enqueueModelThumbnailJobs([backfill(guid)]);
        retryRuns[index]!({ outcome: "cancelled" });
        await waitFor(() => expect(writtenGuids()).toContain(guid));
      }
      await settle();
      expect(capturedPaths().filter((path) => path === "assets/a.babasset")).toHaveLength(4);
      expect(writtenGuids()).toEqual(["b", "c", "d"]);
    });

    it("keeps the image of a retry that finished as new work arrived, when the asset is unchanged", async () => {
      register("a");
      register("b");
      captureAssetThumbnailPng
        .mockResolvedValueOnce(expired)
        .mockImplementationOnce(async () => {
          enqueueModelThumbnailJobs([backfill("b")]);
          return captured([1]);
        });
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([backfill("a")]);
      await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledTimes(2));
      await settle();
      expect(writtenGuids()).toEqual(["a", "b"]);
      // The interrupted retry was written, so it is not run again.
      expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(3);
    });

    it("discards the image of a retry that finished as a newer save of the asset arrived", async () => {
      register("a");
      captureAssetThumbnailPng
        .mockResolvedValueOnce(expired)
        .mockImplementationOnce(async () => {
          enqueueModelThumbnailJobs([backfill("a", 2)]);
          return captured([1]);
        });
      render(<ModelThumbnailCaptureHost />);
      enqueueModelThumbnailJobs([backfill("a")]);
      await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledWith("a", expect.any(Uint8Array), { cacheKey: "a.revision-2", projectGuid }));
      await settle();
      expect(writeAssetThumbnail).toHaveBeenCalledOnce();
      expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(3);
    });
  });

  it("cancels a pending source read and releases its scope when the capture host closes", async () => {
    let finish!: (bytes: Uint8Array) => void;
    readAssetChunk.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<ModelThumbnailCaptureHost />);
    enqueueModelThumbnailJobs([{ guid: "model", path: "assets/model.babasset", type: "Model", payload: {} }]);
    await waitFor(() => expect(readAssetChunk).toHaveBeenCalledOnce());
    const options = readAssetChunk.mock.calls[0]![2]!;
    expect(options.priority).toBe("background");
    expect(options.signal!.aborted).toBe(false);
    view.unmount();
    expect(options.signal!.aborted).toBe(true);
    expect(scopes[0]!.dispose).toHaveBeenCalledOnce();
    finish(new Uint8Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captureModelThumbnailPng).not.toHaveBeenCalled();
    expect(writeAssetThumbnail).not.toHaveBeenCalled();
  });

  it("captures an Animation from its owning Model and retarget source", async () => {
    assets.set("hero-model", {
      path: "assets/hero.babasset",
      header: { type: "Model", payload: { importScale: 0.5 } },
    });
    assets.set("source-anim", {
      path: "assets/source-idle.babasset",
      header: { type: "Animation", payload: { modelGuid: "source-model" } },
    });
    assets.set("source-model", {
      path: "assets/source.babasset",
      header: { type: "Model", payload: {} },
    });
    const targetBytes = new Uint8Array([1]);
    const sourceBytes = new Uint8Array([2]);
    readAssetChunk.mockImplementation(async (path) =>
      path === "assets/hero.babasset" ? targetBytes : sourceBytes,
    );
    render(<ModelThumbnailCaptureHost />);
    enqueueModelThumbnailJobs([
      {
        guid: "idle",
        path: "assets/idle.babasset",
        type: "Animation",
        payload: {
          modelGuid: "hero-model",
          clipName: "Idle",
          sourceAnimationGuid: "source-anim",
        },
      },
    ]);
    await waitFor(() =>
      expect(writeAssetThumbnail).toHaveBeenCalledWith(
        "idle",
        expect.any(Uint8Array),
      ),
    );
    expect(readAssetChunk.mock.calls).toEqual([
      ["assets/hero.babasset", "source", { scope: scopes[0], signal: expect.any(AbortSignal), priority: "background" }],
      ["assets/source.babasset", "source", { scope: scopes[0], signal: expect.any(AbortSignal), priority: "background" }],
    ]);
    expect(scopes[0]!.dispose).toHaveBeenCalledOnce();
    expect(captureModelThumbnailPng.mock.calls[0]![1]).toBe(targetBytes);
    expect(captureModelThumbnailPng.mock.calls[0]![5]).toEqual({
      importScale: 0.5,
      clipName: "Idle",
      sourceClipBytes: sourceBytes,
      signal: expect.any(AbortSignal),
    });
  });

  it("serializes batches, deduplicates backfill, and continues after a missing source fails", async () => {
    let release!: (value: Uint8Array | null) => void;
    readAssetChunk.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<ModelThumbnailCaptureHost />);
    const missing = {
      guid: "missing",
      path: "assets/missing.babasset",
      payload: {},
      onlyIfMissing: true,
    };
    const good = { guid: "good", path: "assets/good.babasset", payload: {} };
    enqueueModelThumbnailJobs([missing]);
    enqueueModelThumbnailJobs([missing, good]);
    await waitFor(() => expect(readAssetChunk).toHaveBeenCalledTimes(1));
    expect(writeAssetThumbnail).not.toHaveBeenCalled();
    release(null);
    await waitFor(() =>
      expect(writeAssetThumbnail).toHaveBeenCalledWith(
        "good",
        expect.any(Uint8Array),
      ),
    );
    enqueueModelThumbnailJobs([missing, good]);
    await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledTimes(2));
    expect(
      readAssetChunk.mock.calls.filter(([path]) => path === missing.path),
    ).toHaveLength(1);
  });

  it("preserves every explicitly selected job in a large batch while reading only one at a time", async () => {
    let release!: (value: Uint8Array | null) => void;
    readAssetChunk.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const jobs = Array.from({ length: 130 }, (_, index) => ({ guid: `model-${index}`, path: `assets/model-${index}.babasset`, payload: {} }));
    render(<ModelThumbnailCaptureHost />);
    enqueueModelThumbnailJobs(jobs);
    await waitFor(() => expect(readAssetChunk).toHaveBeenCalledOnce());
    expect(readAssetChunk.mock.calls[0]![0]).toBe(jobs[0]!.path);
    release(new Uint8Array([1]));
    // The queue yields a timer turn between captures: 130 of them outlast waitFor's default second on a slow host.
    await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledTimes(jobs.length), { timeout: 10_000 });
    expect(readAssetChunk.mock.calls.map(([path]) => path)).toEqual(jobs.map(({ path }) => path));
    expect(scopes.every((scope) => scope.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("captures the packed GLB without a slot MaterialLibrary or extra ResourceCache", async () => {
    render(<ModelThumbnailCaptureHost />);
    enqueueModelThumbnailJobs([
      {
        guid: "model-1",
        path: "assets/hero.babasset",
        payload: {
          materialSlots: [
            { index: 0, name: "Hero Mat", materialGuid: "mat-1" },
          ],
          clipNames: [],
        },
      },
    ]);
    await waitFor(() => {
      expect(captureModelThumbnailPng).toHaveBeenCalled();
    });
    expect(collectPlayMaterialLibrary).not.toHaveBeenCalled();
    expect(collectPlayTextureBytes).not.toHaveBeenCalled();
    expect(resourceCacheForEngine).not.toHaveBeenCalled();
    expect(MaterialLibrary).not.toHaveBeenCalled();
    const resolveMaterial = captureModelThumbnailPng.mock.calls[0]![3] as (
      guid: string,
    ) => unknown | null;
    expect(resolveMaterial("mat-1")).toBeNull();
    expect(writeAssetThumbnail).toHaveBeenCalledWith(
      "model-1",
      expect.any(Uint8Array),
    );
  });
});
