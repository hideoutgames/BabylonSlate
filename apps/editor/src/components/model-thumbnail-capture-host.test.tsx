import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { enqueueModelThumbnailJobs } from "../lib/model-thumbnail-queue";
import { ModelThumbnailCaptureHost } from "./model-thumbnail-capture-host";

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
    },
  ) => Promise<Uint8Array | null>
>(async () => new Uint8Array([137, 80, 78, 71]));
const MaterialLibrary = vi.fn();
const captureAssetThumbnailPng = vi.fn<(...args: unknown[]) => Promise<Uint8Array | null>>(async () => new Uint8Array([137, 80, 78, 71]));
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
const writeAssetThumbnail = vi.fn(async () => undefined);
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
}));

vi.mock("../lib/asset-thumbnail-input", () => ({
  prepareAssetThumbnailInput: (input: unknown) => prepareAssetThumbnailInput(input),
}));

vi.mock("../context/play-context", () => ({
  useOptionalPlay: () => ({
    ensureSharedEngine: () => ({ id: "shared-engine" }),
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
    .mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
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
  captureAssetThumbnailPng.mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
  prepareAssetThumbnailInput.mockClear();
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

  it.each(["project switch", "disabled thumbnails", "unmount"])("discards an in-flight capture after %s", async (change) => {
    let finish!: (png: Uint8Array) => void;
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
    finish(new Uint8Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeAssetThumbnail).not.toHaveBeenCalled();
    expect(scopes[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("replaces queued saves with the newest revision without overlapping captures", async () => {
    let finish!: (png: Uint8Array) => void;
    captureAssetThumbnailPng.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    assets.set("asset", { path: "assets/preview.babasset", header: { type: "Material", payload: {} } });
    render(<ModelThumbnailCaptureHost />);
    const job = { guid: "asset", path: "assets/preview.babasset", type: "Material" as const, payload: {}, projectGuid };
    enqueueModelThumbnailJobs([{ ...job, cacheKey: "old" }]);
    await waitFor(() => expect(captureAssetThumbnailPng).toHaveBeenCalledOnce());
    enqueueModelThumbnailJobs([{ ...job, cacheKey: "middle" }, { ...job, cacheKey: "new" }]);
    expect(captureAssetThumbnailPng).toHaveBeenCalledOnce();
    finish(new Uint8Array([1]));
    await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledWith("asset", expect.any(Uint8Array), { projectGuid, cacheKey: "new" }));
    expect(writeAssetThumbnail).toHaveBeenCalledOnce();
    expect(captureAssetThumbnailPng).toHaveBeenCalledTimes(2);
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
    await waitFor(() => expect(writeAssetThumbnail).toHaveBeenCalledTimes(jobs.length));
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
