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
    },
  ) => Promise<Uint8Array | null>
>(async () => new Uint8Array([137, 80, 78, 71]));
const MaterialLibrary = vi.fn();
const resourceCacheForEngine = vi.fn(() => ({}));
const collectPlayMaterialLibrary = vi.fn(async () => ({
  documents: new Map(),
  functions: new Map(),
  textureGuids: [],
}));
const collectPlayTextureBytes = vi.fn(async () => new Map());
const writeAssetThumbnail = vi.fn(async () => undefined);
const readAssetChunk = vi.fn<
  (path: string, kind: string) => Promise<Uint8Array | null>
>(async () => new Uint8Array([1, 2, 3, 4]));
const assets = new Map<
  string,
  { path: string; header: { type: string; payload: Record<string, unknown> } }
>();

vi.mock("@babylonslate/render", () => ({
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

vi.mock("../context/play-context", () => ({
  useOptionalPlay: () => ({
    ensureSharedEngine: () => ({ id: "shared-engine" }),
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    thumbnailsEnabled: true,
    assetRegistry: { getByGuid: (guid: string) => assets.get(guid) },
    readAssetChunk,
    collectPlayMaterialLibrary,
    collectPlayTextureBytes,
    writeAssetThumbnail,
  }),
}));

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
  readAssetChunk.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
  assets.clear();
});

describe("ModelThumbnailCaptureHost", () => {
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
      ["assets/hero.babasset", "source"],
      ["assets/source.babasset", "source"],
    ]);
    expect(captureModelThumbnailPng.mock.calls[0]![1]).toBe(targetBytes);
    expect(captureModelThumbnailPng.mock.calls[0]![5]).toEqual({
      importScale: 0.5,
      clipName: "Idle",
      sourceClipBytes: sourceBytes,
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
