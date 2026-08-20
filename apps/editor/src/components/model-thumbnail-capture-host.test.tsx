import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { enqueueModelThumbnailJobs } from "../lib/model-thumbnail-queue";
import { ModelThumbnailCaptureHost } from "./model-thumbnail-capture-host";

const captureModelThumbnailPng = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
const MaterialLibrary = vi.fn();
const resourceCacheForEngine = vi.fn(() => ({}));
const collectPlayMaterialLibrary = vi.fn(async () => ({
  documents: new Map(),
  functions: new Map(),
  textureGuids: [],
}));
const collectPlayTextureBytes = vi.fn(async () => new Map());
const writeAssetThumbnail = vi.fn(async () => undefined);
const readAssetChunk = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));

vi.mock("@babylonslate/render", () => ({
  captureModelThumbnailPng: (...args: unknown[]) =>
    captureModelThumbnailPng(...args),
  MaterialLibrary: class {
    constructor() {
      MaterialLibrary();
    }
    acquire() {
      return { ok: false, diagnostics: [] };
    }
    dispose() {}
  },
  resourceCacheForEngine: (...args: unknown[]) =>
    resourceCacheForEngine(...args),
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
    readAssetChunk,
    collectPlayMaterialLibrary,
    collectPlayTextureBytes,
    writeAssetThumbnail,
  }),
}));

afterEach(() => {
  cleanup();
  captureModelThumbnailPng.mockClear();
  MaterialLibrary.mockClear();
  resourceCacheForEngine.mockClear();
  collectPlayMaterialLibrary.mockClear();
  collectPlayTextureBytes.mockClear();
  writeAssetThumbnail.mockClear();
  readAssetChunk.mockClear();
});

describe("ModelThumbnailCaptureHost", () => {
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
    ) => unknown;
    expect(resolveMaterial("mat-1")).toBeNull();
    expect(writeAssetThumbnail).toHaveBeenCalledWith(
      "model-1",
      expect.any(Uint8Array),
    );
  });
});
